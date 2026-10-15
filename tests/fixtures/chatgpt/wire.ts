// Handwritten structural fixtures. No live account, conversation, header or content values.
export const conversationId = '11111111-1111-1111-1111-111111111111';
export const otherConversationId = '22222222-2222-2222-2222-222222222222';
export const identity = 'a'.repeat(64);
export function searchItem(id = conversationId) {
  return {
    id: 'synthetic-result',
    source_type: 'conversation',
    source_key: 'synthetic-source',
    title: 'Fictional project',
    snippet: '  Exact fictional prototype excerpt.  ',
    update_time: 1_760_000_000.125 as number | null,
    match_kind: 'content',
    payload: {
      kind: 'conversation',
      conversation_id: id,
      message_id: 'synthetic-message',
      is_archived: false,
      is_starred: null,
    },
  };
}
export function searchBody(items = [searchItem()]) {
  return {
    items,
    cursor: null as string | null,
    partial_results: false,
    source_statuses: [
      {
        source_type: 'conversation',
        status: 'ok',
        has_more: false,
        source_key: 'synthetic-source',
        duration_ms: 1,
        error_code: null,
      },
    ],
  };
}
export function listItem(id = conversationId) {
  return {
    id,
    title: 'Fictional project',
    create_time: '2025-10-09T08:53:20.125000+00:00',
    update_time: '2025-10-09T08:53:20.125000+00:00' as string | null,
    is_archived: false,
    is_temporary_chat: false,
    workspace_id: null as string | null,
  };
}
export function listBody(items = [listItem()]) {
  return { items, total: items.length, limit: 50, offset: 0 };
}
export function message(text = '  Exact fictional message.  ', role = 'assistant') {
  return {
    id: 'synthetic-message',
    author: { role, name: null, metadata: {} },
    content: { content_type: 'text', parts: [text] as unknown[] },
    metadata: {} as Record<string, unknown>,
    channel: null as string | null,
  };
}
export function messagesBody(id = conversationId) {
  return {
    conversation_id: id,
    current_node: 'answer',
    is_temporary_chat: false,
    mapping: {
      root: {
        id: 'root',
        parent: null as string | null,
        children: ['question'],
        message: null as unknown,
      },
      question: {
        id: 'question',
        parent: 'root',
        children: ['answer'],
        message: message('Synthetic question?', 'user'),
      },
      answer: { id: 'answer', parent: 'question', children: [], message: message() },
    },
  };
}
export function readResult(body: unknown = null) {
  return { status: 'success', identityBefore: identity, identityAfter: identity, body };
}
export function bootstrap(user = 'synthetic-user', account = 'synthetic-personal-account') {
  return {
    session: {
      accessToken: 'SYNTHETIC-CREDENTIAL-DO-NOT-RETURN',
      user: { id: user },
      account: { id: account, structure: 'personal' },
    },
  };
}
export function bootstrapHtml(data: unknown = bootstrap()) {
  return `<html><script type="application/json">${JSON.stringify(data)}</script></html>`;
}
