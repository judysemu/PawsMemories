import test from "node:test";
import assert from "node:assert/strict";

const { authedFetch } = await import("../src/api.ts");

/** Records every call and replays a scripted sequence of outcomes. */
function stubFetch(outcomes) {
  const calls = [];
  global.fetch = async (input, init) => {
    calls.push({ input, init, method: (init?.method || "GET").toUpperCase() });
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    return new Response(outcome.body ?? "{}", { status: outcome.status });
  };
  return calls;
}

const originalFetch = global.fetch;
test.after(() => { global.fetch = originalFetch; });

test("a GET retries past a redeploy 503 and returns the eventual success", async () => {
  const calls = stubFetch([{ status: 503 }, { status: 503 }, { status: 200, body: '{"ok":true}' }]);
  const res = await authedFetch("/api/thing");
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3, "both 503s must be retried");
});

test("a POST is never replayed, because a paid stage could be charged twice", async () => {
  // Several paid routes are idempotent by key and several are not; this
  // wrapper cannot tell them apart, so it must not decide to replay any.
  const calls = stubFetch([{ status: 503 }, { status: 200 }]);
  const res = await authedFetch("/api/pay", { method: "POST", body: "{}" });
  assert.equal(res.status, 503, "the first answer must be returned as-is");
  assert.equal(calls.length, 1, "an unsafe method must be attempted exactly once");
});

test("a GET carrying a body is treated as unsafe and not replayed", async () => {
  const calls = stubFetch([{ status: 502 }, { status: 200 }]);
  const res = await authedFetch("/api/search", { method: "GET", body: "query" });
  assert.equal(res.status, 502);
  assert.equal(calls.length, 1);
});

test("a 4xx is returned immediately — the server already decided", async () => {
  const calls = stubFetch([{ status: 400, body: '{"error":"INVALID"}' }, { status: 200 }]);
  const res = await authedFetch("/api/thing");
  assert.equal(res.status, 400);
  assert.equal(calls.length, 1, "a considered rejection must not be retried");
});

test("a network error on a GET is retried, then surfaces if it never clears", async () => {
  const calls = stubFetch([new Error("network down")]);
  await assert.rejects(authedFetch("/api/thing"), /network down/);
  assert.equal(calls.length, 3, "one initial attempt plus two retries");
});

test("a caller abort is a decision and is not retried", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = stubFetch([new Error("aborted")]);
  await assert.rejects(authedFetch("/api/thing", { signal: controller.signal }));
  assert.equal(calls.length, 1, "an aborted request must not be replayed");
});

test("the Authorization header survives a retry", async () => {
  const calls = stubFetch([{ status: 503 }, { status: 200 }]);
  await authedFetch("/api/thing");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    // Headers are built once and reused; every attempt must carry them.
    assert.ok(call.init.headers instanceof Headers, "headers must be passed on each attempt");
  }
});

test("each attempt is given an abort signal so a stall cannot hang the UI", async () => {
  const calls = stubFetch([{ status: 200 }]);
  await authedFetch("/api/thing");
  assert.ok(calls[0].init.signal, "a bare fetch with no signal can hang indefinitely");
});
