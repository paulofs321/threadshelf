import * as v from 'valibot';
import { boundedText, CountSchema } from '../contracts/primitives';
import { validate } from '../contracts/validation';
import type { ProviderId } from '../contracts/primitives';
import { accessPortName, panelPortName } from './protocol';

// Candidate origins only; these constants do not establish provider/session support.
export const providerOrigins: Record<ProviderId, string> = {
  chatgpt: 'https://chatgpt.com',
  'google-ai-mode': 'https://www.google.com',
};

export function providerPermission(provider: ProviderId) {
  return { permissions: ['scripting' as const], origins: [`${providerOrigins[provider]}/*`] };
}

export function permittedUrl(provider: ProviderId, value: string): boolean {
  if (value.length > 2048) return false;

  try {
    const url = new URL(value);

    return (
      url.href === value &&
      url.origin === providerOrigins[provider] &&
      url.username === '' &&
      url.password === '' &&
      url.port === ''
    );
  } catch {
    return false;
  }
}

const DocumentIdSchema = boundedText(128);
export const PanelWindowSchema = v.object({ id: CountSchema, incognito: v.literal(false) });

export function panelWindowId(name: string): number | null {
  const prefix = `${accessPortName}:window:`;

  if (name.length > 128 || !name.startsWith(prefix)) return null;

  const windowId = Number(name.slice(prefix.length));

  return validate(CountSchema, windowId).ok && name === panelPortName(windowId) ? windowId : null;
}

export const SelectedTabSchema = v.strictObject({
  id: CountSchema,
  windowId: CountSchema,
  active: v.boolean(),
  incognito: v.literal(false),
  status: v.literal('complete'),
  url: boundedText(2048),
});
export type SelectedTab = v.InferOutput<typeof SelectedTabSchema>;

const ProbeSchema = v.strictObject({
  documentId: DocumentIdSchema,
  frameId: v.literal(0),
  result: v.strictObject({ origin: boundedText(256), topLevel: v.literal(true) }),
});

export function validateProbe(provider: ProviderId, input: unknown, documentId?: string) {
  const result = validate(ProbeSchema, input);

  if (
    !result.ok ||
    result.value.result.origin !== providerOrigins[provider] ||
    (documentId !== undefined && documentId !== result.value.documentId)
  ) {
    return null;
  }

  return result.value.documentId;
}

// Only extension-owned side panels may connect. Chrome supplies this metadata; messages cannot.
const PanelSenderSchema = v.object({
  id: boundedText(128),
  url: boundedText(256),
  origin: boundedText(256),
  documentId: DocumentIdSchema,
  documentLifecycle: v.literal('active'),
  frameId: v.optional(v.literal(0)),
  tab: v.optional(v.never()),
  nativeApplication: v.optional(v.never()),
});

const PanelSourceSchema = v.object({
  ...PanelSenderSchema.entries,
  documentId: v.optional(DocumentIdSchema),
  documentLifecycle: v.optional(v.literal('active')),
});

// Chrome can omit document metadata on extension-owned connections. Resolve it independently.
export function validatePanelSource(input: unknown, extensionId: string) {
  const result = validate(PanelSourceSchema, input);
  const origin = `chrome-extension://${extensionId}`;

  return result.ok &&
    result.value.id === extensionId &&
    result.value.origin === origin &&
    result.value.url === `${origin}/sidepanel.html`
    ? result.value
    : null;
}

export function validatePanelSender(input: unknown, extensionId: string) {
  const result = validate(PanelSenderSchema, input);
  const origin = `chrome-extension://${extensionId}`;

  return result.ok &&
    result.value.id === extensionId &&
    result.value.origin === origin &&
    result.value.url === `${origin}/sidepanel.html`
    ? result.value.documentId
    : null;
}

const PanelContextSchema = v.object({
  contextType: v.literal('SIDE_PANEL'),
  documentId: DocumentIdSchema,
  documentOrigin: boundedText(256),
  documentUrl: boundedText(256),
  incognito: v.literal(false),
  tabId: v.literal(-1),
  frameId: v.picklist([-1, 0]),
  // Global side panels currently report -1; this metadata does not identify their window.
  windowId: v.union([v.literal(-1), CountSchema]),
});

export function validatePanelContext(
  input: unknown,
  documentId: string,
  extensionId: string,
  windowId: number,
): boolean {
  const result = validate(PanelContextSchema, input);
  const origin = `chrome-extension://${extensionId}`;

  return (
    result.ok &&
    result.value.documentId === documentId &&
    result.value.documentOrigin === origin &&
    result.value.documentUrl === `${origin}/sidepanel.html` &&
    (result.value.windowId === -1 || result.value.windowId === windowId)
  );
}
