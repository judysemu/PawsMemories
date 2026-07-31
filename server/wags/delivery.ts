import type { Pool } from "mysql2/promise";
import { WAGS_EXCLUSIVE_CATALOG } from "../../src/wardrobe/catalog";
import { isGenerativeSlot } from "./materializer";
import type { WagsPlan, WagsPlanItem } from "./planner";

/**
 * W3 — box delivery.
 *
 * Approving a box materializes its Gemini plan into concrete, granted things:
 *   - accessory slots  → unlock of a Wags-exclusive wardrobe item the user
 *                        does not already own (colour-matched to the plan)
 *   - credit_pack      → +20 credits on the user account
 *   - everything else  → a collectible box_items row (title/description kept
 *                        verbatim from the plan) rendered in the Wags Inbox
 *
 * Design rules:
 *   1. box_items are the permanent record. The inbox renders from them alone;
 *      plan_json is never re-read after delivery, so a re-plan cannot rewrite
 *      what a subscriber already received.
 *   2. Idempotent. Delivery runs inside a check on existing box_items; calling
 *      deliver twice grants nothing twice. Credits are the dangerous part, so
 *      the credit grant happens only when the credit_pack row INSERT succeeded.
 *   3. Wardrobe grants come only from WAGS_EXCLUSIVE_CATALOG — the free base
 *      catalog is already everyone's; granting from it would deliver nothing.
 */

const ACCESSORY_SLOTS = new Set(["accessory", "accessory_2", "accessory_3"]);
const DEFAULT_CREDIT_PACK_AMOUNT = 20;

export interface DeliveryResult {
  boxId: number;
  itemsCreated: number;
  wardrobeGranted: string[];
  creditsGranted: number;
  alreadyDelivered: boolean;
}

/** Hex distance in RGB space — good enough to colour-match a plan item. */
function colorDistance(a: string, b: string): number {
  const parse = (hex: string) => {
    const h = hex.replace("#", "");
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  };
  try {
    const [r1, g1, b1] = parse(a);
    const [r2, g2, b2] = parse(b);
    return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const NAMED_COLORS: Record<string, string> = {
  red: "#c0392b",
  rose: "#c2547e",
  pink: "#ed64a6",
  orange: "#d97742",
  amber: "#c98a2d",
  gold: "#d6ad29",
  yellow: "#ecc94b",
  green: "#4c9e6e",
  forest: "#276749",
  teal: "#2c7a7b",
  blue: "#3182ce",
  navy: "#1a2340",
  midnight: "#1a2340",
  purple: "#6b46c1",
  violet: "#44337a",
  silver: "#b8bfc9",
  gray: "#718096",
  grey: "#718096",
  white: "#e2e8f0",
  black: "#1a202c",
  brown: "#8a5a2b",
  copper: "#b26a3a",
  cream: "#e8ddc7",
};

// Longest name first, so "midnight blue" resolves to midnight (#1a2340) rather
// than stopping at the generic "blue" substring.
const NAMED_COLOR_ENTRIES = Object.entries(NAMED_COLORS).sort(
  (a, b) => b[0].length - a[0].length,
);

function planColorToHex(color: string): string | null {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  for (const [name, hex] of NAMED_COLOR_ENTRIES) {
    if (c.includes(name)) return hex;
  }
  return null;
}

/**
 * Pick the Wags-exclusive wardrobe item that best matches a plan item, from the
 * set the user does not already own. Deterministic: colour distance, then
 * catalog order. Returns null when the user owns every exclusive (grant becomes
 * a collectible-only row rather than a dead duplicate).
 */
export function matchWardrobeItem(
  planItem: WagsPlanItem,
  ownedIds: Set<string>,
): string | null {
  const available = WAGS_EXCLUSIVE_CATALOG.filter(
    (item) => !ownedIds.has(item.id),
  );
  if (available.length === 0) return null;

  const planHexes = (planItem.colors || [])
    .map(planColorToHex)
    .filter((h): h is string => h !== null);

  if (planHexes.length === 0) return available[0].id;

  let best = available[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of available) {
    const score = Math.min(
      ...planHexes.map((hex) => colorDistance(candidate.color, hex)),
    );
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best.id;
}

/** Wardrobe-item ids a user owns through delivered Wags boxes. */
export async function getOwnedWardrobeItems(
  pool: Pool,
  userPhone: string,
): Promise<Set<string>> {
  const [rows] = (await pool.query(
    `SELECT DISTINCT i.wardrobe_item_id
     FROM wardrobe_wags_box_items i
     JOIN wardrobe_wags_boxes b ON b.id = i.box_id
     WHERE b.user_phone = ? AND b.status IN ('delivered','delivered_flagged','reviewed_ok')
       AND i.wardrobe_item_id IS NOT NULL`,
    [userPhone],
  )) as any;
  return new Set((rows as any[]).map((r) => String(r.wardrobe_item_id)));
}

/**
 * Materialize an approved box's plan into box_items and grant entitlements.
 * Caller is responsible for having verified admin authority and box status.
 */
export async function deliverBox(
  pool: Pool,
  box: { id: number; user_phone: string; plan_json: WagsPlan | null },
  options?: {
    /**
     * BO-3: when false, box_items are created and entitlements granted but the
     * box stays 'approved' — the materializer flips it to 'delivered' only
     * after every generative slot has a stored asset. Defaults to true for
     * backward compatibility with pre-materializer callers/tests.
     */
    finalizeStatus?: boolean;
  },
): Promise<DeliveryResult> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Lock the box before the idempotency check. Concurrent delivery attempts
    // serialize here, so only the first transaction can create items or credits.
    const [lockedRows] = (await connection.query(
      `SELECT id FROM wardrobe_wags_boxes WHERE id = ? FOR UPDATE`,
      [box.id],
    )) as any;
    if (!lockedRows?.length) throw new Error(`Box ${box.id} not found.`);

    const [existing] = (await connection.query(
      `SELECT COUNT(*) AS n FROM wardrobe_wags_box_items WHERE box_id = ?`,
      [box.id],
    )) as any;
    if (Number(existing?.[0]?.n || 0) > 0) {
      await connection.commit();
      return {
        boxId: box.id,
        itemsCreated: 0,
        wardrobeGranted: [],
        creditsGranted: 0,
        alreadyDelivered: true,
      };
    }

    const plan = box.plan_json;
    if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) {
      throw new Error(
        `Box ${box.id} has no plan to deliver — run the planner first.`,
      );
    }

    const owned = await getOwnedWardrobeItems(
      connection as any,
      box.user_phone,
    );
    const grantedThisBox: string[] = [];
    let creditsGranted = 0;
    let itemsCreated = 0;

    for (const item of plan.items) {
      let wardrobeItemId: string | null = null;
      let creditAmount: number | null = null;

      if (ACCESSORY_SLOTS.has(item.slot)) {
        // Colour-match against everything owned, including grants earlier in
        // this same box, so a plus-tier box never grants the same item twice.
        wardrobeItemId = matchWardrobeItem(
          item,
          new Set([...owned, ...grantedThisBox]),
        );
        if (wardrobeItemId) grantedThisBox.push(wardrobeItemId);
      } else if (item.slot === "credit_pack") {
        creditAmount = DEFAULT_CREDIT_PACK_AMOUNT;
      }

      await connection.query(
        `INSERT INTO wardrobe_wags_box_items
         (box_id, slot, wardrobe_item_id, entitlement_type, credit_amount, title, description, personalization_note, asset_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          box.id,
          item.slot,
          wardrobeItemId,
          wardrobeItemId
            ? "wardrobe_item"
            : creditAmount
              ? "credits"
              : "collectible",
          creditAmount,
          item.title.slice(0, 160),
          item.description.slice(0, 600),
          item.size_note ? item.size_note.slice(0, 200) : null,
          // BO-3: 2D-generative slots owe the subscriber a real asset before the
          // box may reach 'delivered'; everything else has no asset obligation.
          isGenerativeSlot(item.slot) ? "pending" : "none",
        ],
      );
      itemsCreated += 1;

      // Credits are granted immediately after the row that records them exists,
      // so a crash between the two can under-grant (visible, fixable) but never
      // over-grant (silent, unfixable).
      if (creditAmount) {
        await connection.query(
          `UPDATE users SET credits = credits + ? WHERE phone = ?`,
          [creditAmount, box.user_phone],
        );
        creditsGranted += creditAmount;
      }
    }

    if (options?.finalizeStatus !== false) {
      await connection.query(
        `UPDATE wardrobe_wags_boxes
       SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
        [box.id],
      );
    }

    await connection.commit();
    return {
      boxId: box.id,
      itemsCreated,
      wardrobeGranted: grantedThisBox,
      creditsGranted,
      alreadyDelivered: false,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
