/**
 * Scheduled-post endpoint.
 *
 * Mirrors the Pawprints catalog sync in the main app: a scheduled cloud
 * routine sends `Authorization: Bearer $X_POST_SCHEDULER_SECRET` and the
 * server does the work. Same shape on purpose — one auth pattern for
 * scheduled routines is one pattern to get right.
 *
 * The endpoint chooses the variant and calls the poster; it never decides
 * whether the cadence allows a post. That belongs in the poster, where it is
 * measured against the database, so a second scheduler or a manual trigger
 * cannot bypass it.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db.js';
import { CAMPAIGNS, getCampaign, selectVariant } from '../campaigns.js';
import { publishPost } from '../poster.js';

/**
 * Constant-time comparison so a wrong guess cannot be narrowed by timing.
 * Length is compared first because timingSafeEqual throws on a mismatch.
 */
function secretMatches(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Bodies already published for a campaign, newest first. */
async function postedBodies(campaign: string): Promise<string[]> {
  const [rows]: any = await getPool().query(
    `SELECT body FROM x_posts
      WHERE campaign = ? AND status = 'posted'
      ORDER BY created_at DESC
      LIMIT 50`,
    [campaign],
  );
  return (rows as any[]).map((r) => String(r.body));
}

export function createSchedulerRouter(): Router {
  const router = Router();

  router.post('/post', async (req: Request, res: Response) => {
    const expected = String(process.env.X_POST_SCHEDULER_SECRET || '').trim();
    if (!expected) {
      // Refuse rather than run unauthenticated. An endpoint that publishes to
      // a public timeline must never be reachable without a credential.
      console.error('[Scheduler] X_POST_SCHEDULER_SECRET is not set — refusing');
      return res.status(503).json({ error: 'Scheduled posting is not configured.' });
    }

    const header = String(req.headers.authorization || '');
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!secretMatches(bearer, expected)) {
      console.warn('[Scheduler] POST /admin/post rejected — bad or missing bearer');
      return res.status(401).json({ error: 'Scheduler authorization is required.' });
    }

    const campaignId = String((req.body as any)?.campaign || 'barkley');
    const campaign = getCampaign(campaignId);
    if (!campaign) {
      return res.status(400).json({
        error: `Unknown campaign "${campaignId}".`,
        known: Object.keys(CAMPAIGNS),
      });
    }

    try {
      const already = await postedBodies(campaign.id);
      const { body, exhausted } = selectVariant(campaign, already);

      const outcome = await publishPost({
        campaign: campaign.id,
        body,
        targetUrl: campaign.targetUrl,
      });

      // 200 for every decided outcome, including "skipped". A scheduler that
      // sees a non-2xx will retry, and retrying a cadence hold is exactly the
      // burst the hold exists to prevent.
      return res.json({
        campaign: campaign.id,
        variantsExhausted: exhausted,
        variantCount: campaign.variants.length,
        postedCount: already.length,
        ...outcome,
      });
    } catch (err: any) {
      console.error('[Scheduler] post failed:', err?.message || err);
      return res.status(500).json({ error: 'Scheduled post failed.', detail: String(err?.message || err).slice(0, 200) });
    }
  });

  /** Read-only view so a routine can verify without publishing. */
  router.get('/post/status', async (req: Request, res: Response) => {
    const expected = String(process.env.X_POST_SCHEDULER_SECRET || '').trim();
    const header = String(req.headers.authorization || '');
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!expected || !secretMatches(bearer, expected)) {
      return res.status(401).json({ error: 'Scheduler authorization is required.' });
    }
    try {
      const [rows]: any = await getPool().query(
        `SELECT campaign, status, x_tweet_id, created_at
           FROM x_posts ORDER BY created_at DESC LIMIT 10`,
      );
      res.json({
        postingEnabled: String(process.env.X_POSTING_ENABLED || '').trim().toLowerCase() === 'true',
        campaigns: Object.keys(CAMPAIGNS),
        recent: rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || err).slice(0, 200) });
    }
  });

  return router;
}
