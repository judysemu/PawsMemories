# Hostinger environment variables — diagnosing a "missing" secret

Status: living document. Started 2026-08-18 after `FAL_KEY` appeared to vanish
from the Hostinger panel following a restart.

## The symptom

A secret that was definitely set earlier shows as blank in the Hostinger Node.js
app's environment editor after a restart or redeploy. The instinct is to
conclude the variable was dropped and to paste in a replacement.

## What we established

**The panel masks saved secrets.** A blank-looking field is not evidence that a
value is absent. It is indistinguishable from a populated one.

**Changing an environment variable triggers a full redeploy.** Hostinger re-runs
the pipeline — `npm install`, the (no-op) build script, and a fresh Passenger
start — every time a variable is added or edited. This is why the deployment
list shows entries that were never archive uploads. It also means environment
changes genuinely do reach the running process; they are not queued or cached.

**`builtAt` not moving is expected during env edits.** Those redeploys re-extract
the *existing* archive. The bundle is unchanged, so `/readyz` keeps reporting the
same `commit` and `builtAt`. A stale `builtAt` after an env change is normal and
is not a symptom of a stuck deployment.

**Nothing had actually reported the key missing.** The application distinguishes
"no credential" from "provider rejected the call": `server/ai-video/falVideo.ts`
throws `FAL_VIDEO_NOT_CONFIGURED` only when the key is empty. No such error was
ever observed. The entire diagnosis rested on the masked field.

## Fix attempts, in order

1. **Assumed the restart wiped it; planned to re-paste the key.** Wrong premise.
   Rejected once it was clear the other secrets — DB credentials, `JWT_SECRET`,
   Shopify, Resend — all survived the same restart. A restart that drops exactly
   one variable and preserves the rest is not a real failure mode.

2. **Proposed a server-side `.env` as a durable fallback.** Technically sound:
   `server.ts` imports `dotenv/config`, and `scripts/build-deploy-zip.sh` refuses
   to package any `.env`, so a file in the app root survives every deploy. dotenv
   does not override already-set variables, so the panel still wins. Kept as a
   contingency, but not adopted — it treats a symptom that was never confirmed,
   and it splits the source of truth for secrets across two places.

3. **Checked for a hung deployment or a caching layer.** Ruled out. The ten most
   recent deployments all report `completed`, and the latest build log is clean
   (583 packages installed, no-op build as designed).

4. **Adopted: report credential presence from the application itself.**
   `summarizeProviderConfig()` in `server.ts` reports, as booleans only, whether
   each provider credential is present in the process environment. It is exposed
   on the `/readyz` healthy response under `providers`.

## How to check now

```bash
curl -s https://pawsome3d.com/readyz
```

The `providers` block answers the question directly:

```json
{ "providers": { "fal": true, "gemini": true, "resend": true } }
```

`true` means the running process has a non-empty, non-placeholder value. The
value itself is never read out — `tests/readyz_providers.test.mjs` asserts that
no serialized form of the summary can contain a secret, and that every field is
a boolean. Placeholder values (`MY_...`, `PASTE_...`, and similar template
leftovers) count as absent, matching how the Stripe client already guards its
key. Multi-part credentials such as `MEDIA_BUCKET_KEY` + `MEDIA_BUCKET_SECRET`
report `true` only when every part is present.

The block appears only on the healthy (200) response. The 503 path deliberately
withholds it, for the same reason it withholds build provenance: an endpoint
answering while the service is degraded should say as little as possible.

## Rules of thumb

- Never rotate a credential to fix a symptom you have not confirmed. If the
  provider account is locked or unfunded, a good key and a bad key both fail, and
  the rotation destroys your ability to tell which you had.
- Keep the previous key valid until a replacement is observed working.
- Trust the application over the hosting panel. `/readyz` reads the same
  `process.env` the feature code reads; the panel reads a database row.
