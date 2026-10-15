import { describe, expect, it } from 'vitest';
import type { Candidate, ProviderOutcome } from '../../src/contracts';
import { normalizeProviderOutcome } from '../../src/search/normalize';
import { chatRequest } from '../fixtures/contracts';
import { chatCandidate, googleCandidate, linkVerifiers } from '../fixtures/search/providers';

function batch(candidates: unknown[] = [chatCandidate]) {
  return {
    requestId: chatRequest.requestId,
    scope: chatRequest.scope,
    status: 'success',
    candidates,
    coverage: { extent: 'complete', reasons: [] },
  };
}

const normalize = (input: unknown) => normalizeProviderOutcome(input, chatRequest, linkVerifiers);
const failed = (outcome: ProviderOutcome) =>
  expect(outcome).toEqual({
    requestId: chatRequest.requestId,
    scope: chatRequest.scope,
    status: 'schema-changed',
  });

describe('bounded scoped deduplication and untrusted provider validation', () => {
  it('revalidates the final inventory against the current link policy', () => {
    let checks = 0;
    failed(normalizeProviderOutcome(batch(), chatRequest, { chatgpt: () => ++checks === 1 }));
    expect(checks).toBe(2);
  });

  it('coalesces repeats by scoped conversation identity and retains distinct evidence', () => {
    const second = {
      ...chatCandidate,
      id: 'fictional-second-hit',
      evidence: [
        {
          id: 'fictional-extra',
          source: 'native-snippet',
          text: 'A fictional librarian repairs the floating shelves.',
        },
      ],
    };
    const input = batch([chatCandidate, chatCandidate, second]);
    const before = structuredClone(input);
    const result = normalize(input);
    expect(result).toMatchObject({
      status: 'success',
      candidates: [
        { id: chatCandidate.id, evidence: [...chatCandidate.evidence, ...second.evidence] },
      ],
    });
    expect(input).toEqual(before);
  });

  it('fills only missing metadata from the same conversation and deduplicates identical text', () => {
    const first: Candidate = {
      id: chatCandidate.id,
      scope: chatCandidate.scope,
      conversationId: chatCandidate.conversationId,
      evidence: [],
    };
    const copy = {
      ...chatCandidate,
      evidence: chatCandidate.evidence.map((item) => ({
        ...item,
        id: `fictional-alias-${item.id}`,
      })),
    };
    expect(normalize(batch([first, chatCandidate, copy]))).toMatchObject({
      candidates: [chatCandidate],
    });
  });

  it('keeps different conversations with equal titles distinct', () => {
    const second = {
      ...chatCandidate,
      id: 'fictional-other-candidate',
      conversationId: 'fictional-other-thread',
      originalUrl: 'https://chatgpt.example.invalid/threads/fictional-other-thread',
    };
    expect(normalize(batch([chatCandidate, second]))).toMatchObject({
      status: 'success',
      candidates: [chatCandidate, second],
    });
  });

  it.each([
    { title: 'Conflicting fictional title', evidence: [] },
    { originalUrl: 'https://chatgpt.example.invalid/threads/fictional-other-thread' },
    { date: { ...chatCandidate.date, meaning: 'conversation-updated' } },
    {
      evidence: [
        {
          ...chatCandidate.evidence[0],
          text: 'Conflicting exact excerpt',
          source: 'native-snippet',
        },
      ],
    },
    { evidence: [{ ...chatCandidate.evidence[1], text: 'Conflicting same ID' }] },
  ])('rejects conflicting duplicate metadata/evidence: %j', (patch) => {
    failed(normalize(batch([chatCandidate, { ...chatCandidate, ...patch }])));
  });

  it('rejects conflicting links even when both pass a permissive link verifier', () => {
    failed(
      normalizeProviderOutcome(
        batch([
          chatCandidate,
          { ...chatCandidate, originalUrl: 'https://chatgpt.example.invalid/alternate' },
        ]),
        chatRequest,
        { chatgpt: () => true },
      ),
    );
  });

  it('discloses evidence omitted at the deduplicated candidate bound', () => {
    const makeEvidence = (offset: number) =>
      Array.from({ length: 8 }, (_, index) => ({
        id: `fictional-${offset + index}`,
        source: 'native-snippet',
        text: `Fictional exact excerpt ${offset + index}`,
      }));
    const result = normalize(
      batch([
        { ...chatCandidate, evidence: makeEvidence(0) },
        { ...chatCandidate, evidence: makeEvidence(8) },
      ]),
    );
    expect(result).toMatchObject({
      status: 'success',
      coverage: { extent: 'partial', reasons: ['missing-evidence'] },
    });

    if (result.status !== 'success') throw new Error('Expected synthetic success.');

    expect(result.candidates[0]?.evidence).toEqual(makeEvidence(0));
    expect(
      normalize({
        ...batch([
          { ...chatCandidate, evidence: makeEvidence(0) },
          { ...chatCandidate, evidence: makeEvidence(8) },
        ]),
        coverage: { extent: 'unknown', reasons: ['unknown-reach', 'missing-evidence'] },
      }),
    ).toMatchObject({
      coverage: { extent: 'unknown', reasons: ['unknown-reach', 'missing-evidence'] },
    });
  });

  it.each([
    null,
    {},
    { ...batch(), extra: 'untrusted' },
    { ...batch(), requestId: 'fictional-obsolete-request' },
    { ...batch(), scope: { ...chatRequest.scope, generation: 2 } },
    batch([googleCandidate]),
    batch([{ ...chatCandidate, scope: { ...chatCandidate.scope, generation: 2 } }]),
    batch([{ ...chatCandidate, originalUrl: 'javascript:alert(1)' }]),
    batch([
      {
        ...chatCandidate,
        originalUrl: 'https://foreign.example.invalid/threads/fictional-thread-aurora',
      },
    ]),
    batch([
      {
        ...chatCandidate,
        evidence: [{ id: 'fictional-evidence', source: 'model', text: 'invented' }],
      },
    ]),
    batch([
      {
        ...chatCandidate,
        date: {
          at: '2026-09-12T10:00:00.000Z',
          meaning: 'conversation-updated',
          source: 'rendered-message',
        },
      },
    ]),
    batch(Array.from({ length: 101 }, () => chatCandidate)),
    batch([
      chatCandidate,
      {
        ...chatCandidate,
        conversationId: 'fictional-other',
        originalUrl: 'https://chatgpt.example.invalid/threads/fictional-other',
      },
    ]),
    { ...batch(), status: 'rate-limited', retryAfterMs: 300_001 },
    { ...batch(), status: 'unavailable' },
  ])('maps malformed, obsolete or unsafe input to schema-changed (%#)', (input) => {
    failed(normalize(input));
  });

  it('preflights response text budgets before deduplication', () => {
    const candidate = {
      ...chatCandidate,
      evidence: [
        { id: 'fictional-large-excerpt', source: 'native-snippet', text: 'x'.repeat(2_000) },
      ],
    };
    failed(normalize(batch(Array.from({ length: 33 }, () => candidate))));
  });

  it('rejects throwing getters and failed link policies without exposing exception text', () => {
    failed(
      normalize({
        get requestId() {
          throw new Error('fictional private getter');
        },
      }),
    );
    failed(normalizeProviderOutcome(batch(), chatRequest, {}));
    failed(
      normalizeProviderOutcome(batch(), chatRequest, {
        chatgpt: () => {
          throw new Error('fictional private policy');
        },
      }),
    );
  });

  it('accepts absent links without inventing one and preserves valid retry hints', () => {
    const candidate = structuredClone(chatCandidate);
    delete candidate.originalUrl;
    expect(normalizeProviderOutcome(batch([candidate]), chatRequest, {})).toMatchObject({
      candidates: [candidate],
    });
    const rateLimited = {
      requestId: chatRequest.requestId,
      scope: chatRequest.scope,
      status: 'rate-limited',
      retryAfterMs: 5_000,
    };
    expect(normalize(rateLimited)).toEqual(rateLimited);
  });
});
