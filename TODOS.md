# TODOS

Active core/company implementation: [65 tasks and acceptance gates](docs/REALBUD-CORE-EXECUTION-2026-09-14.md), [machine-readable register](docs/REALBUD-CORE-EXECUTION-2026-09-14.json), [implemented foundation and verification](outputs/realbud-core-implementation-2026-09-14/README.md). This takes precedence for the new company/QM/native-service scope; dated delivery lists below retain their separate evidence and commercial boundaries.

Canonical commercial sequence: `docs/REALBUD-V021-COMMERCIAL-DELIVERY-PLAN.md`.
Release detail: `docs/GRADUATE-RELEASE.md` (strata + graduate release).
Pickup list: `docs/NEXT-WAVE.md`.

Austin-specific delivery register (10 September, Windows and routines revision 6): [setup, workflow coverage and implementation tasks](docs/AUSTIN-DELIVERY-PLAN-2026-09-10.md), generated from [the canonical task JSON](docs/AUSTIN-DELIVERY-PLAN-2026-09-10.json). It connects the Austin rollout and Hermes harness plans into 47 tasks with dependencies, accountable owners and acceptance evidence. These are planned build/decision/verification items, not completed office work. Windows decisions and pricing: [consolidated operating plan](docs/AUSTIN-OPERATING-PLAN-2026-09-10.md). Prove one Windows workflow through Hermes + Cua before another engine or hardware commitment. Other pilot and release items below keep their own scope.

## Done (2026-08-31)

- Mac notary keychain profiles `realbud-notary` + `ClawConnect`
- Notarized + stapled RealBud **0.1.17** DMG + arm64 zip (local `release/`)
- `pnpm clean:release` — one version on disk, no unpacked `.app` tree

## Open

1. **P0 provider identity** — report credentials only for the exact configured provider. OAuth profile status must never borrow an unrelated API key.
2. **P0 browser authority** — exact scheme, host, and port allow-list; typed tools, lease, expiry, and human Submit remain mandatory.
3. **P0 delivery finality** — persist channel jobs and receipts, deduplicate retries, and surface partial or failed delivery after restart.
4. **P0 usage ledger** — sanitised provider, model, latency, usage, cost availability, and final outcome per work item.
5. **Upstream release regression** — 13 September: stock 0.21.2 admitted and active in the signed local app; 0.21.0 rollback retained. [Engine, approval, recovery and installed evidence](outputs/realbud-hermes-latest-2026-09-13/README.md). Clean Windows delivery and repeated live-office acceptance remain open; repeat admission for the next stable release.
6. **Website and paid pilot funnel** — supervised-pilot claims, proof states, PMS and portfolio qualification, no unproved price or autonomy claims.
7. **Visit / office** — type eight real fields on You → This office (Dickson ACT strata pilot). Training names do not unlock live portal.
8. **Strata Stage-0** — portal product name + base URL for the Dickson property; human Submit spike.
9. **Installed shadow pilot** — one named PM, one source, up to three workflows, two to four weeks, weekly time and correction review.
10. **Windows Authenticode cert** — then `win.signtoolOptions` + signed NSIS.
11. **Bundle pinned Hermes** — unlock `hermesInstallCommand` on win32; graduate double-click without Terminal.
12. **Public GitHub release** — upload the current signed artifacts and update metadata only after the installed and pilot gates pass.

## Parked

- `T15` retention sweep — if disk/privacy comes up on the visit.
- Inbound mail, Pocket, Ask clock (PR C), Bud Submit — after Stage-0 evidence.
