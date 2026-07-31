import type mysql from "mysql2/promise";
import {
  PaymentEvidenceSchema,
  PrintOrderPublicSchema,
  RenderDispatchSchema,
  RenderJobPublicSchema,
  type PrintOrderPublic,
  type RenderJobPublic,
} from "./apiContracts.ts";
import type {
  FrozenPrintOrderInsert,
  RenderJobCompletionRecord,
  RenderJobInsert,
  StationeryApiRepositoryPort,
  StationeryAssetEvidence,
  StationeryTemplateVersionRecord,
} from "./apiPorts.ts";
import {
  SealedPrintManifestSchema,
  SealedRenderManifestSchema,
  StationeryValidationReportSchema,
  TemplateVersionSpecSchema,
} from "./contracts.ts";
import {
  createProviderSubmission,
  ProviderEventSchema,
  ProviderSubmissionSchema,
  type ProviderSubmission,
} from "./fulfillment.ts";
import type { FulfillmentLockedRepositoryPort } from "./ports.ts";

type Queryable = mysql.Pool | mysql.PoolConnection;

export class MySqlStationeryV2Repository implements StationeryApiRepositoryPort {
  constructor(private readonly getPool: () => mysql.Pool) {}

  async getTemplateVersion(templateUuid: string, versionNumber: number): Promise<StationeryTemplateVersionRecord | null> {
    const [rows]: any = await this.getPool().query(
      `SELECT spec_json, spec_hash, status
       FROM stationery_template_versions
       WHERE template_uuid = ? AND version_number = ?
       LIMIT 1`,
      [templateUuid, versionNumber],
    );
    if (!rows[0]) return null;
    return {
      spec: TemplateVersionSpecSchema.parse(parseJson(rows[0].spec_json)),
      specHash: String(rows[0].spec_hash),
      status: rows[0].status,
    };
  }

  async getAssetEvidence(assetUuid: string, versionNumber: number): Promise<StationeryAssetEvidence | null> {
    const [rows]: any = await this.getPool().query(
      `SELECT a.asset_uuid, a.owner_id, a.status, av.version_number, av.sha256, av.commercial_use_eligible
       FROM assets a
       JOIN asset_versions av ON av.asset_id = a.id
       WHERE a.asset_uuid = ? AND av.version_number = ?
       LIMIT 1`,
      [assetUuid, versionNumber],
    );
    if (!rows[0]) return null;
    return {
      assetUuid: String(rows[0].asset_uuid),
      versionNumber: Number(rows[0].version_number),
      sha256: String(rows[0].sha256),
      ownerId: String(rows[0].owner_id),
      status: rows[0].status,
      commercialUseEligible: Boolean(rows[0].commercial_use_eligible),
    };
  }

  async createRenderJobIdempotent(input: RenderJobInsert): Promise<{ job: RenderJobPublic; created: boolean }> {
    const pool = this.getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const existing = await findRenderJobByIdempotency(connection, input.ownerId, input.idempotencyKey);
      if (existing) {
        await connection.commit();
        return { job: existing, created: false };
      }
      const [templateRows]: any = await connection.query(
        `SELECT id FROM stationery_template_versions
         WHERE template_uuid = ? AND version_number = ? AND spec_hash = ?
         LIMIT 1 FOR SHARE`,
        [input.template.spec.templateUuid, input.template.spec.versionNumber, input.template.specHash],
      );
      if (!templateRows[0]) throw new Error("TEMPLATE_VERSION_NOT_FOUND");
      await connection.query(
        `INSERT INTO stationery_render_jobs
          (job_uuid, owner_id, template_version_id, preset_id, client_idempotency_key,
           request_hash, request_json, validation_report_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        [
          input.jobUuid,
          input.ownerId,
          templateRows[0].id,
          input.request.presetId,
          input.idempotencyKey,
          input.requestHash,
          JSON.stringify(input.request),
          JSON.stringify(input.validationReport),
          toSqlDate(input.createdAt),
          toSqlDate(input.createdAt),
        ],
      );
      const dispatch = RenderDispatchSchema.parse({
        contractVersion: 1,
        jobUuid: input.jobUuid,
        template: input.template.spec,
        templateSpecHash: input.template.specHash,
        presetId: input.request.presetId,
        requestHash: input.requestHash,
        slotInputs: input.request.slotInputs,
      });
      await connection.query(
        `INSERT INTO stationery_render_outbox
          (render_job_id, dispatch_key, payload_json, state, attempt_count, available_at, created_at, updated_at)
         SELECT id, ?, ?, 'pending', 0, ?, ?, ?
         FROM stationery_render_jobs WHERE job_uuid = ?`,
        [input.jobUuid, JSON.stringify(dispatch), toSqlDate(input.createdAt), toSqlDate(input.createdAt), toSqlDate(input.createdAt), input.jobUuid],
      );
      const created = await findRenderJobByUuid(connection, input.ownerId, input.jobUuid);
      if (!created) throw new Error("RENDER_JOB_INSERT_FAILED");
      await connection.commit();
      return { job: created, created: true };
    } catch (error: any) {
      await connection.rollback();
      if (error?.code === "ER_DUP_ENTRY") {
        const existing = await findRenderJobByIdempotency(pool, input.ownerId, input.idempotencyKey);
        if (existing) return { job: existing, created: false };
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  getRenderJob(ownerId: string, jobUuid: string): Promise<RenderJobPublic | null> {
    return findRenderJobByUuid(this.getPool(), ownerId, jobUuid);
  }

  getRenderJobByIdempotency(ownerId: string, idempotencyKey: string): Promise<RenderJobPublic | null> {
    return findRenderJobByIdempotency(this.getPool(), ownerId, idempotencyKey);
  }

  async getRenderJobForCompletion(jobUuid: string): Promise<RenderJobCompletionRecord | null> {
    const [rows]: any = await this.getPool().query(
      `${renderJobSelect()}
       WHERE rj.job_uuid = ?
       LIMIT 1`,
      [jobUuid],
    );
    if (!rows[0]) return null;
    const publicJob = parseRenderJob(rows[0]);
    return {
      ...publicJob,
      ownerId: String(rows[0].owner_id),
      request: parseJson(rows[0].request_json),
      templateSpecHash: String(rows[0].spec_hash),
    };
  }

  async recordRenderDispatchFailure(jobUuid: string, failureCode: string, updatedAt: string): Promise<void> {
    const connection = await this.getPool().getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        `UPDATE stationery_render_jobs
         SET state = 'dispatch_failed', failure_code = ?, updated_at = ?
         WHERE job_uuid = ? AND state IN ('queued', 'dispatch_failed')`,
        [failureCode, toSqlDate(updatedAt), jobUuid],
      );
      await connection.query(
        `UPDATE stationery_render_outbox o
         JOIN stationery_render_jobs rj ON rj.id = o.render_job_id
         SET o.state = 'pending', o.attempt_count = o.attempt_count + 1,
             o.available_at = DATE_ADD(?, INTERVAL 30 SECOND), o.updated_at = ?
         WHERE rj.job_uuid = ? AND o.state <> 'dispatched'`,
        [toSqlDate(updatedAt), toSqlDate(updatedAt), jobUuid],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async recordRenderDispatched(jobUuid: string, updatedAt: string): Promise<void> {
    const connection = await this.getPool().getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        `UPDATE stationery_render_jobs
         SET state = 'rendering', failure_code = NULL, updated_at = ?
         WHERE job_uuid = ? AND state IN ('queued', 'dispatch_failed', 'rendering')`,
        [toSqlDate(updatedAt), jobUuid],
      );
      await connection.query(
        `UPDATE stationery_render_outbox o
         JOIN stationery_render_jobs rj ON rj.id = o.render_job_id
         SET o.state = 'dispatched', o.attempt_count = o.attempt_count + 1, o.updated_at = ?
         WHERE rj.job_uuid = ?`,
        [toSqlDate(updatedAt), jobUuid],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async completeRenderJobImmutable(input: {
    jobUuid: string;
    renderManifest: any;
    validationReport: any;
    updatedAt: string;
  }): Promise<RenderJobPublic> {
    const manifest = SealedRenderManifestSchema.parse(input.renderManifest);
    const report = StationeryValidationReportSchema.parse(input.validationReport);
    const [result]: any = await this.getPool().query(
      `UPDATE stationery_render_jobs rj
       JOIN assets a ON a.asset_uuid = ?
       JOIN asset_versions av ON av.asset_id = a.id AND av.version_number = ?
       SET rj.state = 'ready', rj.render_manifest_json = ?, rj.render_manifest_hash = ?,
           rj.validation_report_json = ?, rj.output_asset_uuid = ?, rj.output_version_number = ?,
           rj.output_asset_id = a.id, rj.output_asset_version_id = av.id,
           rj.failure_code = NULL, rj.updated_at = ?
       WHERE rj.job_uuid = ? AND rj.state IN ('queued', 'dispatch_failed', 'rendering')`,
      [
        manifest.output.assetUuid,
        manifest.output.versionNumber,
        JSON.stringify(manifest),
        manifest.manifestHash,
        JSON.stringify(report),
        manifest.output.assetUuid,
        manifest.output.versionNumber,
        toSqlDate(input.updatedAt),
        input.jobUuid,
      ],
    );
    const job = await this.getRenderJobForCompletion(input.jobUuid);
    if (!job) throw new Error("RENDER_JOB_NOT_FOUND");
    if (Number(result.affectedRows) === 0 && job.renderManifest?.manifestHash !== manifest.manifestHash) {
      throw new Error("IMMUTABLE_RENDER_CONFLICT");
    }
    return RenderJobPublicSchema.strip().parse(job);
  }

  async createFrozenPrintOrderIdempotent(input: FrozenPrintOrderInsert): Promise<{ order: PrintOrderPublic; created: boolean }> {
    const pool = this.getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const existing = await findPrintOrderByIdempotency(connection, input.ownerId, input.clientIdempotencyKey);
      if (existing) {
        await connection.commit();
        return { order: existing, created: false };
      }
      const [jobRows]: any = await connection.query(
        "SELECT id FROM stationery_render_jobs WHERE job_uuid = ? AND owner_id = ? AND state = 'ready' LIMIT 1 FOR SHARE",
        [input.renderJobUuid, input.ownerId],
      );
      if (!jobRows[0]) throw new Error("RENDER_NOT_READY");
      const [manifestResult]: any = await connection.query(
        `INSERT INTO stationery_print_manifests
          (local_order_uuid, owner_id, render_job_id, client_idempotency_key, request_hash,
           manifest_json, manifest_hash, payment_evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.localOrderUuid,
          input.ownerId,
          jobRows[0].id,
          input.clientIdempotencyKey,
          input.requestHash,
          JSON.stringify(input.manifest),
          input.manifest.manifestHash,
          JSON.stringify(input.paymentEvidence),
          toSqlDate(input.createdAt),
        ],
      );
      const snapshot = createProviderSubmission({
        localOrderUuid: input.localOrderUuid,
        provider: input.manifest.provider,
        printManifestHash: input.manifest.manifestHash,
        paymentState: "paid",
        createdAt: input.createdAt,
      });
      if (snapshot.idempotencyKey !== input.providerIdempotencyKey) throw new Error("PROVIDER_IDEMPOTENCY_MISMATCH");
      await connection.query(
        `INSERT INTO stationery_fulfillment_orders
          (local_order_uuid, print_manifest_id, provider, provider_idempotency_key, payment_state,
           state, provider_order_id, applied_event_ids_json, state_changed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshot.localOrderUuid,
          manifestResult.insertId,
          snapshot.provider,
          snapshot.idempotencyKey,
          snapshot.paymentState,
          snapshot.state,
          snapshot.providerOrderId,
          JSON.stringify(snapshot.appliedEventIds),
          toSqlDate(snapshot.stateChangedAt),
          toSqlDate(snapshot.updatedAt),
        ],
      );
      const created = await findPrintOrderByUuid(connection, input.localOrderUuid, input.ownerId);
      if (!created) throw new Error("PRINT_ORDER_INSERT_FAILED");
      await connection.commit();
      return { order: created, created: true };
    } catch (error: any) {
      await connection.rollback();
      if (error?.code === "ER_DUP_ENTRY") {
        const existing = await findPrintOrderByIdempotency(pool, input.ownerId, input.clientIdempotencyKey);
        if (existing) return { order: existing, created: false };
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  getPrintOrder(ownerId: string, localOrderUuid: string): Promise<PrintOrderPublic | null> {
    return findPrintOrderByUuid(this.getPool(), localOrderUuid, ownerId);
  }

  getPrintOrderByIdempotency(ownerId: string, idempotencyKey: string): Promise<PrintOrderPublic | null> {
    return findPrintOrderByIdempotency(this.getPool(), ownerId, idempotencyKey);
  }

  async getPrintOrderByUuid(localOrderUuid: string): Promise<(PrintOrderPublic & { ownerId: string }) | null> {
    const [rows]: any = await this.getPool().query(`${printOrderSelect()} WHERE pm.local_order_uuid = ? LIMIT 1`, [localOrderUuid]);
    if (!rows[0]) return null;
    return { ...parsePrintOrder(rows[0]), ownerId: String(rows[0].owner_id) };
  }

  async getPrintOrderByProviderReference(input: { provider: "printful" | "slant3d"; providerIdempotencyKey?: string; providerOrderId?: string }): Promise<PrintOrderPublic | null> {
    if (!input.providerIdempotencyKey && !input.providerOrderId) return null;
    const clauses = ["fo.provider = ?"];
    const values: unknown[] = [input.provider];
    const references: string[] = [];
    if (input.providerIdempotencyKey) { references.push("fo.provider_idempotency_key = ?"); values.push(input.providerIdempotencyKey); }
    if (input.providerOrderId) { references.push("fo.provider_order_id = ?"); values.push(input.providerOrderId); }
    clauses.push(`(${references.join(" OR ")})`);
    const [rows]: any = await this.getPool().query(`${printOrderSelect()} WHERE ${clauses.join(" AND ")} LIMIT 1`, values);
    return rows[0] ? parsePrintOrder(rows[0]) : null;
  }

  async getByLocalOrderUuid(localOrderUuid: string): Promise<ProviderSubmission | null> {
    const [rows]: any = await this.getPool().query(
      `SELECT fo.*, pm.manifest_hash AS print_manifest_hash
       FROM stationery_fulfillment_orders fo
       JOIN stationery_print_manifests pm ON pm.local_order_uuid = fo.local_order_uuid
       WHERE fo.local_order_uuid = ? LIMIT 1`,
      [localOrderUuid],
    );
    return rows[0] ? parseSubmission(rows[0]) : null;
  }

  async withOrderLock<T>(localOrderUuid: string, work: (repository: FulfillmentLockedRepositoryPort) => Promise<T>): Promise<T> {
    const connection = await this.getPool().getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        "SELECT id FROM stationery_fulfillment_orders WHERE local_order_uuid = ? LIMIT 1 FOR UPDATE",
        [localOrderUuid],
      );
      const result = await work(new MySqlLockedFulfillmentRepository(connection, localOrderUuid));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async recordReconciliation(input: Parameters<StationeryApiRepositoryPort["recordReconciliation"]>[0]): Promise<void> {
    await this.getPool().query(
      `INSERT INTO stationery_reconciliation_runs
        (reconciliation_uuid, local_order_uuid, requested_by_owner_id, reason,
         observation_json, decision_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.reconciliationUuid,
        input.localOrderUuid,
        input.requestedByOwnerId,
        input.reason,
        input.observation ? JSON.stringify(input.observation) : null,
        JSON.stringify(input.decision),
        toSqlDate(input.recordedAt),
      ],
    );
  }
}

class MySqlLockedFulfillmentRepository implements FulfillmentLockedRepositoryPort {
  constructor(
    private readonly connection: mysql.PoolConnection,
    private readonly localOrderUuid: string,
  ) {}

  async claimProviderEventId(
    provider: "printful" | "slant3d",
    providerEventId: string,
    localOrderUuid: string,
  ): Promise<"inserted" | "existing" | "conflict"> {
    try {
      await this.connection.query(
        `INSERT INTO stationery_provider_event_claims (provider, provider_event_id, local_order_uuid, claimed_at)
         VALUES (?, ?, ?, NOW(3))`,
        [provider, providerEventId, localOrderUuid],
      );
      return "inserted";
    } catch (error: any) {
      if (error?.code !== "ER_DUP_ENTRY") throw error;
    }
    const [rows]: any = await this.connection.query(
      "SELECT local_order_uuid FROM stationery_provider_event_claims WHERE provider = ? AND provider_event_id = ? LIMIT 1",
      [provider, providerEventId],
    );
    return rows[0]?.local_order_uuid === localOrderUuid ? "existing" : "conflict";
  }

  async recordProviderEventEvidence(input: Parameters<FulfillmentLockedRepositoryPort["recordProviderEventEvidence"]>[0]): Promise<void> {
    const event = ProviderEventSchema.parse(input.event);
    await this.connection.query(
      `INSERT INTO stationery_provider_events
        (provider, provider_event_id, local_order_uuid, event_json, disposition, reason, occurred_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.provider,
        event.eventId,
        input.localOrderUuid,
        JSON.stringify(event),
        input.disposition,
        input.reason,
        toSqlDate(event.occurredAt),
        toSqlDate(input.recordedAt),
      ],
    );
  }

  async insertIfAbsent(snapshot: ProviderSubmission): Promise<"inserted" | "existing"> {
    const parsed = ProviderSubmissionSchema.parse(snapshot);
    const [manifestRows]: any = await this.connection.query(
      "SELECT id FROM stationery_print_manifests WHERE local_order_uuid = ? LIMIT 1",
      [this.localOrderUuid],
    );
    if (!manifestRows[0]) throw new Error("PRINT_MANIFEST_NOT_FOUND");
    const [result]: any = await this.connection.query(
      `INSERT IGNORE INTO stationery_fulfillment_orders
        (local_order_uuid, print_manifest_id, provider, provider_idempotency_key, payment_state,
         state, provider_order_id, applied_event_ids_json, state_changed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parsed.localOrderUuid,
        manifestRows[0].id,
        parsed.provider,
        parsed.idempotencyKey,
        parsed.paymentState,
        parsed.state,
        parsed.providerOrderId,
        JSON.stringify(parsed.appliedEventIds),
        toSqlDate(parsed.stateChangedAt),
        toSqlDate(parsed.updatedAt),
      ],
    );
    return Number(result.affectedRows) === 1 ? "inserted" : "existing";
  }

  async getForUpdate(): Promise<ProviderSubmission | null> {
    const [rows]: any = await this.connection.query(
      `SELECT fo.*, pm.manifest_hash AS print_manifest_hash
       FROM stationery_fulfillment_orders fo
       JOIN stationery_print_manifests pm ON pm.local_order_uuid = fo.local_order_uuid
       WHERE fo.local_order_uuid = ? LIMIT 1 FOR UPDATE`,
      [this.localOrderUuid],
    );
    return rows[0] ? parseSubmission(rows[0]) : null;
  }

  async saveTransition(expectedUpdatedAt: string, snapshot: ProviderSubmission): Promise<"saved" | "conflict"> {
    const parsed = ProviderSubmissionSchema.parse(snapshot);
    const [result]: any = await this.connection.query(
      `UPDATE stationery_fulfillment_orders
       SET payment_state = ?, state = ?, provider_order_id = ?, applied_event_ids_json = ?,
           state_changed_at = ?, updated_at = ?
       WHERE local_order_uuid = ? AND updated_at = ?`,
      [
        parsed.paymentState,
        parsed.state,
        parsed.providerOrderId,
        JSON.stringify(parsed.appliedEventIds),
        toSqlDate(parsed.stateChangedAt),
        toSqlDate(parsed.updatedAt),
        this.localOrderUuid,
        toSqlDate(expectedUpdatedAt),
      ],
    );
    return Number(result.affectedRows) === 1 ? "saved" : "conflict";
  }
}

async function findRenderJobByUuid(queryable: Queryable, ownerId: string, jobUuid: string): Promise<RenderJobPublic | null> {
  const [rows]: any = await queryable.query(`${renderJobSelect()} WHERE rj.owner_id = ? AND rj.job_uuid = ? LIMIT 1`, [ownerId, jobUuid]);
  return rows[0] ? parseRenderJob(rows[0]) : null;
}

async function findRenderJobByIdempotency(queryable: Queryable, ownerId: string, idempotencyKey: string): Promise<RenderJobPublic | null> {
  const [rows]: any = await queryable.query(
    `${renderJobSelect()} WHERE rj.owner_id = ? AND rj.client_idempotency_key = ? LIMIT 1`,
    [ownerId, idempotencyKey],
  );
  return rows[0] ? parseRenderJob(rows[0]) : null;
}

function renderJobSelect(): string {
  return `SELECT rj.*, tv.template_uuid, tv.version_number AS template_version_number, tv.spec_hash
          FROM stationery_render_jobs rj
          JOIN stationery_template_versions tv ON tv.id = rj.template_version_id`;
}

function parseRenderJob(row: any): RenderJobPublic {
  const manifest = row.render_manifest_json ? SealedRenderManifestSchema.parse(parseJson(row.render_manifest_json)) : null;
  return RenderJobPublicSchema.parse({
    jobUuid: String(row.job_uuid),
    templateUuid: String(row.template_uuid),
    templateVersionNumber: Number(row.template_version_number),
    presetId: String(row.preset_id),
    state: row.state,
    requestHash: String(row.request_hash),
    validationReport: StationeryValidationReportSchema.parse(parseJson(row.validation_report_json)),
    renderManifest: manifest,
    output: manifest?.output ?? null,
    failureCode: row.failure_code ? String(row.failure_code) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

async function findPrintOrderByUuid(queryable: Queryable, localOrderUuid: string, ownerId: string): Promise<PrintOrderPublic | null> {
  const [rows]: any = await queryable.query(
    `${printOrderSelect()} WHERE pm.local_order_uuid = ? AND pm.owner_id = ? LIMIT 1`,
    [localOrderUuid, ownerId],
  );
  return rows[0] ? parsePrintOrder(rows[0]) : null;
}

async function findPrintOrderByIdempotency(queryable: Queryable, ownerId: string, idempotencyKey: string): Promise<PrintOrderPublic | null> {
  const [rows]: any = await queryable.query(
    `${printOrderSelect()} WHERE pm.owner_id = ? AND pm.client_idempotency_key = ? LIMIT 1`,
    [ownerId, idempotencyKey],
  );
  return rows[0] ? parsePrintOrder(rows[0]) : null;
}

function printOrderSelect(): string {
  return `SELECT pm.*, fo.provider, fo.provider_idempotency_key, fo.state, fo.provider_order_id,
                 fo.updated_at, rj.job_uuid AS render_job_uuid
          FROM stationery_print_manifests pm
          JOIN stationery_fulfillment_orders fo ON fo.local_order_uuid = pm.local_order_uuid
          JOIN stationery_render_jobs rj ON rj.id = pm.render_job_id`;
}

function parsePrintOrder(row: any): PrintOrderPublic {
  const payment = PaymentEvidenceSchema.parse(parseJson(row.payment_evidence_json));
  const { ownerId: _ownerId, ...publicPayment } = payment;
  return PrintOrderPublicSchema.parse({
    localOrderUuid: String(row.local_order_uuid),
    renderJobUuid: String(row.render_job_uuid),
    provider: row.provider,
    state: row.state,
    providerOrderId: row.provider_order_id ? String(row.provider_order_id) : null,
    providerIdempotencyKey: String(row.provider_idempotency_key),
    printManifest: SealedPrintManifestSchema.parse(parseJson(row.manifest_json)),
    paymentEvidence: publicPayment,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function parseSubmission(row: any): ProviderSubmission {
  return ProviderSubmissionSchema.parse({
    schemaVersion: "fulfillment.submission.v1",
    localOrderUuid: String(row.local_order_uuid),
    provider: row.provider,
    printManifestHash: String(row.print_manifest_hash ?? ""),
    idempotencyKey: String(row.provider_idempotency_key),
    paymentState: row.payment_state,
    state: row.state,
    providerOrderId: row.provider_order_id ? String(row.provider_order_id) : null,
    appliedEventIds: parseJson(row.applied_event_ids_json),
    stateChangedAt: toIso(row.state_changed_at),
    updatedAt: toIso(row.updated_at),
  });
}

function parseJson(value: unknown): any {
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8"));
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function toIso(value: unknown): string {
  let date: Date;
  if (value instanceof Date) {
    // mysql2 constructs DATETIME values in the process timezone. Preserve the
    // stored UTC wall-clock components instead of applying that timezone twice.
    date = new Date(Date.UTC(
      value.getFullYear(),
      value.getMonth(),
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
      value.getMilliseconds(),
    ));
  } else {
    const raw = String(value).trim().replace(" ", "T");
    date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`);
  }
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_DATABASE_TIMESTAMP");
  return date.toISOString();
}

function toSqlDate(value: string): string {
  return new Date(value).toISOString().slice(0, 23).replace("T", " ");
}
