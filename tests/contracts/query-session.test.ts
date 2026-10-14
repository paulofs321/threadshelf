import { describe, expect, it } from 'vitest';
import {
  DateRangeSchema,
  limits,
  ProviderRequestSchema,
  QuerySchema,
  requireValid,
  sameScope,
  scopeKey,
  SearchRequestSchema,
  SessionOutcomeSchema,
  SessionScopeSchema,
  validate,
} from '../../src/contracts';
import {
  chatRequest,
  chatScope,
  ephemeralScope,
  googleScope,
  request,
} from '../fixtures/contracts';

describe('query and date validation', () => {
  it('normalizes surrounding whitespace without changing the user query', () => {
    const result = validate(QuerySchema, { ...request.query, text: '  floating library  ' });
    expect(result.ok && result.value.text).toBe('floating library');
  });

  it.each([null, undefined, 42, {}, '', '  \n\t', 'a\u0000b', 'a'.repeat(limits.query + 1)])(
    'rejects malformed or oversized query text %#',
    (text) => expect(validate(QuerySchema, { ...request.query, text }).ok).toBe(false),
  );

  it('bounds the original input before trimming and accepts the exact limit', () => {
    expect(validate(QuerySchema, { ...request.query, text: 'a'.repeat(limits.query) }).ok).toBe(
      true,
    );
    expect(
      validate(QuerySchema, { ...request.query, text: `${' '.repeat(limits.query)}a` }).ok,
    ).toBe(false);
  });

  it.each([
    { providers: [] },
    { providers: ['chatgpt', 'chatgpt'] },
    { providers: ['gemini'] },
    { providers: ['chatgpt', 'google-ai-mode', 'chatgpt'] },
    { mode: 'execute' },
    { timeZone: 'Fictional/Cloud-City' },
    { endpoint: 'https://example.invalid/' },
    { dateRange: undefined },
  ])('rejects unknown operations/providers/options %#', (changes) => {
    expect(validate(QuerySchema, { ...request.query, ...changes }).ok).toBe(false);
  });

  it('accepts a canonical half-open interval', () => {
    expect(
      validate(DateRangeSchema, {
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-10-01T00:00:00.000Z',
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    ['2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    ['2026-02-30T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
    ['2026-09-01', '2026-10-01T00:00:00.000Z'],
    ['2026-09-01T00:00:00.000+02:00', '2026-10-01T00:00:00.000Z'],
  ])('rejects invalid/ambiguous intervals %#', (start, end) => {
    expect(validate(DateRangeSchema, { start, end }).ok).toBe(false);
  });

  it('does not return input or detailed validator issues on failure', () => {
    expect(validate(QuerySchema, { text: 'fictional private-like text' })).toEqual({
      ok: false,
      code: 'invalid-contract',
    });
    expect(() => requireValid(QuerySchema, {})).toThrow('Invalid contract context.');
  });

  it('contains exceptions from hostile boundary objects without exposing their text', () => {
    const input = { ...request.query };
    Object.defineProperty(input, 'text', {
      get: () => {
        throw new Error('fictional private-like exception text');
      },
    });
    expect(validate(QuerySchema, input)).toEqual({ ok: false, code: 'invalid-contract' });
  });
});

describe('session scope and request invariants', () => {
  it('distinguishes verified identity, absent workspace and ephemeral identity', () => {
    expect(validate(SessionScopeSchema, chatScope).ok).toBe(true);
    expect(validate(SessionScopeSchema, googleScope).ok).toBe(true);
    expect(validate(SessionScopeSchema, ephemeralScope).ok).toBe(true);
    expect(validate(SessionScopeSchema, { ...chatScope, workspacePartition: undefined }).ok).toBe(
      false,
    );
    expect(
      validate(SessionScopeSchema, { ...ephemeralScope, accountPartition: 'guessed-title' }).ok,
    ).toBe(false);
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'rejects unsafe generations %#',
    (generation) =>
      expect(validate(SessionScopeSchema, { ...chatScope, generation }).ok).toBe(false),
  );

  it.each(['', ' padded', 'control\u0000', 'x'.repeat(limits.id + 1)])(
    'rejects malformed IDs %#',
    (accountPartition) => {
      expect(validate(SessionScopeSchema, { ...chatScope, accountPartition }).ok).toBe(false);
    },
  );

  it('compares the complete account/workspace/generation identity', () => {
    const variants = [
      { ...chatScope, generation: 2 },
      requireValid(SessionScopeSchema, {
        ...chatScope,
        accountPartition: 'fictional-other-account',
      }),
      requireValid(SessionScopeSchema, {
        ...chatScope,
        workspacePartition: 'fictional-other-workspace',
      }),
      googleScope,
      ephemeralScope,
    ];
    expect(sameScope(chatScope, { ...chatScope })).toBe(true);
    variants.forEach((scope) => expect(sameScope(chatScope, scope)).toBe(false));
  });

  it('encodes opaque IDs without delimiter collisions', () => {
    const left = requireValid(SessionScopeSchema, {
      ...chatScope,
      accountPartition: 'a:b',
      workspacePartition: 'c',
    });
    const right = requireValid(SessionScopeSchema, {
      ...chatScope,
      accountPartition: 'a',
      workspacePartition: 'b:c',
    });
    expect(scopeKey(left)).not.toBe(scopeKey(right));
  });

  it.each([
    { scopes: [] },
    { scopes: [chatScope] },
    { scopes: [chatScope, chatScope] },
    { scopes: [chatScope, googleScope, ephemeralScope] },
  ])('requires exactly one scope for each selected provider %#', ({ scopes }) =>
    expect(validate(SearchRequestSchema, { ...request, scopes }).ok).toBe(false),
  );

  it('rejects provider dispatch outside the explicit selection', () => {
    expect(
      validate(ProviderRequestSchema, {
        ...chatRequest,
        query: { ...request.query, providers: ['google-ai-mode'] },
      }).ok,
    ).toBe(false);
  });

  it('keeps session failure distinct from a ready session', () => {
    expect(validate(SessionOutcomeSchema, { status: 'ready', scope: ephemeralScope }).ok).toBe(
      true,
    );
    expect(
      validate(SessionOutcomeSchema, {
        status: 'login-expired',
        provider: 'chatgpt',
        generation: 2,
      }).ok,
    ).toBe(true);
    expect(validate(SessionOutcomeSchema, { status: 'login-expired', scope: chatScope }).ok).toBe(
      false,
    );
  });
});
