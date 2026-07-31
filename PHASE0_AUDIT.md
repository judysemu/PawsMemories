# Phase 0 spatial normalization audit

The active normalization paths are:

- `src/three/AvatarModel.tsx` for pet avatar display fitting;
- `src/three/objects/ObjectModel.tsx` for prop GLB scale, centering, and ground
  contact;
- `src/three/objects/catalog.ts` for target display sizes and active assets;
- `src/three/ar/eighthWallAR.ts` for iOS AR display fitting.

Manufacturing scale remains server-authoritative. Display transforms do not
serve as evidence of print dimensions.
