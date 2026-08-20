# Bug sweep — 3D model builder

Swept 2026-08-20 against production data. Findings are ordered by customer
impact, not by effort.

## 1. Rigging fails on roughly half of all builds

**Evidence.** Across every model job ever run:

| Status | Count |
| --- | --- |
| `done` | 14 |
| `done_static_fallback` | **13** |
| `failed` | 1 |

`server/pipeline-rig-recovery.ts:524` decides:

```ts
const status = hasRig ? "done" : hasStatic ? "done_static_fallback" : "failed";
```

So 13 of 28 builds — **46%** — produced a model that could not be rigged. The
customer receives a static mesh, the rig portion is refunded
(`rig_refunded_at`), and the job reports success.

**Why it matters.** The degradation is invisible from the outside. Nothing
alerts, the job is terminal-and-successful, and the refund makes it look
handled. A 46% failure rate on the feature's headline capability — a *posable*
pet — is being absorbed silently rather than surfaced.

**Caveat on the data.** The most recent model job is 2026-07-28. This is a
historical rate, not a current one, and the rig pipeline has changed since. The
first repair action is therefore to measure before rebuilding.

## 2. Three jobs exist with an empty `kind`

```
id=23 kind="" status=failed provider=null  error="Poller error"
id=22 kind="" status=failed provider=null  error="Poller error"
id=21 kind="" status=failed provider=null  error="Poller error"
```

Every dispatch path keys off `kind`. A row with `kind=''` and `provider=null`
cannot be routed, retried, or reported on — it is invisible to per-kind
dashboards and to any recovery sweep that filters by kind. All three died with
the same opaque `"Poller error"`, which names no subsystem.

These are old, but the write path that produced them has not been proven
closed.

## 3. `done_static_fallback` is terminal in seven places

`grep` finds the literal in `generationRefunds.ts` (x5),
`model-persistence-events.ts`, `pipeline-rig-recovery.ts`, and `server.ts`
(x4). Any new terminal state has to be added to all of them, and missing one
means either a double refund or a job that never settles.

Not a live bug. A structural hazard: the set of terminal statuses is a concept
with no single definition.

## Recommended repair spec

**R1 — Measure the current rig failure rate before changing anything.**
The 46% figure is historical. Run ten builds across the shapes customers
actually submit and record `done` vs `done_static_fallback`. If the current rate
is low, items R2–R3 are wasted work; if it is still near half, this is the
single biggest quality problem in the product. *Do not skip this to get to the
interesting part.*

**R2 — Make the fallback visible.** `done_static_fallback` should emit a
persistence event that is actually watched, and the customer-facing copy should
say plainly that a posable rig could not be built and that portion was not
charged. Today the customer is told the build succeeded, receives something
less than they asked for, and is left to notice the refund on their own.

**R3 — Give `"Poller error"` a subsystem and a kind.** Every job write must set
`kind`; a job that cannot be classified cannot be recovered. Reject the insert
rather than accepting a blank.

**R4 — Define terminal status once.** Export a single `TERMINAL_JOB_STATUSES`
set from `server/generationRefunds.ts` and import it everywhere the literals
appear now. This is the change most likely to prevent a future refund bug, and
it is the cheapest of the four.

### Backup / follow-up actions

1. **If R1 shows the rate is still high**, instrument *which* rig stage fails —
   bone mapping, weight painting, or export — before attempting a fix. The
   current data says only "no rig", which is not actionable.
2. **If rigging cannot be made reliable**, consider selling the static model as
   the default product and the rig as an explicit upgrade that can fail
   honestly, rather than a promise silently downgraded 46% of the time.
3. **If the `kind=''` write path cannot be found**, add a `NOT NULL` +
   `CHECK (kind <> '')` constraint and let the insert fail loudly. A job that
   cannot be routed is worse than a job that was never created.
4. **Before any rig rework**, confirm the Azure GPU decision still stands. That
   path is permanently out (quota 0/0 on A100, capacity refusal on T4), so any
   plan that assumes in-house rigging capacity is starting from a false premise.
