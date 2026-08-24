import test from "node:test";
import assert from "node:assert/strict";

const { isBot, classifyDevice, referrerHost, normalizePath, recordPageView } =
  await import("../server/analytics/pageviews.ts");

/** Captures the parameters an insert would have written. */
function capturingPool(onQuery = () => {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); onQuery(); return [[], []]; },
  };
}

test("no identifier of any kind reaches the database", async () => {
  // The privacy position is structural: if the insert cannot carry an
  // identifier, no future change to a policy document can make it leak one.
  const pool = capturingPool();
  await recordPageView(pool, {
    path: "/barkley",
    referrer: "https://x.com/someone/status/123",
    userAgent: "Mozilla/5.0 (iPhone) AppleWebKit",
    utmSource: "x",
  });
  const { sql, params } = pool.calls[0];
  for (const forbidden of ["ip", "cookie", "session", "user_id", "fingerprint", "visitor"]) {
    assert.doesNotMatch(sql.toLowerCase(), new RegExp(`\\b${forbidden}\\b`), `${forbidden} must not be stored`);
  }
  // Six columns exactly: path, referrer host, three utm tags, device.
  assert.equal(params.length, 6);
});

test("the referrer is reduced to a host, never a full URL", async () => {
  // A referring URL can carry a search query or a private path.
  const pool = capturingPool();
  await recordPageView(pool, {
    path: "/",
    referrer: "https://www.google.com/search?q=very+personal+medical+question",
    userAgent: "Mozilla/5.0 Chrome",
  });
  assert.equal(pool.calls[0].params[1], "google.com");
});

test("own-domain referrers are dropped, not counted as a source", () => {
  // Otherwise the site becomes its own biggest referrer and the report is junk.
  assert.equal(referrerHost("https://pawsome3d.com/pricing"), null);
  assert.equal(referrerHost("https://www.pawsome3d.com/"), null);
  assert.equal(referrerHost("https://x.pawsome3d.com/"), null);
  assert.equal(referrerHost("https://x.com/i/status/1"), "x.com");
  assert.equal(referrerHost("not a url"), null);
  assert.equal(referrerHost(null), null);
});

test("the query string is discarded — it is where tokens and emails live", () => {
  assert.equal(normalizePath("/orders?token=secret&email=a@b.com"), "/orders");
  assert.equal(normalizePath("/barkley#beat-3"), "/barkley");
  assert.equal(normalizePath("/pricing/"), "/pricing");
  assert.equal(normalizePath("/"), "/");
});

test("a path that is not a path is refused rather than stored", () => {
  assert.equal(normalizePath("https://evil.example/x"), null);
  assert.equal(normalizePath("javascript:alert(1)"), null);
  assert.equal(normalizePath("no-leading-slash"), null);
  assert.equal(normalizePath("/" + "x".repeat(300)), null);
  assert.equal(normalizePath(""), null);
  assert.equal(normalizePath(null), null);
});

test("obvious crawlers are not counted", async () => {
  for (const ua of [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "curl/8.4.0",
    "python-requests/2.31",
    "facebookexternalhit/1.1",
    "",
  ]) {
    const pool = capturingPool();
    const out = await recordPageView(pool, { path: "/", userAgent: ua });
    assert.equal(out.recorded, false, `"${ua.slice(0, 30)}" should be filtered`);
    assert.equal(pool.calls.length, 0, "a bot must not reach the database");
  }
});

test("a real browser is counted", async () => {
  const pool = capturingPool();
  const out = await recordPageView(pool, {
    path: "/barkley",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  });
  assert.equal(out.recorded, true);
  assert.equal(pool.calls.length, 1);
});

test("device classes are coarse by design", () => {
  assert.equal(classifyDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148"), "mobile");
  assert.equal(classifyDevice("Mozilla/5.0 (iPad; CPU OS 17_0) Safari"), "tablet");
  assert.equal(classifyDevice("Mozilla/5.0 (Macintosh) Chrome/120 Safari"), "desktop");
  assert.equal(classifyDevice(null), "unknown");
});

test("UTM values are campaign labels, not free text", async () => {
  const pool = capturingPool();
  await recordPageView(pool, {
    path: "/",
    userAgent: "Mozilla/5.0 Chrome",
    utmSource: "x",
    utmMedium: "<script>alert(1)</script>",
    utmCampaign: "barkley",
  });
  const [, , source, medium, campaign] = pool.calls[0].params;
  assert.equal(source, "x");
  assert.equal(medium, null, "a value that is not a label is dropped, not stored");
  assert.equal(campaign, "barkley");
});

test("a database failure never propagates to the visitor", async () => {
  // A visitor losing the page to a stats insert is far worse than a missing row.
  const pool = { query: async () => { throw new Error("connection lost"); } };
  const original = console.error;
  console.error = () => {};
  try {
    const out = await recordPageView(pool, { path: "/", userAgent: "Mozilla/5.0 Chrome" });
    assert.equal(out.recorded, false);
  } finally { console.error = original; }
});
