/**
 * Tests for campaigns — rotation, and copy that fits before it is published.
 *
 * The poster refuses an over-length post rather than truncating, so a variant
 * that is too long fails at publish time on a live schedule. Catching it here
 * turns a silent missed slot into a failing test at review.
 */
import { describe, it, expect } from 'vitest';
import { CAMPAIGNS, X_LINK_WEIGHT, bodyBudget, getCampaign, selectVariant } from '../src/campaigns.js';
import { MAX_POST_LENGTH, composePostBody } from '../src/poster.js';

describe('campaign copy', () => {
  it('every variant fits once X counts the link', () => {
    // X counts any link as 23 characters regardless of its real length, so
    // measuring the literal string would pass copy that X then rejects.
    const budget = bodyBudget(MAX_POST_LENGTH);
    for (const campaign of Object.values(CAMPAIGNS)) {
      for (const variant of campaign.variants) {
        expect(
          variant.length,
          `"${variant.slice(0, 40)}…" is ${variant.length} chars, budget is ${budget}`,
        ).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('composes to something the poster will accept', () => {
    // The real check: run each variant through the poster's own composer.
    for (const campaign of Object.values(CAMPAIGNS)) {
      for (const body of campaign.variants) {
        const out = composePostBody({ campaign: campaign.id, body, targetUrl: campaign.targetUrl });
        expect(out.error, `${campaign.id}: ${out.error}`).toBeUndefined();
        expect(out.text).toContain(campaign.targetUrl);
      }
    }
  });

  it('reserves the link weight in the budget', () => {
    expect(bodyBudget(MAX_POST_LENGTH)).toBe(MAX_POST_LENGTH - (X_LINK_WEIGHT + 1));
  });

  it('every campaign has a https target and at least two variants', () => {
    for (const c of Object.values(CAMPAIGNS)) {
      expect(c.targetUrl).toMatch(/^https:\/\//);
      // One variant means a daily schedule repeats the same sentence forever,
      // which is the shape automated accounts get flagged for.
      expect(c.variants.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('has no duplicate variants — a duplicate silently loses a slot', () => {
    for (const c of Object.values(CAMPAIGNS)) {
      // The poster dedupes on body, so two identical variants would mean the
      // rotation quietly runs one short.
      expect(new Set(c.variants.map((v) => v.trim())).size).toBe(c.variants.length);
    }
  });
});

describe('variant selection', () => {
  const c = CAMPAIGNS.barkley;

  it('returns an unposted variant first', () => {
    const { body, exhausted } = selectVariant(c, [c.variants[0]]);
    expect(body).not.toBe(c.variants[0]);
    expect(exhausted).toBe(false);
  });

  it('walks the whole rotation before repeating', () => {
    const posted: string[] = [];
    for (let i = 0; i < c.variants.length; i++) {
      const { body, exhausted } = selectVariant(c, posted);
      expect(exhausted).toBe(false);
      expect(posted).not.toContain(body);
      posted.unshift(body);
    }
    expect(new Set(posted).size).toBe(c.variants.length);
  });

  it('recycles rather than going silent once every variant has run', () => {
    // Silence and exhaustion look identical from outside, and only one of them
    // is intended.
    const posted = [...c.variants].reverse();
    const { body, exhausted } = selectVariant(c, posted);
    expect(exhausted).toBe(true);
    expect(c.variants).toContain(body);
  });

  it('recycles the least recently used variant', () => {
    // postedBodies arrives newest-first, so the oldest is the one to reuse.
    const posted = [c.variants[2], c.variants[1], c.variants[0]];
    const all = [c.variants[0], c.variants[1], c.variants[2]];
    const { body } = selectVariant({ ...c, variants: all }, posted);
    expect(body).toBe(c.variants[0]);
  });

  it('survives an empty history', () => {
    const { body, exhausted } = selectVariant(c, []);
    expect(body).toBe(c.variants[0]);
    expect(exhausted).toBe(false);
  });
});

describe('lookup', () => {
  it('returns null for an unknown campaign rather than a default', () => {
    // Falling back to a default would post the wrong campaign's copy.
    expect(getCampaign('nope')).toBeNull();
    expect(getCampaign('barkley')?.id).toBe('barkley');
  });
});
