/** Runtime error log for the "Pawsome3D Runtime Log Watch" scheduled routine
 *  (see docs/AUTOMATIONS.md). There is no API for live application/request
 *  logs on this Hostinger shared-hosting site — only Node.js build logs —
 *  so the routine instead reads this file via the Hostinger connector's
 *  hosting_getWebsiteFileContentV1.
 *
 *  Deliberately not touching the ~130 existing console.error call sites
 *  across the app: this wraps console.error once at boot so every existing
 *  call site is captured automatically, plus process-level crash paths that
 *  don't go through it at all.
 *
 *  A logger that cannot write must still be able to say so. The original
 *  version swallowed every write error and returned null for a missing file,
 *  which made a broken logger and a quiet day look identical — production
 *  errors were occurring while the endpoint returned empty, and every
 *  diagnosis had to be inferred from response bodies instead. Failures are now
 *  recorded, the log directory falls back to somewhere writable, and the read
 *  path reports its own health. */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const CONFIGURED_LOG_DIR = process.env.RUNTIME_LOG_DIR || "logs";
const RETENTION_DAYS = 14;
const LOG_FILE_NAME_PATTERN = /^runtime-\d{4}-\d{2}-\d{2}\.log$/;

/** Resolved against cwd explicitly. Passenger's working directory is not
 *  guaranteed to be the app root, and a relative path that silently resolves
 *  somewhere unexpected is the failure this module exists to prevent. */
function resolveDir(dir: string): string {
  return isAbsolute(dir) ? dir : join(process.cwd(), dir);
}

let activeDir = resolveDir(CONFIGURED_LOG_DIR);
let usingFallback = false;
let lastWriteError: string | null = null;
let writesAttempted = 0;
let writesSucceeded = 0;

export interface RuntimeLogDiagnostics {
  directory: string;
  configuredDirectory: string;
  usingFallback: boolean;
  writable: boolean;
  writesAttempted: number;
  writesSucceeded: number;
  lastWriteError: string | null;
}

function logFilePath(dir: string, date: Date = new Date()): string {
  return join(dir, `runtime-${date.toISOString().slice(0, 10)}.log`);
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function formatArg(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  return typeof value === "string" ? value : safeStringify(value);
}

function appendTo(dir: string, line: string): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(logFilePath(dir), line);
}

function writeLine(level: "error" | "fatal", args: unknown[]): void {
  writesAttempted += 1;
  const entry = { ts: new Date().toISOString(), level, message: args.map(formatArg).join(" ") };
  const line = `${JSON.stringify(entry)}\n`;

  try {
    appendTo(activeDir, line);
    writesSucceeded += 1;
    lastWriteError = null;
    return;
  } catch (error: any) {
    lastWriteError = `${activeDir}: ${error?.message || error}`;
  }

  // The configured directory is unwritable — a read-only app root, a
  // permissions change, a full disk. Losing the log entirely is worse than
  // writing it somewhere less convenient, so fall back once and keep going.
  if (!usingFallback) {
    const fallback = join(tmpdir(), "pawsome3d-runtime-logs");
    try {
      appendTo(fallback, line);
      activeDir = fallback;
      usingFallback = true;
      writesSucceeded += 1;
      return;
    } catch (error: any) {
      lastWriteError = `${lastWriteError} | fallback ${fallback}: ${error?.message || error}`;
    }
  }
  // Logging must never be why a request fails, so this still swallows — but
  // lastWriteError now survives for the diagnostics endpoint to report.
}

function pruneOldLogs(): void {
  try {
    mkdirSync(activeDir, { recursive: true });
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(activeDir)) {
      if (!LOG_FILE_NAME_PATTERN.test(name)) continue;
      const full = join(activeDir, name);
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    }
  } catch {
    // A pruning failure should never block boot.
  }
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Reads one day's log file for GET /api/admin/runtime-log. Returns null if
 *  the date is malformed or the file doesn't exist (no errors that day is
 *  the normal case, not a failure). `date` must be pre-validated by the
 *  caller against DATE_ONLY_PATTERN — enforced again here defensively since
 *  it's about to become part of a filesystem path. */
export function readRuntimeLog(date: string): string | null {
  if (!DATE_ONLY_PATTERN.test(date)) return null;
  const path = join(activeDir, `runtime-${date}.log`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/** Health of the logger itself, so an empty response can be told apart from a
 *  logger that never wrote anything. Returned alongside the log content. */
export function getRuntimeLogDiagnostics(): RuntimeLogDiagnostics {
  return {
    directory: activeDir,
    configuredDirectory: resolveDir(CONFIGURED_LOG_DIR),
    usingFallback,
    // A logger that has been asked to write and never succeeded is broken,
    // whatever the directory listing suggests.
    writable: writesAttempted === 0 ? existsSync(activeDir) : writesSucceeded > 0,
    writesAttempted,
    writesSucceeded,
    lastWriteError,
  };
}

/** Call once, as early as possible in startup. */
export function installRuntimeLogger(): void {
  pruneOldLogs();

  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    writeLine("error", args);
  };

  // Prove the log is writable at boot rather than discovering it during an
  // incident. This also creates the day's file, so a later empty read means
  // "no errors" rather than "never worked".
  writeLine("error", [`[runtime-log] logger started (pid ${process.pid}, dir ${activeDir})`]);
  if (lastWriteError) {
    originalConsoleError("[runtime-log] LOGGING IS DEGRADED:", lastWriteError);
  }

  // Node's default behavior for both of these is to log to stderr and exit —
  // preserve that (log to the file first, then exit the same way) rather
  // than silently keeping a process alive in a state Node itself considers
  // unrecoverable.
  process.on("uncaughtException", (err) => {
    writeLine("fatal", [err]);
    originalConsoleError("Uncaught exception — exiting:", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    writeLine("fatal", [reason]);
    originalConsoleError("Unhandled rejection — exiting:", reason);
    process.exit(1);
  });
}

/** Test seam: resets module state so a suite can exercise the fallback path. */
export function __resetRuntimeLoggerStateForTests(dir?: string): void {
  activeDir = resolveDir(dir ?? CONFIGURED_LOG_DIR);
  usingFallback = false;
  lastWriteError = null;
  writesAttempted = 0;
  writesSucceeded = 0;
}
