import React, { Suspense, Component, ReactNode, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { PlacedObject, PetObjectKind } from "../../types";
import { OBJECT_CATALOG } from "./catalog";

/** Renders a downloaded GLB, auto-normalized to `fitSize` and dropped to the ground. */
function GlbObject({ url, fitSize, spatialMetadata }: { url: string; fitSize: number; spatialMetadata?: PlacedObject["spatialMetadata"] }) {
  const { scene } = useGLTF(url);
  const model = useMemo(() => {
    const cloned = scene.clone(true);
    const box = new THREE.Box3().setFromObject(cloned);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const longest = Math.max(size.x, size.y, size.z) || 1;
    const authoritative = spatialMetadata && !["unknown", "estimated"].includes(spatialMetadata.calibrationMethod);
    const s = authoritative ? spatialMetadata.physicalScale : fitSize / longest;
    cloned.scale.setScalar(s);
    cloned.updateMatrixWorld(true);
    const scaledBox = new THREE.Box3().setFromObject(cloned);
    scaledBox.getCenter(center);
    cloned.position.x -= center.x;
    cloned.position.z -= center.z;
    cloned.position.y -= scaledBox.min.y;
    cloned.updateMatrixWorld(true);
    cloned.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    return cloned;
  }, [scene, fitSize, spatialMetadata]);
  return <primitive object={model} />;
}

/** If a GLB is missing/broken, silently render the procedural placeholder instead. */
class GlbFallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    /* expected when public/objects/<kind>.glb hasn't been added yet */
  }
  render() {
    return this.state.failed ? <>{this.props.fallback}</> : <>{this.props.children}</>;
  }
}

/** Simple low-poly placeholder meshes used until real GLB assets are dropped in. */
function Procedural({ kind }: { kind: PetObjectKind }) {
  switch (kind) {
    case "food_bowl":
    case "water_bowl": {
      const water = kind === "water_bowl";
      return (
        <group>
          <mesh castShadow receiveShadow position={[0, 0.05, 0]}>
            <cylinderGeometry args={[0.16, 0.12, 0.1, 24]} />
            <meshStandardMaterial color={water ? "#3b82f6" : "#b45309"} metalness={0.1} roughness={0.6} />
          </mesh>
          <mesh position={[0, 0.09, 0]}>
            <cylinderGeometry args={[0.13, 0.13, 0.02, 24]} />
            <meshStandardMaterial color={water ? "#60a5fa" : "#7c2d12"} />
          </mesh>
        </group>
      );
    }
    case "ball":
      return (
        <mesh castShadow position={[0, 0.12, 0]}>
          <sphereGeometry args={[0.12, 24, 24]} />
          <meshStandardMaterial color="#d4e02a" />
        </mesh>
      );
    case "bone":
      return (
        <group position={[0, 0.06, 0]} rotation={[0, 0, Math.PI / 2]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.03, 0.03, 0.22, 12]} />
            <meshStandardMaterial color="#f5f5dc" />
          </mesh>
          {[-0.11, 0.11].map((y) =>
            [-0.04, 0.04].map((x) => (
              <mesh key={`${y}-${x}`} castShadow position={[x, y, 0]}>
                <sphereGeometry args={[0.045, 12, 12]} />
                <meshStandardMaterial color="#f5f5dc" />
              </mesh>
            ))
          )}
        </group>
      );
    case "chew_toy":
      return (
        <mesh castShadow position={[0, 0.08, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.09, 0.035, 12, 24]} />
          <meshStandardMaterial color="#ef4444" />
        </mesh>
      );
    case "bed":
      return (
        <group position={[0, 0.04, 0]}>
          <mesh castShadow receiveShadow>
            <boxGeometry args={[0.7, 0.08, 0.5]} />
            <meshStandardMaterial color="#8b5cf6" />
          </mesh>
          <mesh position={[0, 0.06, 0]}>
            <boxGeometry args={[0.55, 0.06, 0.36]} />
            <meshStandardMaterial color="#c4b5fd" />
          </mesh>
        </group>
      );
    case "dog_house":
      return (
        <group>
          <mesh castShadow receiveShadow position={[0, 0.25, 0]}>
            <boxGeometry args={[0.7, 0.5, 0.7]} />
            <meshStandardMaterial color="#a16207" />
          </mesh>
          <mesh castShadow position={[0, 0.6, 0]} rotation={[0, Math.PI / 4, 0]}>
            <coneGeometry args={[0.6, 0.35, 4]} />
            <meshStandardMaterial color="#7c2d12" />
          </mesh>
          <mesh position={[0, 0.18, 0.351]}>
            <circleGeometry args={[0.16, 20]} />
            <meshStandardMaterial color="#1c1917" />
          </mesh>
        </group>
      );
    case "hydrant":
      return (
        <group position={[0, 0, 0]}>
          <mesh castShadow position={[0, 0.18, 0]}>
            <cylinderGeometry args={[0.09, 0.11, 0.36, 16]} />
            <meshStandardMaterial color="#dc2626" />
          </mesh>
          <mesh castShadow position={[0, 0.4, 0]}>
            <sphereGeometry args={[0.09, 16, 12]} />
            <meshStandardMaterial color="#dc2626" />
          </mesh>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[0.1 * s, 0.24, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.03, 0.03, 0.06, 12]} />
              <meshStandardMaterial color="#b91c1c" />
            </mesh>
          ))}
        </group>
      );
    default:
      return (
        <mesh castShadow position={[0, 0.1, 0]}>
          <boxGeometry args={[0.2, 0.2, 0.2]} />
          <meshStandardMaterial color="#9ca3af" />
        </mesh>
      );
  }
}

interface ObjectModelProps {
  object: PlacedObject;
  onClick?: (id: string) => void;
}

/** Renders a single placed object at its transform, GLB if available else procedural. */
export default function ObjectModel({ object, onClick }: ObjectModelProps) {
  const def = OBJECT_CATALOG[object.kind];
  const scale = object.scale * (def?.baseScale ?? 1);
  return (
    <group
      position={object.position}
      rotation={[0, object.rotationY, 0]}
      scale={scale}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(object.id);
      }}
    >
      {def?.glbUrl ? (
        <GlbFallback fallback={<Procedural kind={object.kind} />}>
          <Suspense fallback={null}>
            <GlbObject url={def.glbUrl} fitSize={def.fitSize} spatialMetadata={object.spatialMetadata} />
          </Suspense>
        </GlbFallback>
      ) : (
        <Procedural kind={object.kind} />
      )}
    </group>
  );
}
