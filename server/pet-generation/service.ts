import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { createProviderForSku } from "./factory";
import { MySqlProviderJobStore } from "./jobStore";
import { PetGlbOrderRepository, type PetGlbOrder } from "./orderRepository";
import { validatePetGlb, type ValidationReport } from "./validation";
import { CUSTOM_RIGGED_PET_GLB_V1 } from "./skuRegistry";
import { PetGenerationError } from "./provider";
import type { PetModelGenerationInput } from "./types";

export interface PetGlbServiceDeps {
  getPool: () => mysql.Pool;
  isAdmin: (phone: string) => Promise<boolean>;
  isOperator?: (phone: string) => Promise<boolean>;
  /** Persists a GLB buffer as an immutable asset version. Returns version id. */
  persistVersion: (input: {
    ownerPhone: string;
    assetId: number | null;
    glb: Buffer;
    sha256: string;
    validationReport: ValidationReport;
    metadata: Record<string, unknown>;
  }) => Promise<{ assetId: number; versionId: number }>;
  /** Issues a short-lived authenticated download URL for an approved version. */
  signDownload: (versionId: number, ownerPhone: string, ttlSeconds: number) => Promise<string>;
  rigProfileJoints?: string[];
}

export const DOWNLOAD_TTL_SECONDS = 900;

/** Credits quote — reuses the existing formula unchanged. Do not "refine". */
export function quoteCredits(viewCount: number, baseCredits = 10): number {
  const viewMultiplier = viewCount >= 5 ? 1.5 : 1;
  return Math.ceil(baseCredits * viewMultiplier);
}

export class PetGlbService {
  private readonly orders: PetGlbOrderRepository;

  constructor(private readonly deps: PetGlbServiceDeps) {
    this.orders = new PetGlbOrderRepository(deps.getPool);
  }

  get repository(): PetGlbOrderRepository {
    return this.orders;
  }

  // ── 1. Order creation + credit reservation ────────────────────────────────
  async createOrder(ownerPhone: string): Promise<PetGlbOrder> {
    const credits = quoteCredits(5);
    const pool = this.deps.getPool();

    const [balRows] = await pool.query("SELECT credits FROM users WHERE phone = ? LIMIT 1", [ownerPhone]);
    const balance = (balRows as any[])[0]?.credits ?? 0;
    if (balance < credits) {
      throw new PetGenerationError("INSUFFICIENT_CREDITS", `Requires ${credits} credits; balance ${balance}`);
    }

    const order = await this.orders.create(ownerPhone, CUSTOM_RIGGED_PET_GLB_V1, credits);
    await pool.query("UPDATE users SET credits = credits - ? WHERE phone = ?", [credits, ownerPhone]);
    return this.orders.transition(order.id, "awaiting_payment", {
      actorType: "customer",
      actorId: ownerPhone,
      reason: "credits_reserved",
    });
  }

  // ── 2. Payment — ONLY a verified webhook may set paid ─────────────────────
  async handlePaymentSucceeded(eventId: string, eventType: string, orderUuid: string): Promise<PetGlbOrder | null> {
    const order = await this.orders.findByUuid(orderUuid);
    if (!order) throw new PetGenerationError("ORDER_NOT_FOUND", `No order ${orderUuid}`);

    // Inbound replay defence — a redelivered event is a no-op.
    const first = await this.orders.claimStripeEvent(eventId, eventType, order.id);
    if (!first) return null;

    await this.deps.getPool().query(
      `UPDATE pet_glb_orders SET credits_disposition = 'charged' WHERE id = ?`,
      [order.id],
    );
    const paid = await this.orders.transition(order.id, "paid", {
      actorType: "system",
      reason: "stripe_webhook_verified",
      requestId: eventId,
    });
    return this.orders.transition(paid.id, "awaiting_references", { actorType: "system" });
  }

  // ── 3. References ─────────────────────────────────────────────────────────
  async attachReferences(orderUuid: string, ownerPhone: string, referenceSessionId: number): Promise<PetGlbOrder> {
    const order = await this.requireOwned(orderUuid, ownerPhone);
    await this.deps.getPool().query(
      `UPDATE pet_glb_orders SET reference_session_id = ? WHERE id = ?`,
      [referenceSessionId, order.id],
    );
    return this.orders.transition(order.id, "references_received", {
      actorType: "customer",
      actorId: ownerPhone,
    });
  }

  // ── 4. Generation — unpaid orders can never reach here ────────────────────
  async startGeneration(orderUuid: string, refs: PetModelGenerationInput): Promise<PetGlbOrder> {
    const order = await this.mustFind(orderUuid);
    if (order.creditsDisposition !== "charged") {
      throw new PetGenerationError("NOT_PAID", `Order ${orderUuid} is not paid`);
    }
    if (order.generationJobId) {
      // Retry reuses the existing job — never a second charge.
      return this.orders.transition(order.id, "generating", { actorType: "system", jobId: order.generationJobId });
    }

    const queued = await this.orders.transition(order.id, "queued", { actorType: "system" });
    const provider = createProviderForSku(CUSTOM_RIGGED_PET_GLB_V1, {
      store: new MySqlProviderJobStore(this.deps.getPool),
    });
    const job = await provider.createJob(refs);
    await this.orders.attachGenerationJob(queued.id, job.id);
    return this.orders.transition(queued.id, "generating", { actorType: "system", jobId: job.id });
  }

  // ── 5. Poll + validate + persist immutable version ────────────────────────
  async pollAndValidate(orderUuid: string): Promise<{ order: PetGlbOrder; report?: ValidationReport }> {
    const order = await this.mustFind(orderUuid);
    if (!order.generationJobId) throw new PetGenerationError("NO_JOB", "Order has no generation job");

    const provider = createProviderForSku(CUSTOM_RIGGED_PET_GLB_V1, {
      store: new MySqlProviderJobStore(this.deps.getPool),
    });

    const job = await provider.getJob(order.generationJobId);
    if (job.status === "cancelled") {
      return { order: await this.orders.transition(order.id, "cancelled", { actorType: "system" }) };
    }
    if (job.status === "failed") {
      return { order: await this.orders.transition(order.id, "failed", { actorType: "system", reason: job.reason }) };
    }
    if (job.status !== "completed") return { order };

    const validating = await this.orders.transition(order.id, "validating", { actorType: "system" });
    const artifacts = await provider.fetchArtifacts(order.generationJobId);

    const report = validatePetGlb(artifacts.glb.data, {
      rigProfileJoints: this.deps.rigProfileJoints,
    });

    const { assetId, versionId } = await this.deps.persistVersion({
      ownerPhone: order.ownerPhone,
      assetId: order.assetId,
      glb: artifacts.glb.data,
      sha256: artifacts.glb.sha256,
      validationReport: report,
      metadata: { ...artifacts.metadata, orderUuid, versionCandidate: true },
    });

    await this.deps.getPool().query(
      `UPDATE pet_glb_orders SET asset_id = ? WHERE id = ?`,
      [assetId, validating.id],
    );

    // Automation may reach awaiting_human_review — never approved.
    const next = report.operatorReady ? "awaiting_human_review" : "repair_required";
    const updated = await this.orders.transition(validating.id, next, {
      actorType: "system",
      reason: report.operatorReady ? "validators_passed" : report.reasonCodes.join(","),
      jobId: order.generationJobId,
    });

    return { order: { ...updated, assetId }, report: { ...report, fileHash: artifacts.glb.sha256 } as ValidationReport & { versionId?: number } };
  }

  // ── 6. Operator approval — role-gated, one immutable version ──────────────
  async approve(orderUuid: string, actorPhone: string, versionId: number, note?: string): Promise<PetGlbOrder> {
    await this.assertOperator(actorPhone);
    const order = await this.mustFind(orderUuid);
    return this.orders.approve(order.id, versionId, actorPhone, note);
  }

  async requestRepair(orderUuid: string, actorPhone: string, reasonCode: string): Promise<PetGlbOrder> {
    await this.assertOperator(actorPhone);
    const order = await this.mustFind(orderUuid);
    return this.orders.transition(order.id, "repair_required", {
      actorType: "operator",
      actorId: actorPhone,
      reason: reasonCode,
    });
  }

  async operatorQueue(actorPhone: string, limit = 50): Promise<PetGlbOrder[]> {
    await this.assertOperator(actorPhone);
    return this.orders.listByState("awaiting_human_review", limit);
  }

  // ── 7. Delivery — exactly once, hash-bound ────────────────────────────────
  async deliver(orderUuid: string, ownerPhone: string): Promise<{ url: string; versionId: number }> {
    const order = await this.requireOwned(orderUuid, ownerPhone);
    if (!order.approvedVersionId) {
      throw new PetGenerationError("NOT_APPROVED", "No operator-approved version for this order");
    }

    if (order.state === "approved") {
      await this.orders.transition(order.id, "delivering", { actorType: "system" });
      await this.orders.markDelivered(order.id);
    }

    const url = await this.deps.signDownload(order.approvedVersionId, ownerPhone, DOWNLOAD_TTL_SECONDS);
    return { url, versionId: order.approvedVersionId };
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private async mustFind(orderUuid: string): Promise<PetGlbOrder> {
    const order = await this.orders.findByUuid(orderUuid);
    if (!order) throw new PetGenerationError("ORDER_NOT_FOUND", `No order ${orderUuid}`);
    return order;
  }

  private async requireOwned(orderUuid: string, phone: string): Promise<PetGlbOrder> {
    const order = await this.mustFind(orderUuid);
    if (order.ownerPhone !== phone) {
      const admin = await this.deps.isAdmin(phone);
      if (!admin) throw new PetGenerationError("FORBIDDEN", "Not your order");
    }
    return order;
  }

  /**
   * Operator gate. Deliberately NOT the same as isAdmin: the existing admin
   * bypass in spatial-generator reviewJob must not silently satisfy a
   * mandatory-operator-approval requirement. If no operator predicate is
   * configured, approval is refused outright rather than falling back to admin.
   */
  private async assertOperator(phone: string): Promise<void> {
    if (!this.deps.isOperator) {
      throw new PetGenerationError(
        "OPERATOR_ROLE_UNCONFIGURED",
        "No operator role configured; refusing to fall back to admin for approval",
      );
    }
    if (!(await this.deps.isOperator(phone))) {
      throw new PetGenerationError("NOT_OPERATOR", "Operator role required");
    }
  }
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
