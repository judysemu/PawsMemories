import assert from "node:assert/strict";
import test from "node:test";
import { pollImageTo3D, TripoError } from "../tripo.ts";
import { TripoModelBuildAdapter, ModelBuildProviderError } from "../server/model-builds/provider.ts";
import { createValidPngBuffer } from "../server/model-builds/validation.ts";

async function withFetch(responseFactory, run) {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.TRIPO_API_KEY;
  process.env.TRIPO_API_KEY = "test-key-not-a-secret";
  globalThis.fetch = responseFactory;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.TRIPO_API_KEY;
    else process.env.TRIPO_API_KEY = previousKey;
  }
}

async function runAdapterCreate(taskResponse) {
  const pngDataUri = `data:image/png;base64,${createValidPngBuffer(32, 32).toString("base64")}`;
  let uploadNumber = 0;
  return withFetch(
    async (url) => {
      if (String(url).endsWith("/upload")) {
        uploadNumber += 1;
        return Response.json({ data: { image_token: `safe-upload-${uploadNumber}` } });
      }
      return taskResponse();
    },
    () => new TripoModelBuildAdapter().start({
      frontUrl: pngDataUri,
      leftUrl: pngDataUri,
      rightUrl: pngDataUri,
      rearUrl: pngDataUri,
      threeQuarterUrl: pngDataUri,
    }, "config-hash"),
  );
}

for (const [status, failureCode] of [
  ["failed", "PROVIDER_TASK_FAILED"],
  ["banned", "PROVIDER_CONTENT_POLICY"],
  ["expired", "PROVIDER_TASK_EXPIRED"],
  ["unknown", "PROVIDER_TASK_UNKNOWN"],
]) {
  test(`Tripo ${status} is an explicit sanitized terminal result`, async () => {
    const result = await withFetch(
      async () => Response.json({
        data: {
          status,
          output: { model: "https://provider.invalid/private.glb?signature=do-not-log" },
          message: "arbitrary provider details must not escape",
        },
      }),
      () => pollImageTo3D("tripo:safe-task-id"),
    );

    assert.equal(result.done, true);
    assert.equal(result.failureCode, failureCode);
    assert.equal(JSON.stringify(result).includes("signature="), false);
    assert.equal(JSON.stringify(result).includes("arbitrary provider"), false);
  });
}

test("Tripo task-not-found is terminal and sanitized", async () => {
  const result = await withFetch(
    async () => Response.json(
      { code: 9999, message: "task not found at https://provider.invalid/private?signature=leak" },
      { status: 404 },
    ),
    () => pollImageTo3D("tripo:safe-task-id"),
  );

  assert.equal(result.done, true);
  assert.equal(result.failureCode, "PROVIDER_TASK_NOT_FOUND");
  assert.equal(JSON.stringify(result).includes("signature="), false);
});

test("Tripo 429/provider 2000 is retryable without provider-body disclosure", async () => {
  await assert.rejects(
    withFetch(
      async () => Response.json(
        { code: 2000, message: "slow down https://provider.invalid/private?signature=leak" },
        { status: 429 },
      ),
      () => pollImageTo3D("tripo:safe-task-id"),
    ),
    (error) => {
      assert.ok(error instanceof TripoError);
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes("signature="), false);
      return true;
    },
  );
});

test("Tripo provider code 2000 is retryable even when transported as HTTP 200", async () => {
  await assert.rejects(
    withFetch(
      async () => Response.json({
        code: 2000,
        message: "slow down https://provider.invalid/private?signature=leak",
      }),
      () => pollImageTo3D("tripo:safe-task-id"),
    ),
    (error) => {
      assert.ok(error instanceof TripoError);
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes("signature="), false);
      return true;
    },
  );
});

test("Tripo success logging never discloses signed output URLs or response bodies", async () => {
  const signedUrl = "https://provider.invalid/private.glb?signature=do-not-log";
  const messages = [];
  const originalLog = console.log;
  console.log = (...args) => messages.push(args.join(" "));
  try {
    const result = await withFetch(
      async () => Response.json({ data: { status: "success", output: { model: signedUrl } } }),
      () => pollImageTo3D("tripo:safe-task-id"),
    );
    assert.equal(result.glbUrl, signedUrl);
  } finally {
    console.log = originalLog;
  }

  assert.equal(messages.join("\n").includes(signedUrl), false);
  assert.equal(messages.join("\n").includes("signature="), false);
});

test("Tripo create transport failure is ambiguous and never marked retryable", async () => {
  await assert.rejects(
    runAdapterCreate(async () => {
      throw new TypeError("connection reset after request bytes were sent");
    }),
    (error) => {
      assert.ok(error instanceof ModelBuildProviderError);
      assert.equal(error.code, "PROVIDER_SUBMISSION_AMBIGUOUS");
      assert.equal(error.retryable, false);
      assert.equal(error.submissionDisposition, "ambiguous_acceptance");
      assert.equal(error.message.includes("connection reset"), false);
      return true;
    },
  );
});

test("Tripo create success without task ID is ambiguous", async () => {
  await assert.rejects(
    runAdapterCreate(async () => Response.json({ data: {} })),
    (error) => {
      assert.ok(error instanceof ModelBuildProviderError);
      assert.equal(error.code, "PROVIDER_SUBMISSION_AMBIGUOUS");
      assert.equal(error.submissionDisposition, "ambiguous_acceptance");
      return true;
    },
  );
});

test("Tripo create distinguishes definitive rejection from safe documented throttle", async () => {
  await assert.rejects(
    runAdapterCreate(async () => Response.json(
      { code: 1004, message: "invalid request with arbitrary detail" },
      { status: 400 },
    )),
    (error) => {
      assert.ok(error instanceof ModelBuildProviderError);
      assert.equal(error.submissionDisposition, "definitive_rejection");
      assert.equal(error.retryable, false);
      return true;
    },
  );

  await assert.rejects(
    runAdapterCreate(async () => Response.json(
      { code: 2000, message: "provider throttle detail" },
      { status: 429 },
    )),
    (error) => {
      assert.ok(error instanceof ModelBuildProviderError);
      assert.equal(error.code, "PROVIDER_RATE_LIMITED");
      assert.equal(error.submissionDisposition, "safe_retry");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});
