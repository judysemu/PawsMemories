import React, { useEffect, useState } from "react";

/**
 * model-viewer is a reviewed, lockfile-pinned application dependency. It is
 * imported only in the browser because the package registers a custom element
 * at module evaluation time and is not SSR-safe.
 */
let modelViewerLoader: Promise<void> | null = null;
function ensureModelViewer(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if ((window as any).customElements?.get("model-viewer")) return Promise.resolve();
  modelViewerLoader ??= import("@google/model-viewer").then(() => customElements.whenDefined("model-viewer")).then(() => undefined);
  return modelViewerLoader;
}

/**
 * Front-facing, eye-level camera. model-viewer's default is `0deg 75deg auto`,
 * but it only applies until the user interacts; combined with auto-rotate the
 * models were arriving at whatever angle the swivel had reached, so cards in a
 * grid all faced different directions. Pinning the orbit means every card
 * presents the model head-on.
 */
const FRONT_ORBIT = "0deg 80deg 105%";

/**
 * A phone can hold only a handful of live WebGL contexts (typically 8, fewer
 * under memory pressure). A grid of model cards mounts one <model-viewer> —
 * and therefore one context — per card, so scrolling a full FurBin blew past
 * the limit and took the GPU process down with it. On mobile we render the
 * poster image instead and keep the interactive viewer for the detail modal,
 * where exactly one is on screen at a time.
 */
function isLowPowerDevice(): boolean {
  if (typeof window === "undefined") return false;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const narrow = window.matchMedia?.("(max-width: 900px)").matches ?? false;
  const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent || ""
  );
  return uaMobile || (coarsePointer && narrow);
}

interface PetModelViewerProps {
  /** Public URL of the GLB model. */
  src: string;
  /** Optional still image used as a loading poster — and as the mobile thumbnail. */
  poster?: string;
  alt?: string;
  className?: string;
  animationName?: string;
  animationCrossfade?: number;
  /**
   * Default false. Auto-rotate was on everywhere, which meant every card in a
   * grid ran its own render loop — the GPU cost of a FurBin page scaled with
   * the number of models on screen, and the constant swivel made it hard to
   * actually look at a model. Opt in per-viewer if a hero surface wants it.
   */
  autoRotate?: boolean;
  /**
   * Render as a static thumbnail (poster image, no WebGL). Automatically true
   * on mobile when a poster is available; pass explicitly to force either way.
   */
  thumbnail?: boolean;
}

/**
 * Renders a 3D pet model using Google's <model-viewer> web component.
 */
const PetModelViewer: React.FC<PetModelViewerProps> = ({
  src,
  poster,
  alt = "3D model of your pet",
  className = "",
  animationName,
  animationCrossfade,
  autoRotate = false,
  thumbnail,
}) => {
  const [ready, setReady] = useState(
    typeof window !== "undefined" && !!(window as any).customElements?.get("model-viewer")
  );
  const [lowPower] = useState(() => isLowPowerDevice());

  // Explicit prop wins; otherwise fall back to poster-only on mobile. Without a
  // poster there is nothing to show, so we still mount the viewer rather than
  // render an empty box.
  const useThumbnail = thumbnail ?? (lowPower && !!poster);

  if (useThumbnail) {
    return poster ? (
      <img
        src={poster}
        alt={alt}
        loading="lazy"
        decoding="async"
        className={className}
        style={{ width: "100%", height: "100%", objectFit: "contain", background: "transparent" }}
      />
    ) : (
      <div
        className={className}
        style={{ width: "100%", height: "100%", background: "transparent" }}
        aria-label={alt}
      />
    );
  }

  useEffect(() => {
    let active = true;
    ensureModelViewer().then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!ready) {
    return (
      <div
        className={className}
        style={{ width: "100%", height: "100%", minHeight: "100%", background: "transparent" }}
        aria-busy="true"
      />
    );
  }

  return (
    // @ts-expect-error - Custom web component loaded on demand
    <model-viewer
      src={src}
      poster={poster}
      alt={alt}
      camera-controls={true}
      auto-rotate={autoRotate ? true : undefined}
      camera-orbit={FRONT_ORBIT}
      animation-name={animationName}
      animation-crossfade-duration={animationCrossfade !== undefined ? animationCrossfade : 300}
      autoplay={false}
      ar
      ar-modes="webxr scene-viewer quick-look"
      shadow-intensity="1"
      exposure="1"
      loading="eager"
      className={className}
      style={{ width: "100%", height: "100%", minHeight: "100%", background: "transparent" }}
    />
  );
};

export default PetModelViewer;
