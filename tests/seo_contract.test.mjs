import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const seoSource = await readFile(new URL("../src/seo.ts", import.meta.url), "utf8");
const legalSource = await readFile(new URL("../server/legal.ts", import.meta.url), "utf8");
const robots = await readFile(new URL("../public/robots.txt", import.meta.url), "utf8");
const sitemap = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");

test("public entry includes complete search and social metadata", () => {
  for (const marker of ["name=\"description\"", "rel=\"canonical\"", "og:title", "twitter:card", "application/ld\\+json", "site.webmanifest"]) {
    assert.match(indexHtml, new RegExp(marker));
  }
  assert.match(indexHtml, /Create 3D pet models, videos/);
});

test("private client workspaces switch to noindex while the public entry remains indexable", () => {
  assert.match(appSource, /syncSeoMetadata\(currentScreen, isAuthed\)/);
  assert.match(seoSource, /index,follow,max-image-preview:large/);
  assert.match(seoSource, /noindex,nofollow,noarchive/);
});

test("sitemap, crawler rules, and server-rendered legal pages are discoverable", () => {
  assert.match(robots, /Sitemap: https:\/\/pawsome3d\.com\/sitemap\.xml/);
  assert.match(robots, /Disallow: \/api\//);
  for (const path of ["https://pawsome3d.com/", "/legal/privacy", "/legal/terms", "/legal/sms"]) {
    assert.ok(sitemap.includes(path));
  }
  assert.ok(sitemap.includes("https://pawsome3d.com/store"));
  assert.doesNotMatch(robots, /Disallow: \/store/);
  assert.match(seoSource, /\[Screen\.STORE\]/);
  assert.match(legalSource, /rel="canonical"/);
  assert.match(legalSource, /application\/ld\+json/);
});
