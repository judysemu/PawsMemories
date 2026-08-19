#!/usr/bin/env -S npx tsx
/**
 * Production environment doctor.
 *
 * The hosting panel is not a reliable readout: it has shown a blank field for a
 * populated value, and shown a value as saved when the save had not persisted.
 * Both cost real debugging time, and the second left production serving a
 * revoked credential while every presence check happily reported "configured".
 *
 * This asks the running process instead, via /readyz, and compares what it
 * reports against the local .env. Fingerprints are the first 8 hex of SHA-256 —
 * not invertible, but enough to prove two places hold the same value.
 *
 *   npx tsx scripts/manual/check-production-env.ts
 *   npx tsx scripts/manual/check-production-env.ts --url https://staging.example.com
 *
 * Exit codes: 0 all good · 1 drift or a missing credential · 2 could not reach.
 */
import "dotenv/config";
import { createHash } from "crypto";

const urlFlag = process.argv.indexOf("--url");
const BASE = urlFlag > 0 ? process.argv[urlFlag + 1] : "https://pawsome3d.com";

/** Local env var backing each provider key reported by /readyz. */
const LOCAL_SOURCE: Record<string, string> = {
  fal: "FAL_KEY",
  gemini: "GEMINI_API_KEY",
  resend: "RESEND_API_KEY",
  stripe: "STRIPE_SECRET_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  shopify: "SHOPIFY_CLIENT_SECRET",
  mediaBucket: "MEDIA_BUCKET_KEY",
  byokVault: "KEY_ENCRYPTION_SECRET",
};

const fingerprint = (value: string) =>
  createHash("sha256").update(value.trim()).digest("hex").slice(0, 8);

async function main(): Promise<void> {
  let body: any;
  try {
    const response = await fetch(`${BASE}/readyz`, { signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    // A restarting server answers 503 {"status":"starting"} from the readiness
    // gate, and a mid-boot 404 is no longer possible — but a proxy error page
    // still is, so fail on the parse rather than on a confusing key error.
    try {
      body = JSON.parse(text);
    } catch {
      console.error(`${BASE}/readyz did not return JSON (HTTP ${response.status}):`);
      console.error(text.slice(0, 200));
      process.exit(2);
    }
  } catch (err: any) {
    console.error(`Could not reach ${BASE}/readyz: ${err?.message || err}`);
    process.exit(2);
  }

  if (body.status !== "ready") {
    console.error(`Not ready: ${JSON.stringify(body).slice(0, 200)}`);
    process.exit(2);
  }

  const build = body.build || {};
  console.log(`${BASE}`);
  console.log(`  commit ${String(build.commit || "?").slice(0, 7)} · built ${build.builtAt} · schema ${build.schemaVersion}\n`);

  const present: Record<string, boolean> = body.providers || {};
  const remote: Record<string, string | null> = body.providerFingerprints || {};
  if (!Object.keys(remote).length) {
    console.error("This deployment predates providerFingerprints. Deploy a newer build.");
    process.exit(2);
  }

  let problems = 0;
  const rows: string[] = [];
  for (const name of Object.keys(present).sort()) {
    const localVar = LOCAL_SOURCE[name];
    const localValue = localVar ? String(process.env[localVar] || "").trim() : "";
    const localFp = localValue ? fingerprint(localValue) : null;
    const remoteFp = remote[name] ?? null;

    let verdict: string;
    if (!present[name]) {
      verdict = "MISSING in production";
      problems++;
    } else if (!localFp) {
      // Not having it locally is normal for server-only credentials; it just
      // means this run cannot corroborate the value, so say that rather than
      // implying agreement.
      verdict = "present (not in local .env — unverified)";
    } else if (localFp === remoteFp) {
      verdict = "matches local";
    } else {
      verdict = `DRIFT — local ${localFp}`;
      problems++;
    }
    rows.push(`  ${name.padEnd(13)} ${String(remoteFp ?? "-").padEnd(10)} ${verdict}`);
  }

  console.log("  provider      prod-fp    status");
  console.log(rows.join("\n"));

  if (problems) {
    console.log(`\n${problems} problem(s). DRIFT means production holds a different value than local —`);
    console.log("re-save it in the hosting panel, then run this again. The panel's own display");
    console.log("is not evidence either way.");
    process.exit(1);
  }
  console.log("\nAll reported credentials are present, and every one that could be checked matches local.");
}

main().catch((err) => { console.error(err?.message || err); process.exit(2); });
