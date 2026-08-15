import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import jwt from "jsonwebtoken";

let port;
let apiUrl;

let serverProcess;
let bootTimer;
const MOCK_JWT_SECRET = "fixture-only-signing-material"; // gitleaks:allow - immutable test fixture

// Create a valid token for testing authed routes
const validToken = jwt.sign(
  { phone: "test", userId: 1 },
  MOCK_JWT_SECRET,
  { expiresIn: "1h" }
);

// Hard ceiling for the whole file. If anything leaves a child/handle alive,
// we kill the child and force the test file to finish instead of hanging CI.
const FILE_TIMEOUT_MS = 30000;
let fileTimer;

async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const selected = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

function signalServer(signal) {
  if (!serverProcess?.pid || serverProcess.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-serverProcess.pid, signal);
    else serverProcess.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

before(async () => {
  port = await reserveFreePort();
  apiUrl = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: MOCK_JWT_SECRET,
      NODE_ENV: "test",
      DB_DISABLED: "1",
    };
    // Explicitly disable DB so initDb() gracefully skips rather than blocking
    // on a connection refused / retry loop when no MySQL is reachable (CI).
    delete env.DB_NAME;
    delete env.DB_USER;

    const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    serverProcess = spawn(tsxBin, ["server.ts"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let booted = false;
    const markBooted = (line) => {
      if (!booted && line.includes(`Server running on port ${port}`)) {
        booted = true;
        if (bootTimer) clearTimeout(bootTimer);
        resolve();
      }
    };

    serverProcess.stdout.on("data", (data) => markBooted(data.toString()));
    serverProcess.stderr.on("data", (data) => markBooted(data.toString()));

    serverProcess.on("error", (err) => {
      if (!booted) {
        if (bootTimer) clearTimeout(bootTimer);
        reject(err);
      }
    });

    serverProcess.on("exit", (code) => {
      if (!booted) {
        if (bootTimer) clearTimeout(bootTimer);
        reject(new Error(`Server exited early with code ${code}`));
      }
    });

    // Timeout if it takes too long to boot.
    bootTimer = setTimeout(() => {
      if (!booted) {
        try { signalServer("SIGKILL"); } catch { /* ignore */ }
        reject(new Error("Server boot timeout"));
      }
    }, 10000);
  });
});

after(async () => {
  if (bootTimer) clearTimeout(bootTimer);
  if (fileTimer) clearTimeout(fileTimer);
  const child = serverProcess;
  if (!child) return;

  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();

    let killTimer;
    const onExit = () => {
      if (killTimer) clearTimeout(killTimer);
      resolve();
    };
    child.once("exit", onExit);

    try { signalServer("SIGTERM"); } catch { /* ignore */ }
    killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        try { signalServer("SIGKILL"); } catch { /* ignore */ }
      }
    }, 2000);
  });

  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    try { stream?.destroy?.(); } catch { /* ignore */ }
  }
});

// Guarantee the file never hangs the suite: if the test run overstays the
// ceiling, tear down the child and let the runner finish.
before(() => {
  fileTimer = setTimeout(() => {
    console.error("[auth-routes] file timeout reached; forcing teardown");
    if (serverProcess && serverProcess.pid && !serverProcess.killed) {
      try { signalServer("SIGKILL"); } catch { /* ignore */ }
    }
    // Do NOT process.exit() here — only the child is killed so the rest of
    // `tsx --test` continues normally.
  }, FILE_TIMEOUT_MS);
  if (typeof fileTimer.unref === "function") fileTimer.unref();
});

test("Public routes are reachable without a token", async () => {
  // Login route should not return 401 Unauthorized (it might return 400 for bad input,
  // or 500 for DB error, but NOT the auth middleware's 401)
  const loginRes = await fetch(`${apiUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "x", password: "y" }),
  });

  assert.notEqual(
    loginRes.status,
    401,
    "POST /api/auth/login should not be blocked by requireAuth (should not return 401)"
  );

  // Same for signup
  const signupRes = await fetch(`${apiUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "123", password: "y", name: "test", email: "test@test.com" }),
  });

  assert.notEqual(
    signupRes.status,
    401,
    "POST /api/auth/signup should not be blocked by requireAuth (should not return 401)"
  );

  const pawprintTemplatesRes = await fetch(`${apiUrl}/api/pawprints/templates`);
  assert.equal(
    pawprintTemplatesRes.status,
    200,
    "GET /api/pawprints/templates should be handled by Node, not the Studio proxy"
  );
  const pawprintTemplates = await pawprintTemplatesRes.json();
  assert.ok(Array.isArray(pawprintTemplates.digitalCategories));
  assert.equal(
    Object.hasOwn(pawprintTemplates, "printProducts"),
    false,
    "PawPrint templates endpoint should not expose retired physical-print options"
  );
});

test("Studio proxy is isolated to /api/studio", async () => {
  const avatarRes = await fetch(`${apiUrl}/api/avatars`);
  assert.equal(
    avatarRes.status,
    401,
    "GET /api/avatars should reach its auth guard, not the Studio proxy"
  );

  const studioRes = await fetch(`${apiUrl}/api/studio/productions`);
  assert.equal(
    studioRes.status,
    401,
    "GET /api/studio/* should remain protected by authentication"
  );
});

test("Protected animator and scenes routes return 401 without a token", async () => {
  const animatorRes = await fetch(`${apiUrl}/api/animator/jobs`);
  assert.equal(animatorRes.status, 401, "GET /api/animator/jobs without token MUST return 401");

  const scenesRes = await fetch(`${apiUrl}/api/scenes/backgrounds`);
  assert.equal(scenesRes.status, 401, "GET /api/scenes/backgrounds without token MUST return 401");
});

test("Protected animator and scenes routes accept a valid token", async () => {
  const animatorRes = await fetch(`${apiUrl}/api/animator/jobs`, {
    headers: { Authorization: `Bearer ${validToken}` },
  });
  // Since DB is broken in this test environment, we expect a 500, NOT a 401.
  assert.notEqual(animatorRes.status, 401, "GET /api/animator/jobs WITH token should pass auth (no 401)");

  const scenesRes = await fetch(`${apiUrl}/api/scenes/backgrounds`, {
    headers: { Authorization: `Bearer ${validToken}` },
  });
  // The backgrounds endpoint might be mocked or hit DB, but it shouldn't 401
  assert.notEqual(scenesRes.status, 401, "GET /api/scenes/backgrounds WITH token should pass auth (no 401)");
});
