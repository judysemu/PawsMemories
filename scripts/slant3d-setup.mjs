#!/usr/bin/env node
/**
 * scripts/slant3d-setup.mjs
 *
 * One-shot setup for the three SLANT3D_* env vars that server/slant3d.ts needs:
 *
 *   SLANT3D_API_KEY              (you already have this — the script reads it)
 *   SLANT3D_PLATFORM_ID          (this script creates or finds it)
 *   SLANT3D_DEFAULT_FILAMENT_ID  (this script lists candidates)
 *
 * `slant3dConfigured()` requires all three. Until they're set, model printing
 * is disabled and the UI shows "Physical model printing is being configured".
 *
 * The script NEVER writes your API key anywhere — it reads it from the
 * environment and prints only the two non-secret IDs you need to paste into
 * Hostinger.
 *
 * Usage:
 *   export SLANT3D_API_KEY='sl-...'          # or put it in .env
 *   node scripts/slant3d-setup.mjs           # inspect only, creates nothing
 *   node scripts/slant3d-setup.mjs --create  # create the platform if absent
 *
 * Docs: https://slant3dapi.com/documentation/platforms
 *       https://slant3dapi.com/documentation/filaments
 */

import fs from "node:fs";
import path from "node:path";

const BASE_URL = (process.env.SLANT3D_API_BASE_URL || "https://slant3dapi.com/v2/api").replace(/\/$/, "");

// Match the platform to the production site so the Slant dashboard is legible.
const PLATFORM = {
  name: "Pawsome3D",
  url: process.env.APP_URL || "https://pawsome3d.com",
  description: "Custom 3D pet models printed as physical keepsakes.",
  // webhookURL deliberately omitted: there is no /api/print/slant3d/webhook
  // route in server.ts yet, and Slant requires a reachable HTTPS endpoint.
  // Registering a URL that 404s is worse than registering none. Add it later
  // with a PATCH once the handler exists.
};

// ── Load .env if the key isn't already exported ──────────────────────────────
if (!process.env.SLANT3D_API_KEY) {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

const API_KEY = String(process.env.SLANT3D_API_KEY || "").trim();
if (!API_KEY) {
  console.error(`
✖ SLANT3D_API_KEY is not set.

  Note the name: the code reads SLANT3D_API_KEY (with the "3D").
  If you have SLANT_API_KEY set in Hostinger, that variable is read by
  nothing — rename it.

  export SLANT3D_API_KEY='sl-...'   then re-run.
`);
  process.exit(1);
}

const CREATE = process.argv.includes("--create");

async function api(pathname, init = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    const msg = payload?.message || payload?.error || payload?.raw || `HTTP ${res.status}`;
    throw new Error(`${init.method || "GET"} ${pathname} → ${res.status}: ${msg}`);
  }
  return payload;
}

/** Slant wraps collections inconsistently; unwrap defensively. */
function listFrom(payload, keys) {
  if (Array.isArray(payload)) return payload;
  const data = payload?.data ?? payload;
  if (Array.isArray(data)) return data;
  for (const k of keys) {
    if (Array.isArray(data?.[k])) return data[k];
    if (Array.isArray(payload?.[k])) return payload[k];
  }
  return [];
}

function idOf(obj) {
  return String(obj?.publicId || obj?.id || obj?.platformId || "");
}

async function main() {
  console.log(`\nSlant 3D setup — ${BASE_URL}\n${"─".repeat(64)}`);

  // ── 1. Platforms ───────────────────────────────────────────────────────────
  console.log("\n▸ Existing platforms");
  const platformsPayload = await api("/platforms");
  const platforms = listFrom(platformsPayload, ["platforms", "items", "results"]);

  if (platforms.length) {
    for (const p of platforms) {
      console.log(`   • ${p?.name || "(unnamed)"}`);
      console.log(`     publicId: ${idOf(p)}`);
      console.log(`     url:      ${p?.url || "—"}`);
      console.log(`     webhook:  ${p?.webhookURL || "(none)"}`);
    }
  } else {
    console.log("   (none)");
  }

  let platformId = "";
  const existing = platforms.find(
    (p) => String(p?.name || "").toLowerCase() === PLATFORM.name.toLowerCase()
  );

  if (existing) {
    platformId = idOf(existing);
    console.log(`\n   ✔ Reusing existing "${PLATFORM.name}" platform.`);
  } else if (CREATE) {
    console.log(`\n▸ Creating platform "${PLATFORM.name}"…`);
    const created = await api("/platforms", {
      method: "POST",
      body: JSON.stringify(PLATFORM),
    });
    const p = created?.data?.platform || created?.data || created?.platform || created;
    platformId = idOf(p);
    console.log(`   ✔ Created. publicId: ${platformId}`);
    if (p?.webhookSecret) {
      // Never emit provider secrets to terminals, CI logs, or agent traces.
      // There is no Slant webhook handler yet, so operators should rotate and
      // store a secret through the provider dashboard when that route exists.
      console.log("   ℹ A webhook secret was issued but intentionally not displayed. Rotate it when webhook support is enabled.");
    }
  } else {
    console.log(`\n   ⚠ No platform named "${PLATFORM.name}".`);
    console.log("     Re-run with --create to make one, or create it on the Account page.");
  }

  // ── 2. Filaments ───────────────────────────────────────────────────────────
  console.log(`\n▸ Available filaments`);
  const filamentsPayload = await api("/filaments");
  const filaments = listFrom(filamentsPayload, ["filaments", "items", "results"]);
  const available = filaments.filter((f) => f?.available !== false);

  console.log(`   ${filaments.length} total, ${available.length} currently available.\n`);

  // Neutral colours read best for a pet figurine and hide layer lines better
  // than a saturated colour. Surface these first as suggestions.
  const preferred = /matte black|black|matte white|white|grey|gray/i;
  const sorted = [...available].sort((a, b) => {
    const ap = preferred.test(String(a?.name || a?.color || "")) ? 0 : 1;
    const bp = preferred.test(String(b?.name || b?.color || "")) ? 0 : 1;
    return ap - bp || String(a?.name || "").localeCompare(String(b?.name || ""));
  });

  for (const f of sorted) {
    const star = preferred.test(String(f?.name || f?.color || "")) ? "★" : " ";
    console.log(
      `   ${star} ${String(f?.name || f?.color || "(unnamed)").padEnd(28)} ` +
      `${String(f?.profile || "").padEnd(6)} ${idOf(f)}`
    );
  }

  const unavailable = filaments.length - available.length;
  if (unavailable > 0) {
    console.log(`\n   (${unavailable} filament(s) hidden — currently out of stock)`);
  }

  // ── 3. What to paste ───────────────────────────────────────────────────────
  const suggested = sorted[0];
  console.log(`\n${"─".repeat(64)}\nSet these in Hostinger:\n`);
  console.log(`  SLANT3D_API_KEY=<your existing key — RENAME from SLANT_API_KEY>`);
  console.log(`  SLANT3D_PLATFORM_ID=${platformId || "<run with --create>"}`);
  console.log(`  SLANT3D_DEFAULT_FILAMENT_ID=${suggested ? idOf(suggested) : "<pick from the list above>"}`);
  if (suggested) {
    console.log(`\n  (suggested filament: ${suggested?.name || suggested?.color} — ★ = neutral, hides layer lines)`);
  }
  console.log(`
  SLANT3D_API_BASE_URL is optional — the code already defaults to
  ${BASE_URL}

  ⚠ Filament availability changes. slant3d.ts checks \`available\` at order
    time, so if your chosen filament goes out of stock, print checkout starts
    failing. Re-run this script to pick a replacement.

  Verify afterwards with the admin deployment gate, which calls
  verifySlant3dConfiguration() and checks platformValid + filamentAvailable.
`);
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}\n`);
  if (/401|403|unauthor/i.test(err.message)) {
    console.error("  That looks like an auth failure — check the API key is current and active.\n");
  }
  process.exit(1);
});
