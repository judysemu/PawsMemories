# Pawsome3D and FurryFriend Administrator Access Runbook

**Updated:** 2026-07-31  
**Sites:** `https://pawsome3d.com` and `https://furryfriend.cc`

This document records the administrator access model, credential locations,
recovery procedures, publishing instructions, and post-login checks. It
deliberately contains no password, API key, session token, database password,
or recovery code. Store those values in Hostinger's encrypted environment
settings and the owner's password manager, never in Git or a deployment ZIP.

## Credential register

| Access | Account or variable | Where the value lives | Secret handling |
| --- | --- | --- | --- |
| Hostinger owner account | Hostinger account login or configured SSO | Owner's password manager and Hostinger account security | Enable MFA; retain recovery codes offline |
| Pawsome3D administrator login | `ADMIN_EMAIL` | Hostinger → Websites → `pawsome3d.com` → Environment variables | Login identifier; do not hard-code |
| Pawsome3D administrator password | `ADMIN_PASSWORD` | Same Hostinger environment-variable page and password manager | Secret; rotate by updating Hostinger and redeploying |
| Pawsome3D internal admin row key | `ADMIN_KEY` | Same Hostinger environment-variable page | Use `admin`; identifier, not a password |
| Pawsome3D session signing key | `JWT_SECRET` | Same Hostinger environment-variable page | Generate with `openssl rand -hex 48`; rotating signs everyone out |
| Administrator feedback inbox | `MODEL_FEEDBACK_EMAIL` | Same Hostinger environment-variable page | Usually the administrator-controlled support inbox |
| Outbound administrator email | `RESEND_API_KEY`, `MAIL_FROM` | Hostinger environment variables; Resend owns the API key/domain | Never copy the key into a browser bundle or repository |
| FurryFriend hosting administration | Hostinger owner account | Hostinger account and password manager | FurryFriend has no separate website-admin password |
| FurryFriend editorial approval | Git author identity plus `approvedBy`/`approvedAt` ledger evidence | `furryfriend/content/editorial-ledger.json` | Reviewer name and time are evidence, not credentials |

If a value is unknown, retrieve or rotate it at its authoritative location. Do
not paste an existing secret into an issue, chat, document, commit, screenshot,
or shell history.

## Pawsome3D administrator instructions

### Sign in

1. Open `https://pawsome3d.com/sign-up`.
2. Choose **Log in**.
3. Enter the current `ADMIN_EMAIL` and `ADMIN_PASSWORD` values maintained in
   Hostinger/password manager.
4. After login, open the profile menu. **Wags admin** must be visible.
5. The direct administrative route is `https://pawsome3d.com/admin/wags`.

The administrator uses the normal customer login rather than a separate or
hidden login endpoint. The server synchronizes the configured email/password
at startup and verifies that the matching database user has both
`is_admin=1` and `is_operator=1`. Production startup fails if `ADMIN_KEY`,
`ADMIN_EMAIL`, or `ADMIN_PASSWORD` is missing.

### Administrator capabilities

- Open the server-guarded Wags administration panel.
- Use customer creation, Pet GLB, body-rig, AI video, voice, Fur Bin, Pawprints,
  and Print Shop flows with the administrator role.
- Access optional Pet GLB diagnostic/recovery endpoints guarded by the
  administrator/operator role. These are not a required customer-release gate.
- Receive **Toss it** model-feedback messages at `MODEL_FEEDBACK_EMAIL`. Each
  message includes the customer identity, Fur Bin item, order, provider job,
  asset UUID, version, and SHA-256 automatically.

### Verify access after every deployment

1. Log out, then log in again with the configured administrator account.
2. Confirm the profile/header identifies the account as administrator.
3. Open `/admin/wags`; a non-admin must not be able to open the same data.
4. Open `/fur-bin`, `/pet-glb`, and `/animator` and confirm the signed-in
   application loads without another login prompt.
5. Check `https://pawsome3d.com/version` against the deployed commit.
6. Check `https://pawsome3d.com/healthz` for process liveness and
   `https://pawsome3d.com/readyz` for database/dependency readiness.
7. Review Hostinger runtime logs for admin-sync errors. A successful boot logs
   that the admin/operator account was synchronized and verified, but never
   prints the password.

### Change or recover the administrator login

1. In Hostinger, open **Websites → pawsome3d.com → Environment variables**.
2. Update `ADMIN_EMAIL` and/or `ADMIN_PASSWORD`. Generate a unique password in
   the owner's password manager.
3. Save the environment settings and redeploy/restart the Node application.
4. Confirm clean startup, then sign in using the new value.
5. Invalidate any saved sessions by rotating `JWT_SECRET` only when necessary;
   this logs out every account.

The environment configuration is authoritative. A database-only password
change can be replaced by the next application boot when the admin account is
synchronized from `ADMIN_PASSWORD`.

### Credential-generation commands

Run these locally and store the results directly in the password manager and
Hostinger. Do not add their output to this file.

```bash
openssl rand -hex 48   # JWT_SECRET
openssl rand -hex 32   # WORKER_SHARED_SECRET or another service secret
```

## FurryFriend administrator instructions

### Current access model

`furryfriend.cc` is a static, pre-rendered editorial site. It intentionally has:

- no login form;
- no website-admin account;
- no runtime database or server session;
- no browser-side AI/API credentials; and
- no unauthenticated administrative route.

Therefore there is no FurryFriend website password to distribute. Hosting
changes require the Hostinger owner account. Editorial changes require access
to this private repository and an accountable human approval recorded in the
editorial ledger.

### Review and publish an article

1. Edit the article in `furryfriend/content/articles.mjs`.
2. Verify every Pawsome3D product claim against the currently deployed product.
3. Update the matching job in
   `furryfriend/content/editorial-ledger.json`:
   - set `state` to `published`;
   - add `approvedBy` with the real human reviewer's name; and
   - add `approvedAt` as an ISO-8601 timestamp.
4. Update `claimEvidence` whenever a product promise, destination, or source
   changes. Do not publish a blocked or unverified claim.
5. Build and verify under Node 24.18:

   ```bash
   cd /Users/robert/Desktop/claude7126/PawsMemories/furryfriend
   export PATH="/Users/robert/.nvm/versions/node/v24.18.0/bin:$PATH"
   npm run check
   ```

6. Confirm the article is included in `dist/sitemap.xml`, has `index,follow`,
   and includes Article/Breadcrumb structured data with the recorded reviewer.
7. In Hostinger, open **Websites → furryfriend.cc → Files → File Manager** and
   open the domain's configured document root.
8. Upload the **contents** of `furryfriend/dist/` so `index.html` is at the
   document root; do not upload source files, `.git`, or secrets.
9. Verify the home page, guide page, `robots.txt`, `sitemap.xml`, legal pages,
   canonical URL, TLS, and a nonexistent URL/404 response.

### FurryFriend post-deployment checks

- `https://furryfriend.cc/`
- `https://furryfriend.cc/guides/`
- `https://furryfriend.cc/editorial-policy/`
- `https://furryfriend.cc/robots.txt`
- `https://furryfriend.cc/sitemap.xml`
- Published article URL(s)

Use Google Search Console's domain-property access for sitemap submission and
indexing inspection. Search Console credentials belong in the owner's Google
account/password manager, not this repository.

## Incident and offboarding checklist

If administrator access may be compromised:

1. Change the Hostinger account password and review/restore MFA.
2. Rotate `ADMIN_PASSWORD` and `JWT_SECRET`, then redeploy Pawsome3D.
3. Rotate affected provider keys in their own dashboards and replace the
   corresponding Hostinger values.
4. Review Hostinger activity/runtime logs, GitHub access, recent deployments,
   database administrator-role changes, and outbound email activity.
5. Remove former administrators from Hostinger, GitHub, Google Search Console,
   Resend, Stripe, Printful, Tripo, storage, and monitoring accounts.
6. Record the incident, rotations, deployment commit, and verification result
   without recording the secret values themselves.

## Related documents

- `README.md` — Pawsome3D environment and Hostinger deployment instructions
- `.env.example` — complete environment-variable names and safe defaults
- `docs/current/FULL_SITE_MAP_2026-07-31.md` — public, authenticated, admin, and API map
- `furryfriend/README.md` — static editorial architecture and build boundary
- `docs/current/FURRYFRIEND_SITE_BRIEF_2026-07-31.md` — editorial and launch policy
