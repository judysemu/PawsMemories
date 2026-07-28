# Documentation and Reference Cleanup Manifest — 2026-07-28

## Rule applied

The instruction “clean the repo of anything more than 3 days old” is applied to
obsolete tracked documentation and reference material only. The cutoff is
2026-07-25 00:00 local time.

The cleanup must not remove:

- application or worker source;
- migrations or tests;
- package/dependency lock files;
- requirements files;
- user assets or generated artifacts;
- Git worktrees;
- `.codex/skills`, `SKILLS.md`, or operational agent rules;
- legal/license materials;
- `README.md` (it will be updated to point to current documentation);
- recent (2026-07-27+) first-sale audit evidence still useful for regression
  history.

## Removal set

The following tracked planning/reference areas are older than the cutoff and have
been superseded by `docs/current/`:

- obsolete root design, audit, prompt, phase, deployment, marketplace, BIM, UV,
  wardrobe, and architecture markdown files dated 2026-07-24 or earlier;
- `NEED_REVIEW/`;
- `phase-evidence/`;
- old `docs/superpowers/` plans/specs;
- old remodel and ADR documents under `docs/`.

Text files used by programs (`requirements.txt`, `robots.txt`) are not documents
for this rule and remain.

## Retained current reference set

- `README.md`
- `SKILLS.md`
- `.codex/skills/**`
- `docs/current/**`
- `docs/architecture/FIRST_PAID_PET_GLB_ARCHITECTURE.md`
- `docs/architecture/ANIMATION_AGENT_CHAIN_SPEC.md`
- `docs/audits/**` dated 2026-07-27
- source-adjacent technical READMEs whose deletion would remove a subsystem
  contract rather than stale planning material

## Recovery

All removed files remain recoverable from Git history at baseline commit
`4ee12d648344034707c71bacbcd5fdfab66cc0b2`.
