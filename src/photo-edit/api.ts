// ─── Photo edit: background removal (client) ────────────────────────────────
// Thin wrapper over POST /api/photo-edit/remove-background.
//
// The server fails OPEN — a provider outage returns removed:false with the
// original untouched rather than an error status — so this module reports
// "not removed" as an ordinary outcome, never a thrown exception. The caller
// keeps the photo it already had either way.
import { authedFetch } from "../api";

/**
 * Deliberately one shape rather than a discriminated union: this project does
 * not enable `strict`, and without strictNullChecks TypeScript will not narrow
 * a union on a boolean discriminant, so callers would be left casting.
 */
export interface BackgroundRemovalOutcome {
  /** True only when `dataUrl` holds a cutout. */
  removed: boolean;
  /** WebP-with-alpha, inlined. Present only when `removed`. */
  dataUrl?: string;
  /** The matte was served from cache, so it cost nothing this time. */
  cached?: boolean;
  /** Customer-facing explanation. Empty when the feature is simply off. */
  reason?: string;
  /** The server flag is off — not a failure, and nothing to show the customer. */
  featureDisabled?: boolean;
}

/** Server ceiling is 15 MB of decoded bytes; base64 inflates by about a third. */
const MAX_DATA_URL_LENGTH = 15 * 1024 * 1024 * 1.4;

const GENERIC_FAILURE = "We couldn't separate the background on this photo. Your original is unchanged.";

/**
 * The signed URL points at the private bucket and expires, so the bytes are
 * inlined immediately. Everything downstream — the collage renderer, the draft
 * spec, the print pipeline — already passes StudioPhoto.dataUrl around, and a
 * URL that dies mid-order would be a much worse failure than a slightly larger
 * string in memory.
 */
async function inlineSignedUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cutout fetch failed: ${response.status}`);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("cutout could not be read"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(blob);
  });
}

export async function removeBackground(imageDataUrl: string): Promise<BackgroundRemovalOutcome> {
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(imageDataUrl)) {
    return { removed: false, reason: "Background removal needs a PNG, JPEG or WebP photo." };
  }
  if (imageDataUrl.length > MAX_DATA_URL_LENGTH) {
    return { removed: false, reason: "That photo is too large to separate. Try one under 15 MB." };
  }

  let payload: any;
  try {
    const response = await authedFetch("/api/photo-edit/remove-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageDataUrl }),
    });

    // 503 FEATURE_DISABLED is the flag being off, not a fault. It is reported
    // separately so the caller can hide the control rather than showing an
    // error for something the customer never asked for.
    if (response.status === 503) {
      return { removed: false, featureDisabled: true };
    }
    if (!response.ok) {
      // Distinct from the fail-open text below. These two arrive for entirely
      // different reasons — a rejected request versus a provider outage — and
      // wearing the same words made a live failure impossible to diagnose from
      // the UI, which is exactly when diagnosis matters.
      let detail = "";
      try {
        const body = await response.json();
        detail = String(body?.error || "");
      } catch {
        // A non-JSON error body tells us nothing; the status still does.
      }
      return {
        removed: false,
        reason: detail || `That photo was rejected before matting (HTTP ${response.status}).`,
      };
    }
    payload = await response.json();
  } catch {
    return { removed: false, reason: GENERIC_FAILURE };
  }

  if (!payload?.removed) {
    return { removed: false, reason: String(payload?.reason || GENERIC_FAILURE) };
  }

  // Accept both a bare string and the { url, expiresAt } envelope that
  // getPrivateSignedUrl returns. Insisting on a string discarded a matte that
  // had already succeeded and been billed, and reported it to the customer as a
  // provider failure — the most expensive way to be wrong about a response.
  const signedUrl = typeof payload.url === "string"
    ? payload.url
    : typeof payload.url?.url === "string" ? payload.url.url : "";
  if (!signedUrl) {
    return { removed: false, reason: GENERIC_FAILURE };
  }

  try {
    return { removed: true, dataUrl: await inlineSignedUrl(signedUrl), cached: Boolean(payload.cached) };
  } catch {
    // The matte succeeded but its bytes are unreachable. Same outcome for the
    // customer as a provider failure, so it is reported the same way.
    return { removed: false, reason: GENERIC_FAILURE };
  }
}
