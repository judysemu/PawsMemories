import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doctorPath = path.join(root, "scripts/animator-doctor.mjs");
const ansiPattern = /\u001b\[[0-9;]*m/g;

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

async function runDoctor(workerUrl) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "animator-doctor-test-"));
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [doctorPath, "--fix"],
      {
        cwd: root,
        env: {
          ...process.env,
          ANIMATOR_DATA_DIR: dataDir,
          BLENDER_WORKER_URL: workerUrl,
        },
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
      },
    );
    return `${stdout}\n${stderr}`.replace(ansiPattern, "");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function withHealthServer(status, callback) {
  const server = http.createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: status === 200 ? "ok" : "unavailable" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function probeLine(output, label) {
  const line = output.split("\n").find((candidate) => candidate.includes(label));
  assert.ok(line, `Missing ${label} probe in output:\n${output}`);
  return line;
}

test("doctor has no dead meshoptimizer fallback or shell health probe", async () => {
  const source = await readFile(doctorPath, "utf8");
  assert.doesNotMatch(source, /\bexecSync\b/);
  assert.doesNotMatch(source, /execAsync|curl\s+-/);
  assert.match(source, /fetch\(/);
  assert.match(source, /AbortSignal\.timeout\(/);
});

test("missing meshoptimizer is an explicit optional warning without ReferenceError", async () => {
  const port = await freePort();
  const output = await runDoctor(`http://127.0.0.1:${port}`);
  const line = probeLine(output, "meshoptimizer (Node bindings)");
  assert.match(line, /optional/);
  assert.match(output, /meshoptimizer not installed or importable/);
  assert.doesNotMatch(output, /ReferenceError/);
});

test("unreachable worker is an optional warning, never a green reachability result", async () => {
  const port = await freePort();
  const output = await runDoctor(`http://127.0.0.1:${port}`);
  const line = probeLine(output, "Worker reachability");
  assert.match(line, /optional/);
  assert.doesNotMatch(line, /✓/);
});

test("non-2xx worker health is an optional warning", async () => {
  await withHealthServer(503, async (workerUrl) => {
    const output = await runDoctor(workerUrl);
    const line = probeLine(output, "Worker reachability");
    assert.match(line, /optional/);
    assert.match(output, /HTTP 503/);
  });
});

test("2xx worker health is reported reachable", async () => {
  await withHealthServer(200, async (workerUrl) => {
    const output = await runDoctor(workerUrl);
    const line = probeLine(output, "Worker reachability");
    assert.match(line, /✓/);
    assert.doesNotMatch(line, /optional/);
  });
});
