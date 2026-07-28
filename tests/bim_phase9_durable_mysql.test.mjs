import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import { hashBimContract } from "../server/bim/contracts.ts";
import { DurableBimRepository } from "../server/bim/durableRepository.ts";
import { DurableBimService } from "../server/bim/durableService.ts";
import { runMigrations } from "../server/migrations/runner.ts";

const config = {
  host: process.env.MYSQL_TEST_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_TEST_PORT || 3306),
  user: process.env.MYSQL_TEST_USER || "root",
  password: process.env.MYSQL_TEST_PASSWORD || "",
};

test("migration 29 backs owner-scoped durable BIM idempotency", async (t) => {
  let admin;
  try {
    admin = await mysql.createConnection(config);
  } catch {
    t.skip("Local MySQL is not available");
    return;
  }

  const database = `paws_bim_v2_${process.pid}_${Date.now()}`;
  let pool;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``);
    pool = mysql.createPool({ ...config, database, connectionLimit: 3 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        phone VARCHAR(32) PRIMARY KEY,
        password_hash VARCHAR(255) NULL,
        credits INT NOT NULL DEFAULT 0
      )
    `);
    await runMigrations(pool);

    const repository = new DurableBimRepository(pool);
    let refundState = "committed";
    let workerMode = "success";
    const credits = {
      quote: async ({ expectedCredits }) => ({ amountCredits: expectedCredits, evidenceHash: "1".repeat(64) }),
      debit: async () => ({ state: "committed", evidenceHash: "2".repeat(64) }),
      refund: async () => ({ state: refundState, evidenceHash: "3".repeat(64) }),
      reconcile: async () => ({ state: "committed", evidenceHash: "4".repeat(64) }),
    };
    const worker = {
      async build(command) {
        if (workerMode === "throw") throw new Error("temporary worker outage");
        return { result: {
          contractVersion: "phase9-v2.0.0",
          jobUuid: command.jobUuid,
          attemptUuid: command.attemptUuid,
          mode: command.mode,
          preBuildReportHash: command.preBuildReportHash,
          modelHash: command.modelHash,
          calibrationHash: command.calibrationHash,
          outputSha256: "c".repeat(64),
          evidence: { reopened: true },
        } };
      },
    };
    const artifactRegistrar = {
      async register({ command }) {
        const assetUuid = crypto.randomUUID();
        const [assetResult] = await pool.query(
          "INSERT INTO assets (asset_uuid, owner_id, asset_type) VALUES (?, ?, 'bim_shell_glb')",
          [assetUuid, command.ownerKey],
        );
        const [versionResult] = await pool.query(
          `INSERT INTO asset_versions
            (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key)
           VALUES (?, 1, ?, 'model/gltf-binary', 256, 'private', ?)`,
          [assetResult.insertId, "c".repeat(64), `bim/${command.jobUuid}/shell.glb`],
        );
        await pool.query("UPDATE assets SET current_version_id = ? WHERE id = ?", [versionResult.insertId, assetResult.insertId]);
        return [{
          role: "shell_glb",
          assetId: Number(assetResult.insertId),
          assetVersionId: Number(versionResult.insertId),
          assetUuid,
          versionNumber: 1,
          sha256: "c".repeat(64),
          sizeBytes: 256,
          mimeType: "model/gltf-binary",
        }];
      },
    };
    const service = new DurableBimService({
      repository,
      credits,
      worker,
      postBuildVerifier: {
        async verify({ command }) {
          const reportJson = { stage: "post-build", passed: true, mode: command.mode, modelHash: command.modelHash, calibrationHash: command.calibrationHash };
          return { reportHash: hashBimContract(reportJson), modelHash: command.modelHash, calibrationHash: command.calibrationHash, overallPass: true, reportJson };
        },
      },
      artifactRegistrar,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });

    const modelHash = "a".repeat(64);
    const calibrationHash = "b".repeat(64);
    const reportJson = { stage: "pre-build", mode: "shell", passed: true, modelHash, calibrationHash };
    const input = {
      mode: "shell",
      idempotencyKey: "mysql-durable-idempotency-0001",
      modelHash,
      calibrationHash,
      proposalHash: modelHash,
      acceptedProposalHash: modelHash,
      preBuild: {
        reportHash: hashBimContract(reportJson),
        overallPass: true,
        modelHash,
        calibrationHash,
        reportJson,
      },
    };

    const first = await service.enqueue("owner-a", input);
    const replay = await service.enqueue("owner-a", input);
    assert.equal(replay.jobUuid, first.jobUuid);
    assert.equal(await repository.getByUuid("owner-b", first.jobUuid), null);
    const ready = await service.runNext("mysql-worker-a");
    assert.equal(ready.state, "ready");
    const accepted = await service.accept("owner-a", first.jobUuid, ready.hashes.outputManifest);
    assert.equal(accepted.state, "accepted");

    const retryInput = structuredClone(input);
    retryInput.idempotencyKey = "mysql-durable-idempotency-0002";
    retryInput.preBuild.reportJson.buildCase = "retry";
    retryInput.preBuild.reportHash = hashBimContract(retryInput.preBuild.reportJson);
    workerMode = "throw";
    const retryJob = await service.enqueue("owner-a", retryInput);
    const retryable = await service.runNext("mysql-worker-b");
    assert.equal(retryable.state, "failed_retryable");
    const retried = await service.retry("owner-a", retryJob.jobUuid, "mysql-durable-retry-key-0001");
    assert.equal(retried.attempt.attemptNumber, 2);
    assert.equal(retried.verification.preBuildPassed, true);

    const cancelInput = structuredClone(input);
    cancelInput.idempotencyKey = "mysql-durable-idempotency-0003";
    cancelInput.preBuild.reportJson.buildCase = "cancel";
    cancelInput.preBuild.reportHash = hashBimContract(cancelInput.preBuild.reportJson);
    const cancelJob = await service.enqueue("owner-a", cancelInput);
    refundState = "unknown";
    const cancelled = await service.cancel("owner-a", cancelJob.jobUuid);
    assert.equal(cancelled.billing.refunded, false);
    assert.equal(cancelled.billing.refundState, "unknown");
    const reconciled = await service.reconcileCredits("owner-a", cancelJob.jobUuid);
    assert.equal(reconciled.billing.refunded, true);

    const [counts] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM bim_build_jobs_v2) AS jobs,
         (SELECT COUNT(*) FROM bim_build_attempts_v2) AS attempts,
         (SELECT COUNT(*) FROM bim_verification_reports_v2 WHERE stage = 'prebuild') AS reports,
         (SELECT COUNT(*) FROM bim_credit_events_v2 WHERE event_type = 'debit' AND state = 'committed') AS debits`,
    );
    assert.deepEqual(
      { jobs: Number(counts[0].jobs), attempts: Number(counts[0].attempts), reports: Number(counts[0].reports), debits: Number(counts[0].debits) },
      { jobs: 3, attempts: 4, reports: 3, debits: 3 },
    );
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
