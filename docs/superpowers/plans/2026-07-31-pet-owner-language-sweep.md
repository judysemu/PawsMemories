# Pet-owner language sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make customer-facing Pawsome3D copy pet-owner friendly while preserving the current layout, fonts, colors, routes, APIs, and SEO terminology.

**Architecture:** Add one small shared `FriendlyError` presentation component using existing utility classes and icons, then update primary signup, home, create, model, print, and checkout copy in place. Technical words remain in secondary help/SEO/download copy.

**Tech Stack:** React, TypeScript, Tailwind utility classes, Lucide icons, existing Vite/type-check pipeline.

## Global Constraints

- Keep existing layout, typography, color tokens, spacing, and interaction patterns.
- Keep GLB and other technical terms in secondary/help/SEO contexts only.
- Do not change API contracts, billing, generation, or fulfillment behavior.
- Error messages must remain accessible and preserve actionable next steps.

### Task 1: Shared friendly error presentation

**Files:**
- Create: `src/components/FriendlyError.tsx`
- Modify: `src/components/ErrorBoundary.tsx`

- [ ] Add a reusable alert with `role="alert"`, existing error color tokens, an AlertCircle icon, heading, message, and optional action text.
- [ ] Replace the error boundary's raw red paragraph with the shared alert while keeping the production-safe technical detail behavior.
- [ ] Run `npm run lint`.

### Task 2: Signup and primary creation language

**Files:**
- Modify: `src/components/SignUp.tsx`
- Modify: `src/components/CreateScreen.tsx`
- Modify: `src/components/CustomizeScreen.tsx`

- [ ] Replace creator/developer terms in headings, buttons, hints, and errors with pet-owner wording.
- [ ] Keep species choices and existing controls unchanged; change only labels/hints and error presentation.
- [ ] Use the shared alert for visible errors.
- [ ] Run focused TypeScript verification.

### Task 3: Model, home, and download language

**Files:**
- Modify: `src/components/HomePage.tsx`
- Modify: `src/components/Dashboard.tsx`
- Modify: `src/components/PetGlbStoreScreen.tsx`
- Modify: `src/components/AvatarDashboard.tsx`

- [ ] Make primary hero and dashboard copy outcome-led for pet owners.
- [ ] Keep “GLB” in SEO headings/supporting copy/download details but remove it from primary CTA emphasis.
- [ ] Replace “modelling/building/asset” wording in visible states with “preparing your pet/model/keepsake.”
- [ ] Use the shared alert for visible load/submit errors.

### Task 4: Print and checkout language

**Files:**
- Modify: `src/components/PrintRequestForm.tsx`
- Modify: `src/components/MarketplaceScreen.tsx`
- Modify: `src/components/create-flow/CreateCheckoutScreen.tsx`

- [ ] Replace file/technical-first labels with pet keepsake language while retaining file-format help in secondary text.
- [ ] Make payment and service failures explain what the owner should do next.
- [ ] Preserve pricing, API calls, and checkout behavior.

### Task 5: Verification and release artifact

**Files:**
- Test: existing TypeScript/build checks and repository copy scan.

- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Scan customer-facing source for remaining primary “rigging/provider/pipeline/asset” language and raw red error paragraphs.
- [ ] Review the production bundle for the new primary wording and preserved GLB SEO text.
- [ ] Commit the UI sweep and build the Hostinger archive.
