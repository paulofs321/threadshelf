import * as v from 'valibot';
import { CandidateListSchema } from '../../contracts/conversation';
import type { Candidate, Evidence, OriginalLinkVerifier } from '../../contracts/conversation';
import type { Coverage } from '../../contracts/outcome';
import { boundedArray, boundedText, limits } from '../../contracts/primitives';
import type { SessionScope } from '../../contracts/session';
import { requireValid } from '../../contracts/validation';
import { ChatGptConversationIdSchema } from './transport';

const text = v.pipe(v.string(), v.maxLength(64_000));
const seconds = v.nullable(v.number());
const SearchItemSchema = v.object({
  id: boundedText(256),
  source_type: v.literal('conversation'),
  source_key: boundedText(512),
  title: text,
  snippet: text,
  update_time: seconds,
  match_kind: boundedText(64),
  payload: v.object({
    kind: v.literal('conversation'),
    conversation_id: ChatGptConversationIdSchema,
    message_id: v.nullable(boundedText(256)),
    is_archived: v.boolean(),
  }),
});
const SearchSchema = v.object({
  items: boundedArray(SearchItemSchema, 30),
  cursor: v.nullable(boundedText(4_096)),
  partial_results: v.boolean(),
  source_statuses: boundedArray(
    v.object({
      source_type: boundedText(64),
      status: boundedText(64),
      has_more: v.boolean(),
    }),
    8,
  ),
});
const ListSchema = v.object({
  items: boundedArray(
    v.object({
      id: ChatGptConversationIdSchema,
      title: text,
      create_time: v.nullable(v.string()),
      update_time: v.nullable(v.string()),
      is_archived: v.boolean(),
      is_temporary_chat: v.boolean(),
      workspace_id: v.nullable(v.string()),
    }),
    100,
  ),
  total: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  limit: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(100)),
  offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export const verifyChatGptOriginalLink: OriginalLinkVerifier = (url, id) =>
  v.safeParse(ChatGptConversationIdSchema, id).success &&
  url.href === `https://chatgpt.com/c/${id}`;

function fromSeconds(value: number | null): Candidate['date'] {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 253_402_300_799.999) return;

  return {
    at: new Date(Math.trunc(value * 1_000)).toISOString(),
    meaning: 'conversation-updated',
    source: 'provider-metadata',
  };
}

function fromIso(value: string | null): Candidate['date'] {
  // Only the observed UTC forms; no locale parsing or guessed midnight/date meaning.
  if (
    value === null ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/u.test(value)
  )
    return;

  const milliseconds = Date.parse(value);

  if (!Number.isFinite(milliseconds)) return;

  const at = new Date(milliseconds).toISOString();

  if (at.slice(0, 19) !== value.slice(0, 19)) return;

  return { at, meaning: 'conversation-updated', source: 'provider-metadata' };
}

export interface ChatGptCandidates {
  candidates: Candidate[];
  coverage: Coverage;
}

export function parseChatGptCandidates(
  input: unknown,
  scope: SessionScope,
  kind: 'search' | 'list',
): ChatGptCandidates {
  const rows: { id: string; title: string; snippet?: string; date?: Candidate['date'] }[] = [];
  const reasons: Coverage['reasons'] = ['unknown-reach'];

  if (kind === 'search') {
    const body = requireValid(SearchSchema, input);

    if (!body.source_statuses.some((s) => s.source_type === 'conversation' && s.status === 'ok'))
      throw new Error('Invalid provider response.');

    if (
      body.partial_results ||
      body.cursor !== null ||
      body.source_statuses.some((s) => s.has_more) ||
      body.items.length === 30
    )
      reasons.push('result-limit');

    for (const row of body.items)
      rows.push({
        id: row.payload.conversation_id,
        title: row.title,
        snippet: row.snippet,
        date: fromSeconds(row.update_time),
      });
  } else {
    const body = requireValid(ListSchema, input);

    if (body.offset !== 0 || body.items.length > body.limit || body.total < body.items.length)
      throw new Error('Invalid provider response.');

    if (body.total > body.items.length || body.items.length === body.limit)
      reasons.push('result-limit');

    for (const row of body.items) {
      if (row.workspace_id !== null) throw new Error('Invalid provider response.');

      if (!row.is_temporary_chat)
        rows.push({ id: row.id, title: row.title, date: fromIso(row.update_time) });
    }
  }

  const candidates: Candidate[] = [];
  const byId = new Map<string, Candidate>();
  let remaining = limits.totalEvidence;

  for (const row of rows) {
    let candidate = byId.get(row.id);

    if (!candidate) {
      candidate = {
        id: `chatgpt:${candidates.length}` as Candidate['id'],
        scope,
        conversationId: row.id as Candidate['conversationId'],
        originalUrl: `https://chatgpt.com/c/${row.id}`,
        ...(row.title.trim() ? { title: row.title.slice(0, limits.title) } : {}),
        ...(row.date ? { date: row.date } : {}),
        evidence: [],
      };
      byId.set(row.id, candidate);
      candidates.push(candidate);
    }

    const snippet = row.snippet?.trim() ? row.snippet : candidate.title;
    const source = row.snippet?.trim() ? 'native-snippet' : 'title';

    if (
      snippet &&
      remaining > 0 &&
      candidate.evidence.length < limits.evidencePerCandidate &&
      !candidate.evidence.some((e) => e.text === snippet.slice(0, limits.excerpt))
    ) {
      const excerpt = snippet.slice(0, Math.min(limits.excerpt, remaining));

      if (excerpt.trim()) {
        candidate.evidence.push({
          id: `${candidate.id}:${candidate.evidence.length}` as Evidence['id'],
          text: excerpt,
          source,
        });
        remaining -= excerpt.length;
      }
    }
  }

  if (candidates.some((c) => c.evidence.length === 0)) reasons.push('missing-evidence');

  return {
    candidates: requireValid(CandidateListSchema, candidates),
    coverage: { extent: reasons.includes('result-limit') ? 'partial' : 'unknown', reasons },
  };
}

const opaque = boundedText(256);
const NodeSchema = v.object({
  id: opaque,
  parent: v.nullable(opaque),
  children: boundedArray(opaque, 2_048),
  message: v.unknown(),
});
const MessagesSchema = v.object({
  conversation_id: ChatGptConversationIdSchema,
  current_node: opaque,
  is_temporary_chat: v.boolean(),
  mapping: v.pipe(
    v.custom<Record<string, unknown>>(
      (x) =>
        x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length <= 2_048,
    ),
    v.record(opaque, NodeSchema),
  ),
});
const MessageSchema = v.object({
  author: v.object({ role: boundedText(64) }),
  content: v.object({
    content_type: boundedText(64),
    parts: v.exactOptional(boundedArray(v.unknown(), 128)),
  }),
  channel: v.exactOptional(v.nullable(v.string())),
  metadata: v.object({ is_visually_hidden_from_conversation: v.exactOptional(v.boolean()) }),
});

export function parseChatGptMessages(input: unknown, conversationId: string): string[] {
  const body = requireValid(MessagesSchema, input);

  if (body.conversation_id !== conversationId || body.is_temporary_chat)
    throw new Error('Invalid provider response.');

  const seen = new Set<string>();
  const branch: unknown[] = [];
  let id: string | null = body.current_node;

  while (id !== null) {
    const node: v.InferOutput<typeof NodeSchema> | undefined = body.mapping[id];

    if (seen.has(id) || !node || node.id !== id) throw new Error('Invalid provider response.');

    seen.add(id);
    branch.push(node.message);
    id = node.parent;
  }

  const excerpts: string[] = [];

  for (const raw of branch.reverse()) {
    if (raw === null) continue;

    const message = requireValid(MessageSchema, raw);

    if (
      !['user', 'assistant'].includes(message.author.role) ||
      message.metadata.is_visually_hidden_from_conversation ||
      (message.channel != null && message.channel !== 'final') ||
      message.content.content_type !== 'text'
    )
      continue;

    if (!message.content.parts || message.content.parts.some((part) => typeof part !== 'string'))
      throw new Error('Invalid provider response.');

    for (const part of message.content.parts) {
      const value = part as string;

      if (value.trim() && excerpts.length < 4) excerpts.push(value.slice(0, limits.excerpt));
    }
  }

  return excerpts;
}
