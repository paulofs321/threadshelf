import { vi } from 'vitest';
import { AccessBroker } from '../../src/platform/broker';
import type { SelectedTabAccessPort } from '../../src/platform/broker';
import type { AccessMessage, AccessReply } from '../../src/platform/protocol';

// Handwritten browser metadata only. No provider wire schemas, sessions, or captures.
export const tab = {
  id: 7,
  windowId: 3,
  active: true,
  incognito: false,
  status: 'complete',
  url: 'https://chatgpt.com/',
};
export const probe = {
  documentId: 'fiction-document-one',
  frameId: 0,
  result: { origin: 'https://chatgpt.com', topLevel: true },
};

export function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Uninitialized deferred.');
  };

  let reject: (reason?: unknown) => void = () => {
    throw new Error('Uninitialized deferred.');
  };

  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
}

export function brokerHarness(panel = 'one') {
  let counter = 0;
  const messages: AccessMessage[] = [];
  const replies = new Map<string, (reply: AccessReply) => void>();
  const port = {
    ownerWindow: vi.fn<SelectedTabAccessPort['ownerWindow']>().mockResolvedValue(3),
    hasPermission: vi.fn<SelectedTabAccessPort['hasPermission']>().mockResolvedValue(true),
    selectedTab: vi.fn<SelectedTabAccessPort['selectedTab']>().mockResolvedValue(tab),
    inspectDocument: vi.fn<SelectedTabAccessPort['inspectDocument']>().mockResolvedValue(probe),
  };
  const close = vi.fn();
  const broker = new AccessBroker(
    port,
    (message) => {
      messages.push(message);
      if (message.kind === 'reply') replies.get(message.requestId)?.(message);
    },
    close,
    () => `fiction-panel-${panel}-partition-${++counter}`,
  );

  function replyFor(requestId: string) {
    const next = deferred<AccessReply>();
    replies.set(requestId, next.resolve);

    return next.promise;
  }

  async function connect(requestId = 'fiction-request-one') {
    const reply = replyFor(requestId);
    broker.receive({ operation: 'connect', provider: 'chatgpt', requestId });

    return reply;
  }

  return { broker, port, messages, close, replyFor, connect };
}

export function event<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();

  return {
    addListener: vi.fn((listener: (...args: Args) => void) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: (...args: Args) => void) => {
      listeners.delete(listener);
    }),
    emit(...args: Args) {
      for (const listener of listeners) listener(...args);
    },
    size() {
      return listeners.size;
    },
  };
}

export async function selected(harness: ReturnType<typeof brokerHarness>) {
  const reply = await harness.connect();
  if (reply.status !== 'selected') throw new Error('Expected synthetic selection.');

  return reply.scope;
}
