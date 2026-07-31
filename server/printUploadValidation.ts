const MAX_PRINT_UPLOAD_BYTES = 25 * 1024 * 1024;

export class PrintUploadValidationError extends Error {}

export interface ValidatedPrintUpload {
  base64: string;
  mime: "model/gltf-binary" | "model/gltf+json" | "model/obj" | "model/stl";
  bytes: number;
}

function strictBase64(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (
    !compact ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    throw new PrintUploadValidationError(
      "The model file is not valid base64 data.",
    );
  }
  const estimatedBytes = Math.floor((compact.length * 3) / 4);
  if (estimatedBytes > MAX_PRINT_UPLOAD_BYTES + 2) {
    throw new PrintUploadValidationError(
      "The model file exceeds the 25 MB upload limit.",
    );
  }
  const buffer = Buffer.from(compact, "base64");
  if (!buffer.length || buffer.length > MAX_PRINT_UPLOAD_BYTES) {
    throw new PrintUploadValidationError(
      "The model file must be between 1 byte and 25 MB.",
    );
  }
  if (
    buffer.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")
  ) {
    throw new PrintUploadValidationError(
      "The model file is not valid base64 data.",
    );
  }
  return buffer;
}

function detectMime(buffer: Buffer): ValidatedPrintUpload["mime"] | null {
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "glTF" &&
    buffer.readUInt32LE(4) === 2 &&
    buffer.readUInt32LE(8) === buffer.length
  ) {
    return "model/gltf-binary";
  }

  const prefix = buffer
    .subarray(0, Math.min(buffer.length, 2 * 1024 * 1024))
    .toString("utf8");
  const trimmed = prefix.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const document = JSON.parse(buffer.toString("utf8"));
      if (document?.asset?.version === "2.0" && Array.isArray(document?.scenes))
        return "model/gltf+json";
    } catch {
      return null;
    }
  }

  if (
    /^(?:\s*#.*\n)*\s*(?:mtllib\s+|o\s+|g\s+|v\s+)/m.test(prefix) &&
    /^\s*v\s+[-+\d.]/m.test(prefix) &&
    /^\s*f\s+\d/m.test(prefix)
  ) {
    return "model/obj";
  }

  if (buffer.length >= 84) {
    const triangleCount = buffer.readUInt32LE(80);
    if (84 + triangleCount * 50 === buffer.length) return "model/stl";
  }
  if (
    /^\s*solid(?:\s|\r|\n)/i.test(prefix) &&
    /\bfacet\s+normal\b/i.test(prefix) &&
    /\bendsolid\b/i.test(prefix)
  ) {
    return "model/stl";
  }
  return null;
}

export function validatePrintUpload(
  fileBase64: unknown,
  declaredMime: unknown,
): ValidatedPrintUpload {
  if (typeof fileBase64 !== "string")
    throw new PrintUploadValidationError("No model file was provided.");
  const match = /^data:([^;,]*);base64,([\s\S]+)$/.exec(fileBase64.trim());
  if (!match)
    throw new PrintUploadValidationError(
      "The model file must be a base64 data URL.",
    );

  const dataUrlMime =
    match[1].trim().toLowerCase() || "application/octet-stream";
  const requestMime =
    typeof declaredMime === "string" ? declaredMime.trim().toLowerCase() : "";
  if (
    requestMime &&
    dataUrlMime !== requestMime &&
    requestMime !== "application/octet-stream"
  ) {
    throw new PrintUploadValidationError(
      "The model file MIME declarations do not match.",
    );
  }

  const buffer = strictBase64(match[2]);
  const detectedMime = detectMime(buffer);
  if (!detectedMime) {
    throw new PrintUploadValidationError(
      "The upload is not a valid GLB, glTF, OBJ, or STL model.",
    );
  }
  const allowedDeclarations = new Set([
    "application/octet-stream",
    detectedMime,
    ...(detectedMime === "model/obj"
      ? ["text/plain", "application/x-tgif"]
      : []),
    ...(detectedMime === "model/stl"
      ? ["application/sla", "application/vnd.ms-pki.stl"]
      : []),
  ]);
  if (!allowedDeclarations.has(dataUrlMime)) {
    throw new PrintUploadValidationError(
      "The declared MIME type does not match the model contents.",
    );
  }
  return {
    base64: buffer.toString("base64"),
    mime: detectedMime,
    bytes: buffer.length,
  };
}

export { MAX_PRINT_UPLOAD_BYTES };
