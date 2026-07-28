import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { PetGenerationError } from "./provider";
import type {
  MeshProfile,
  PetGlbOrderConfiguration,
  PetGlbStageKind,
  SubjectProfile,
  TextureQuality,
} from "./types";

export type PetGlbOrderState =
  | "draft"
  | "awaiting_payment"
  | "paid"
  | "awaiting_references"
  | "references_received"
  | "queued"
  | "generating"
  | "validating"
  | "repair_required"
  | "awaiting_human_review"
  | "approved"
  | "delivering"
  | "delivered"
  | "failed"
  | "refund_pending"
  | "refunded"
  | "cancelled"
  | "awaiting_reference_approval"
  | "base_queued"
  | "base_generating"
  | "awaiting_base_approval"
  | "texture_queued"
  | "texture_generating"
  | "awaiting_texture_approval"
  | "rig_checking"
  | "awaiting_rig_purchase"
  | "rig_queued"
  | "rig_generating"
  | "awaiting_rig_approval"
  | "stage_rejected"
  | "stage_failed"
  | "recovery_required";

export type ActorType = "system" | "customer" | "operator";

export interface PetGlbOrder {
  id: number;
  orderUuid: string;
  ownerPhone: string;
  sku: string;
  state: PetGlbOrderState;
  referenceSessionId: number | null;
  generationJobId: string | null;
  assetId: number | null;
  approvedVersionId: number | null;
  creditsReserved: number;
  creditsDisposition: "reserved" | "charged" | "refunded" | "none";
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  meshProfile: MeshProfile;
  subjectProfile: SubjectProfile;
  includeTexture: boolean;
  includeRig: boolean;
  textureQuality: TextureQuality;
  styleDirection: string | null;
  referenceManifest: Record<string, string> | null;
  referenceManifestHash: string | null;
  currentStage: PetGlbStageKind | null;
  currentStageAttemptId: number | null;
  finalCustomerVersionId: number | null;
}

export interface TransitionContext {
  actorType: ActorType;
  actorId?: string;
  reason?: string;
  requestId?: string;
  jobId?: string;
}

/**
 * Legal transitions. Anything absent is rejected — the machine is closed, not
 * advisory. Automation can reach awaiting_human_review but NEVER approved or
 * delivered; those require an operator (enforced in approve()).
 */
const LEGAL: Record<PetGlbOrderState, PetGlbOrderState[]> = {
  draft: ["awaiting_payment", "awaiting_references", "cancelled"],
  awaiting_payment: ["paid", "cancelled", "failed"],
  paid: ["awaiting_references", "references_received", "refund_pending", "cancelled"],
  awaiting_references: ["references_received", "awaiting_reference_approval", "refund_pending", "cancelled"],
  references_received: ["queued", "refund_pending", "cancelled"],
  queued: ["generating", "failed", "cancelled"],
  generating: ["validating", "failed", "cancelled"],
  validating: ["awaiting_human_review", "repair_required", "failed"],
  repair_required: ["queued", "generating", "failed", "refund_pending"],
  awaiting_human_review: ["approved", "repair_required", "failed", "refund_pending"],
  approved: ["delivering", "failed"],
  delivering: ["delivered", "failed"],
  delivered: ["refund_pending"],
  failed: ["refund_pending", "queued", "cancelled"],
  refund_pending: ["refunded", "failed"],
  refunded: [],
  cancelled: [],
  awaiting_reference_approval: ["base_queued", "stage_rejected", "cancelled"],
  base_queued: ["base_generating", "stage_failed", "recovery_required", "cancelled"],
  base_generating: ["awaiting_base_approval", "stage_failed", "recovery_required", "cancelled"],
  awaiting_base_approval: ["texture_queued", "rig_checking", "awaiting_human_review", "stage_rejected", "cancelled"],
  texture_queued: ["texture_generating", "stage_failed", "recovery_required", "cancelled"],
  texture_generating: ["awaiting_texture_approval", "stage_failed", "recovery_required", "cancelled"],
  awaiting_texture_approval: ["rig_checking", "awaiting_human_review", "stage_rejected", "cancelled"],
  rig_checking: ["awaiting_rig_purchase", "stage_failed", "recovery_required", "cancelled"],
  awaiting_rig_purchase: ["rig_queued", "stage_rejected", "cancelled"],
  rig_queued: ["rig_generating", "stage_failed", "recovery_required", "cancelled"],
  rig_generating: ["awaiting_rig_approval", "stage_failed", "recovery_required", "cancelled"],
  awaiting_rig_approval: ["awaiting_human_review", "stage_rejected", "cancelled"],
  stage_rejected: ["base_queued", "texture_queued", "rig_checking", "rig_queued", "cancelled"],
  stage_failed: ["base_queued", "texture_queued", "rig_checking", "rig_queued", "refund_pending", "cancelled"],
  recovery_required: ["base_generating", "texture_generating", "rig_checking", "rig_generating", "stage_failed"],
};

function mapRow(r: any): PetGlbOrder {
  return {
    id: r.id,
    orderUuid: r.order_uuid,
    ownerPhone: r.owner_phone,
    sku: r.sku,
    state: r.state,
    referenceSessionId: r.reference_session_id ?? null,
    generationJobId: r.generation_job_id ?? null,
    assetId: r.asset_id ?? null,
    approvedVersionId: r.approved_version_id ?? null,
    creditsReserved: r.credits_reserved,
    creditsDisposition: r.credits_disposition,
    deliveredAt: r.delivered_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    meshProfile: (r.mesh_profile || "hd") as MeshProfile,
    subjectProfile: (r.subject_profile || "pet") as SubjectProfile,
    includeTexture: r.include_texture === undefined ? true : Boolean(r.include_texture),
    includeRig: Boolean(r.include_rig),
    textureQuality: (r.texture_quality || "standard") as TextureQuality,
    styleDirection: r.style_direction ?? null,
    referenceManifest: typeof r.reference_manifest_json === "string"
      ? JSON.parse(r.reference_manifest_json)
      : r.reference_manifest_json ?? null,
    referenceManifestHash: r.reference_manifest_hash ?? null,
    currentStage: r.current_stage ?? null,
    currentStageAttemptId: r.current_stage_attempt_id ? Number(r.current_stage_attempt_id) : null,
    finalCustomerVersionId: r.final_customer_version_id ? Number(r.final_customer_version_id) : null,
  };
}

export class PetGlbOrderRepository {
  constructor(private readonly getPool: () => mysql.Pool) {}

  async create(ownerPhone: string, sku: string, creditsReserved = 0): Promise<PetGlbOrder> {
    const orderUuid = crypto.randomUUID();
    const pool = this.getPool();
    await pool.query(
      `INSERT INTO pet_glb_orders (order_uuid, owner_phone, sku, state, credits_reserved, credits_disposition)
       VALUES (?, ?, ?, 'draft', ?, ?)`,
      [orderUuid, ownerPhone, sku, creditsReserved, creditsReserved > 0 ? "reserved" : "none"],
    );
    const created = await this.findByUuid(orderUuid);
    if (!created) throw new PetGenerationError("ORDER_CREATE_FAILED", "Order insert did not persist");
    await this.writeEvent(pool, created.id, null, "draft", { actorType: "customer", actorId: ownerPhone });
    return created;
  }

  async createConfigured(
    ownerPhone: string,
    sku: string,
    configuration: PetGlbOrderConfiguration,
  ): Promise<PetGlbOrder> {
    const orderUuid = crypto.randomUUID();
    const pool = this.getPool();
    await pool.query(
      `INSERT INTO pet_glb_orders
         (order_uuid, owner_phone, sku, state, credits_reserved, credits_disposition,
          mesh_profile, subject_profile, include_texture, include_rig, texture_quality, style_direction)
       VALUES (?, ?, ?, 'awaiting_references', 0, 'none', ?, ?, ?, ?, ?, ?)`,
      [
        orderUuid,
        ownerPhone,
        sku,
        configuration.meshProfile,
        configuration.subjectProfile,
        configuration.includeTexture ? 1 : 0,
        configuration.includeRig ? 1 : 0,
        configuration.textureQuality,
        configuration.styleDirection,
      ],
    );
    const created = await this.findByUuid(orderUuid);
    if (!created) throw new PetGenerationError("ORDER_CREATE_FAILED", "Order insert did not persist");
    await this.writeEvent(pool, created.id, null, "awaiting_references", {
      actorType: "customer",
      actorId: ownerPhone,
      reason: "configured_order_created",
    });
    return created;
  }

  async findByUuid(orderUuid: string): Promise<PetGlbOrder | undefined> {
    const [rows] = await this.getPool().query(
      `SELECT * FROM pet_glb_orders WHERE order_uuid = ? LIMIT 1`,
      [orderUuid],
    );
    const arr = rows as any[];
    return arr.length ? mapRow(arr[0]) : undefined;
  }

  async listByOwner(ownerPhone: string, limit = 20): Promise<PetGlbOrder[]> {
    const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));
    const [rows] = await this.getPool().query(
      `SELECT * FROM pet_glb_orders
        WHERE owner_phone = ?
        ORDER BY updated_at DESC
        LIMIT ?`,
      [ownerPhone, bounded],
    );
    return (rows as any[]).map(mapRow);
  }

  /**
   * Atomic guarded transition. The state predicate is in the UPDATE's WHERE
   * clause, so two concurrent callers cannot both win — the loser sees
   * affectedRows === 0. The audit row is written in the SAME transaction as
   * the state change, so an order can never move without a trace.
   */
  async transition(
    orderId: number,
    to: PetGlbOrderState,
    ctx: TransitionContext,
  ): Promise<PetGlbOrder> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.query(
        `SELECT * FROM pet_glb_orders WHERE id = ? FOR UPDATE`,
        [orderId],
      );
      const arr = rows as any[];
      if (!arr.length) throw new PetGenerationError("ORDER_NOT_FOUND", `Order not found: ${orderId}`);
      const from = arr[0].state as PetGlbOrderState;

      if (from === to) {
        await conn.commit();
        return mapRow(arr[0]);
      }
      if (!LEGAL[from]?.includes(to)) {
        throw new PetGenerationError(
          "ILLEGAL_TRANSITION",
          `Illegal transition ${from} -> ${to} for order ${orderId}`,
        );
      }

      const [res] = await conn.query(
        `UPDATE pet_glb_orders SET state = ?, updated_at = NOW() WHERE id = ? AND state = ?`,
        [to, orderId, from],
      );
      if ((res as any).affectedRows === 0) {
        throw new PetGenerationError("CONCURRENT_TRANSITION", `Lost race transitioning order ${orderId}`);
      }

      await this.writeEvent(conn, orderId, from, to, ctx);
      await conn.commit();

      const updated = await this.findByUuid(arr[0].order_uuid);
      return updated!;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Operator approval. Binds exactly one immutable version.
   * `approved_version_id IS NULL` in the WHERE makes it write-once at the
   * database, not merely in application logic — this repo has been burned by
   * application-only invariants before.
   */
  async approve(
    orderId: number,
    versionId: number,
    operatorId: string,
    note?: string,
  ): Promise<PetGlbOrder> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();

      const [res] = await conn.query(
        `UPDATE pet_glb_orders
            SET approved_version_id = ?, state = 'approved', updated_at = NOW()
          WHERE id = ? AND state = 'awaiting_human_review' AND approved_version_id IS NULL`,
        [versionId, orderId],
      );
      if ((res as any).affectedRows === 0) {
        throw new PetGenerationError(
          "APPROVAL_REJECTED",
          `Order ${orderId} is not awaiting review, or a version is already approved`,
        );
      }

      await this.writeEvent(conn, orderId, "awaiting_human_review", "approved", {
        actorType: "operator",
        actorId: operatorId,
        reason: note,
      });
      await conn.commit();

      const [rows] = await this.getPool().query(`SELECT * FROM pet_glb_orders WHERE id = ?`, [orderId]);
      return mapRow((rows as any[])[0]);
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Delivery-exactly-once: `delivered_at IS NULL` guard is the enforcement. */
  async markDelivered(orderId: number): Promise<void> {
    const [res] = await this.getPool().query(
      `UPDATE pet_glb_orders
          SET delivered_at = NOW(), state = 'delivered', updated_at = NOW()
        WHERE id = ? AND state = 'delivering' AND delivered_at IS NULL`,
      [orderId],
    );
    if ((res as any).affectedRows === 0) {
      throw new PetGenerationError("ALREADY_DELIVERED", `Order ${orderId} was already delivered`);
    }
    await this.writeEvent(this.getPool(), orderId, "delivering", "delivered", { actorType: "system" });
  }

  /**
   * Inbound Stripe replay defence. Returns true only for the FIRST time an
   * event id is seen. Stripe's idempotencyKey guards outbound calls; this
   * guards redelivery, which is a different failure.
   */
  async claimStripeEvent(eventId: string, eventType: string, orderId?: number): Promise<boolean> {
    const [res] = await this.getPool().query(
      `INSERT IGNORE INTO stripe_event_ledger (event_id, event_type, order_id) VALUES (?, ?, ?)`,
      [eventId, eventType, orderId ?? null],
    );
    return (res as any).affectedRows === 1;
  }

  async attachGenerationJob(orderId: number, jobId: string): Promise<void> {
    await this.getPool().query(
      `UPDATE pet_glb_orders SET generation_job_id = ?, updated_at = NOW() WHERE id = ?`,
      [jobId, orderId],
    );
  }

  async listByState(state: PetGlbOrderState, limit = 50): Promise<PetGlbOrder[]> {
    const [rows] = await this.getPool().query(
      `SELECT * FROM pet_glb_orders WHERE state = ? ORDER BY created_at ASC LIMIT ?`,
      [state, limit],
    );
    return (rows as any[]).map(mapRow);
  }

  private async writeEvent(
    conn: mysql.Pool | mysql.PoolConnection,
    orderId: number,
    from: PetGlbOrderState | null,
    to: PetGlbOrderState,
    ctx: TransitionContext,
  ): Promise<void> {
    await conn.query(
      `INSERT INTO pet_glb_order_events
         (order_id, from_state, to_state, actor_type, actor_id, reason, request_id, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        from,
        to,
        ctx.actorType,
        ctx.actorId ?? null,
        ctx.reason ?? null,
        ctx.requestId ?? null,
        ctx.jobId ?? null,
      ],
    );
  }
}

export const LEGAL_TRANSITIONS = LEGAL;
