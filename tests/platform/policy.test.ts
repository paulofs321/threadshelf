import { describe, expect, it } from 'vitest';
import { validate } from '../../src/contracts/validation';
import {
  permittedUrl,
  providerPermission,
  validatePanelContext,
  validatePanelSender,
  validateProbe,
} from '../../src/platform/policy';
import { AccessMessageSchema, AccessRequestSchema } from '../../src/platform/protocol';
import { probe } from './helpers';

const sender = {
  id: 'fiction-extension',
  origin: 'chrome-extension://fiction-extension',
  url: 'chrome-extension://fiction-extension/sidepanel.html',
  documentId: 'fiction-panel-document',
  documentLifecycle: 'active',
};
const context = {
  contextType: 'SIDE_PANEL',
  documentId: sender.documentId,
  documentOrigin: sender.origin,
  documentUrl: sender.url,
  incognito: false,
  tabId: -1,
  frameId: 0,
  windowId: 3,
};

describe('selected context policy', () => {
  it('requests only scripting and the selected exact origin', () => {
    expect(providerPermission('chatgpt')).toEqual({
      permissions: ['scripting'],
      origins: ['https://chatgpt.com/*'],
    });
    expect(providerPermission('google-ai-mode')).toEqual({
      permissions: ['scripting'],
      origins: ['https://www.google.com/*'],
    });
  });

  it.each([
    'http://chatgpt.com/',
    'https://chatgpt.com.evil.invalid/',
    'https://chatgpt.com:8443/',
    'https://person:secret@chatgpt.com/',
    'https://accounts.google.com/',
    'https://gemini.google.com/',
    'https://chatgpt.com',
    'javascript:alert(1)',
    'x'.repeat(2049),
    'not-a-url',
  ])('rejects another/unsafe/noncanonical origin: %s', (url) => {
    expect(permittedUrl('chatgpt', url)).toBe(false);
  });
  it('accepts only the configured provider origin', () => {
    expect(permittedUrl('chatgpt', 'https://chatgpt.com/')).toBe(true);
    expect(permittedUrl('google-ai-mode', 'https://www.google.com/')).toBe(true);
    expect(permittedUrl('google-ai-mode', 'https://google.ch/')).toBe(false);
  });

  it('requires a Chrome-supplied active extension document and a live panel context', () => {
    expect(validatePanelSender(sender, sender.id)).toBe(sender.documentId);
    expect(validatePanelContext(context, sender.documentId, sender.id)).toBe(3);
  });
  it.each([
    { id: 'another-extension' },
    { url: 'https://chatgpt.com/' },
    { origin: 'https://chatgpt.com' },
    { url: `${sender.url}?forged=1` },
    { documentId: undefined },
    { documentLifecycle: 'prerender' },
    { frameId: 1 },
    { tab: { id: 7 } },
    { nativeApplication: 'fiction-app' },
  ])('rejects forged/content-script/native/inactive sender %j', (patch) => {
    expect(validatePanelSender({ ...sender, ...patch }, sender.id)).toBeNull();
  });
  it.each([
    { contextType: 'TAB' },
    { documentId: 'another-document' },
    { documentOrigin: 'https://chatgpt.com' },
    { documentUrl: `${sender.url}#forged` },
    { incognito: true },
    { tabId: 7 },
    { frameId: 1 },
    { windowId: -1 },
  ])('rejects stale/wrong/incognito panel contexts %j', (patch) => {
    expect(validatePanelContext({ ...context, ...patch }, sender.documentId, sender.id)).toBeNull();
  });
  it.each([
    { ...probe, frameId: 1 },
    { ...probe, documentId: 'another-document' },
    { ...probe, result: { origin: 'https://accounts.google.com', topLevel: true } },
    { ...probe, result: { origin: 'https://chatgpt.com', topLevel: false } },
    { ...probe, result: { ...probe.result, privateText: 'fiction only' } },
    null,
    [],
  ])('rejects redirects, wrong frames/documents and unexpected output', (input) => {
    expect(validateProbe('chatgpt', input, probe.documentId)).toBeNull();
  });
});

describe('bounded operation protocol', () => {
  it.each([
    { operation: 'fetch', requestId: 'fiction-request', url: 'https://chatgpt.com/' },
    { operation: 'search', provider: 'chatgpt', requestId: 'fiction-request', query: 'fiction' },
    { operation: 'connect', provider: 'chatgpt', requestId: 'fiction-request', headers: {} },
    { operation: 'connect', provider: 'chatgpt', requestId: 'fiction-request', body: {} },
    { operation: 'connect', provider: 'chatgpt', requestId: 'fiction-request', tabId: 7 },
    { operation: 'connect', provider: 'gemini', requestId: 'fiction-request' },
    { operation: 'connect', provider: 'chatgpt', requestId: 'x'.repeat(257) },
    { operation: 'inspect-context', provider: 'chatgpt', requestId: 'fiction-request' },
    { operation: 'cancel', requestId: 'fiction-request', executable: 'fiction' },
  ])('rejects unknown/unbounded operations or extra arguments', (input) => {
    expect(validate(AccessRequestSchema, input).ok).toBe(false);
  });
  it('rejects fake authenticated success and private content in replies', () => {
    expect(
      validate(AccessMessageSchema, {
        kind: 'reply',
        requestId: 'fiction-request',
        status: 'ready',
      }).ok,
    ).toBe(false);
    expect(
      validate(AccessMessageSchema, {
        kind: 'reply',
        requestId: 'fiction-request',
        status: 'unavailable',
        candidates: [],
      }).ok,
    ).toBe(false);
  });
});
