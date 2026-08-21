#!/usr/bin/env -S npx tsx
/**
 * Verify a Hugging Face ZeroGPU Space before anything depends on it.
 *
 *   ZEROGPU_SPACE=owner/space HF_TOKEN=hf_... npx tsx scripts/manual/zerogpu-probe.ts
 *   ... npx tsx scripts/manual/zerogpu-probe.ts --call predict --arg '"hello"'
 *
 * Checks, cheapest first, so a wrong token is reported before any GPU time is
 * spent: token identity and tier, the Space's existence and hardware, its
 * declared API surface, and only then an optional real call.
 *
 * Tier matters more than it looks. The included daily allowance is 40 minutes
 * on PRO, 5 on a free account and 2 unauthenticated, so the same Space is a
 * usable test rig or nearly unusable depending on which token reaches it.
 */
import "dotenv/config";

const SPACE = String(process.env.ZEROGPU_SPACE || "").trim();
const TOKEN = String(process.env.HF_TOKEN || "").trim();
const callFlag = process.argv.indexOf("--call");
const CALL = callFlag > 0 ? process.argv[callFlag + 1] : null;
const argFlag = process.argv.indexOf("--arg");
const ARG = argFlag > 0 ? process.argv[argFlag + 1] : null;

const ok = (m: string) => console.log(`[  ok  ] ${m}`);
const bad = (m: string) => { console.log(`[ FAIL ] ${m}`); failures++; };
const warn = (m: string) => console.log(`[ warn ] ${m}`);
let failures = 0;

(async () => {
  if (!SPACE || !TOKEN) {
    console.error("Set ZEROGPU_SPACE (owner/name) and HF_TOKEN first.");
    console.error("A token lives at https://huggingface.co/settings/tokens — read scope is enough.");
    process.exit(2);
  }

  const auth = { Authorization: `Bearer ${TOKEN}` };

  // 1. Whose quota will this spend?
  try {
    const res = await fetch("https://huggingface.co/api/whoami-v2", { headers: auth });
    if (!res.ok) {
      bad(`token rejected by the Hub (${res.status}) — GPU calls will fall back to the 2 min/day unauthenticated tier`);
    } else {
      const me: any = await res.json();
      const plan = me?.periodEnd || me?.isPro ? "PRO" : (me?.type === "user" ? "free" : String(me?.type || "unknown"));
      ok(`token belongs to ${me?.name || "?"} (${plan})`);
      if (plan !== "PRO") {
        warn("not a PRO account — included allowance is 5 min/day, not 40. Hosting your own ZeroGPU Space needs PRO (or a >30-day-old verified free account, max 2 Spaces).");
      }
      const orgs = (me?.orgs || []).map((o: any) => o.name).filter(Boolean);
      if (orgs.length) ok(`orgs: ${orgs.join(", ")}`);
    }
  } catch (err: any) {
    bad(`could not reach the Hub API: ${err?.message || err}`);
  }

  // 2. Does the Space exist, and is it actually on ZeroGPU?
  let sdk = "";
  try {
    const res = await fetch(`https://huggingface.co/api/spaces/${SPACE}`, { headers: auth });
    if (!res.ok) {
      bad(`Space ${SPACE} not found or not visible to this token (${res.status})`);
    } else {
      const s: any = await res.json();
      sdk = String(s?.sdk || "");
      const hardware = s?.runtime?.hardware?.current || s?.runtime?.hardware?.requested || "unknown";
      const stage = s?.runtime?.stage || "unknown";
      ok(`Space found — sdk=${sdk || "?"} hardware=${hardware} stage=${stage} private=${!!s?.private}`);

      if (sdk && sdk !== "gradio") {
        bad(`sdk is "${sdk}" — ZeroGPU is Gradio-SDK only. A Docker Space cannot use ZeroGPU.`);
      }
      if (!String(hardware).toLowerCase().includes("zero")) {
        warn(`hardware reports "${hardware}" — if this is not zero-a10g/zerogpu the Space is not on the shared pool`);
      }
      if (stage !== "RUNNING") {
        warn(`stage is ${stage} — a sleeping Space wakes on first request, so the first call will be slow`);
      }
    }
  } catch (err: any) {
    bad(`could not read the Space: ${err?.message || err}`);
  }

  // 3. What endpoints does it expose? Names are what the client calls.
  const host = `https://${SPACE.replace("/", "-").toLowerCase()}.hf.space`;
  try {
    const res = await fetch(`${host}/gradio_api/info`, { headers: auth, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      warn(`could not read ${host}/gradio_api/info (${res.status}) — the Space may still be building`);
    } else {
      const info: any = await res.json();
      const named = Object.keys(info?.named_endpoints || {});
      if (named.length) {
        ok(`named endpoints: ${named.join(", ")}`);
        for (const name of named) {
          const ep = info.named_endpoints[name];
          const params = (ep?.parameters || []).map((p: any) => `${p.parameter_name || p.label}:${p.type?.type || "?"}`);
          console.log(`         ${name}(${params.join(", ")}) -> ${(ep?.returns || []).length} output(s)`);
        }
      } else {
        warn("no named endpoints — add api_name= to the Gradio event so the backend can address it");
      }
    }
  } catch (err: any) {
    warn(`endpoint discovery failed: ${err?.message || err}`);
  }

  // 4. Optional: spend real GPU time.
  if (CALL) {
    // Only @spaces.GPU-decorated endpoints allocate a GPU; a plain Gradio
    // function costs nothing. The probe cannot tell which is which from the
    // API surface, so it warns rather than asserting.
    console.log(`\nCalling ${CALL} — spends daily GPU quota if the endpoint is GPU-decorated.`);
    const { callZeroGpu } = await import("../../server/labs/zerogpu.ts");
    try {
      const data = ARG ? [JSON.parse(ARG)] : [];
      const { result, elapsedMs } = await callZeroGpu(CALL, data, process.env);
      ok(`call succeeded in ${(elapsedMs / 1000).toFixed(1)}s`);
      console.log(`         result: ${JSON.stringify(result).slice(0, 300)}`);
      const seconds = Math.max(elapsedMs / 1000, 0.1);
      console.log(seconds < 5
        ? "         under 5s round trip — likely a CPU endpoint, so little or no quota was spent"
        : `         at this duration a 40 min/day allowance is about ${Math.floor(2400 / seconds)} calls`);
    } catch (err: any) {
      bad(`${err?.code || "call failed"}: ${err?.message || err}`);
      if (err?.consumedGpu) warn("this failure still consumed GPU quota");
    }
  } else {
    console.log("\nNo --call given, so no GPU time was spent. Add --call <endpoint> to test a real run.");
  }

  console.log(`\n${failures ? `${failures} problem(s).` : "No problems."}`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err?.message || err); process.exit(1); });
