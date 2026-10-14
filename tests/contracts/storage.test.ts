import { describe, expect, it } from 'vitest';
import {
  CacheEntrySchema,
  cacheEntrySchemaFor,
  CacheKeySchema,
  limits,
  validate,
} from '../../src/contracts';
import { chatCandidate, chatScope, ephemeralScope, linkVerifiers } from '../fixtures/contracts';

const entry = {
  key: { version: 1, scope: chatScope },
  candidate: chatCandidate,
  cachedAt: '2026-10-14T08:00:00.000Z',
  expiresAt: '2026-10-14T09:00:00.000Z',
};
const now = '2026-10-14T08:30:00.000Z';

describe('optional storage boundary contracts', () => {
  it('allows only versioned verified account/workspace/generation keys', () => {
    expect(validate(CacheKeySchema, entry.key).ok).toBe(true);
    expect(validate(CacheKeySchema, { version: 2, scope: chatScope }).ok).toBe(false);
    expect(validate(CacheKeySchema, { version: 1, scope: ephemeralScope }).ok).toBe(false);
    expect(
      validate(CacheKeySchema, { version: 1, scope: chatScope, credentials: 'fictional' }).ok,
    ).toBe(false);
  });

  it('validates a current entry without enabling persistence', () => {
    expect(validate(cacheEntrySchemaFor(chatScope, now, linkVerifiers), entry).ok).toBe(true);
  });

  it.each([
    { expiresAt: entry.cachedAt },
    { expiresAt: '2026-10-14T07:00:00.000Z' },
    { expiresAt: '2026-10-15T08:00:00.001Z' },
    { candidate: { ...chatCandidate, scope: { ...chatScope, generation: 2 } } },
    {
      key: {
        ...entry.key,
        scope: { ...chatScope, workspacePartition: 'fictional-other-workspace' },
      },
    },
  ])('rejects invalid lifetimes and mismatched partitions %#', (changes) => {
    expect(validate(CacheEntrySchema, { ...entry, ...changes }).ok).toBe(false);
  });

  it('bounds TTL at the exact limit', () => {
    const expiresAt = new Date(Date.parse(entry.cachedAt) + limits.cacheTtlMs).toISOString();
    expect(validate(CacheEntrySchema, { ...entry, expiresAt }).ok).toBe(true);
  });

  it('rejects obsolete generations, expired entries and future writes', () => {
    expect(
      validate(cacheEntrySchemaFor({ ...chatScope, generation: 2 }, now, linkVerifiers), entry).ok,
    ).toBe(false);
    expect(validate(cacheEntrySchemaFor(chatScope, entry.expiresAt, linkVerifiers), entry).ok).toBe(
      false,
    );
    expect(
      validate(cacheEntrySchemaFor(chatScope, '2026-10-14T07:00:00.000Z', linkVerifiers), entry).ok,
    ).toBe(false);
    expect(validate(cacheEntrySchemaFor(chatScope, now, {}), entry).ok).toBe(false);
  });
});
