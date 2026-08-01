// ─── Phase 5 Feature Flag ───────────────────────────────────────────────────
// Server-authoritative and on by default. Set false only for an emergency
// rollback; generated GLBs depend on this canonical private library.

export function isFurBinV5Enabled(): boolean {
  return process.env.FUR_BIN_V5_ENABLED !== "false";
}

export function assertFurBinV5Enabled(): void {
  if (!isFurBinV5Enabled()) {
    throw Object.assign(new Error("Fur Bin V5 showcase is not enabled"), { code: "FEATURE_DISABLED" });
  }
}
