/**
 * Outbound posting for the bot account.
 *
 * This exists to drive traffic to Pawsome3D surfaces — principally the Barkley
 * tour at /barkley, which serves a summary_large_image card — using the same
 * OAuth credentials the DM service already holds.
 *
 * It deliberately does only one thing: publish a post the operator configured.
 * It does not follow, like, reply to strangers, or scrape. Those are the
 * behaviours X's automation rules treat as platform manipulation, and a
 * suspended account costs more than any traffic they would win.
 *
 * Three properties matter more than throughput here:
 *
 *   Idempotence. A scheduler restarts, retries and overlaps. Every one of
 *   those is a duplicate on a public timeline without a durable record, and
 *   duplicates are the most visible failure mode there is. Every post carries
 *   a dedupe key checked against x_posts before anything is sent.
 *
 *   A cadence floor. Even correct posts, too close together, read as
 *   automation. The floor is enforced against the last posted row rather than
 *   an in-memory timer, so a restart cannot reset it.
 *
 *   Refusing to guess. If the token is missing or posting is disabled, the
 *   attempt is recorded as skipped with a reason. Silence that leaves no trace
 *   is indistinguishable from a broken scheduler.
 */
import crypto from 'node:crypto';
import { getPool } from './db.js';
import { getBotUserToken } from './botTokenStore.js';
import { xFetch } from './xClient.js';

/** X's hard limit for a standard post. */
export const MAX_POST_LENGTH = 280;

export type PostOutcome =
  | { status: 'posted'; tweetId: string; dedupeKey: string }
  | { status: 'skipped'; reason: string; dedupeKey: string }
  | { status: 'failed'; reason: string; dedupeKey: string };

export interface PostRequest {
  /** Groups related posts and scopes the cadence floor. */
  campaign: string;
  body: string;
  /** Appended if not already present, so the card renders. */
  targetUrl?: string;
  /**
   * Stable identity for "this exact post". Defaults to a hash of campaign +
   * body + url, so re-running an unchanged scheduled slot is a no-op.
   */
  dedupeKey?: string;
}

export function derivedDedupeKey(req: PostRequest): string {
  if (req.dedupeKey) return req.dedupeKey.slice(0, 191);
  const digest = crypto
    .createHash('sha256')
    .update(`${req.campaign}\n${req.body.trim()}\n${req.targetUrl ?? ''}`)
    .digest('hex');
  return `${req.campaign}:${digest.slice(0, 32)}`;
}

/** Appends the URL when absent, and reports rather than silently truncating. */
export function composePostBody(req: PostRequest): { text: string; error?: string } {
  const base = req.body.trim();
  if (!base) return { text: '', error: 'post body is empty' };

  const text = req.targetUrl && !base.includes(req.targetUrl)
    ? `${base} ${req.targetUrl}`
    : base;

  if (text.length > MAX_POST_LENGTH) {
    // Truncating would publish a sentence the operator did not write, and can
    // cut the URL — which removes the only reason the post exists.
    return { text, error: `post is ${text.length} characters, limit is ${MAX_POST_LENGTH}` };
  }
  return { text };
}

export function isPostingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.X_POSTING_ENABLED || '').trim().toLowerCase() === 'true';
}

/** Minimum gap between posts in one campaign. Default 6h. */
export function cadenceFloorMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.X_POST_MIN_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 6 * 60 * 60 * 1000;
}

async function alreadyPosted(dedupeKey: string): Promise<boolean> {
  const [rows]: any = await getPool().query(
    'SELECT 1 FROM x_posts WHERE dedupe_key = ? AND status = ? LIMIT 1',
    [dedupeKey, 'posted'],
  );
  return (rows as any[]).length > 0;
}

/** Milliseconds since this campaign last posted, or null if it never has. */
export async function msSinceLastPost(campaign: string): Promise<number | null> {
  const [rows]: any = await getPool().query(
    `SELECT UNIX_TIMESTAMP(created_at) * 1000 AS ms
       FROM x_posts
      WHERE campaign = ? AND status = 'posted'
      ORDER BY created_at DESC
      LIMIT 1`,
    [campaign],
  );
  const arr = rows as any[];
  if (!arr.length) return null;
  return Date.now() - Number(arr[0].ms);
}

async function record(
  req: PostRequest,
  dedupeKey: string,
  status: 'posted' | 'skipped' | 'failed',
  detail: { tweetId?: string; error?: string },
): Promise<void> {
  // A recording failure must not be reported as a posting failure: the post
  // may already be public. Log and move on.
  try {
    await getPool().query(
      `INSERT INTO x_posts (dedupe_key, campaign, body, target_url, status, x_tweet_id, error_detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), x_tweet_id = VALUES(x_tweet_id),
                               error_detail = VALUES(error_detail)`,
      [dedupeKey, req.campaign, req.body, req.targetUrl ?? null, status, detail.tweetId ?? null, detail.error ?? null],
    );
  } catch (err: any) {
    console.error(`[Poster] could not record ${status} for ${dedupeKey}: ${err?.message || err}`);
  }
}

/**
 * Publish one post, or explain why it was not published.
 *
 * Never throws for an expected condition — a scheduler that crashes on a
 * disabled flag stops running entirely.
 */
export async function publishPost(req: PostRequest): Promise<PostOutcome> {
  const dedupeKey = derivedDedupeKey(req);

  const composed = composePostBody(req);
  if (composed.error) {
    await record(req, dedupeKey, 'failed', { error: composed.error });
    return { status: 'failed', reason: composed.error, dedupeKey };
  }

  if (!isPostingEnabled()) {
    await record(req, dedupeKey, 'skipped', { error: 'X_POSTING_ENABLED is not true' });
    return { status: 'skipped', reason: 'posting disabled', dedupeKey };
  }

  // Dedupe before cadence: a repeat of something already public is not a
  // cadence problem, and should read as a no-op rather than a throttle.
  if (await alreadyPosted(dedupeKey)) {
    return { status: 'skipped', reason: 'already posted', dedupeKey };
  }

  const since = await msSinceLastPost(req.campaign);
  const floor = cadenceFloorMs();
  if (since !== null && since < floor) {
    const wait = Math.ceil((floor - since) / 60000);
    await record(req, dedupeKey, 'skipped', { error: `cadence floor: ${wait} minute(s) remaining` });
    return { status: 'skipped', reason: `cadence floor, ${wait} minute(s) remaining`, dedupeKey };
  }

  let token: string;
  try {
    token = await getBotUserToken();
  } catch (err: any) {
    const reason = `no usable bot token: ${err?.message || err}`;
    await record(req, dedupeKey, 'failed', { error: reason });
    return { status: 'failed', reason, dedupeKey };
  }
  if (!token) {
    const reason = 'bot token is empty';
    await record(req, dedupeKey, 'failed', { error: reason });
    return { status: 'failed', reason, dedupeKey };
  }

  try {
    const resp = await xFetch('https://api.x.com/2/tweets', {
      method: 'POST',
      token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: composed.text }),
    });
    const raw = await resp.text();

    if (!resp.ok) {
      // 403 here is usually the app lacking write scope rather than a bad
      // post, so keep the body: it is the only thing that distinguishes them.
      const reason = `X rejected the post (${resp.status}): ${raw.slice(0, 300)}`;
      await record(req, dedupeKey, 'failed', { error: reason });
      return { status: 'failed', reason, dedupeKey };
    }

    let tweetId = '';
    try {
      tweetId = JSON.parse(raw)?.data?.id ?? '';
    } catch {
      /* fall through to the empty-id check */
    }
    if (!tweetId) {
      const reason = `X accepted the post but returned no id: ${raw.slice(0, 200)}`;
      await record(req, dedupeKey, 'failed', { error: reason });
      return { status: 'failed', reason, dedupeKey };
    }

    await record(req, dedupeKey, 'posted', { tweetId });
    console.log(`[Poster] posted ${tweetId} for campaign ${req.campaign}`);
    return { status: 'posted', tweetId, dedupeKey };
  } catch (err: any) {
    const reason = `post request failed: ${err?.message || err}`;
    await record(req, dedupeKey, 'failed', { error: reason });
    return { status: 'failed', reason, dedupeKey };
  }
}
