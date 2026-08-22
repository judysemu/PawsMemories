/**
 * Cover the two changes of 2026-08-21: posting scope, and unrelated config
 * no longer blocking boot.
 *
 * Both were invisible failures rather than loud ones — a token that looked
 * healthy but could not publish, and a service that would not start because a
 * feature it wasn't using lacked credentials.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DM_SCOPES, POSTING_SCOPES, canPost } from '../src/xClient.js';
import { loadConfig } from '../src/config.js';

const BOOT_MINIMUM = {
  X_CLIENT_ID: 'id',
  X_CLIENT_SECRET: 'secret',
  X_CONSUMER_SECRET: 'consumer',
  X_BOT_USER_ID: '123',
  DB_HOST: 'h',
  DB_NAME: 'n',
  DB_USER: 'u',
  DB_PASSWORD: 'p',
};

describe('posting scope', () => {
  it('requests tweet.write — read alone cannot publish', () => {
    expect(DM_SCOPES.split(' ')).toContain('tweet.write');
  });

  it('keeps the DM scopes it already had', () => {
    for (const s of ['dm.read', 'dm.write', 'tweet.read', 'users.read', 'offline.access']) {
      expect(DM_SCOPES.split(' ')).toContain(s);
    }
  });

  it('reports an unrecorded scope as unknown, not as denied', () => {
    // Treating "never recorded" as "cannot post" would send someone
    // re-authorising a token that was fine.
    expect(canPost(null)).toBeNull();
    expect(canPost('')).toBeNull();
  });

  it('recognises a grant that can and cannot publish', () => {
    expect(canPost('dm.read dm.write tweet.read users.read')).toBe(false);
    expect(canPost('tweet.read tweet.write users.read')).toBe(true);
  });

  it('POSTING_SCOPES is a subset of what is requested', () => {
    for (const s of POSTING_SCOPES) expect(DM_SCOPES.split(' ')).toContain(s);
  });
});

describe('boot configuration', () => {
  // Validation failure calls process.exit(1) rather than throwing, so the
  // exit has to be intercepted to assert on it at all.
  afterEach(() => vi.restoreAllMocks());
  // loadConfig reads process.env directly, so the environment has to be
  // swapped rather than passed.
  function exitsOnLoad(env: Record<string, string>): boolean {
    const saved = process.env;
    process.env = { ...env } as any;
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('__exit__');
    }) as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      loadConfig();
      return false;
    } catch (e: any) {
      return e?.message === '__exit__';
    } finally {
      exit.mockRestore();
      process.env = saved;
    }
  }

  function loadWith(env: Record<string, string>) {
    const saved = process.env;
    process.env = { ...env } as any;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { return loadConfig(); } finally { process.env = saved; }
  }

  it('starts with only X credentials and a database', () => {
    // A posting-only deployment must not need Blender, an LLM or a bucket.
    expect(exitsOnLoad(BOOT_MINIMUM)).toBe(false);
  });

  it('still refuses to start without X credentials or a database', () => {
    for (const drop of ['X_CLIENT_ID', 'DB_HOST', 'DB_PASSWORD']) {
      const env: any = { ...BOOT_MINIMUM };
      delete env[drop];
      expect(exitsOnLoad(env), `${drop} must remain required`).toBe(true);
    }
  });

  it('boots without DM-refinement credentials', () => {
    // These were boot-required, so a migration or a scheduled post needed an
    // LLM key for a code path it never reaches.
    const cfg = loadWith(BOOT_MINIMUM);
    expect(cfg.LLM_API_KEY ?? '').toBe('');
    expect(cfg.BLENDER_WORKER_URL ?? '').toBe('');
  });
});
