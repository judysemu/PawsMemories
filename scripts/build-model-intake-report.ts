#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverGlbs } from "./audit-glb-fixtures.mjs";
import { parseGlb, validatePetGlb, type CheckResult } from "../server/pet-generation/validation.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importsRoot = path.join(repoRoot, "fixtures/inhouse3d/imports");
const outputPath = path.join(repoRoot, "docs/MODEL_INTAKE_REPORT.html");
const bonemap = JSON.parse(fs.readFileSync(path.join(repoRoot, "blender-worker/bonemap.json"), "utf8"));
const rigProfileJoints = Object.keys(bonemap.canonical || {});

type Tier = "ready" | "remap" | "animate" | "rig" | "reject";

interface ModelRow {
  file: string;
  batch: string;
  tier: Tier;
  detail: string;
  triangles: number;
  materials: number;
  textures: number;
  joints: number;
  clips: string[];
  duplicateCopies: number;
  sensitiveFlags: string[];
  sha256: string;
}

const tierLabels: Record<Tier, string> = {
  ready: "Likely passable",
  remap: "Passable after joint mapping",
  animate: "Passable after animation",
  rig: "Passable after rigging",
  reject: "Not passable",
};

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function checkById(checks: CheckResult[], id: string): CheckResult | undefined {
  return checks.find((check) => check.id === id);
}

function collectStrings(value: unknown, strings: string[] = []): string[] {
  if (typeof value === "string") strings.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, strings));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => collectStrings(entry, strings));
  return strings;
}

function sensitiveFlags(file: string, document: unknown): string[] {
  const flags = new Set<string>();
  if (/(?:password|passwd|secret|credential|private.?key|access.?token|resume|invoice|contract)/i.test(path.basename(file))) {
    flags.add("sensitive filename");
  }
  for (const value of collectStrings(document)) {
    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) flags.add("email-like string");
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) flags.add("private-key marker");
    if (/(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s,;]{8,}/i.test(value)) flags.add("credential-like assignment");
    if (/(?:AccountKey|SharedAccessSignature|DefaultEndpointsProtocol)\s*=/i.test(value)) flags.add("connection-string marker");
    if (/(?:^|\s)(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/i.test(value)) flags.add("local filesystem path");
    if (/https?:\/\/[^\s]+[?&](?:token|key|signature|sig|secret)=/i.test(value)) flags.add("credential-like URL");
  }
  return [...flags].sort();
}

function embeddedAssetEvidence(document: any): { textures: number; externalUris: number } {
  const images = Array.isArray(document?.images) ? document.images : [];
  const buffers = Array.isArray(document?.buffers) ? document.buffers : [];
  const externalUris = [...images, ...buffers]
    .filter((entry) => typeof entry?.uri === "string" && !entry.uri.startsWith("data:"))
    .length;
  return {
    textures: Array.isArray(document?.textures) ? document.textures.length : 0,
    externalUris,
  };
}

function classify(bytes: Buffer, relativeFile: string): Omit<ModelRow, "duplicateCopies"> {
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  let document: any = null;
  try {
    document = parseGlb(bytes).json;
  } catch {
    return {
      file: relativeFile,
      batch: relativeFile.split(path.sep)[0] || "imports",
      tier: "reject",
      detail: "The GLB container does not parse.",
      triangles: 0,
      materials: 0,
      textures: 0,
      joints: 0,
      clips: [],
      sensitiveFlags: sensitiveFlags(relativeFile, null),
      sha256,
    };
  }

  const report = validatePetGlb(bytes, { rigProfileJoints });
  const by = (id: string) => checkById(report.checks, id);
  const assets = embeddedAssetEvidence(document);
  const materials = Array.isArray(document.materials) ? document.materials.length : 0;
  const joints = (document.skins || []).reduce((count: number, skin: any) => count + (skin.joints?.length || 0), 0);
  const clips = (document.animations || []).map((clip: any, index: number) => String(clip.name || `clip_${index}`));
  const triangles = Number(by("mesh_exists")?.measured?.triangles || 0);
  const goodBase = by("glb_parses")?.passed === true
    && by("scene_exists")?.passed === true
    && by("mesh_exists")?.passed === true
    && materials > 0
    && assets.textures > 0
    && assets.externalUris === 0;
  const goodRig = by("skin_exists")?.passed === true
    && by("skeleton_nodes_exist")?.passed === true
    && by("skin_weights_present")?.passed === true;
  const goodMotion = by("idle_clip_exists")?.passed === true
    && by("walk_clip_exists")?.passed === true
    && by("animation_targets_resolve")?.passed === true;
  const profileMatches = by("rig_joint_coverage")?.passed === true;

  let tier: Tier;
  let detail: string;
  if (!goodBase) {
    tier = "reject";
    const failed = [
      by("scene_exists")?.passed !== true && "scene",
      by("mesh_exists")?.passed !== true && "mesh",
      materials === 0 && "materials",
      assets.textures === 0 && "embedded textures",
      assets.externalUris > 0 && "self-contained assets",
    ].filter(Boolean);
    detail = `Fails structural delivery gates: ${failed.join(", ")}.`;
  } else if (goodRig && goodMotion && profileMatches) {
    tier = "ready";
    detail = "All measured delivery gates pass. Visual QA is still required.";
  } else if (goodRig && goodMotion) {
    tier = "remap";
    detail = by("rig_joint_coverage")?.detail || "Animation exists, but the joint profile needs remapping.";
  } else if (goodRig) {
    tier = "animate";
    const missing = [
      by("idle_clip_exists")?.passed !== true && "idle",
      by("walk_clip_exists")?.passed !== true && "walk",
      by("animation_targets_resolve")?.passed !== true && "valid animation targets",
    ].filter(Boolean);
    detail = `Usable weighted rig; add ${missing.join(" + ")}.`;
  } else {
    tier = "rig";
    detail = "Valid textured base; create or repair its skeleton and skin weights.";
  }

  return {
    file: relativeFile,
    batch: relativeFile.split(path.sep)[0] || "imports",
    tier,
    detail,
    triangles,
    materials,
    textures: assets.textures,
    joints,
    clips,
    sensitiveFlags: sensitiveFlags(relativeFile, document),
    sha256,
  };
}

function reportHtml(rows: ModelRow[]): string {
  const counts = Object.fromEntries(Object.keys(tierLabels).map((tier) => [tier, rows.filter((row) => row.tier === tier).length])) as Record<Tier, number>;
  const repairable = counts.remap + counts.animate + counts.rig;
  const duplicateCopies = [...new Set(rows.map((row) => row.sha256))]
    .reduce((sum, hash) => sum + Math.max(0, rows.filter((row) => row.sha256 === hash).length - 1), 0);
  const flaggedFiles = rows.filter((row) => row.sensitiveFlags.length > 0).length;
  const generated = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: "America/Denver", timeZoneName: "short",
  }).format(new Date());
  const cards = (["ready", "remap", "animate", "rig", "reject"] as Tier[]).map((tier) => `
    <button class="metric ${tier}" data-filter="${tier}" type="button">
      <strong>${counts[tier]}</strong><span>${tierLabels[tier]}</span>
    </button>`).join("");
  const tableRows = rows.map((row) => `
    <tr data-tier="${row.tier}" data-file="${escapeHtml(row.file)}" data-search="${escapeHtml(`${row.file} ${row.batch} ${tierLabels[row.tier]} ${row.detail}`.toLowerCase())}">
      <td><span class="badge ${row.tier}">${escapeHtml(tierLabels[row.tier])}</span></td>
      <td><strong>${escapeHtml(path.basename(row.file))}</strong><small>${escapeHtml(row.batch)}</small><small><a href="http://127.0.0.1:8766/docs/MODEL_VISUAL_REVIEW.html?file=${encodeURIComponent(row.file)}">Open visual review</a></small></td>
      <td>${escapeHtml(row.detail)}</td>
      <td>${row.triangles.toLocaleString()}<small>${row.materials} material(s) · ${row.textures} texture(s)</small></td>
      <td>${row.joints}<small>${row.clips.length ? escapeHtml(row.clips.join(", ")) : "No clips"}</small></td>
      <td>${row.duplicateCopies ? `<span class="badge duplicate">${row.duplicateCopies} other cop${row.duplicateCopies === 1 ? "y" : "ies"}</span>` : "Unique"}</td>
      <td>${row.sensitiveFlags.length ? `<span class="badge sensitive">FLAG</span><small>${escapeHtml(row.sensitiveFlags.join(", "))}</small>` : "None detected"}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pawsome3D Model Intake</title>
  <style>
    :root { color-scheme: dark; --bg:#0c1220; --panel:#172033; --line:#334155; --text:#f8fafc; --muted:#a8b3c5; --ready:#36d399; --remap:#60a5fa; --animate:#fbbf24; --rig:#fb923c; --reject:#fb7185; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--text); font:15px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(1500px,calc(100% - 28px)); margin:28px auto 60px; } h1 { margin:0; font-size:clamp(1.7rem,4vw,2.5rem); } p { margin:7px 0; } a { color:#93c5fd; } .muted, small { color:var(--muted); }
    .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:22px 0; }
    .metric { appearance:none; text-align:left; background:var(--panel); color:var(--text); border:1px solid var(--line); border-top:4px solid currentColor; border-radius:12px; padding:14px; cursor:pointer; }
    .metric strong { display:block; font-size:1.8rem; } .metric span { color:var(--muted); } .metric.active { outline:2px solid currentColor; }
    .ready { color:var(--ready); } .remap { color:var(--remap); } .animate { color:var(--animate); } .rig { color:var(--rig); } .reject,.sensitive { color:var(--reject); }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px; margin-top:14px; }
    .answer { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:10px; margin-top:14px; }
    .answer div { background:#0f172a; border:1px solid var(--line); border-radius:10px; padding:12px; }
    .answer strong { display:block; font-size:1.45rem; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; } input { flex:1; min-width:240px; color:var(--text); background:#0f172a; border:1px solid var(--line); border-radius:9px; padding:10px 12px; }
    button.reset { color:var(--text); background:#26344d; border:1px solid var(--line); border-radius:9px; padding:10px 12px; cursor:pointer; }
    .badge { display:inline-block; border:1px solid currentColor; border-radius:999px; padding:2px 7px; font-size:.72rem; font-weight:800; white-space:nowrap; }
    .duplicate { color:#c4b5fd; } table { width:100%; border-collapse:collapse; margin-top:12px; } th,td { text-align:left; vertical-align:top; border-bottom:1px solid var(--line); padding:10px 8px; } th { color:var(--muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; } td small { display:block; margin-top:3px; max-width:320px; overflow-wrap:anywhere; } tr[hidden] { display:none; }
    .legend { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:8px 18px; padding-left:20px; }
    @media(max-width:900px){ .table-wrap{overflow-x:auto} table{min-width:980px} }
  </style>
</head>
<body><main>
  <h1>Which models can we use?</h1>
  <p class="muted">Generated ${escapeHtml(generated)} · ${rows.length} GLB files · Structural inspection only</p>
  <p><a href="AZURE_TRELLIS_STATUS.html">← Back to Azure/TRELLIS status</a></p>
  <section class="panel">
    <strong>Plain answer</strong>
    <div class="answer">
      <div><strong class="ready">${counts.ready}</strong>likely passable after a visual playback check</div>
      <div><strong class="animate">${repairable}</strong>usable after a known repair</div>
      <div><strong class="reject">${counts.reject}</strong>broken or structurally unusable</div>
    </div>
    <p class="muted">No file is being discarded. Automated checks can confirm structure, textures, rig data, and clip names; they cannot tell whether the animal looks right or moves naturally.</p>
    <p><strong>Next:</strong> open visual review from a row, rotate the model, play its motion, and record your judgment. The viewer uses only local files.</p>
  </section>
  <div class="metrics">${cards}</div>
  <section class="panel">
    <strong>${duplicateCopies} duplicate file ${duplicateCopies === 1 ? "copy" : "copies"}</strong> by exact SHA-256 · <strong>${flaggedFiles} sensitive-string ${flaggedFiles === 1 ? "flag" : "flags"}</strong>
    <p class="muted">Potentially sensitive values are never printed here; only the flag category is shown. “Likely passable” still requires a visual render check for anatomy, texture quality, deformation, scale, orientation, and natural-looking movement.</p>
  </section>
  <section class="panel">
    <strong>How the buckets work</strong>
    <ul class="legend">
      <li><span class="ready">Likely passable:</span> textured mesh, weighted rig, idle + walk, valid targets, and a matching quadruped joint profile. Visual review is the last gate.</li>
      <li><span class="remap">Passable after joint mapping:</span> good rig and motion, but joint names need a small compatibility repair.</li>
      <li><span class="animate">Passable after animation:</span> usable weighted rig, but missing required idle/walk motion.</li>
      <li><span class="rig">Passable after rigging:</span> useful textured base mesh that still needs a skeleton and skin weights.</li>
      <li><span class="reject">Not passable:</span> broken container, mesh, texture, or self-contained asset gate. Keep the source, but do not send it into production.</li>
    </ul>
  </section>
  <section class="panel">
    <div class="toolbar"><input id="search" type="search" placeholder="Search filename, batch, or reason"><button class="reset" id="reset" type="button">Show all</button><span id="visible" class="muted"></span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Decision</th><th>File</th><th>Why</th><th>Mesh</th><th>Rig / clips</th><th>Duplicate</th><th>Sensitive strings</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
  </section>
  <script>
    const rows=[...document.querySelectorAll('tbody tr')]; const metrics=[...document.querySelectorAll('[data-filter]')]; const search=document.querySelector('#search'); let tier='';
    function apply(){const q=search.value.trim().toLowerCase(); let visible=0; rows.forEach(row=>{const show=(!tier||row.dataset.tier===tier)&&(!q||row.dataset.search.includes(q));row.hidden=!show;if(show)visible++});document.querySelector('#visible').textContent=visible+' shown';metrics.forEach(button=>button.classList.toggle('active',button.dataset.filter===tier));}
    metrics.forEach(button=>button.addEventListener('click',()=>{tier=tier===button.dataset.filter?'':button.dataset.filter;apply()})); search.addEventListener('input',apply); document.querySelector('#reset').addEventListener('click',()=>{tier='';search.value='';apply()}); apply();
  </script>
</main></body></html>`;
}

const files = discoverGlbs(importsRoot);
const rowsWithoutDuplicates = files.map((absoluteFile) => classify(
  fs.readFileSync(absoluteFile),
  path.relative(importsRoot, absoluteFile),
));
const frequency = new Map<string, number>();
for (const row of rowsWithoutDuplicates) frequency.set(row.sha256, (frequency.get(row.sha256) || 0) + 1);
const rows: ModelRow[] = rowsWithoutDuplicates
  .map((row) => ({ ...row, duplicateCopies: Math.max(0, (frequency.get(row.sha256) || 1) - 1) }))
  .sort((left, right) => {
    const order: Tier[] = ["ready", "remap", "animate", "rig", "reject"];
    return order.indexOf(left.tier) - order.indexOf(right.tier) || left.file.localeCompare(right.file);
  });

fs.writeFileSync(outputPath, reportHtml(rows), { encoding: "utf8", mode: 0o600 });
const totals = Object.fromEntries(Object.keys(tierLabels).map((tier) => [tier, rows.filter((row) => row.tier === tier).length]));
console.log(JSON.stringify({ outputPath, total: rows.length, tiers: totals, sensitiveFlaggedFiles: rows.filter((row) => row.sensitiveFlags.length).length }, null, 2));
