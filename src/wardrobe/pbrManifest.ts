import { WARDROBE_PBR_MAP_KINDS, type WardrobePbrMapKind } from "../../shared/wardrobePbrCatalog";

export interface WardrobePbrManifestEntry {
  materialId: string;
  configHash: string;
  provider: "fal-ai";
  model: "fal-ai/patina/material";
  seed: number;
  maps: Record<WardrobePbrMapKind, {
    path: string;
    sha256: string;
    width: number;
    height: number;
  }>;
}

export interface WardrobePbrManifest {
  schemaVersion: 1;
  generatedAt: string | null;
  materials: Record<string, WardrobePbrManifestEntry>;
}

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function parseWardrobePbrManifest(raw: unknown): WardrobePbrManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;
  if (root.schemaVersion !== 1 || !root.materials || typeof root.materials !== "object" || Array.isArray(root.materials)) {
    return null;
  }
  if (root.generatedAt !== null && typeof root.generatedAt !== "string") return null;

  const materials: Record<string, WardrobePbrManifestEntry> = {};
  for (const [materialId, value] of Object.entries(root.materials as Record<string, unknown>)) {
    if (!SAFE_ID.test(materialId) || !value || typeof value !== "object" || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    if (entry.materialId !== materialId || entry.provider !== "fal-ai" || entry.model !== "fal-ai/patina/material") return null;
    if (typeof entry.configHash !== "string" || !SHA256.test(entry.configHash)) return null;
    if (!Number.isInteger(entry.seed) || Number(entry.seed) < 0) return null;
    if (!entry.maps || typeof entry.maps !== "object" || Array.isArray(entry.maps)) return null;

    const rawMaps = entry.maps as Record<string, unknown>;
    if (Object.keys(rawMaps).length !== WARDROBE_PBR_MAP_KINDS.length) return null;
    const maps = {} as WardrobePbrManifestEntry["maps"];
    for (const kind of WARDROBE_PBR_MAP_KINDS) {
      const candidate = rawMaps[kind];
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
      const map = candidate as Record<string, unknown>;
      const expectedPath = `/wardrobe/materials/${materialId}/${kind}.png`;
      if (map.path !== expectedPath || typeof map.sha256 !== "string" || !SHA256.test(map.sha256)) return null;
      if (!Number.isInteger(map.width) || !Number.isInteger(map.height) || Number(map.width) !== 1024 || Number(map.height) !== 1024) return null;
      maps[kind] = {
        path: expectedPath,
        sha256: map.sha256,
        width: Number(map.width),
        height: Number(map.height),
      };
    }
    materials[materialId] = {
      materialId,
      configHash: entry.configHash,
      provider: "fal-ai",
      model: "fal-ai/patina/material",
      seed: Number(entry.seed),
      maps,
    };
  }

  return {
    schemaVersion: 1,
    generatedAt: root.generatedAt as string | null,
    materials,
  };
}
