import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RefreshCw, RotateCcw } from "lucide-react";
import FriendlyError from "../FriendlyError";

interface Model3DViewerProps {
  signedUrl: string;
  className?: string;
}

export default function Model3DViewer({ signedUrl, className = "" }: Model3DViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);

  useEffect(() => {
    if (!containerRef.current || !signedUrl) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    const container = containerRef.current;
    const width = container.clientWidth || 400;
    const height = container.clientHeight || 400;

    // 1. Scene setup
    const scene = new THREE.Scene();

    // 2. Camera setup
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 1.2, 3);
    cameraRef.current = camera;

    // 3. Renderer setup
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    container.appendChild(renderer.domElement);

    // 4. Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enableZoom = true;
    controls.enablePan = true;
    controlsRef.current = controls;

    // 5. Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight1.position.set(2, 4, 3);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight2.position.set(-2, 2, -3);
    scene.add(dirLight2);

    // 6. Load GLB Model
    let loadedModel: THREE.Object3D | null = null;
    const loader = new GLTFLoader();

    loader.load(
      signedUrl,
      (gltf) => {
        if (!isMounted) {
          gltf.scene.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              const mesh = child as THREE.Mesh;
              mesh.geometry?.dispose();
              if (Array.isArray(mesh.material)) {
                mesh.material.forEach((m) => m.dispose());
              } else {
                mesh.material?.dispose();
              }
            }
          });
          return;
        }

        loadedModel = gltf.scene;

        // Auto-center and normalize scale
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = 1.6 / maxDim;

        gltf.scene.position.sub(center.multiplyScalar(scale));
        gltf.scene.scale.setScalar(scale);

        scene.add(gltf.scene);
        setLoading(false);
      },
      undefined,
      (err) => {
        if (isMounted) {
          setError((err as any)?.message || "Failed to load 3D GLB model");
          setLoading(false);
        }
      }
    );

    // 7. Animation loop
    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // 8. Resize handler
    const handleResize = () => {
      if (!container || !renderer || !camera) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    // 9. Cleanup & disposal
    return () => {
      isMounted = false;
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animId);

      controls.dispose();

      if (loadedModel) {
        scene.remove(loadedModel);
        loadedModel.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            mesh.geometry?.dispose();
            if (Array.isArray(mesh.material)) {
              mesh.material.forEach((m) => m.dispose());
            } else {
              mesh.material?.dispose();
            }
          }
        });
      }

      renderer.dispose();
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, [signedUrl]);

  const handleResetCamera = () => {
    if (cameraRef.current && controlsRef.current) {
      cameraRef.current.position.set(0, 1.2, 3);
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  };

  return (
    <div className={`relative w-full h-[360px] bg-surface-variant/20 rounded-2xl overflow-hidden border border-outline-variant/30 ${className}`}>
      <div ref={containerRef} className="w-full h-full cursor-grab active:cursor-grabbing touch-none" />

      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface/60 backdrop-blur-sm">
          <RefreshCw className="animate-spin text-primary mb-2" size={32} />
          <span className="text-xs font-bold text-on-surface">Getting your pet ready…</span>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-4 bg-error/10 text-center">
          <FriendlyError message={error} action="Try opening the preview again." className="max-w-xs text-left" />
        </div>
      )}

      {!loading && !error && (
        <div className="absolute bottom-3 right-3 flex items-center gap-2">
          <button
            onClick={handleResetCamera}
            className="px-3 py-1.5 rounded-xl bg-surface/80 hover:bg-surface text-on-surface text-xs font-bold shadow border border-outline-variant flex items-center gap-1 backdrop-blur-md"
            title="Reset Camera View"
          >
            <RotateCcw size={14} /> Reset Camera
          </button>
        </div>
      )}
    </div>
  );
}
