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

test("homepage JSON-LD parses and every declared media file actually exists", async () => {
  const block = indexHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(block, "the homepage must carry a JSON-LD block");
  // Malformed JSON-LD is ignored wholesale by crawlers, so a syntax slip here
  // silently removes every entity at once rather than degrading one of them.
  const graph = JSON.parse(block[1])["@graph"];

  const types = graph.map((node) => node["@type"]);
  assert.ok(types.includes("3DModel"), "the interactive presenter should be declared as a 3DModel");
  assert.ok(types.includes("ItemList"), "the portrait categories should be declared as an ItemList");

  // Declaring a contentUrl that 404s is worse than declaring nothing: the
  // structured data fails validation and the page looks like it is describing
  // assets it does not have. Every media URL must resolve to a real file.
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const urls = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      if (typeof node.contentUrl === "string") urls.push(node.contentUrl);
      Object.values(node).forEach(walk);
    }
  };
  walk(graph);
  assert.ok(urls.length > 0, "at least one media object should be declared");
  for (const url of urls) {
    const relative = url.replace("https://pawsome3d.com/", "");
    const onDisk = fileURLToPath(new URL(`../public/${relative}`, import.meta.url));
    assert.ok(existsSync(onDisk), `${url} is declared in JSON-LD but public/${relative} does not exist`);
  }
});

test("the portrait ItemList matches the categories the catalog actually defines", async () => {
  const { FAMOUS_PORTRAIT_CATEGORIES } = await import("../shared/historicalPetCatalog.ts");
  const block = indexHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  const list = JSON.parse(block[1])["@graph"].find((node) => node["@type"] === "ItemList");
  // A list that drifts from the catalog advertises categories the site does not
  // have, or hides ones it does.
  assert.equal(list.itemListElement.length, FAMOUS_PORTRAIT_CATEGORIES.length);
  assert.equal(list.numberOfItems, FAMOUS_PORTRAIT_CATEGORIES.length);
});
