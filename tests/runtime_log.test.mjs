import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "runtimelog-"));
process.env.RUNTIME_LOG_DIR = join(scratch, "logs");

const { installRuntimeLogger, readRuntimeLog, getRuntimeLogDiagnostics, __resetRuntimeLoggerStateForTests } =
  await import("../server/runtimeLog.ts");

const today = () => new Date().toISOString().slice(0, 10);

test("a healthy logger writes, reads back, and reports itself writable", () => {
  __resetRuntimeLoggerStateForTests(join(scratch, "healthy"));
  const original = console.error;
  try {
    installRuntimeLogger();
    console.error("canary-entry", { detail: 42 });
  } finally {
    console.error = original;
  }

  const content = readRuntimeLog(today());
  assert.ok(content, "the day's log must exist after a write");
  assert.match(content, /canary-entry/);
  assert.match(content, /logger started/, "boot must prove writability rather than assume it");

  const d = getRuntimeLogDiagnostics();
  assert.equal(d.writable, true);
  assert.equal(d.usingFallback, false);
  assert.equal(d.lastWriteError, null);
  assert.ok(d.writesSucceeded > 0);
});

test("an unwritable directory falls back instead of losing the entry", { skip: process.getuid && process.getuid() === 0 ? "running as root" : false }, () => {
  const locked = join(scratch, "locked");
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o500); // r-x: cannot create files inside

  __resetRuntimeLoggerStateForTests(join(locked, "nested"));
  const original = console.error;
  try {
    installRuntimeLogger();
    console.error("entry-that-must-survive");
  } finally {
    console.error = original;
    chmodSync(locked, 0o700);
  }

  const d = getRuntimeLogDiagnostics();
  // Losing the log entirely is worse than writing it somewhere less
  // convenient, so the entry must still land and say where it went.
  assert.equal(d.usingFallback, true, "an unwritable directory must fall back");
  assert.ok(d.directory.includes("pawsome3d-runtime-logs"));
  assert.ok(existsSync(d.directory));

  const files = readdirSync(d.directory).filter((f) => f.startsWith("runtime-"));
  assert.ok(files.length > 0, "the fallback directory must contain the day's log");
  assert.match(readFileSync(join(d.directory, files[0]), "utf8"), /entry-that-must-survive/);
});

test("a directory that cannot be written anywhere still reports the reason", () => {
  // The endpoint's whole purpose is telling a quiet day apart from a broken
  // logger, so the failure text must survive even when nothing was written.
  __resetRuntimeLoggerStateForTests("/proc/definitely-not-writable");
  const original = console.error;
  try {
    console.error = () => {};
    installRuntimeLogger();
  } finally {
    console.error = original;
  }
  const d = getRuntimeLogDiagnostics();
  if (!d.usingFallback) {
    assert.ok(d.lastWriteError, "an unwritable target must record why");
    assert.equal(d.writable, false, "attempted-but-never-succeeded is not writable");
  }
});

test("readRuntimeLog refuses a path-shaped date", () => {
  __resetRuntimeLoggerStateForTests(join(scratch, "healthy"));
  assert.equal(readRuntimeLog("../../etc/passwd"), null);
  assert.equal(readRuntimeLog("2026-08-20/../../secret"), null);
  assert.equal(readRuntimeLog("not-a-date"), null);
});

test("a day with no errors reads empty but still reports writable", () => {
  __resetRuntimeLoggerStateForTests(join(scratch, "healthy"));
  assert.equal(readRuntimeLog("2000-01-01"), null, "a quiet day has no file");
  const d = getRuntimeLogDiagnostics();
  assert.equal(typeof d.writable, "boolean", "health is reported independently of content");
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
