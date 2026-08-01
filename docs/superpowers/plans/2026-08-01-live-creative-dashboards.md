# Live Creative Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken `/create` transition and crowded Fur Reels layout with one scroll-locked dashboard system while preserving every existing generation module and model asset.

**Architecture:** Add a presentation-only dashboard frame shared by the model builder and Fur Reels. Move active model-order refresh into a lifecycle controller that serializes automatic polls and refreshes secure previews by persisted order/stage/version identity; do not create a new backend workflow or change asset storage. Recompose the existing Animator canvas, scripts, actors, voice, render, and timeline controls into the shared frame.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Google model-viewer, React Three Fiber, Node test runner with tsx, existing Express pet-generation routes.

## Global Constraints

- No database deletion, asset migration, B2 key rewrite, model URL rewrite, or model-record removal.
- Preserve existing Tripo, texture, rigging, Fur Bin, voice, script, render, and download modules.
- Page-level scrolling is disabled on desktop; only dashboard rails may scroll internally.
- `/create` never changes route or component tree when an order starts.
- Existing server order UUIDs, attempt UUIDs, asset-version IDs, and lineage remain authoritative.
- Fur Reels icon is monochrome transparent artwork in the same 20 px optical footprint as adjacent icons.

---

### Task 1: Shared dashboard frame

**Files:**
- Create: `src/components/studio/CreativeDashboard.tsx`
- Test: `tests/creative_dashboard.test.mjs`

**Interfaces:**
- Produces: `CreativeDashboard`, `DashboardMetric`, and named slots `left`, `center`, `right`, `bottom`.
- Consumes: ordinary React nodes only; no generation or storage services.

- [ ] **Step 1: Write a failing rendered-markup test**

Render `CreativeDashboard` with `react-dom/server` and assert one fixed-height frame, three named regions, KPI labels, and independently scrollable rails.

- [ ] **Step 2: Run the focused test and confirm it fails because the component does not exist**

Run: `npx tsx --test tests/creative_dashboard.test.mjs`

- [ ] **Step 3: Implement the frame**

Create a component with this public shape:

```ts
export interface DashboardMetric { label: string; value: React.ReactNode; tone?: "neutral" | "active" | "success" | "danger" }
export function CreativeDashboard(props: {
  title: string;
  subtitle?: string;
  metrics: DashboardMetric[];
  left: React.ReactNode;
  center: React.ReactNode;
  right: React.ReactNode;
  bottom?: React.ReactNode;
}): React.JSX.Element;
```

Use `h-[calc(100dvh-4rem)] overflow-hidden`, a compact metric row, `min-h-0` grid tracks, `overflow-y-auto` only on rails, and a non-scrolling center.

- [ ] **Step 4: Run the focused test and `npm run lint`**

- [ ] **Step 5: Commit the shared frame**

---

### Task 2: Automatic model-build lifecycle controller

**Files:**
- Create: `src/components/pet-model/useLivePetBuild.ts`
- Test: `tests/live_pet_build.test.mjs`

**Interfaces:**
- Consumes: persisted `OrderView`, `requestOrder(orderUuid)`, `pollStage(orderUuid, stage)`, and `requestPreview(orderUuid)` callbacks.
- Produces: `{ liveView, previewUrl, refreshState, error }` and automatic cleanup.

- [ ] **Step 1: Write failing lifecycle tests**

Cover these observable behaviors with controlled async callbacks:

```ts
// active non-reference stage polls automatically
// a second tick never overlaps an unresolved poll
// completed/failed orders stop polling
// changing order UUID discards stale responses
// changing stage attempt or approved asset version refreshes preview
// cleanup prevents state delivery after unmount
```

- [ ] **Step 2: Run the focused test and verify the missing controller is the failure**

- [ ] **Step 3: Implement a serialized scheduler**

Use a single in-flight promise, an abort/cancel generation token, condition-based 2.5-second refresh while active, and no timer after terminal state. POST the existing stage poll route only for queued/processing non-reference stages; otherwise GET the persisted order view. Fetch the secure preview automatically when an artifact-bearing stage identity changes.

- [ ] **Step 4: Run lifecycle tests and `npm run lint`**

- [ ] **Step 5: Commit the controller**

---

### Task 3: Rebuild `/create` around the persistent viewer

**Files:**
- Modify: `src/components/PetModelStudio.tsx`
- Modify: `src/components/PetModelViewer.tsx`
- Test: `tests/pet_model_studio_live_dashboard.test.mjs`
- Test: `tests/pet_model_viewer.test.mjs`

**Interfaces:**
- Consumes: `CreativeDashboard`, `useLivePetBuild`, existing pet-generation endpoints, and existing `PetModelViewer`.
- Produces: one persistent model-building dashboard; no order-detail branch.

- [ ] **Step 1: Write failing UI behavior tests**

Render the component with a controlled authenticated fetch boundary and assert that starting/selecting an order does not remove the Live Model Viewer; active stages schedule refresh; artifact arrival changes the viewer `src`; and previous orders remain available without changing persisted IDs. Assert the removed controls are absent from accessible output.

- [ ] **Step 2: Run tests and confirm failures against the current two-layout component**

- [ ] **Step 3: Recompose the component**

Keep all existing order creation, reference generation, stage approval, pricing, collar, download, retry, and stored-order functions. Replace `!view ? ... : ...` with one `CreativeDashboard`. Put uploads/configuration in the left rail, the always-mounted source/reference/build/GLB surface in center, and stage/charges/recent persisted orders in the right rail.

- [ ] **Step 4: Remove manual refresh interactions**

Delete `poll`, `loadPreview`, `Check stage progress`, `Load secure 3D preview`, and `Back to model builds`. Wire the lifecycle controller to the existing `applyView` identity guard and preview route.

- [ ] **Step 5: Preserve model visibility and asset safety**

Do not issue delete/update calls for historical orders. Keep recent-order selection keyed by `orderUuid`; keep download identity keyed by `orderUuid:approvedVersionId`; keep Fur Bin registration server-owned.

- [ ] **Step 6: Run focused tests, pet-generation integration tests, and lint**

- [ ] **Step 7: Commit the `/create` rebuild**

---

### Task 4: Recompose Fur Reels into the shared dashboard

**Files:**
- Modify: `src/animator/components/AnimatorScreen.tsx`
- Create: `src/animator/components/FurReelsControlRail.tsx`
- Create: `src/animator/components/FurReelsDirectorRail.tsx`
- Create: `src/animator/components/FurReelsTimeline.tsx`
- Test: `tests/animator_dashboard_layout.test.mjs`
- Test: `tests/animator_smoke.test.mjs`

**Interfaces:**
- Consumes: the current scene controller, R3F canvas, actors, director scripts, voice jobs, capture session, and timeline state unchanged.
- Produces: grouped customer controls in shared dashboard slots without duplicating runtime ownership.

- [ ] **Step 1: Write failing rendered-layout and smoke tests**

Assert that Fur Reels renders the shared dashboard regions, directing controls are visible without page scrolling, the canvas remains mounted, voice/script/render/timeline actions remain wired, and floating duplicate panels are absent.

- [ ] **Step 2: Run focused tests and verify current absolute overlay layout fails**

- [ ] **Step 3: Extract presentation-only rails**

Move JSX only. Keep state, scene controller, callbacks, provider calls, and asset loading in `AnimatorScreen`. Pass explicit values and callbacks to the extracted components; do not duplicate or recreate controller state.

- [ ] **Step 4: Mount the existing canvas in the center slot and timeline in the bottom slot**

Keep WebGL context handling, scene backdrop, lighting, sound, actor loading, retargeting, capture, and Theatre camera behavior unchanged.

- [ ] **Step 5: Run animator tests, lint, and production build**

- [ ] **Step 6: Commit the Fur Reels dashboard**

---

### Task 5: Rebuild and verify the standalone Fur Reels icon

**Files:**
- Modify: `public/brand/fur-reels-icon.png`
- Modify: `src/App.tsx`
- Test: `tests/navigation_icon_asset.test.mjs`

**Interfaces:**
- Consumes: the supplied filmstrip-and-puppy artwork.
- Produces: transparent monochrome PNG with tight alpha bounds; sidebar renders it through the same 20 px wrapper as standard icons.

- [ ] **Step 1: Write a failing image behavior test**

Decode the PNG with `sharp` and assert: alpha exists; corner and former white center pixels are transparent; nontransparent bounds occupy at least 85% of the canvas in one dimension; rendered wrapper is 20 px.

- [ ] **Step 2: Run the test and confirm the opaque white center fails**

- [ ] **Step 3: Remove near-white pixels, preserve black artwork, crop to alpha bounds, and add a small transparent optical margin**

- [ ] **Step 4: Render through the same `h-5 w-5` wrapper and active color behavior as adjacent icons**

- [ ] **Step 5: Run focused test and inspect the decoded asset visually**

- [ ] **Step 6: Commit the icon**

---

### Task 6: Full verification, push, and Hostinger package

**Files:**
- Modify only if verification exposes a regression in the scoped work.

- [ ] **Step 1: Run focused UI, model lifecycle, Fur Bin, animator, and asset tests**
- [ ] **Step 2: Run `npm test` under Node 24.18.0**
- [ ] **Step 3: Run `npm run lint` and `npm run build` under Node 24.18.0**
- [ ] **Step 4: Verify `git diff --check`, no model files deleted, no storage/migration files changed, and worktree contains only scoped changes**
- [ ] **Step 5: Commit remaining verified integration changes and push `main`**
- [ ] **Step 6: Build `pawsome3d-deploy.zip` from clean committed HEAD and report commit, size, and SHA-256 without claiming live deployment**
