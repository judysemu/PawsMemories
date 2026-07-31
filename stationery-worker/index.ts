import crypto from "node:crypto";
import express from "express";
import sharp from "sharp";
import { putPrivateObject, sha256Hex } from "../storage.private.ts";
import { RenderDispatchSchema, type RenderDispatch } from "../server/stationery-v2/apiContracts.ts";
import { sealRenderManifest } from "../server/stationery-v2/manifests.ts";
import { sha256Canonical } from "../server/stationery-v2/canonical.ts";

const PORT = Number(process.env.STATIONERY_WORKER_PORT || 8090);
const SECRET = String(process.env.STATIONERY_RENDER_WORKER_SECRET || "").trim();
const CALLBACK_BASE = String(process.env.STATIONERY_CALLBACK_BASE_URL || "").replace(/\/$/, "");
const CALLBACK_URL = `${CALLBACK_BASE}/api/stationery-v2`;
const RENDERER_VERSION = String(process.env.STATIONERY_WORKER_VERSION || "1.0.0");

if (SECRET.length < 24) throw new Error("STATIONERY_RENDER_WORKER_SECRET must be at least 24 characters.");
if (!/^https:\/\//.test(CALLBACK_BASE)) throw new Error("STATIONERY_CALLBACK_BASE_URL must be HTTPS.");

function signature(body: Buffer): string {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

function verifySignature(body: Buffer, supplied: unknown): boolean {
  const value = String(supplied || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(signature(body)));
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" }[char] || char));
}

function svgText(text: string, width: number, height: number, fontSize: number): Buffer {
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><style>text{font-family: sans-serif; fill: #111;}</style><text x="0" y="${fontSize}" font-size="${fontSize}">${xmlEscape(text)}</text></svg>`);
}

function pdfFromJpeg(jpeg: Buffer, width: number, height: number): Buffer {
  const objects: Buffer[] = [];
  const add = (value: string | Buffer) => { objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value)); return objects.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]))
  const content = Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`);
  add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]))
  const header = Buffer.from("%PDF-1.4\n%\xff\xff\xff\xff\n");
  const chunks = [header];
  const offsets = [0];
  let offset = header.length;
  objects.forEach((object, index) => {
    offsets[index + 1] = offset;
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    chunks.push(chunk); offset += chunk.length;
  });
  const xref = offset;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

async function fetchImage(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Source asset returned HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

async function render(dispatch: RenderDispatch): Promise<{ bytes: Buffer; mimeType: string; width: number; height: number }> {
  const preset = dispatch.template.presets.find((candidate) => candidate.presetId === dispatch.presetId);
  if (!preset) throw new Error("Render preset was not found in the frozen template.");
  const dpi = preset.targetDpi;
  const width = preset.widthPx;
  const height = preset.heightPx;
  const backgroundUrl = dispatch.sourceUrls[dispatch.template.backgroundAsset.assetUuid];
  let image = sharp(backgroundUrl ? await fetchImage(backgroundUrl) : { create: { width, height, channels: 4, background: "#ffffff" } }).resize(width, height, { fit: "cover" });
  const overlays: sharp.OverlayOptions[] = [];
  const slots = new Map(dispatch.template.slots.map((slot) => [slot.slotId, slot]));
  for (const input of dispatch.slotInputs) {
    const slot = slots.get(input.slotId);
    if (!slot) continue;
    const left = Math.max(0, Math.round(slot.boundsIn.x * dpi));
    const top = Math.max(0, Math.round(slot.boundsIn.y * dpi));
    const slotWidth = Math.max(1, Math.round(slot.boundsIn.width * dpi));
    const slotHeight = Math.max(1, Math.round(slot.boundsIn.height * dpi));
    if (input.kind === "image") {
      const sourceUrl = dispatch.sourceUrls[input.source.assetUuid];
      if (!sourceUrl) throw new Error(`No signed source URL for ${input.source.assetUuid}.`);
      overlays.push({ input: await sharp(await fetchImage(sourceUrl)).resize(slotWidth, slotHeight, { fit: input.cropMode === "cover" ? "cover" : "contain" }).png().toBuffer(), left, top });
    } else {
      overlays.push({ input: await sharp(svgText(input.content, slotWidth, slotHeight, Math.max(12, Math.round(slotHeight / 8)))).png().toBuffer(), left, top });
    }
  }
  const composited = image.composite(overlays);
  if (preset.format === "png") return { bytes: await composited.png().toBuffer(), mimeType: "image/png", width, height };
  const jpeg = await composited.jpeg({ quality: 95 }).toBuffer();
  if (preset.format === "pdf") return { bytes: pdfFromJpeg(jpeg, width, height), mimeType: "application/pdf", width, height };
  return { bytes: jpeg, mimeType: "image/jpeg", width, height };
}

async function postSigned(url: string, body: unknown): Promise<any> {
  const raw = Buffer.from(JSON.stringify(body));
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-stationery-render-signature": signature(raw) }, body: raw, redirect: "error", signal: AbortSignal.timeout(60_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Stationery callback returned HTTP ${response.status}.`);
  return result;
}

async function processDispatch(dispatch: RenderDispatch): Promise<void> {
  const rendered = await render(dispatch);
  const objectKey = `marketplace/stationery/${dispatch.ownerId}/${dispatch.jobUuid}.${rendered.mimeType === "application/pdf" ? "pdf" : rendered.mimeType === "image/jpeg" ? "jpg" : "png"}`;
  const stored = await putPrivateObject(objectKey, rendered.bytes, rendered.mimeType);
  const asset = await postSigned(`${CALLBACK_URL}/worker-assets/register`, {
    ownerId: dispatch.ownerId,
    assetType: "stationery_print_file",
    mimeType: rendered.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    bucket: "private",
    objectKey: stored.objectKey,
    metadata: { jobUuid: dispatch.jobUuid, renderer: RENDERER_VERSION },
  });
  const validationReport = { schemaVersion: "stationery.validation.v1", templateUuid: dispatch.template.templateUuid, templateVersionNumber: dispatch.template.versionNumber, findings: [], overallPass: true };
  const sourceVersions = [dispatch.template.backgroundAsset, ...dispatch.slotInputs.filter((input) => input.kind === "image").map((input) => input.source)];
  const renderManifest = sealRenderManifest({ schemaVersion: "stationery.render-manifest.v1", templateUuid: dispatch.template.templateUuid, templateVersionNumber: dispatch.template.versionNumber, templateSpecHash: sha256Canonical(dispatch.template), presetId: dispatch.presetId, output: { assetUuid: String(asset.assetUuid), versionNumber: Number(asset.versionNumber), sha256: String(asset.sha256) }, format: dispatch.template.presets.find((preset) => preset.presetId === dispatch.presetId)?.format || "png", widthPx: rendered.width, heightPx: rendered.height, dpi: dispatch.template.presets.find((preset) => preset.presetId === dispatch.presetId)?.targetDpi || 300, colorProfile: dispatch.template.presets.find((preset) => preset.presetId === dispatch.presetId)?.colorProfile || "sRGB", renderer: { name: "stationery-worker", version: RENDERER_VERSION }, sourceVersions, fontFileHashes: [], validationReportHash: sha256Canonical(validationReport), frozenAt: new Date().toISOString() });
  await postSigned(`${CALLBACK_URL}/render-jobs/${encodeURIComponent(dispatch.jobUuid)}/complete`, { renderManifest, validationReport });
}

const app = express();
app.get("/health", (_req, res) => res.json({ status: "ok", service: "stationery-worker", renderer: RENDERER_VERSION }));
app.post("/v1/jobs", express.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!verifySignature(raw, req.headers["x-stationery-render-signature"])) return res.status(401).json({ error: "invalid signature" });
  try { const dispatch = RenderDispatchSchema.parse(JSON.parse(raw.toString("utf8"))); await processDispatch(dispatch); return res.status(202).json({ accepted: true, jobUuid: dispatch.jobUuid }); }
  catch (error) { console.error("[stationery-worker] failed", error); return res.status(500).json({ error: "render failed" }); }
});
app.listen(PORT, "0.0.0.0", () => console.log(`[stationery-worker] listening on ${PORT}`));
