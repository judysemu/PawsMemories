import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};

const api = await import("../src/api.ts");

test("transient session restoration failures preserve the valid token", async () => {
  api.setToken("valid-session-token");
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "temporary outage" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(() => api.fetchMe(), /temporary outage|restore your session/i);
  assert.equal(api.getToken(), "valid-session-token");
});

test("authoritative unauthorized session restoration clears the token", async () => {
  api.setToken("expired-session-token");
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
  assert.equal(await api.fetchMe(), null);
  assert.equal(api.getToken(), null);
});

test("public deep links and incomplete profiles are restored before authenticated routing", async () => {
  const [appSource, signUpSource, captureSource, animatorSource] = await Promise.all([
    fs.readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/components/SignUp.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/animator/capture/useCaptureSession.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/animator/components/AnimatorScreen.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /useState<Screen>\(\(\) =>[\s\S]*screenFromPath\(window\.location\.pathname\)[\s\S]*PUBLIC_SCREENS/);
  assert.match(appSource, /PUBLIC_SCREENS[\s\S]*Screen\.SIGN_UP/);
  assert.match(appSource, /setIncompleteUser\(user\)[\s\S]*setCurrentScreen\(Screen\.SIGN_UP\)/);
  assert.match(signUpSource, /resumeProfile[\s\S]*setStep\("profile"\)/);
  assert.match(captureSource, /Authorization.*Bearer.*getToken/s);
  assert.match(animatorSource, /currentRecordingId = data\.recordingId/);
  assert.doesNotMatch(animatorSource, /currentRecordingId = data\.filename/);
});
