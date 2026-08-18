interface ScaleRequest {
  id: string;
  file: File;
  maxEdge: number;
  maxPixels: number;
  quality: number;
}

self.onmessage = async (event: MessageEvent<ScaleRequest>) => {
  const { id, file, maxEdge, maxPixels, quality } = event.data;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;
    const edgeScale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const pixelScale = Math.min(1, Math.sqrt(maxPixels / (bitmap.width * bitmap.height)));
    const scale = Math.min(edgeScale, pixelScale);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    // alpha:true so a transparent source — or a background-removed cutout —
    // survives this stage. This was previously {alpha:false}, which flattened
    // transparency in the FIRST worker, before any other code could see it;
    // fixing the compositor alone would have changed nothing.
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Photo scaling is unavailable.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    let blob: Blob;
    try {
      // WebP carries alpha, and measurement puts it around a 24th of PNG's
      // size for the same image — which keeps uploads inside the 1 MB limit on
      // /api/pawprints/generate-subject. PNG here would blow that limit on a
      // single 12 MP phone photo.
      blob = await canvas.convertToBlob({ type: "image/webp", quality });
    } catch {
      // JPEG cannot carry alpha at all, so the fallback is PNG. Larger, but
      // this branch only runs where WebP encoding is unavailable.
      blob = await canvas.convertToBlob({ type: "image/png" });
    }
    const buffer = await blob.arrayBuffer();
    self.postMessage({ id, ok: true, width, height, originalWidth, originalHeight, mimeType: blob.type, buffer }, { transfer: [buffer] });
  } catch (error: any) {
    self.postMessage({ id, ok: false, error: error?.message || "The photo could not be prepared." });
  } finally {
    bitmap?.close();
  }
};

export {};
