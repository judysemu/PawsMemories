import test from "node:test";
import assert from "node:assert/strict";

const {
  resolveZeroGpuConfig,
  isZeroGpuConfigured,
  parseGradioEventStream,
  callZeroGpu,
  ZeroGpuError,
} = await import("../server/labs/zerogpu.ts");

const BASE_ENV = { ZEROGPU_SPACE: "acct/paws-trellis", HF_TOKEN: "hf_test" };

test("config requires both a Space and a token", () => {
  assert.equal(resolveZeroGpuConfig({}), null);
  assert.equal(resolveZeroGpuConfig({ ZEROGPU_SPACE: "acct/space" }), null);
  assert.equal(resolveZeroGpuConfig({ HF_TOKEN: "hf_x" }), null);
  assert.ok(resolveZeroGpuConfig(BASE_ENV));
  assert.equal(isZeroGpuConfigured({}), false);
});

test("a malformed Space id is refused rather than turned into a bad URL", () => {
  // "owner/name" is the only valid shape; anything else would produce a host
  // that silently 404s and read as a job failure.
  for (const bad of ["nosuffix", "a/b/c", "acct/", "/space", "acct name/space"]) {
    assert.equal(resolveZeroGpuConfig({ ...BASE_ENV, ZEROGPU_SPACE: bad }), null, bad);
  }
});

test("the default Space URL follows Hugging Face's host convention", () => {
  const c = resolveZeroGpuConfig({ ...BASE_ENV, ZEROGPU_SPACE: "RobStelar/Paws-TRELLIS" });
  assert.equal(c.baseUrl, "https://robstelar-paws-trellis.hf.space");
});

test("a nonsense timeout falls back instead of disabling the bound", () => {
  for (const bad of ["0", "-5", "abc", ""]) {
    assert.equal(resolveZeroGpuConfig({ ...BASE_ENV, ZEROGPU_TIMEOUT_MS: bad }).timeoutMs, 180_000);
  }
  assert.equal(resolveZeroGpuConfig({ ...BASE_ENV, ZEROGPU_TIMEOUT_MS: "90000" }).timeoutMs, 90_000);
});

test("an unconfigured client fails closed and says so", async () => {
  await assert.rejects(
    callZeroGpu("run", [], {}),
    (e) => e instanceof ZeroGpuError && e.code === "ZEROGPU_NOT_CONFIGURED" && e.consumedGpu === false,
  );
});

test("the completion event is unwrapped from the stream", () => {
  const body = [
    "event: heartbeat", "data: null", "",
    "event: generating", "data: [null]", "",
    "event: complete", 'data: [{"glb":"https://example/out.glb"}]', "",
  ].join("\n");
  assert.deepEqual(parseGradioEventStream(body), { glb: "https://example/out.glb" });
});

test("an error event is a failure, not an empty success", () => {
  // Reading the stream to the end and returning nothing would present a failed
  // job as a successful one that produced no asset.
  const body = ["event: error", 'data: "CUDA out of memory"', ""].join("\n");
  assert.throws(
    () => parseGradioEventStream(body),
    (e) => e instanceof ZeroGpuError && e.code === "ZEROGPU_JOB_FAILED" && e.consumedGpu === true,
  );
});

test("a stream that ends without completing is a failure", () => {
  const body = ["event: heartbeat", "data: null", ""].join("\n");
  assert.throws(() => parseGradioEventStream(body), /without a completion event/);
});

test("quota exhaustion is reported as consuming GPU so callers do not retry into it", async () => {
  const original = global.fetch;
  global.fetch = async () => new Response("You have exceeded your GPU quota", { status: 429 });
  try {
    await assert.rejects(
      callZeroGpu("run", [1], BASE_ENV),
      (e) => e instanceof ZeroGpuError && e.code === "ZEROGPU_QUOTA_EXHAUSTED" && e.consumedGpu === true,
    );
  } finally { global.fetch = original; }
});

test("a sleeping Space is distinguished from quota — nothing was billed", async () => {
  const original = global.fetch;
  global.fetch = async () => new Response("Space is sleeping", { status: 503 });
  try {
    await assert.rejects(
      callZeroGpu("run", [1], BASE_ENV),
      (e) => e.code === "ZEROGPU_SPACE_SLEEPING" && e.consumedGpu === false,
    );
  } finally { global.fetch = original; }
});

test("a submit that returns no event id does not silently hang", async () => {
  const original = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
  try {
    await assert.rejects(callZeroGpu("run", [1], BASE_ENV), /no event id/);
  } finally { global.fetch = original; }
});

test("a full round trip returns the payload and an elapsed time", async () => {
  const original = global.fetch;
  let call = 0;
  global.fetch = async (url, init) => {
    call++;
    if (call === 1) {
      assert.equal(init.method, "POST");
      assert.match(String(url), /\/gradio_api\/call\/run$/);
      assert.equal(init.headers.Authorization, "Bearer hf_test");
      return new Response(JSON.stringify({ event_id: "ev-1" }), { status: 200 });
    }
    assert.match(String(url), /\/gradio_api\/call\/run\/ev-1$/);
    return new Response(
      ["event: complete", 'data: ["ok"]', ""].join("\n"),
      { status: 200 },
    );
  };
  try {
    const { result, elapsedMs } = await callZeroGpu("run", ["input"], BASE_ENV);
    assert.equal(result, "ok");
    assert.ok(elapsedMs >= 0);
    assert.equal(call, 2, "submit then poll");
  } finally { global.fetch = original; }
});
