import crypto, { randomUUID } from "node:crypto";
import type mysql from "mysql2/promise";

export type SnapgenOrderStatus =
  | "pending"
  | "submitting"
  | "processing"
  | "recovery_required"
  | "completed"
  | "failed";

export interface SnapgenTier {
  code: string;
  name: string;
  price_cents: number;
  face_limit: number;
  pbr: number;
  rig: number;
  texture_res: string;
}

export interface ReserveSnapgenOrderInput {
  ownerId: string;
  tierCode: string;
  categoryCode: string;
  purchaseToken: string;
  requestHash: string;
  optionsJson: string;
  isRemake: boolean;
  originalOrderId?: number | null;
  allowDevBypass?: boolean;
}

export interface ReservedSnapgenOrder {
  orderId: number;
  replay: boolean;
  status: SnapgenOrderStatus;
  tier: SnapgenTier;
  priceCents: number;
  currency: "USD";
}

export class SnapgenPurchaseError extends Error {
  constructor(
    public readonly code:
      | "PURCHASE_REQUIRED"
      | "PURCHASE_MISMATCH"
      | "PURCHASE_USED"
      | "ORDER_REPLAY_MISMATCH"
      | "CATALOG_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "SnapgenPurchaseError";
  }
}

export function snapgenSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function assertSnapgenProductionConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production" && env.SNAPGEN_SKIP_PURCHASE_VERIFY === "1") {
    throw new Error("SNAPGEN_SKIP_PURCHASE_VERIFY must not be enabled in production.");
  }
}

function validIdentity(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max;
}

function orderStatus(value: unknown): SnapgenOrderStatus {
  const normalized = String(value || "pending") as SnapgenOrderStatus;
  return new Set<SnapgenOrderStatus>([
    "pending", "submitting", "processing", "recovery_required", "completed", "failed",
  ]).has(normalized) ? normalized : "recovery_required";
}

/**
 * Lock purchase evidence, create the durable order, and consume the token in
 * one commit. A replay returns the same order only when the request hash is
 * identical; it never creates a second provider submission.
 */
export async function reserveSnapgenOrder(
  pool: mysql.Pool,
  input: ReserveSnapgenOrderInput,
): Promise<ReservedSnapgenOrder> {
  if (!validIdentity(input.ownerId, 32) || !validIdentity(input.tierCode, 24) || !validIdentity(input.categoryCode, 24)) {
    throw new SnapgenPurchaseError("CATALOG_MISMATCH", "Invalid Snapgen owner or catalog selection.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) {
    throw new SnapgenPurchaseError("ORDER_REPLAY_MISMATCH", "Invalid Snapgen request identity.");
  }
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [tierRows] = await connection.query(
      `SELECT code, name, price_cents, face_limit, pbr, rig, texture_res
         FROM sg_tiers WHERE code = ? AND active = 1 LIMIT 1 FOR UPDATE`,
      [input.tierCode],
    ) as any;
    const tier = Array.isArray(tierRows) ? tierRows[0] as SnapgenTier | undefined : undefined;
    const [categoryRows] = await connection.query(
      `SELECT code FROM sg_categories WHERE code = ? AND active = 1 LIMIT 1`,
      [input.categoryCode],
    ) as any;
    if (!tier || !Array.isArray(categoryRows) || categoryRows.length !== 1) {
      throw new SnapgenPurchaseError("CATALOG_MISMATCH", "Unknown or inactive Snapgen product.");
    }
    const priceCents = input.isRemake
      ? Math.round(Number(tier.price_cents) * 0.5)
      : Number(tier.price_cents);
    const expectedProductId = input.isRemake
      ? `snapgen_remake_${tier.code}`
      : `snapgen_model_${tier.code}`;

    const bypassToken = `dev:${input.ownerId}:${input.requestHash}`;
    const token = input.allowDevBypass ? bypassToken : input.purchaseToken.trim();
    if (!token || token.length > 512) {
      throw new SnapgenPurchaseError("PURCHASE_REQUIRED", "Missing purchase token.");
    }
    const tokenHash = snapgenSha256(token);

    const [existingOrderRows] = await connection.query(
      `SELECT id, user_key, request_hash, status
         FROM sg_orders WHERE purchase_token_sha256 = ? LIMIT 1 FOR UPDATE`,
      [tokenHash],
    ) as any;
    const existingOrder = Array.isArray(existingOrderRows) ? existingOrderRows[0] : null;
    if (existingOrder) {
      if (String(existingOrder.user_key) !== input.ownerId || String(existingOrder.request_hash) !== input.requestHash) {
        throw new SnapgenPurchaseError("ORDER_REPLAY_MISMATCH", "Purchase token is bound to a different order request.");
      }
      await connection.commit();
      transactionStarted = false;
      return {
        orderId: Number(existingOrder.id),
        replay: true,
        status: orderStatus(existingOrder.status),
        tier,
        priceCents,
        currency: "USD",
      };
    }

    let purchaseId: number | null = null;
    if (!input.allowDevBypass) {
      const [purchaseRows] = await connection.query(
        `SELECT id, user_key, product_id, purchase_token, price_cents, currency, consumed, consumed_order_id
           FROM sg_purchases WHERE purchase_token_sha256 = ? LIMIT 1 FOR UPDATE`,
        [tokenHash],
      ) as any;
      const purchase = Array.isArray(purchaseRows) ? purchaseRows[0] : null;
      if (!purchase || String(purchase.purchase_token) !== token) {
        throw new SnapgenPurchaseError("PURCHASE_REQUIRED", "Purchase not found.");
      }
      if (
        String(purchase.user_key) !== input.ownerId
        || String(purchase.product_id) !== expectedProductId
        || Number(purchase.price_cents) !== priceCents
        || String(purchase.currency || "").toUpperCase() !== "USD"
      ) {
        throw new SnapgenPurchaseError("PURCHASE_MISMATCH", "Purchase evidence does not match this order.");
      }
      if (Number(purchase.consumed) !== 0 || purchase.consumed_order_id != null) {
        throw new SnapgenPurchaseError("PURCHASE_USED", "Purchase already used.");
      }
      purchaseId = Number(purchase.id);
    }

    const [inserted] = await connection.query(
      `INSERT INTO sg_orders
        (user_key, tier_code, category_code, status, options_json, purchase_token,
         purchase_token_sha256, request_hash, price_cents, currency, is_remake, original_order_id)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'USD', ?, ?)`,
      [
        input.ownerId,
        tier.code,
        input.categoryCode,
        input.optionsJson,
        token,
        tokenHash,
        input.requestHash,
        priceCents,
        input.isRemake ? 1 : 0,
        input.originalOrderId || null,
      ],
    ) as any;
    const orderId = Number(inserted.insertId);
    if (!Number.isInteger(orderId) || orderId <= 0) throw new Error("Snapgen order insert failed.");

    if (purchaseId != null) {
      const [consumed] = await connection.query(
        `UPDATE sg_purchases
            SET consumed = 1, consumed_order_id = ?
          WHERE id = ? AND consumed = 0 AND consumed_order_id IS NULL`,
        [orderId, purchaseId],
      ) as any;
      if (consumed?.affectedRows !== 1) {
        throw new SnapgenPurchaseError("PURCHASE_USED", "Purchase was consumed concurrently.");
      }
    }

    await connection.commit();
    transactionStarted = false;
    return { orderId, replay: false, status: "pending", tier, priceCents, currency: "USD" };
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export async function claimSnapgenSubmission(pool: mysql.Pool, orderId: number, ownerId: string): Promise<boolean> {
  const [result] = await pool.query(
    `UPDATE sg_orders
        SET status='submitting', submission_attempted_at=NOW(3), error=NULL, error_code=NULL
      WHERE id=? AND user_key=? AND status='pending'`,
    [orderId, ownerId],
  ) as any;
  return result?.affectedRows === 1;
}

export async function persistSnapgenProviderHandle(
  pool: mysql.Pool,
  orderId: number,
  ownerId: string,
  handle: string,
  sourceImageUrl: string,
): Promise<boolean> {
  const [result] = await pool.query(
    `UPDATE sg_orders
        SET status='processing', tripo_op=?, source_image_url=?, provider_handle_persisted_at=NOW(3)
      WHERE id=? AND user_key=? AND status='submitting'`,
    [handle, sourceImageUrl, orderId, ownerId],
  ) as any;
  return result?.affectedRows === 1;
}

export async function quarantineSnapgenOrder(
  pool: mysql.Pool,
  orderId: number,
  ownerId: string,
  errorCode: string,
): Promise<void> {
  await pool.query(
    `UPDATE sg_orders
        SET status='recovery_required', error_code=?, error='Provider submission requires reconciliation.'
      WHERE id=? AND user_key=? AND status IN ('pending','submitting')`,
    [errorCode.slice(0, 64), orderId, ownerId],
  );
}

export interface SnapgenPollClaim {
  claimed: boolean;
  leaseOwner: string | null;
  order: any;
}

export async function claimSnapgenPoll(
  pool: mysql.Pool,
  orderId: number,
  ownerId: string,
): Promise<SnapgenPollClaim | null> {
  const leaseOwner = randomUUID();
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.query(
      `SELECT * FROM sg_orders WHERE id=? AND user_key=? LIMIT 1 FOR UPDATE`,
      [orderId, ownerId],
    ) as any;
    const order = Array.isArray(rows) ? rows[0] : null;
    if (!order) {
      await connection.rollback();
      transactionStarted = false;
      return null;
    }
    if (order.status !== "processing" || (order.poll_lease_expires_at && new Date(order.poll_lease_expires_at).getTime() > Date.now())) {
      await connection.commit();
      transactionStarted = false;
      return { claimed: false, leaseOwner: null, order };
    }
    await connection.query(
      `UPDATE sg_orders
          SET poll_lease_owner=?, poll_lease_expires_at=DATE_ADD(NOW(3), INTERVAL 2 MINUTE)
        WHERE id=?`,
      [leaseOwner, orderId],
    );
    await connection.commit();
    transactionStarted = false;
    return { claimed: true, leaseOwner, order: { ...order, poll_lease_owner: leaseOwner } };
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
