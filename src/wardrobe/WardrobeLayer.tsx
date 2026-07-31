import React, { useEffect, useMemo, useState } from "react";
import { useLoader } from "@react-three/fiber";
import { NoColorSpace, RepeatWrapping, SRGBColorSpace, TextureLoader, Vector2 } from "three";
import { getWardrobePbrProfile } from "../../shared/wardrobePbrCatalog";
import { FULL_WARDROBE_CATALOG, type WardrobeItem } from "./catalog";
import { parseWardrobePbrManifest, type WardrobePbrManifest, type WardrobePbrManifestEntry } from "./pbrManifest";

/**
 * Wardrobe rendering layer for the Fido's Styles viewer.
 *
 * ⚠️ PLACEHOLDER GEOMETRY, deliberately quarantined in this module.
 *
 * These accessories are procedural approximations (torus collar, cone hat,
 * box cape…) because the real bone-attached GLB assets do not exist yet —
 * the sourcing decision (Sketchfab ingest vs. Quaternius pack vs. authored
 * in-house) is open item #7 in IMPLEMENTATION_SPEC.md §11.
 *
 * When real assets land (WARDROBE_WAGS_AND_TEXTURIZER_SPEC.md §1.0 —
 * skeletal bone attachment with auto-fit scaling), this module is replaced
 * wholesale: same `<WardrobeLayer selectedIds>` contract, GLB loading +
 * skeleton attachment inside. Nothing else in the viewer changes. Keeping
 * every placeholder mesh here (and none in FidosStylesScreen) makes the
 * remaining fake geometry auditable at a glance.
 */

function FalPbrMaterial({ item, entry }: { item: WardrobeItem; entry: WardrobePbrManifestEntry }) {
  const paths = [
    entry.maps.basecolor.path,
    entry.maps.normal.path,
    entry.maps.roughness.path,
    entry.maps.metalness.path,
  ];
  const [basecolor, normal, roughness, metalness] = useLoader(TextureLoader, paths);
  const profile = getWardrobePbrProfile(item.materialId);
  const normalScale = profile?.fallback.normalScale ?? 0.5;

  useEffect(() => {
    for (const texture of [basecolor, normal, roughness, metalness]) {
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.repeat.set(2, 2);
    }
    basecolor.colorSpace = SRGBColorSpace;
    normal.colorSpace = NoColorSpace;
    roughness.colorSpace = NoColorSpace;
    metalness.colorSpace = NoColorSpace;
  }, [basecolor, metalness, normal, roughness]);
  const materialNormalScale = useMemo(() => new Vector2(normalScale, normalScale), [normalScale]);

  return (
    <meshStandardMaterial
      color="#ffffff"
      map={basecolor}
      normalMap={normal}
      normalScale={materialNormalScale}
      roughnessMap={roughness}
      metalnessMap={metalness}
      roughness={1}
      metalness={1}
    />
  );
}

function FallbackMaterial({ item }: { item: WardrobeItem }) {
  const fallback = getWardrobePbrProfile(item.materialId)?.fallback;
  return (
    <meshStandardMaterial
      color={item.color}
      roughness={fallback?.roughness ?? 0.72}
      metalness={fallback?.metalness ?? (item.id.includes("gold") ? 0.55 : 0.04)}
    />
  );
}

class PbrMaterialBoundary extends React.Component<
  { item: WardrobeItem; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <FallbackMaterial item={this.props.item} /> : this.props.children;
  }
}

function AccessoryMaterial({ item, entry }: { item: WardrobeItem; entry?: WardrobePbrManifestEntry }) {
  if (!entry) return <FallbackMaterial item={item} />;
  return (
    <PbrMaterialBoundary item={item}>
      <FalPbrMaterial item={item} entry={entry} />
    </PbrMaterialBoundary>
  );
}

/** Procedural fallback until a real bone-attached GLB is provided. */
function WardrobeAccessory({ item, pbrEntry }: { item: WardrobeItem; pbrEntry?: WardrobePbrManifestEntry }) {
  const [x, y, z] = item.anchorMeters;
  const material = () => <AccessoryMaterial item={item} entry={pbrEntry} />;
  if (item.kind === "neck") {
    return (
      <group position={[x, y, z]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          {item.id.includes("medallion")
            ? <sphereGeometry args={[0.09, 24, 18]} />
            : <torusGeometry args={[0.19, 0.025, 12, 48]} />}
          {material()}
        </mesh>
      </group>
    );
  }
  if (item.kind === "head") {
    return (
      <group position={[x, y, z]}>
        <mesh>
          {item.id.includes("crown")
            ? <cylinderGeometry args={[0.16, 0.22, 0.24, 6]} />
            : <coneGeometry args={[item.id.includes("wizard") ? 0.23 : 0.17, item.id.includes("wizard") ? 0.52 : 0.34, 28]} />}
          {material()}
        </mesh>
      </group>
    );
  }
  if (item.kind === "face") {
    return (
      <group position={[x, y, z]}>
        <mesh position={[-0.11, 0, 0]}><torusGeometry args={[0.09, 0.012, 10, 32]} />{material()}</mesh>
        <mesh position={[0.11, 0, 0]}><torusGeometry args={[0.09, 0.012, 10, 32]} />{material()}</mesh>
        <mesh><boxGeometry args={[0.08, 0.018, 0.018]} />{material()}</mesh>
      </group>
    );
  }
  if (item.kind === "back") {
    return (
      <mesh position={[x, y, z]} rotation={[0.15, 0, 0]}>
        <boxGeometry args={[0.54, 0.68, 0.035]} />{material()}
      </mesh>
    );
  }
  return (
    <mesh position={[x, y, z]}>
      <sphereGeometry args={[0.34, 28, 20]} />{material()}
    </mesh>
  );
}

export function WardrobeLayer({ selectedIds }: { selectedIds: string[] }) {
  const [manifest, setManifest] = useState<WardrobePbrManifest | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/wardrobe/materials/manifest.json", {
      signal: controller.signal,
      credentials: "same-origin",
    })
      .then((response) => response.ok ? response.json() : null)
      .then((raw) => setManifest(parseWardrobePbrManifest(raw)))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return (
    <group>
      {FULL_WARDROBE_CATALOG
        .filter((item) => selectedIds.includes(item.id))
        .map((item) => (
          <WardrobeAccessory
            key={item.id}
            item={item}
            pbrEntry={manifest?.materials[item.materialId]}
          />
        ))}
    </group>
  );
}
