/** Runtime error log for the "Pawsome3D Runtime Log Watch" scheduled routine
 *  (see docs/AUTOMATIONS.md). There is no API for live application/request
 *  logs on this Hostinger shared-hosting site — only Node.js build logs —
 *  so the routine instead reads this file via the Hostinger connector's
 *  hosting_getWebsiteFileContentV1.
 *
 *  Deliberately not touching the ~130 existing console.error call sites
 *  across the app: this wraps console.error once at boot so every existing
 *  call site is captured automatically, plus process-level crash paths that
 *  don't go through it at all. */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = process.env.RUNTIME_LOG_DIR || "logs";
const RETENTION_DAYS = 14;
const LOG_FILE_NAME_PATTERN = /^runtime-\d{4}-\d{2}-\d{2}\.log$/;

function logFilePath(date: Date = new Date()): string {
  return join(LOG_DIR, `runtime-${date.toISOString().slice(0, 10)}.log`);
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function formatArg(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  return typeof value === "string" ? value : safeStringify(value);
}

function writeLine(level: "error" | "fatal", args: unknown[]): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const entry = { ts: new Date().toISOString(), level, message: args.map(formatArg).join(" ") };
    appendFileSync(logFilePath(), `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never be why a request fails.
  }
}

function pruneOldLogs(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(LOG_DIR)) {
      if (!LOG_FILE_NAME_PATTERN.test(name)) continue;
      const full = join(LOG_DIR, name);
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
  const path = join(LOG_DIR, `runtime-${date}.log`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/** Call once, as early as possible in startup. */
export function installRuntimeLogger(): void {
  pruneOldLogs();

  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    writeLine("error", args);
  };

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
