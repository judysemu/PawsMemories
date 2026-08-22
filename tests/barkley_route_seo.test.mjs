import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { injectMeta, PAGE_META, canonicalFor } = await import("../server/seoMeta.ts");
const app = fs.readFileSync("src/App.tsx", "utf8");
const shell = fs.readFileSync("index.html", "utf8");

test("the route is reachable and public", () => {
  // The component existed for a week with no route, so the API reported
  // healthy while no user could reach it. These assert reachability, not
  // readiness.
  assert.match(app, /\[Screen\.BARKLEY\]:\s*"\/barkley"/, "needs a path");
  assert.match(app, /Screen\.BARKLEY,/, "must be in PUBLIC_SCREENS or signed-out visitors and crawlers get redirected");
  assert.match(app, /currentScreen === Screen\.BARKLEY &&/, "must actually render");
  assert.match(app, /lazy\(\(\) => import\("\.\/components\/BarkleyScreen"\)\)/,
    "must be lazy — it pulls three.js and a 4MB GLB");
});

test("the page declares itself, not the homepage", () => {
  const html = injectMeta(shell, "/barkley");
  assert.match(html, /<link rel="canonical" href="https:\/\/pawsome3d\.com\/barkley"/);
  assert.match(html, /property="og:url" content="https:\/\/pawsome3d\.com\/barkley"/);
  assert.doesNotMatch(html, /<link rel="canonical" href="https:\/\/pawsome3d\.com\/"/,
    "inheriting the homepage canonical self-excludes the page from the index");
});

test("title and description are distinct from the homepage", () => {
  const barkley = PAGE_META["/barkley"];
  const home = PAGE_META["/"];
  assert.ok(barkley, "route must have page copy");
  assert.notEqual(barkley.title, home.title, "duplicate titles compete with each other");
  assert.notEqual(barkley.description, home.description);
  assert.ok(barkley.description.length > 70 && barkley.description.length < 320,
    "description should survive a SERP snippet without being truncated to nothing");
});

test("structured data describes an interactive lesson, not a video", () => {
  const html = injectMeta(shell, "/barkley");
  const m = /<script type="application\/ld\+json" id="schema-barkley">(.*?)<\/script>/s.exec(html);
  assert.ok(m, "needs page-specific structured data");
  const ld = JSON.parse(m[1]);
  assert.equal(ld["@type"], "LearningResource");
  assert.equal(ld.url, canonicalFor("/barkley"));
  assert.ok(Array.isArray(ld.teaches) && ld.teaches.length >= 3);
  // A VideoObject claim would promise a playable video the page does not have,
  // and Google drops structured data that contradicts the page.
  assert.doesNotMatch(m[1], /VideoObject/);
});

test("the sitemap lists it", () => {
  const sitemap = fs.readFileSync("public/sitemap.xml", "utf8");
  assert.match(sitemap, /<loc>https:\/\/pawsome3d\.com\/barkley<\/loc>/);
});

test("robots does not exclude it", () => {
  const robots = fs.readFileSync("public/robots.txt", "utf8");
  assert.doesNotMatch(robots, /Disallow:\s*\/barkley/);
});
