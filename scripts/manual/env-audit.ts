#!/usr/bin/env -S npx tsx
/**
 * Reconcile the environment variables the code actually reads against the ones
 * the deployment documents.
 *
 *   npx tsx scripts/manual/env-audit.ts
 *   npx tsx scripts/manual/env-audit.ts --env .env      # also audit a real file
 *
 * A variable that is set but never read is not harmless. PAWS_3D_PROVIDER sat
 * in production selecting a provider that no longer existed; MUAPI_API_KEY is a
 * credential for a retired service still sitting in the panel. Both read as
 * live configuration to anyone auditing the deployment, and one of them was a
 * key worth rotating rather than keeping.
 *
 * Three sets are compared:
 *   READ        appears as process.env.X / env.X / env["X"] in shipped code
 *   DOCUMENTED  assigned in .env.example
 *   PRESENT     assigned in the file passed to --env, if any
 *
 * Dynamically composed names are handled explicitly rather than missed:
 * paidApiGuards.ts builds PETSIM_<ENDPOINT>_<SUFFIX> from a template literal,
 * so a naive grep would report every one of them as unread and recommend
 * deleting live caps.
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const envFlag = process.argv.indexOf("--env");
const ENV_FILE = envFlag > 0 ? process.argv[envFlag + 1] : null;

/** Directories holding code that ships or runs. Excludes tests: a name that
 *  only ever appears in a test is not evidence the product reads it. */
const PRODUCT_DIRS = ["server", "src", "shared"];
const TOOLING_DIRS = ["scripts"];
const CODE_FILES = ["server.ts", "db.ts", "auth.ts", "storage.ts", "storage.private.ts",
  "storage.http.ts", "tripo.ts", "heygen.ts", "avatarPrompts.ts", "skeletonContract.ts"];

/**
 * Names assembled at runtime, which no static scan can see.
 * paidApiGuards.ts: `PETSIM_${ENV_TOKEN[ep]}_${SUFFIX}`
 */
const DYNAMIC: string[] = (() => {
  const endpoints = ["CLASSIFY", "RIG", "SEMANTIC_SCAN", "IMAGE_GENERATION"];
  const suffixes = ["ENABLED", "DAILY_CAP", "GLOBAL_DAILY_CAP",
    "ESTIMATED_COST_MICRO_USD", "GLOBAL_DAILY_COST_MICRO_USD"];
  return endpoints.flatMap((e) => suffixes.map((s) => `PETSIM_${e}_${s}`));
})();

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

function readNamesFrom(source: string): Set<string> {
  const found = new Set<string>();
  // process.env.NAME · process.env["NAME"] · env.NAME · env["NAME"]
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[["'`]([A-Z][A-Z0-9_]*)["'`]\]/g,
    /\benv\.([A-Z][A-Z0-9_]*)/g,
    /\benv\[["'`]([A-Z][A-Z0-9_]*)["'`]\]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) found.add(m[1]);
  }
  return found;
}

function assignedNames(file: string): Set<string> {
  const found = new Set<string>();
  if (!fs.existsSync(file)) return found;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m) found.add(m[1]);
  }
  return found;
}

const productFiles = [
  ...PRODUCT_DIRS.flatMap((d) => walk(path.join(ROOT, d))),
  ...CODE_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
];
const toolingFiles = TOOLING_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const files = [...productFiles, ...toolingFiles];

// Separated deliberately. A name read only by an operator script is not
// production configuration -- and one of them, the model-generator doctor,
// reads PAWS_3D_PROVIDER precisely to warn that it is inert. Counting that as
// "the product reads it" would recommend keeping the variable it exists to
// flag for deletion.
const PRODUCT_READ = new Set<string>(DYNAMIC);
for (const file of productFiles) {
  for (const name of readNamesFrom(fs.readFileSync(file, "utf8"))) PRODUCT_READ.add(name);
}
const TOOLING_READ = new Set<string>();
for (const file of toolingFiles) {
  for (const name of readNamesFrom(fs.readFileSync(file, "utf8"))) TOOLING_READ.add(name);
}
const READ = new Set<string>([...PRODUCT_READ, ...TOOLING_READ]);

// Node and tooling names are not application configuration.
const IGNORE = new Set(["NODE_ENV", "PORT", "HOME", "PATH", "PWD", "CI", "TZ",
  "NODE_OPTIONS", "npm_config_yes", "USER", "SHELL", "TMPDIR", "LANG",
  "NAME", "DEV", "PROD", "MODE", "BASE_URL", "SSR", "GITHUB_REF_NAME",
  "GITHUB_HEAD_REF", "AWS_REGION"]);
for (const n of IGNORE) { READ.delete(n); PRODUCT_READ.delete(n); TOOLING_READ.delete(n); }

const DOCUMENTED = assignedNames(path.join(ROOT, ".env.example"));
for (const n of IGNORE) DOCUMENTED.delete(n);

const sorted = (s: Iterable<string>) => [...s].sort();

console.log(`Scanned ${files.length} source files.\n`);

const inert = sorted(DOCUMENTED).filter((n) => !READ.has(n));
console.log(`── Documented but never read — ${inert.length} ──────────────────────`);
console.log("   Safe to delete from the deployment. Each one currently reads as");
console.log("   live configuration to anyone auditing it.\n");
for (const n of inert) console.log(`   ${n}`);

const toolingOnly = sorted(TOOLING_READ).filter((n) => !PRODUCT_READ.has(n));
console.log(`\n── Read only by operator scripts — ${toolingOnly.length} ────────────────`);
console.log("   Not production configuration. Needed locally to run a script, not");
console.log("   in the deployment.\n");
for (const n of toolingOnly) console.log(`   ${n}`);

const undocumented = sorted(PRODUCT_READ).filter((n) => !DOCUMENTED.has(n));
console.log(`\n── Product reads, undocumented — ${undocumented.length} ─────────────────`);
console.log("   The running app depends on these; .env.example does not mention them,");
console.log("   so a fresh deployment would miss them.\n");
for (const n of undocumented) console.log(`   ${n}`);

if (ENV_FILE) {
  const PRESENT = assignedNames(path.join(ROOT, ENV_FILE));
  for (const n of IGNORE) PRESENT.delete(n);
  const stale = sorted(PRESENT).filter((n) => !READ.has(n));
  console.log(`\n── Set in ${ENV_FILE} but never read — ${stale.length} ─────────────────`);
  for (const n of stale) console.log(`   ${n}`);
  const missing = sorted(READ).filter((n) => !PRESENT.has(n));
  console.log(`\n   (${missing.length} read names absent from ${ENV_FILE}; expected for a partial local env)`);
}

console.log(`\nTotals: ${PRODUCT_READ.size} read by product · ${toolingOnly.length} script-only · ` +
  `${DOCUMENTED.size} documented · ${inert.length} inert · ${undocumented.length} undocumented`);
