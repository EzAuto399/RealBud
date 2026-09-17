# `main` source recovery — resolved by merge

Found and fixed 2026-09-17 (goal round 4). Superseded by merge commit
`cc0aeaac "Merge codex/company-qa-slice: restore the source tree so the app runs
from source"`.

## The problem (kept for the record)

`main` could not start from source:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/Users/yoda/projects/PropertyMe/server/ask-control-intent.ts'
imported from '/Users/yoda/projects/PropertyMe/server/index.ts'
```

27+ committed imports had no source on disk. Dist had drifted from source — the
packaged app runs from prebuilt `dist-server`, which still contained
`hermes-paths.js` and `hermes-runtime-selection`, so the product worked while the
tree did not. `pnpm test` could not run at all, because vitest resolves `.ts`
directly with no aliases.

Cause: `de6be72c "Ship the installable office host"`, on `main`, imports the
company platform, but those modules were only ever committed on
`codex/company-qa-slice` and `wip/company-dirty-2026-09-16`. Main got the
importers; the branches got the imported. The branch is based on `de6be72c`, so
main's history is a subset and the merge was additive.

## Resolution

Merged `codex/company-qa-slice` — 471 files, +44,375 / −3,637. Verified after:

| Check | Result |
|---|---|
| `node --experimental-strip-types server/index.ts` | starts; `/api/health` returns `static:false` (real source) |
| `pnpm test` | **2,494 passed**, 224/234 files green |
| send gate on source | `POST /api/desk/drafts/:id/send` → 403, "RealBud never sends." |
| inbound gate on source | `PATCH /api/loops/inbound-triage` → 400, "declared but not built yet" |

The 16 remaining failures are all in `server/service-admin-provision.test.ts` and
are **environmental, not regressions**: `scripts/provision-service-admin.mjs:273`
refuses Node < 24 and this machine runs v22.22.0.

## Four conflicts, resolved by hand

Picking a side would have lost real work in three of them:

- `server/worker-issues.ts` — kept main's `resolveWorkerIssues` (the branch never
  had it; `healHandsReadiness` depends on it), otherwise took the branch.
- `server/worker-issues.test.ts` — branch version plus the `resolveWorkerIssues`
  test. A naive union duplicated the dynamic import and left an unclosed block.
- `server/hands-last.ts` — union, then de-duplicated: one duplicated
  `workerFingerprint` interface member and two unreachable returns removed.
- `scripts/qa-company-core.mjs` — not a conflict but a collision: two different
  scripts at one path. Main's is the U1–U8 second-office HTTP contract (isolation,
  send stays 403 after Allow, worker not ready without a ping on this home); the
  branch's is a Postgres/company acceptance harness that `qa:company` invokes.
  Both kept — main's moved to `scripts/qa-second-office-contract.mjs`, which is
  **not yet wired into a package.json script**.

## Still open

- The pin-vs-compatible readiness split needed no separate patch: the branch's
  `hermes-status.ts:58` already gates on `(status.cli.compatible ?? status.cli.matchesPin)`.

Both items previously listed here have since been closed:

- `scripts/qa-second-office-contract.mjs` is now `pnpm qa:second-office` and runs as
  part of `qa:full`. It passes 16/16.
- `website/` now has a remote — `EzAuto399/RealBud-website` (private), added
  2026-09-17 — so the emergency `backup/website-2026-09-17/` directory was deleted
  as its own README instructed. That repo had no remote when this recovery started,
  which is why a hand-made bundle and tar were the only offsite copy of the billing
  portal. The website working tree has also since been committed and pushed, and its
  docs corrected (`91ff47a`).

## Related, same day

`website/docs/DOMAIN-SETUP.md` had prescribed `A @ → 10.0.1.2` — a private RFC1918
address — and it had been applied to the live zone, which is why `realbud.app` and
therefore the entire public site was unreachable. Corrected with the measured Vercel
addresses and verification steps. See that file.

