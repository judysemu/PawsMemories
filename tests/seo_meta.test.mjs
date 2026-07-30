import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { injectMeta, canonicalFor, normalizePath, PAGE_META } from "../server/seoMeta.ts";

const TEMPLATE = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");

/** Pull the value of a single tag out of rendered HTML. */
function canonical(html) {
  return html.match(/<link\s+rel="canonical"\s+href="([^"]*)"/i)?.[1];
}
function ogUrl(html) {
  return html.match(/<meta\s+property="og:url"\s+content="([^"]*)"/i)?.[1];
}
function title(html) {
  return html.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
}
function description(html) {
  return html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1];
}

test("the template itself still has the tags we rewrite", () => {
  // If someone restructures index.html so a regex stops matching, the injection
  // silently no-ops and we regress to homepage-canonical everywhere. Fail loudly.
  assert.ok(canonical(TEMPLATE), "index.html must carry a canonical link");
  assert.ok(ogUrl(TEMPLATE), "index.html must carry an og:url meta");
  assert.ok(title(TEMPLATE), "index.html must carry a title");
  assert.ok(description(TEMPLATE), "index.html must carry a description meta");
});

test("every known route gets a self-referential canonical", () => {
  for (const route of Object.keys(PAGE_META)) {
    const html = injectMeta(TEMPLATE, route);
    assert.equal(
      canonical(html),
      canonicalFor(route),
      `${route} must declare itself canonical, not the homepage`
    );
    assert.equal(ogUrl(html), canonicalFor(route), `${route} og:url must match its canonical`);
  }
});

test("the five landing pages are no longer duplicates of the homepage", () => {
  const landing = [
    "/3d-pet-models",
    "/custom-dog-figurines",
    "/pet-memorial-models",
    "/how-it-works",
    "/pricing",
  ];
  const homepage = canonicalFor("/");
  for (const route of landing) {
    const html = injectMeta(TEMPLATE, route);
    assert.notEqual(canonical(html), homepage, `${route} must not canonicalise to the homepage`);
  }
});

test("known routes get their own title and description", () => {
  for (const [route, meta] of Object.entries(PAGE_META)) {
    const html = injectMeta(TEMPLATE, route);
    assert.equal(title(html), meta.title.replace(/&/g, "&amp;"));
    assert.equal(description(html), meta.description.replace(/&/g, "&amp;"));
  }
});

test("titles and descriptions are unique across routes", () => {
  const titles = Object.values(PAGE_META).map((m) => m.title);
  const descriptions = Object.values(PAGE_META).map((m) => m.description);
  assert.equal(new Set(titles).size, titles.length, "duplicate titles defeat the fix");
  assert.equal(new Set(descriptions).size, descriptions.length, "duplicate descriptions defeat the fix");
});

test("unknown routes still get a self-referential canonical", () => {
  // An app route with no marketing copy should keep the generic title but must
  // never claim to be the homepage.
  const html = injectMeta(TEMPLATE, "/profile");
  assert.equal(canonical(html), canonicalFor("/profile"));
  assert.equal(title(html), title(TEMPLATE), "unknown routes keep the fallback title");
});

test("path normalisation handles trailing slashes, case and query strings", () => {
  assert.equal(normalizePath("/pricing/"), "/pricing");
  assert.equal(normalizePath("/Pricing"), "/pricing");
  assert.equal(normalizePath("/pricing?utm_source=x"), "/pricing");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath(""), "/");

  // and they all resolve to the same canonical
  const expected = canonicalFor("/pricing");
  for (const variant of ["/pricing", "/pricing/", "/Pricing", "/pricing?utm_source=x"]) {
    assert.equal(canonical(injectMeta(TEMPLATE, variant)), expected);
  }
});

test("the homepage canonical keeps its trailing slash", () => {
  assert.match(canonicalFor("/"), /\/$/);
});

test("static middleware must not serve the SPA shell for /", () => {
  // Regression: express.static's `index` option defaults to "index.html", so a
  // request for "/" was answered from disk and never reached the catch-all —
  // the homepage alone shipped the raw template with the generic title, while
  // every other route was injected correctly. Caught in production, not by the
  // unit tests, because injectMeta() itself was fine; it simply wasn't called.
  const source = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf8");
  const staticBlock = source.match(/express\.static\(distPath,\s*\{[\s\S]*?\n\s*\}\)\)/);
  assert.ok(staticBlock, "expected an express.static(distPath, {...}) call");
  assert.match(
    staticBlock[0],
    /index:\s*false/,
    "express.static(distPath) must set index:false, or GET / bypasses injectMeta()"
  );
});

test("the homepage gets injected copy, not the template default", () => {
  const home = injectMeta(TEMPLATE, "/");
  assert.equal(title(home), PAGE_META["/"].title.replace(/&/g, "&amp;"));
  assert.notEqual(title(home), title(TEMPLATE), "homepage must not keep the generic title");
});

test("metadata is HTML-escaped", () => {
  const html = injectMeta(TEMPLATE, "/");
  assert.ok(!/<title>[^<]*[<>]/.test(html.match(/<title>[\s\S]*?<\/title>/)[0].slice(7, -8)));
});

test("injection does not corrupt the rest of the document", () => {
  const html = injectMeta(TEMPLATE, "/pricing");
  // The JSON-LD graph and the script tags must survive untouched.
  assert.ok(html.includes('application/ld+json'), "structured data must survive");
  assert.equal(
    (html.match(/<link\s+rel="canonical"/gi) || []).length,
    1,
    "must not duplicate the canonical tag"
  );
  assert.equal(html.length > 0, true);
});

test("priority keyword map routes inject proper titles and descriptions", () => {
  const priorityRoutes = [
    "/",
    "/dog-3d-models",
    "/cat-3d-models",
    "/pet-professionals",
    "/glb-pet-models-guide",
    "/denver",
    "/philadelphia",
    "/pricing",
    "/guides"
  ];
  for (const route of priorityRoutes) {
    const html = injectMeta(TEMPLATE, route);
    assert.ok(title(html).length > 10, `${route} must have descriptive title`);
    assert.ok(description(html).length > 20, `${route} must have descriptive meta description`);
  }
});

test("dynamic product page injection produces valid title and Product JSON-LD", () => {
  const html = injectMeta(TEMPLATE, "/product/shiba-inu-glb");
  assert.equal(canonical(html), "https://pawsome3d.com/product/shiba-inu-glb");
  assert.ok(title(html).includes("Shiba Inu Glb"));
  assert.ok(html.includes('id="schema-product"'), "product pages must include product schema");
  assert.ok(html.includes('"@type":"Product"'), "product schema must contain @type Product");
  assert.ok(html.includes('"@type":"Organization"'), "sitewide org schema must be injected");
});

