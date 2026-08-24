/**
 * Post content for the scheduled poster.
 *
 * Content lives here rather than in the scheduler because the scheduler should
 * decide *when*, never *what*. Keeping the copy in one reviewable place means
 * a change to what the account says is a code review, not a config edit — and
 * on a public timeline that distinction matters.
 *
 * Variants exist so a daily cadence does not repeat the same sentence. The
 * poster's dedupe key is derived from the body, so a variant that has already
 * gone out is skipped automatically; selection just has to prefer one that has
 * not.
 */

export interface Campaign {
  id: string;
  /** Where the post sends people. Appended by the poster if absent. */
  targetUrl: string;
  /**
   * Rotated in order, skipping any already posted. Each must leave room for
   * the URL: X counts a link as 23 characters regardless of its real length.
   */
  variants: string[];
}

/** X counts every link as this many characters, whatever its actual length. */
export const X_LINK_WEIGHT = 23;

export const CAMPAIGNS: Record<string, Campaign> = {
  barkley: {
    id: "barkley",
    // UTM-tagged so the visit is attributable. Without tags an X click is
    // indistinguishable from direct traffic once the referrer is stripped,
    // which many clients do -- and the whole point of the post is knowing
    // whether anyone arrived.
    targetUrl: "https://pawsome3d.com/barkley?utm_source=x&utm_medium=social&utm_campaign=barkley",
    variants: [
      "Meet Barkley — he'll walk you through how a single pet photo becomes a 3D model you can print, animate, or stand in your living room.",
      "Ever wondered how a photo of your dog turns into a 3D model? Barkley gives the tour, in 3D, in about two minutes.",
      "New: a guided tour of the Pawsome3D studio, presented by Barkley himself. No signup, no card — just how it works.",
      "One photo in, a textured and rigged 3D pet out. Barkley explains each step, and you can rotate him while he does it.",
      "What is a GLB file, and why does your pet need one? Barkley answers that better than a docs page could.",
    ],
  },
};

/**
 * Longest body a campaign can carry, given its URL.
 *
 * The poster refuses over-length posts rather than truncating, so a variant
 * that is too long fails at publish time. Exposing the budget here lets a test
 * catch it at review time instead.
 */
export function bodyBudget(limit = 280): number {
  // The URL and the space before it.
  return limit - (X_LINK_WEIGHT + 1);
}

export function getCampaign(id: string): Campaign | null {
  return CAMPAIGNS[id] ?? null;
}

/**
 * Choose the next variant, preferring one that has not been posted.
 *
 * `postedBodies` is what the caller has already published for this campaign.
 * Falling back to the least-recently-used variant when every one has run means
 * a long-lived campaign keeps cycling rather than going silent — silence and
 * exhaustion look identical from outside, and only one of them is intended.
 */
export function selectVariant(
  campaign: Campaign,
  postedBodies: readonly string[],
): { body: string; exhausted: boolean } {
  const posted = new Set(postedBodies.map((b) => b.trim()));
  const fresh = campaign.variants.find((v) => !posted.has(v.trim()));
  if (fresh) return { body: fresh, exhausted: false };

  // Every variant has run. Re-use the one that ran longest ago: postedBodies
  // arrives newest-first, so the last match is the oldest.
  const oldest = [...campaign.variants]
    .sort((a, b) => postedBodies.lastIndexOf(b) - postedBodies.lastIndexOf(a))[0];
  return { body: oldest ?? campaign.variants[0], exhausted: true };
}
