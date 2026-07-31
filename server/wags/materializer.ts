import type { Pool } from "mysql2/promise";
import sharp from "sharp";

/**
 * BO-3 — Wags slot materializer.
 *
 * Turns the Gemini plan's 2D slots into REAL generated assets instead of
 * text-only collectible rows. Runs after admin approval (deliverBox creates
 * the box_items rows first with asset_status='pending'); the box flips to
 * 'delivered' only when every generative slot has a stored asset, so a
 * subscriber never opens a box with missing paid content.
 *
 * Design rules:
 *   1. Idempotent per (box_id, slot): a slot already 'generated' is never
 *      regenerated; a 'failed' slot regenerates independently on retry.
 *   2. Non-generative slots (accessory grants, credits, video/restyle
 *      coupons) are untouched — their entitlements were granted at delivery.
 *      The accessory/minimodel executor seam is `isGenerativeSlot`, so the
 *      BO-5 spatial-generator executor can claim those slots without schema
 *      changes.
 *   3. Every provider call is injected (MaterializerDeps) so tests run with
 *      fakes and assert zero unintended Gemini/storage calls.
 *   4. Stickers must actually be stickers: the PNG alpha gate rejects an
 *      opaque image rather than shipping a "transparent" sticker with a
 *      baked-in background.
 */

/** Slots whose deliverable is a generated 2D image asset. */
const GENERATIVE_2D_SLOTS = new Set([
  "sticker_1", "sticker_2", "sticker_3", "sticker_4", "sticker_5",
  "seasonal", "pawprint",
]);

/** Slots reserved for the BO-5 spatial-generator executor (3D). Not 2D-generative. */
const FUTURE_3D_SLOTS = new Set(["accessory", "accessory_2", "accessory_3", "minimodel"]);

export function isGenerativeSlot(slot: string): boolean {
  return GENERATIVE_2D_SLOTS.has(slot);
}

export function isFuture3dSlot(slot: string): boolean {
  return FUTURE_3D_SLOTS.has(slot);
}

export interface SlotPromptContext {
  species: string;
  breed: string | null;
  petName: string | null;
  season: string;
  theme: string;
}

export interface PlanItemLike {
  slot: string;
  title: string;
  description: string;
  colors?: string[];
  tags?: string[];
}

/**
 * Deterministic image prompt per slot. Stickers demand a transparent
 * background (verified afterward — the prompt alone is not trusted);
 * seasonal and pawprint produce full-bleed art.
 */
export function buildSlotPrompt(item: PlanItemLike, ctx: SlotPromptContext): string {
  const subject = ctx.petName
    ? `a ${ctx.breed || ctx.species} named ${ctx.petName}`
    : `a ${ctx.breed || ctx.species}`;
  const palette = item.colors?.length ? ` Palette: ${item.colors.join(", ")}.` : "";
  const base = `${item.title}. ${item.description}`.slice(0, 600);

  if (item.slot.startsWith("sticker_")) {
    return (
      `Die-cut sticker illustration of ${subject}: ${base}` +
      ` Bold clean vector-style linework, playful, expressive.${palette}` +
      ` The sticker shape must be fully isolated on a completely TRANSPARENT background` +
      ` (true alpha, no backdrop, no drop shadow outside the die-cut edge). 1024x1024.`
    );
  }
  if (item.slot === "seasonal") {
    return (
      `Collectible ${ctx.season} seasonal art card featuring ${subject}: ${base}` +
      ` Rich illustrated scene matching the "${ctx.theme}" theme.${palette}` +
      ` Full-bleed portrait composition, no text, no watermark.`
    );
  }
  // pawprint — themed greeting-card art piece featuring the pet.
  return (
    `Greeting-card art piece featuring ${subject}: ${base}` +
    ` Theme: "${ctx.theme}" (${ctx.season}).${palette}` +
    ` Elegant full-bleed portrait-orientation illustration suitable for printing,` +
    ` generous margins, no text, no watermark.`
  );
}

/**
 * PNG alpha gate for stickers. Rejects images with no alpha channel or with a
 * fully opaque alpha plane (a fake "transparent" background).
 */
export async function verifyStickerTransparency(
  pngBuffer: Buffer,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const image = sharp(pngBuffer);
    const metadata = await image.metadata();
    if (!metadata.hasAlpha) return { ok: false, reason: "STICKER_NO_ALPHA_CHANNEL" };
    const stats = await image.stats();
    const alpha = stats.channels[stats.channels.length - 1];
    if (!alpha || alpha.min >= 250) return { ok: false, reason: "STICKER_ALPHA_OPAQUE" };
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: `STICKER_DECODE_FAILED: ${String(err?.message || err).slice(0, 120)}` };
  }
}

export interface MaterializerDeps {
  /** Generate one image from a text prompt; returns a data URL or null. */
  generateImage(prompt: string, label: string): Promise<string | null>;
  /** Persist a data URL to durable storage; returns the public URL. */
  uploadImage(dataUrl: string): Promise<string>;
  /** Sticker alpha gate (injectable for tests; default is the sharp gate). */
  verifySticker?(pngBuffer: Buffer): Promise<{ ok: boolean; reason?: string }>;
}

export interface MaterializeResult {
  boxId: number;
  generated: number;
  failed: number;
  skipped: number;
  delivered: boolean;
}

interface BoxItemRow {
  id: number;
  slot: string;
  title: string;
  description: string;
  asset_status: string | null;
}

function dataUrlToPngBuffer(dataUrl: string): Buffer | null {
  const match = /^data:image\/(?:png|webp|jpeg);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

/**
 * Materialize every pending/failed generative slot of a box, then flip the
 * box to 'delivered' when no generative slot remains unfinished. Safe to call
 * repeatedly; each call touches only unfinished slots.
 */
export async function materializeBoxAssets(
  pool: Pool,
  deps: MaterializerDeps,
  boxId: number,
): Promise<MaterializeResult> {
  const verify = deps.verifySticker ?? verifyStickerTransparency;

  const [boxRows] = await pool.query(
    `SELECT b.id, b.status, b.plan_json, s.species, s.tier
     FROM wardrobe_wags_boxes b
     JOIN wardrobe_wags_subscriptions s ON s.id = b.subscription_id
     WHERE b.id = ? LIMIT 1`,
    [boxId],
  ) as any;
  const box = boxRows?.[0];
  if (!box) throw new Error(`Box ${boxId} not found.`);
  if (!["approved", "delivered", "delivered_flagged"].includes(String(box.status))) {
    throw new Error(`Box ${boxId} is not approved (status=${box.status}).`);
  }

  const plan = box.plan_json
    ? (typeof box.plan_json === "string" ? JSON.parse(box.plan_json) : box.plan_json)
    : null;
  const planItems: PlanItemLike[] = Array.isArray(plan?.items) ? plan.items : [];
  const ctx: SlotPromptContext = {
    species: String(box.species || "dog"),
    breed: plan?.pet_breed ?? null,
    petName: plan?.pet_name ?? null,
    season: String(plan?.season || "current season"),
    theme: String(plan?.theme || "monthly surprise"),
  };

  const [itemRows] = await pool.query(
    `SELECT id, slot, title, description, asset_status
     FROM wardrobe_wags_box_items WHERE box_id = ? ORDER BY id`,
    [boxId],
  ) as any;
  const items: BoxItemRow[] = itemRows || [];
  if (items.length === 0) throw new Error(`Box ${boxId} has no delivered items to materialize.`);

  const unfinishedGenerativeItems = items.filter(
    (item) => isGenerativeSlot(item.slot) && item.asset_status !== "generated",
  );
  if (String(box.tier) === "plus" && unfinishedGenerativeItems.length > 0) {
    throw new Error(
      "WAGS_PLUS_IMAGE_BUDGET_ATOMICITY_REQUIRED: Plus asset generation remains disabled until all seven image calls can be reserved atomically.",
    );
  }

  let generated = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of items) {
    if (!isGenerativeSlot(item.slot)) { skipped += 1; continue; }
    if (item.asset_status === "generated") { skipped += 1; continue; }

    await pool.query(
      `UPDATE wardrobe_wags_box_items SET asset_status = 'pending', asset_error = NULL WHERE id = ?`,
      [item.id],
    );

    try {
      const planItem = planItems.find((p) => p.slot === item.slot)
        ?? { slot: item.slot, title: item.title, description: item.description };
      const prompt = buildSlotPrompt(planItem, ctx);
      const dataUrl = await deps.generateImage(prompt, `wags:${item.slot}`);
      if (!dataUrl) throw new Error("IMAGE_GENERATION_EMPTY");

      if (item.slot.startsWith("sticker_")) {
        const buffer = dataUrlToPngBuffer(dataUrl);
        if (!buffer) throw new Error("STICKER_NOT_DECODABLE");
        const gate = await verify(buffer);
        if (!gate.ok) throw new Error(gate.reason || "STICKER_ALPHA_GATE_FAILED");
      }

      const assetUrl = await deps.uploadImage(dataUrl);
      await pool.query(
        `UPDATE wardrobe_wags_box_items
         SET asset_status = 'generated', asset_url = ?, asset_error = NULL,
             asset_generated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [assetUrl, item.id],
      );
      generated += 1;
    } catch (err: any) {
      failed += 1;
      await pool.query(
        `UPDATE wardrobe_wags_box_items
         SET asset_status = 'failed', asset_error = ? WHERE id = ?`,
        [String(err?.message || err).slice(0, 255), item.id],
      );
    }
  }

  // The box is deliverable only when zero generative slots remain unfinished.
  const [pendingRows] = await pool.query(
    `SELECT COUNT(*) AS n FROM wardrobe_wags_box_items
     WHERE box_id = ? AND asset_status IN ('pending','failed')`,
    [boxId],
  ) as any;
  const unfinished = Number(pendingRows?.[0]?.n || 0);

  let delivered = false;
  if (unfinished === 0 && String(box.status) === "approved") {
    await pool.query(
      `UPDATE wardrobe_wags_boxes
       SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'approved'`,
      [boxId],
    );
    delivered = true;
  }

  return { boxId, generated, failed, skipped, delivered: delivered || unfinished === 0 };
}
