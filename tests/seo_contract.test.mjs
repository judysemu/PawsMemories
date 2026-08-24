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

test("the served HTML links to the pages the sitemap claims exist", () => {
  // Navigation is React state, so these anchors are the only crawlable links on
  // the site. When the block held just Privacy and Terms, those were the only
  // pages Google crawled well and three sitemap URLs were never fetched at all.
  const noscript = indexHtml.slice(
    indexHtml.indexOf("<noscript>"),
    indexHtml.indexOf("</noscript>"),
  );
  const linked = [...noscript.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);

  for (const route of ["/3d-pet-models", "/dog-3d-models", "/cat-3d-models", "/barkley"]) {
    assert.ok(linked.includes(route), `${route} must be reachable by a crawlable link`);
  }
  assert.ok(linked.length >= 15, `expected a real link set, found ${linked.length}`);
});

test("every crawlable link points at a URL the sitemap actually declares", async () => {
  const sitemap = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const noscript = indexHtml.slice(
    indexHtml.indexOf("<noscript>"),
    indexHtml.indexOf("</noscript>"),
  );
  // Linking somewhere the sitemap does not list means one of the two is stale,
  // and a link to a dead route spends crawl budget on a 404.
  for (const [, route] of noscript.matchAll(/href="(\/[^"]*)"/g)) {
    assert.ok(
      sitemap.includes(`<loc>https://pawsome3d.com${route}</loc>`),
      `${route} is linked but absent from the sitemap`,
    );
  }
});

test("the sitemap carries a lastmod for every URL", async () => {
  const sitemap = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const locs = (sitemap.match(/<loc>/g) || []).length;
  const mods = (sitemap.match(/<lastmod>/g) || []).length;
  // lastmod is what tells Google which pages are worth recrawling. Without it
  // the money pages went a month between crawls.
  assert.equal(mods, locs, "every <loc> needs a <lastmod>");
});

test("token-bearing claim links are disallowed to crawlers", async () => {
  const robots = await readFile(new URL("../public/robots.txt", import.meta.url), "utf8");
  // Same class as /verify-email and /reset-password: an indexed token is a
  // spent token, and these arrive by DM where they are trivially shared.
  assert.match(robots, /^Disallow: \/claim\//m);
});

test("per-route injection replaces the noscript heading so pages are not duplicates", async () => {
  const { injectMeta, PAGE_META } = await import("../server/seoMeta.ts");
  const home = injectMeta(indexHtml, "/");
  const pricing = injectMeta(indexHtml, "/pricing");

  const headingOf = (html) => html.match(/<h1 id="noscript-heading">([\s\S]*?)<\/h1>/)[1];
  assert.notEqual(headingOf(home), headingOf(pricing));
  // The heading a crawler reads must agree with the title it is given, minus
  // the brand suffix, and must arrive HTML-escaped.
  const expected = PAGE_META["/pricing"].title.split("|")[0].trim().replace(/&/g, "&amp;");
  assert.equal(headingOf(pricing), expected);
  assert.doesNotMatch(headingOf(pricing), /\| Pawsome3D/);
});

test("asset directories do not redirect routes that share their name", async () => {
  const server = await readFile(new URL("../server.ts", import.meta.url), "utf8");
  const staticBlock = server.slice(
    server.indexOf("express.static(distPath"),
    server.indexOf("const ASSET_EXT"),
  );
  // public/barkley (GLB clips) shares a name with the /barkley route. With the
  // default redirect behaviour express.static answered /barkley with a 301 to
  // /barkley/, whose page then declared canonical=/barkley -- a canonical
  // pointing at a redirect to itself, which is why Google never indexed it.
  assert.match(staticBlock, /redirect:\s*false/);
  assert.match(staticBlock, /index:\s*false/);
});

test("every sitemap route is indexable client-side, not just server-side", async () => {
  // The server sends index,follow, but syncSeoMetadata() runs after mount and
  // overwrites robots for any Screen missing from PUBLIC_METADATA. Google
  // renders JS, so that overwrite is what it acts on: /barkley was declared
  // indexable server-side, shipped without a PUBLIC_METADATA entry, and its
  // indexing request was rejected with "Excluded by 'noindex' tag".
  const sitemap = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const routes = [...sitemap.matchAll(/<loc>https:\/\/pawsome3d\.com([^<]*)<\/loc>/g)]
    .map((m) => m[1] || "/")
    // Legal pages are server-rendered outside the SPA; product pages resolve
    // through PRODUCT_VIEW rather than a route of their own.
    .filter((r) => !r.startsWith("/legal/") && !r.startsWith("/product/"));

  const screenFor = [...appSource.matchAll(/\[Screen\.([A-Z_]+)\]:\s*"([^"]*)"/g)]
    .reduce((acc, [, screen, path]) => ({ ...acc, [path || "/"]: screen }), {});

  const missing = [];
  for (const route of routes) {
    const screen = screenFor[route];
    if (!screen) continue; // aliases like /custom-dog-figurines share a Screen
    if (!seoSource.includes(`[Screen.${screen}]:`)) missing.push(`${route} (Screen.${screen})`);
  }
  assert.deepEqual(missing, [], `sitemap routes served noindex by the client: ${missing.join(", ")}`);
});
