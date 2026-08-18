# Incident: unauthorized fal.ai usage via a removed admin

Date discovered: 2026-08-18. Unauthorized activity dated 2026-08-17.

## What happened

A person with admin access to the fal.ai account used it for their own
commercial image work. Roughly $19 of ~$25 in spend was theirs.

Evidence that it was not this application:

- Models used were `fal-ai/flux-pro/v1.1-ultra`, `fal-ai/bytedance/seedream/v4/edit`
  and `v4.5/edit`. This codebase calls only `veo3.1`, `kling`, and `birefnet/v2`.
- Prompts were Russian-language commercial design briefs: interior
  visualizations from collages, WWII-themed fortifications, a ballroom scene,
  café refrigerator product shots — several iterating on the same brief.
- One prompt ended in `--ar 16:9 --v 6.0`, which is Midjourney syntax pasted
  into flux. That is a human moving prompts between tools, not automation.
- Request ids are UUIDv7 and therefore time-ordered: `01a00eef` through
  `01a00ef6` are consecutive, so this was one concentrated session.
- Renders were 4096x3072 and 4096x2304 — the expensive end.

## Vector

An admin user on the fal account, since revoked and deleted along with all
prior keys. **Not** a credential leaked from this repository. That was checked
directly, and matters because the repo is public:

| Checked | Result |
| --- | --- |
| `VITE_` var reaching the client bundle | not a client var |
| key-shaped string in built client JS | none; only the literal `"fal-ai"` |
| `.env` committed at any point | never tracked |
| `FAL_KEY=` in history | only `FAL_KEY=""` in `.env.example` |
| `uuid:hex32` key shape across all history objects | none |
| key written to a log or a response | never |
| other live-secret shapes in history | only dummies |

## The trap in the sequence

Removing a member does not necessarily invalidate API keys that member
created — those are account-scoped and outlive the user. If unauthorized use
continues after a removal, look for a key the person minted rather than
assuming the removal failed.

## Response

1. Old key revoked. Confirmed dead: `401 credential has been revoked`.
2. New key issued and verified present in production by fingerprint
   (`99997cee` -> `873bb54f`), then verified valid with a live call.
3. Repository swept for credential exposure; clean (table above).

## Blast radius

Confined to fal.ai. The account in question was never associated with
Hostinger, so the hosting panel — which renders credentials in cleartext — was
never visible to them. Stripe, Resend, Shopify, Backblaze, Gemini, ElevenLabs
and `JWT_SECRET` are therefore not implicated by this incident and do not need
rotating on account of it.

## Still open

- **Any other admin or member on fal**, and any key they created. Revoking a
  person does not revoke their keys.
- **A hard spend cap on fal.** Small top-ups bound each incident but do not
  prevent a repeat.
- GitHub collaborators are `judysemu` (admin), `robs46859-eng` (write),
  `robsmithgroup` (write). Confirm all three are accounts you control, and
  check invitations and deploy keys, which require admin rights to read.

Rotations are now verifiable: see [ENV_VAR_TROUBLESHOOTING.md](ENV_VAR_TROUBLESHOOTING.md)
for the fingerprint procedure.
