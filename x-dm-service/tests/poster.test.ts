/**
 * Tests for poster — dedupe, cadence floor, composition limits, failure modes.
 *
 * The properties under test are the ones that protect the account rather than
 * the ones that make a post succeed: a duplicate on a public timeline and a
 * burst of posts are both read as automation, and a suspended account costs
 * more than any traffic the poster wins.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('../src/db.js', () => ({
  getPool: () => ({ query }),
}));

vi.mock('../src/xClient.js', () => ({
  xFetch: vi.fn(),
}));

vi.mock('../src/botTokenStore.js', () => ({
  getBotUserToken: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  getConfig: () => ({}),
}));

const { publishPost, composePostBody, derivedDedupeKey, cadenceFloorMs, isPostingEnabled, MAX_POST_LENGTH } =
  await import('../src/poster.js');
const { xFetch } = await import('../src/xClient.js');
const { getBotUserToken } = await import('../src/botTokenStore.js');

const REQ = { campaign: 'barkley', body: 'Meet Barkley, our 3D studio guide.', targetUrl: 'https://pawsome3d.com/barkley' };

/** No prior post, and every write succeeds. */
function freshDb() {
  query.mockReset();
  query.mockResolvedValue([[], []]);
}

beforeEach(() => {
  freshDb();
  vi.mocked(xFetch).mockReset();
  vi.mocked(getBotUserToken).mockReset().mockResolvedValue('tok');
  process.env.X_POSTING_ENABLED = 'true';
  delete process.env.X_POST_MIN_INTERVAL_MS;
});

describe('composition', () => {
  it('appends the target URL so the card renders', () => {
    expect(composePostBody(REQ).text).toContain('https://pawsome3d.com/barkley');
  });

  it('does not append a URL the body already contains', () => {
    const body = 'Tour: https://pawsome3d.com/barkley';
    const out = composePostBody({ campaign: 'c', body, targetUrl: 'https://pawsome3d.com/barkley' });
    expect(out.text.match(/pawsome3d\.com\/barkley/g)).toHaveLength(1);
  });

  it('reports an over-length post instead of truncating it', () => {
    // Truncation would publish a sentence the operator never wrote, and can
    // cut the URL — removing the only reason the post exists.
    const out = composePostBody({ campaign: 'c', body: 'x'.repeat(MAX_POST_LENGTH + 5) });
    expect(out.error).toMatch(/limit is 280/);
  });

  it('rejects an empty body', () => {
    expect(composePostBody({ campaign: 'c', body: '   ' }).error).toMatch(/empty/);
  });
});

describe('dedupe key', () => {
  it('is stable for identical content', () => {
    expect(derivedDedupeKey(REQ)).toBe(derivedDedupeKey({ ...REQ }));
  });

  it('changes when the body changes', () => {
    expect(derivedDedupeKey(REQ)).not.toBe(derivedDedupeKey({ ...REQ, body: 'different' }));
  });

  it('honours an explicit key', () => {
    expect(derivedDedupeKey({ ...REQ, dedupeKey: 'slot-2026-08-21' })).toBe('slot-2026-08-21');
  });
});

describe('guards', () => {
  it('does not post when disabled, and says why', async () => {
    process.env.X_POSTING_ENABLED = 'false';
    const out = await publishPost(REQ);
    expect(out.status).toBe('skipped');
    expect(vi.mocked(xFetch)).not.toHaveBeenCalled();
  });

  it('does not repost something already public', async () => {
    query.mockReset();
    query.mockResolvedValueOnce([[{ 1: 1 }], []]); // alreadyPosted -> true
    const out = await publishPost(REQ);
    expect(out).toMatchObject({ status: 'skipped', reason: 'already posted' });
    expect(vi.mocked(xFetch)).not.toHaveBeenCalled();
  });

  it('holds to the cadence floor, measured from the database not a timer', async () => {
    // An in-memory timer resets on restart; a scheduler that restarts often
    // would post every time it came up.
    query.mockReset();
    query.mockResolvedValueOnce([[], []]);                                   // not already posted
    query.mockResolvedValueOnce([[{ ms: Date.now() - 60_000 }], []]);        // posted a minute ago
    query.mockResolvedValue([[], []]);
    const out = await publishPost(REQ);
    expect(out.status).toBe('skipped');
    expect(out.reason).toMatch(/cadence floor/);
    expect(vi.mocked(xFetch)).not.toHaveBeenCalled();
  });

  it('posts once the floor has elapsed', async () => {
    query.mockReset();
    query.mockResolvedValueOnce([[], []]);
    query.mockResolvedValueOnce([[{ ms: Date.now() - 7 * 60 * 60 * 1000 }], []]);
    query.mockResolvedValue([[], []]);
    vi.mocked(xFetch).mockResolvedValue(
      new Response(JSON.stringify({ data: { id: '1861' } }), { status: 201 }),
    );
    const out = await publishPost(REQ);
    expect(out).toMatchObject({ status: 'posted', tweetId: '1861' });
  });

  it('defaults the floor to six hours and accepts an override', () => {
    expect(cadenceFloorMs({})).toBe(6 * 60 * 60 * 1000);
    expect(cadenceFloorMs({ X_POST_MIN_INTERVAL_MS: '900000' })).toBe(900_000);
    expect(cadenceFloorMs({ X_POST_MIN_INTERVAL_MS: 'abc' })).toBe(6 * 60 * 60 * 1000);
  });

  it('treats only the exact string "true" as enabled', () => {
    expect(isPostingEnabled({ X_POSTING_ENABLED: 'true' })).toBe(true);
    expect(isPostingEnabled({ X_POSTING_ENABLED: 'TRUE ' })).toBe(true);
    expect(isPostingEnabled({ X_POSTING_ENABLED: '1' })).toBe(false);
    expect(isPostingEnabled({})).toBe(false);
  });
});

describe('failures', () => {
  it('keeps X\'s response body — it is what separates a scope error from a bad post', async () => {
    vi.mocked(xFetch).mockResolvedValue(
      new Response('{"detail":"oauth2 scope tweet.write required"}', { status: 403 }),
    );
    const out = await publishPost(REQ);
    expect(out.status).toBe('failed');
    expect(out.reason).toMatch(/tweet\.write/);
  });

  it('does not report success when X returns no id', async () => {
    vi.mocked(xFetch).mockResolvedValue(new Response('{"data":{}}', { status: 201 }));
    const out = await publishPost(REQ);
    expect(out.status).toBe('failed');
    expect(out.reason).toMatch(/no id/);
  });

  it('fails cleanly when no token is available rather than throwing', async () => {
    // A scheduler that crashes on a missing token stops running entirely.
    vi.mocked(getBotUserToken).mockRejectedValue(new Error('refresh failed'));
    const out = await publishPost(REQ);
    expect(out.status).toBe('failed');
    expect(out.reason).toMatch(/refresh failed/);
  });

  it('surfaces a transport error without throwing', async () => {
    vi.mocked(xFetch).mockRejectedValue(new Error('socket hang up'));
    const out = await publishPost(REQ);
    expect(out.status).toBe('failed');
    expect(out.reason).toMatch(/socket hang up/);
  });
});
