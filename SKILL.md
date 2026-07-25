---
name: agent-chain-orchestration
description: >
  Build and review "paired-agent" LLM orchestration chains — a fast/low-temperature
  "cold" fact agent combined with a warm/high-temperature "hot" persona agent under a
  latency budget, with divergence guarding, trace persistence, and a human review queue.
  Use when adding a new agent chain, wiring a chain into a live request path, or reviewing
  a coding agent's chain work before merge. Encodes the failure modes hit while shipping
  the Judy Response Core + Cultural/Safety chains so they are not repeated.
metadata:
  type: reference
---

# Agent-chain orchestration (hot/cold paired agents)

A reusable pattern for LLM response pipelines where one call must be **correct** and
another must be **charming**, and where wrong output can hurt a user (safety, legal,
medical, money). Two agents run under a shared latency budget:

- **Cold agent** — low temperature (~0.1–0.15). Produces verified, source-grounded facts.
  No personality. This is the source of truth.
- **Hot agent** — high temperature (~0.7–0.9). Wraps the cold facts in brand voice /
  persona. May add warmth, never alter facts.

The hot agent consumes the cold agent's output, so the two are **sequential by data
dependency** even though they are launched together. Be honest about that (see Pitfall 3).

Reference implementation in this repo: `src/lib/agents/orchestrator.ts`, wired at
`src/app/api/avatar/chat/route.ts`, documented in `docs/agent-chain.md`.

## When to reach for this pattern

- A response needs both factual accuracy and a consistent voice.
- Some outputs are safety- or compliance-sensitive and must be reviewable/auditable.
- You want a graceful degradation path (return verified facts even if the persona layer
  is slow or goes off-script) rather than a hard failure.

If you only need one of {accuracy, voice}, use a single agent. This pattern's cost is real.

## The shape

1. **Cold call** → verified facts, pinned to the reply language.
2. **Hot call** → persona wrapper around those exact facts, same language.
3. **Divergence check** → confirm the hot output still contains the cold facts; if not,
   fall back to a cold-only response with a localized lead-in.
4. **Latency budget** → if the whole chain exceeds the budget, resolve with cold-only.
5. **Trace persistence** → write exactly one trace row per response (input, per-step
   output/temperature/latency, final output, and which path was taken).
6. **(Sensitive chains) Review queue** → novel claims are drafted for humans, never shown
   raw to users; users get a safe fallback until a human approves.

## Non-negotiable checklist (each item is a bug we actually shipped)

### 1. Wire it into the live path — don't leave a parallel dead endpoint
A chain that nothing calls improves nothing. New routes whose only references are their
own doc-comments are dead code. Grep for real callers before declaring "done":
`grep -rn "runYourChain\|/api/your/endpoint" src` and confirm a component or the existing
pipeline invokes it. "Voice pipeline unchanged" is a red flag, not a feature, when the
new work was supposed to change that pipeline.

### 2. Never reference a `const` from inside its own initializer (TDZ)
This throws `ReferenceError: Cannot access 'x' before initialization` at runtime, is
invisible to `tsc`, and (because a throw inside a Promise executor *rejects* the promise)
can make `Promise.race` reject before the good path finishes — turning every request into
the error fallback.

```ts
// ❌ BROKEN — timeoutPromise is in the temporal dead zone here
const timeoutPromise = new Promise((resolve) => {
  const id = setTimeout(() => resolve(x), BUDGET);
  (timeoutPromise as any).timeoutId = id;   // rejects the promise
});

// ✅ Declare the handle in the outer scope
let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
const timeoutPromise = new Promise((resolve) => {
  timeoutHandle = setTimeout(() => resolve(x), BUDGET);
});
try {
  return await Promise.race([hotPromise, timeoutPromise]);
} finally {
  if (timeoutHandle) clearTimeout(timeoutHandle);   // no double-fire
}
```

### 3. Don't call it "parallel" if it's sequential; size the budget accordingly
The hot agent needs the cold output injected, so latency ≈ cold + hot, not max(cold, hot).
A budget smaller than that guarantees the cold-only fallback fires for most requests.
Either set the budget to cover both calls, or genuinely parallelize (e.g. hot drafts a
persona template that is merged with cold facts without a second model round-trip).

### 4. Compare like-for-like in the divergence check
The check verifies cold facts survived into the hot output. If cold is English and hot is
translated, English safety words never appear in the translated text → **false divergence
on every non-English safety query** → users pushed to the fallback exactly when it matters.
Fixes: pin the cold agent to the same reply language as the hot agent, extract facts using
that locale's terms plus universal numeric patterns, and use substring matching (not
`\b...\b` word-boundary regex — word boundaries don't exist in CJK/Arabic/Devanagari).

### 5. Localize every hard-coded string, including fallbacks
A localized answer wrapped in `"Here's what I know for sure: ..."` is still broken for a
non-English user. Keep a per-locale lead-in map and default to English only for unknown
locales.

### 6. Write exactly one trace row per response
Timeout/fallback branches that each persist a trace, plus an uncleared timer, produce
duplicate and false "timedOut" rows that corrupt the very table your audit relies on. Use
a single `traceWritten` guard **and** `clearTimeout` in a `finally`.

### 7. Safety-sensitive content goes through humans before users see it
Novel/uncertain claims: draft at low temperature for a review queue, create the record as
`pending`, and return a safe, uncertainty-honest fallback to the user. Only serve persona
answers built on `approved` records. Never render an unreviewed model draft to a user.
De-duplicate: check for an existing `pending`/`approved` claim before creating another.

### 8. Interactive admin/review UI must be a client component
In the Next.js App Router, `onClick` handlers require `'use client'`. A server component
with `onClick` errors at render — and `tsc`/lint pass anyway, so "build ✅" won't catch it.
Don't smuggle interactivity via `dangerouslySetInnerHTML`. A page must not render its own
`<html>/<head>/<body>` when nested under a root layout.

## Data model sketch

```prisma
model AgentChainTrace {
  id          String   @id @default(cuid())
  chainName   String
  userId      String?
  input       Json
  steps       Json     // [{ agentName, temperature, output, why, latencyMs }]
  finalOutput Json
  createdAt   DateTime @default(now())
}

model CulturalClaim {          // generalize: any human-reviewed claim
  id            String    @id @default(cuid())
  situationTag  String
  venueName     String
  location      String
  claimText     String
  sourcesCited  Json
  varianceNotes String?
  riskFlags     Json?
  status        String    @default("pending") // pending | approved | rejected
  reviewedBy    String?
  reviewedAt    DateTime?
  createdAt     DateTime  @default(now())
  @@index([situationTag, status])
  @@index([status])
}
```

Keep migrations forward-only and squash mid-pass churn (don't ship "add column" +
"redefine table to add two more columns" as two migrations if one would do).

## Review rubric (use when auditing a coding agent's chain PR)

Verify against the code, not the PR summary. Run:

- `grep -rn "runYourChain\|/api/<endpoint>" src` — is it actually wired in? (Pitfall 1)
- `tsc --noEmit` and the **project's** test runner (`npm test`), not a stray `npx jest`.
  Note native-binding runners (vitest+rolldown, swc) may not run in a Linux sandbox if
  `node_modules` was built on macOS — run locally.
- Read the timeout/race block for TDZ self-reference and missing `clearTimeout`. (2, 6)
- Check the budget vs. cold+hot latency. (3)
- Trace the divergence check's language assumptions and any hard-coded user-facing strings. (4, 5)
- Confirm review-gated content never reaches users unapproved. (7)
- Confirm interactive review pages are `'use client'`. (8)
- `git status` / `git diff` for **undisclosed** file changes (corrupted or truncated docs
  omitted from the summary's file list). Treat "build ✅ / tests ✅ / all criteria met" as
  a claim to verify, not a result.

## Definition of done

Wired into the real request path; one trace row per response; graceful cold-only
degradation on timeout and on divergence; correct behavior verified in ≥2 languages
including a safety query; review queue gates sensitive content; admin UI actually toggles
state; migrations apply cleanly on a populated DB; and every file changed is accounted for
in the summary.
