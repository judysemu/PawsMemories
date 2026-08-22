# Deploying x-dm-service

Standing this up on `x.pawsome3d.com` as a fifth Hostinger Node site.

The service is not deployed anywhere today. Until it is, `X_POSTING_ENABLED`
is inert wherever it is set — no process reads it.

## Why a subdomain rather than the main app

Two of its four public surfaces are **inbound from X**: `/webhooks/x`, which X
calls, and `/oauth`, which X redirects to. It needs a public address whatever
else is true, so the question is only whose.

A separate host keeps the blast radius at itself. This service holds a
credential that can publish to a public timeline; a stuck poller or a bad
deploy should not be able to reach the storefront.

## 1. Create the site

Hostinger → add `x.pawsome3d.com` as a Node.js website on the existing plan.

**Wait for TLS before step 4.** X requires HTTPS on the OAuth callback.
Hostinger issues the certificate automatically but not instantly, and an
OAuth round-trip attempted too early fails in a way that reads like a config
error.

## 2. Environment

A posting-only deployment needs ten variables. The DM-refinement credentials
(Blender, LLM, media bucket) are no longer required to boot — the service
warns and carries on without them.

| Variable | Notes |
|---|---|
| `X_CLIENT_ID` | OAuth 2.0 client id from the `pawsom` app |
| `X_CLIENT_SECRET` | OAuth 2.0 client secret |
| `X_CONSUMER_SECRET` | OAuth 1.0a consumer secret — used to verify webhook signatures |
| `X_BOT_USER_ID` | numeric id of @stelarbabyOS |
| `DB_HOST` | `127.0.0.1` on Hostinger, **not** `localhost` — `mysql2` resolves localhost to IPv6 and the grant does not cover `::1` |
| `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` | same database as the main app; this service owns its own tables and its own `_migrations` ledger |
| `X_POSTING_ENABLED` | `true` — exact string, nothing else counts |
| `X_POST_SCHEDULER_SECRET` | `openssl rand -hex 32`; the scheduler's bearer |

Optional: `X_POST_MIN_INTERVAL_MS` (cadence floor, default 6h),
`X_WEBHOOK_URL` (only if registering the DM webhook).

## 3. Migrate

```bash
npm run migrate
```

Applies `007_x_posts` and `008_x_oauth_scope` if they have not run. Both are
already applied against the production database as of 2026-08-21.

## 4. Authorise the bot account

Visit `https://x.pawsome3d.com/oauth` and complete consent as **@stelarbabyOS**.

**This step is what makes posting possible.** Scopes are fixed when a token is
issued. `tweet.write` was added to the requested set on 2026-08-21, so any
token minted before then can read but not publish, and every post returns 403.
Changing the code did not change the stored token — only re-authorising does.

The granted scope is now recorded, so afterwards the token's capability is
checkable rather than assumed.

The callback is already registered in the X app:

```
https://x.pawsome3d.com/oauth/callback     production
http://localhost:3001/oauth/callback       local development
```

## 5. Verify before scheduling

```bash
curl -s https://x.pawsome3d.com/health

curl -s https://x.pawsome3d.com/admin/post/status \
  -H "Authorization: Bearer $X_POST_SCHEDULER_SECRET"
```

The status response reports `postingEnabled`, the known campaigns, and the ten
most recent rows from `x_posts`.

Then one real post, with the cadence floor lowered so it is not held:

```bash
curl -s -X POST https://x.pawsome3d.com/admin/post \
  -H "Authorization: Bearer $X_POST_SCHEDULER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"campaign":"barkley"}'
```

Expect `{"status":"posted","tweetId":"…"}`. Put the floor back afterwards.

A `403` in the failure reason means the token still lacks `tweet.write` —
return to step 4. The response body from X is preserved deliberately, because
it is the only thing that separates a scope problem from a bad post.

## 6. Create the trigger

Daily, calling `POST /admin/post` with the bearer. See
`docs/AUTOMATIONS.md` → *Pawsome3D X Post*.

The endpoint answers **200 for a skipped post**, so a scheduler will not retry
a cadence hold. Only an unhandled server error returns 500.

## What it will and will not do

It publishes posts configured in `src/campaigns.ts` and nothing else. It does
not follow, like, reply to strangers, or scrape — those are the behaviours X's
automation rules treat as platform manipulation, and a suspended account costs
more than any traffic they would win.

Post copy changes through code review rather than a config edit, so what the
account says is never altered from a panel.
