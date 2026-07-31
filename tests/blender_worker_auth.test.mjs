import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let child;
let baseUrl;
let childOutput = "";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Blender worker did not start. Output:\n${childOutput}`);
}

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(root, "blender-worker"),
    env: {
      ...process.env,
      PORT: String(port),
      WORKER_SHARED_SECRET: "worker-auth-regression-secret",
      BLENDER_AUTOSTART_BRIDGE: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { childOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { childOutput += chunk.toString(); });
  await waitForServer(baseUrl);
});

after(() => {
  child?.kill("SIGTERM");
});

test("Blender worker rejects unauthenticated code-execution and job routes", async () => {
  const render = await fetch(`${baseUrl}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-valid-json",
  });
  assert.equal(render.status, 401);

  const job = await fetch(`${baseUrl}/jobs/not-a-real-job`);
  assert.equal(job.status, 401);
});

test("Blender worker accepts the shared secret before validating a legacy request", async () => {
  const response = await fetch(`${baseUrl}/render`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": "worker-auth-regression-secret",
    },
    body: "{}",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Missing python_script in request body" });
});

test("Blender worker rejects wrong secrets regardless of byte length", async () => {
  for (const secret of [
    "short",
    "worker-auth-regression-secrex",
    "worker-auth-regression-secret-too-long",
  ]) {
    const response = await fetch(`${baseUrl}/render`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-secret": secret,
      },
      body: "{}",
    });
    assert.equal(response.status, 401);
  }
});

test("Blender worker fails closed when its shared secret is not configured", async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const { WORKER_SHARED_SECRET: _ignored, ...envWithoutWorkerSecret } = process.env;
  let output = "";
  const unconfiguredWorker = spawn(process.execPath, ["server.js"], {
    cwd: path.join(root, "blender-worker"),
    env: {
      ...envWithoutWorkerSecret,
      PORT: String(port),
      BLENDER_AUTOSTART_BRIDGE: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  unconfiguredWorker.stdout.on("data", (chunk) => { output += chunk.toString(); });
  unconfiguredWorker.stderr.on("data", (chunk) => { output += chunk.toString(); });

  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const health = await fetch(`${url}/health`);
        if (health.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const response = await fetch(`${url}/render`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-secret": "caller-supplied-secret",
      },
      body: "{}",
    });
    assert.equal(response.status, 401, output);
  } finally {
    unconfiguredWorker.kill("SIGTERM");
  }
});

test("Blender worker compares equal-length secret buffers with timingSafeEqual", async () => {
  const source = await readFile(path.join(root, "blender-worker/server.js"), "utf8");
  assert.match(source, /Buffer\.from\(expected/);
  assert.match(source, /Buffer\.from\(provided/);
  assert.match(source, /expectedBuffer\.length\s*!==\s*providedBuffer\.length/);
  assert.match(source, /crypto\.timingSafeEqual\(expectedBuffer,\s*providedBuffer\)/);
});

test("Blender worker health remains public", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
});

test("Blender TCP bridge is loopback-only and is not published by the container", async () => {
  const bridge = await readFile(path.join(root, "blender-worker/bridge/tcp_server.py"), "utf8");
  const dockerfile = await readFile(path.join(root, "blender-worker/Dockerfile"), "utf8");
  assert.match(bridge, /TCP_HOST\s*=\s*os\.environ\.get\("BLENDER_BRIDGE_BIND_HOST",\s*"127\.0\.0\.1"\)/);
  assert.doesNotMatch(dockerfile, /^EXPOSE\s+9876\s*$/m);
});
