# Live Creative Dashboards Design

## Scope

Replace the broken `/create` order-detail transition and the crowded Fur Reels workstation layout with one consistent, fixed-viewport dashboard system. Rebuild the Fur Reels navigation asset as a standalone monochrome glyph. No unrelated product behavior changes are included.

## Shared dashboard frame

- Occupies the viewport below the existing application header and never scrolls at page level.
- Uses a compact KPI/status strip, fixed left control rail, dominant center workspace, fixed right context rail, and an optional bottom transport strip.
- Only an individual rail may scroll when its content exceeds the available height.
- Uses the existing Pawsome3D color tokens, rounded panels, readable labels, and pet-owner language.

## `/create`

- The center **Live model viewer** remains mounted from upload through delivery.
- Before generation it shows the selected source photo and clear empty-state guidance.
- During reference generation it shows generated angles in the center workspace.
- During mesh work it shows the existing build-energy visual over the source image.
- As soon as a base, textured, or rigged GLB becomes available, the viewer automatically requests the current secure preview and replaces the previous visual in place.
- The page automatically refreshes active order state. There is no manual `Check stage progress`, `Load secure 3D preview`, order-detail route, or `Back to model builds` control.
- Starting a build does not swap component trees or change routes. Stage progress, charges, validation, and Fur Bin registration update in the KPI strip and right rail.
- Failures remain in the viewer and expose only the permitted recovery action. Completed builds expose download and Fur Bin confirmation without navigation.

## Fur Reels

- Uses the same fixed dashboard proportions and panel hierarchy as `/create`.
- Left rail contains pet/cast, scene, directing, voice, and output choices using plain-language grouped controls.
- The Three.js canvas remains mounted as the dominant center workspace.
- Right rail contains the selected script, cast assignments, lighting, sound, and render readiness.
- Timeline and playback controls remain in a fixed bottom strip.
- Floating overlapping cards and duplicated controls are removed. Advanced transform and rig controls remain available under a clearly labeled advanced workspace without becoming the default customer experience.

## Fur Reels icon

- Preserve the supplied filmstrip-and-puppy artwork.
- Remove every white/background fill so only the monochrome artwork remains.
- Crop to the alpha bounds with a small optical margin.
- Render in the same 20 px box, alignment, color treatment, and active-state behavior as the other sidebar icons.

## State and error handling

- Automatic refresh runs only while an order or render job is active and stops on completion, failure, unmount, or replacement.
- Requests are serialized to prevent overlapping provider polls.
- Preview URLs are refreshed whenever the order, stage, or asset version changes.
- Stale responses cannot replace a newer selected build.
- Errors are shown in the relevant dashboard panel without redirecting or destroying the current workspace.

## Acceptance

- `/create` remains on one dashboard before, during, and after generation.
- No manual progress or preview-loading buttons remain.
- The center viewer visibly changes when a new model artifact becomes available.
- Fur Reels and `/create` share the same dashboard frame and responsive behavior.
- The page is scroll locked on desktop; only rails may internally scroll.
- The Fur Reels icon has no visible tile, center fill, or excess transparent canvas and matches adjacent icons optically.
