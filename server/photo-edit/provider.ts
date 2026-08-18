/**
 * Background-removal provider contract.
 *
 * One interface so the model can be swapped — hosted fal → self-hosted ONNX —
 * without touching the pipeline. `id` is recorded in the cache key, so changing
 * provider re-mattes rather than serving a cutout from a model we no longer use.
 *
 * LICENSING (see PAWSMEMORIES_PHOTO_EDITOR_ARCHITECTURE_2026-08-18.md §1):
 * any implementation added here must use a model whose WEIGHTS carry an
 * explicit commercial grant. The wrapper library's licence is not sufficient —
 * several popular options are MIT wrappers around non-commercial weights.
 * BiRefNet is MIT on both. u2net/DUTS, RMBG, and MODNet are not usable.
 */
export interface CutoutResult {
  /** Base64 image data WITHOUT the data-URL prefix. */
  base64: string;
  mimeType: string;
  widthPx: number;
  heightPx: number;
}

export interface BackgroundRemovalProvider {
  /** Stable identifier, stored in photo_edit_cache.provider. */
  readonly id: string;
  removeBackground(input: { base64: string; mimeType: string }): Promise<CutoutResult>;
}

export class BackgroundRemovalError extends Error {
  constructor(message: string, public readonly code: "NOT_CONFIGURED" | "PROVIDER_FAILED" | "OUTPUT_INVALID") {
    super(message);
    this.name = "BackgroundRemovalError";
  }
}
