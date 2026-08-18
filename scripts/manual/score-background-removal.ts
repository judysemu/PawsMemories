#!/usr/bin/env -S npx tsx
/**
 * Quality gate harness for background removal (architecture §8, step 6.5).
 *
 * Runs every image in a folder through the configured provider and writes a
 * side-by-side review sheet: original, cutout on a checkerboard (so alpha is
 * actually visible), and cutout on white (how it prints).
 *
 *   npx tsx scripts/manual/score-background-removal.ts fixtures/scratch/bg-test
 *
 * Put the photos in fixtures/scratch/ — it is gitignored, so they never enter
 * git and never dirty the worktree. That second part matters:
 * scripts/build-deploy-zip.sh refuses to package a dirty worktree, so test
 * images dropped anywhere tracked would silently block every deploy.
 *
 * USE REAL PHOTOS. Studio squares and AI-generated images pass every model;
 * the failures that matter are wispy fur on a busy background, backlighting,
 * and dark fur on dark ground. Ten images of that kind is a real gate.
 *
 * NOTE: this spends money — each image is a live fal call.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createFalBirefnetProvider } from "../../server/photo-edit/falBirefnet";

const inputDir = process.argv[2];
const outFlag = process.argv.indexOf("--out");
const outputDir = outFlag > 0 ? process.argv[outFlag + 1] : path.join(inputDir || ".", "review");

// Reviews land beside the inputs, which keeps them inside the same gitignored
// tree rather than scattering generated JPEGs into the repo.

if (!inputDir || !fs.existsSync(inputDir)) {
  console.error("Usage: npx tsx scripts/manual/score-background-removal.ts <folder-of-photos> [--out <folder>]");
  process.exit(2);
}
if (!String(process.env.FAL_KEY || "").trim()) {
  console.error("FAL_KEY is not set in .env — the provider cannot run.");
  process.exit(2);
}

/** Checkerboard behind the cutout, so transparency is visible rather than
 *  silently reading as white. Without this a total failure (nothing removed)
 *  and a perfect cutout look identical on a white page. */
async function checkerboard(width: number, height: number): Promise<Buffer> {
  const cell = 16;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><pattern id="c" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">
      <rect width="${cell * 2}" height="${cell * 2}" fill="#ffffff"/>
      <rect width="${cell}" height="${cell}" fill="#d0d0d0"/>
      <rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="#d0d0d0"/>
    </pattern></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main(): Promise<void> {
  const files = fs.readdirSync(inputDir)
    // HEIC/HEIF included: sharp has libheif compiled in, so the harness can
    // read straight off a phone. Note the APP cannot — see the accept list in
    // PhotoStep.tsx. Testing a format customers cannot upload is only useful
    // for deciding whether to support it.
    .filter((name) => /\.(jpe?g|png|webp|heic|heif)$/i.test(name))
    .sort();
  if (!files.length) {
    console.error(`No images found in ${inputDir}`);
    process.exit(2);
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const provider = createFalBirefnetProvider();
  console.log(`Provider: ${provider.id}\nImages:   ${files.length}\nOutput:   ${outputDir}\n`);

  const results: { name: string; ms: number; ok: boolean; note: string }[] = [];

  for (const [index, name] of files.entries()) {
    const source = fs.readFileSync(path.join(inputDir, name));
    const meta = await sharp(source).metadata();
    const mp = ((meta.width || 0) * (meta.height || 0)) / 1_000_000;
    process.stdout.write(`[${index + 1}/${files.length}] ${name} — ${meta.width}x${meta.height} (${mp.toFixed(1)} MP) … `);

    const started = Date.now();
    try {
      // sharp reports heif for both .heic and .heif; fal wants a real MIME.
      const fmt = meta.format === "jpg" ? "jpeg" : meta.format;
      const mimeType = `image/${fmt === "heif" ? "heic" : fmt}`;
      const cutout = await provider.removeBackground({ base64: source.toString("base64"), mimeType });
      const ms = Date.now() - started;
      const cutoutBuf = Buffer.from(cutout.base64, "base64");

      // Three panels at a common height so they compare fairly.
      const H = 900;
      const panel = async (buf: Buffer, background: "checker" | "white" | null) => {
        const fitted = await sharp(buf).resize({ height: H, fit: "inside" }).toBuffer();
        const m = await sharp(fitted).metadata();
        if (!background) return sharp(fitted).png().toBuffer();
        const bg = background === "checker"
          ? await checkerboard(m.width || H, m.height || H)
          : await sharp({ create: { width: m.width || H, height: m.height || H, channels: 3, background: "#ffffff" } }).png().toBuffer();
        return sharp(bg).composite([{ input: fitted }]).png().toBuffer();
      };

      const [a, b, c] = await Promise.all([
        panel(source, null),
        panel(cutoutBuf, "checker"),
        panel(cutoutBuf, "white"),
      ]);
      const metas = await Promise.all([a, b, c].map((buf) => sharp(buf).metadata()));
      const totalW = metas.reduce((sum, m) => sum + (m.width || 0), 0) + 40;

      const sheet = await sharp({ create: { width: totalW, height: H, channels: 3, background: "#202020" } })
        .composite([
          { input: a, left: 0, top: 0 },
          { input: b, left: (metas[0].width || 0) + 20, top: 0 },
          { input: c, left: (metas[0].width || 0) + (metas[1].width || 0) + 40, top: 0 },
        ])
        .jpeg({ quality: 92 })
        .toBuffer();

      const outName = `${String(index + 1).padStart(2, "0")}-${path.parse(name).name}.jpg`;
      fs.writeFileSync(path.join(outputDir, outName), sheet);
      fs.writeFileSync(path.join(outputDir, `${String(index + 1).padStart(2, "0")}-cutout.webp`), cutoutBuf);
      console.log(`ok ${(ms / 1000).toFixed(1)}s → ${outName}`);
      results.push({ name, ms, ok: true, note: `${cutout.widthPx}x${cutout.heightPx}` });
    } catch (err: any) {
      const ms = Date.now() - started;
      console.log(`FAILED (${err?.code || "error"}) ${err?.message || ""}`);
      results.push({ name, ms, ok: false, note: err?.message || "failed" });
    }
  }

  const ok = results.filter((r) => r.ok);
  const avg = ok.length ? ok.reduce((s, r) => s + r.ms, 0) / ok.length / 1000 : 0;
  console.log(`\n${ok.length}/${results.length} succeeded, average ${avg.toFixed(1)}s per image.`);
  console.log(`Review sheets in ${outputDir} — left: original · middle: cutout on checkerboard · right: cutout on white.\n`);
  console.log("Score each 1-5 on the fur edge specifically. The middle panel is the honest one:");
  console.log("a model that removed nothing looks fine on white and obviously wrong on the checkerboard.");

  // Scoring sheet the reviewer fills in.
  const csv = ["file,seconds,succeeded,score_1_to_5,notes"]
    .concat(results.map((r) => `${r.name},${(r.ms / 1000).toFixed(1)},${r.ok},,`))
    .join("\n");
  fs.writeFileSync(path.join(outputDir, "scores.csv"), csv + "\n");
  console.log(`\nScoring sheet: ${path.join(outputDir, "scores.csv")}`);
}

main().catch((err) => { console.error(err?.message || err); process.exit(1); });
