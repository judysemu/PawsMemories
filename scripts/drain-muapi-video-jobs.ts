#!/usr/bin/env -S npx tsx
// One-off deploy step for the MuAPI -> fal.ai video provider cutover.
// Force-fails (and refunds) any Fur Reels video job still queued/running
// under the retired MuAPI provider at deploy time, using the same
// failGenerationJobAndRefundOnce path every other failure goes through so
// wallet ledger semantics stay correct. Run once, right before/at deploy.
// Usage: npm run drain:muapi-video          (dry run — lists affected jobs)
//        npm run drain:muapi-video -- --apply  (actually fails + refunds them)
import "dotenv/config";
import { getPool, closePool } from "../db";
import { failGenerationJobAndRefundOnce } from "../server/generationRefunds";

const APPLY = process.argv.includes("--apply");

async function run(): Promise<void> {
  const [rows] = await getPool().query(
    `SELECT j.id, j.user_phone, j.credits_reserved
       FROM generation_jobs j
       JOIN ai_video_requests v ON v.job_id = j.id
      WHERE j.status IN ('queued','running') AND v.provider = 'muapi'`,
  );
  const jobs = rows as { id: number; user_phone: string; credits_reserved: number }[];

  if (!jobs.length) {
    console.log("No in-flight MuAPI video jobs found. Nothing to drain.");
    await closePool();
    return;
  }

  console.log(`Found ${jobs.length} in-flight MuAPI video job(s):`);
  for (const job of jobs) {
    console.log(`  job ${job.id} (user ${job.user_phone}, ${job.credits_reserved} credits reserved)`);
  }

  if (!APPLY) {
    console.log("\nDry run only — pass --apply to fail and refund these jobs.");
    await closePool();
    return;
  }

  for (const job of jobs) {
    const result = await failGenerationJobAndRefundOnce(
      getPool(),
      job.id,
      "Video provider migrated from MuAPI to fal.ai; please regenerate.",
    );
    console.log(`  job ${job.id}: ${result.status}, refundApplied=${result.refundApplied}`);
  }

  await closePool();
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
