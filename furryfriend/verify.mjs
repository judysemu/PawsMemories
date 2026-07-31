import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const htmlFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".html")) htmlFiles.push(full);
  }
}

function routeTarget(href) {
  const clean = href.split(/[?#]/, 1)[0];
  if (clean === "/") return path.join(dist, "index.html");
  if (path.extname(clean)) return path.join(dist, clean.slice(1));
  return path.join(dist, clean.slice(1), "index.html");
}

assert.ok(fs.existsSync(dist), "dist must exist");
walk(dist);
assert.ok(htmlFiles.length >= 11, "expected the full public route set");

const canonicals = new Set();
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, "utf8");
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1, `${file} must have one h1`);
  const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
  assert.ok(canonical, `${file} is missing a canonical`);
  assert.ok(!canonicals.has(canonical), `duplicate canonical ${canonical}`);
  canonicals.add(canonical);

  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => JSON.parse(match[1]), `${file} has invalid JSON-LD`);
  }
  for (const match of html.matchAll(/href="(\/[^"]*)"/g)) {
    if (match[1].startsWith("//")) continue;
    assert.ok(fs.existsSync(routeTarget(match[1])), `${file} links to missing ${match[1]}`);
  }
}

const sitemap = fs.readFileSync(path.join(dist, "sitemap.xml"), "utf8");
for (const file of htmlFiles.filter((candidate) => candidate.includes(`${path.sep}guides${path.sep}`) && candidate !== path.join(dist, "guides", "index.html"))) {
  const html = fs.readFileSync(file, "utf8");
  assert.match(html, /name="robots" content="noindex,follow"/, `${file} preview must be noindex`);
  const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
  assert.ok(!sitemap.includes(canonical), `${file} preview must not be in sitemap`);
  assert.ok(!html.includes('"@type":"Article"'), `${file} must not claim published Article data before human approval`);
}

for (const phrase of ["45% off", "pre-paid gift option", "guaranteed likeness", "guaranteed delivery"]) {
  for (const file of htmlFiles) {
    assert.ok(!fs.readFileSync(file, "utf8").toLowerCase().includes(phrase.toLowerCase()), `${file} contains blocked claim: ${phrase}`);
  }
}

assert.match(fs.readFileSync(path.join(dist, "robots.txt"), "utf8"), /Sitemap: https:\/\/furryfriend\.cc\/sitemap\.xml/);
assert.ok(fs.statSync(path.join(dist, "og.png")).size > 100_000, "social preview image is missing or implausibly small");

console.log(`FurryFriend verification PASS: ${htmlFiles.length} HTML pages, ${canonicals.size} unique canonicals`);
