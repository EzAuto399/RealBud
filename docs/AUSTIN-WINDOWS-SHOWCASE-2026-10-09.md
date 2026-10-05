# Austin showcase on Windows: Friday 9 October 2026

Goal (owner, 5 Oct): install RealBud on Austin Realty's Windows PC and show all five workflows. Kevin: W1 bank → CSV → REI, W2 weekly invoices, W3 morning priorities. Sherry: W4 maintenance alerts, W5 inspection planning. Customer sign-ins (Gmail, Redbark, REI, Property Inspect) happen on their own screens; Bud never handles passwords.

## Plan
| Day | Work | Proof |
|---|---|---|
| Mon 5 / Tue 6 | W5 inspections screen; Austin fictional demo seed plus a chained showcase rehearsal; storage write guard and last-good fallback; Windows readiness survey | Mac local tests + GUI QA (`qa-inspections`, `qa-austin-showcase`) |
| Tue 6 night | Reconcile the shared checkout after `claude/mac-integration` lands; commit all Kevin/Sherry and shell work on a branch | Full suite + workflow gate on the branch |
| Wed 7 | Windows installer from CI (or native Windows); install on a Windows machine; office link; Bud setup | Installed-device tier on Windows |
| Thu 8 | Dress rehearsal on Windows following `outputs/austin-showcase-*/DEMO-SCRIPT.md`; fix whatever breaks | Installed Windows run with screenshots |
| Fri 9 | **Demo format (owner, 5 Oct):** first all five workflows on fictional data on the owner's Mac (`scripts/seed-austin-demo.mjs`, talk track `outputs/austin-showcase-2026-10-05/DEMO-SCRIPT.md`); then install on Austin's Windows PC and connect their real Gmail, Redbark and REI on their own screens | Customer session |

## Status
- Done on Mac (local tests): W1–W4 workflow QA, the Bud settings approval cards, the live Sherry setup with a real model (`outputs/sherry-live-setup-2026-10-05/`), the desktop shell, and the folder auto-repair, desk backups and memory growth fixes.
- Open risks:
  - no Windows VM found in UTM on this Mac
  - Windows CI on `main` was red before today's work
  - the shared checkout mixes Codex's HTTPS change with today's work, and needs reconciling before any build

Demo rehearsal (Mac, fake providers): `scripts/qa-austin-showcase.mjs` passes 8/8 (W1–W5 plus a rule-change card). The demo screens are not labelled "fictional"; only the data says so ("Fictional …" addresses), so say it out loud.

## Branch status, 5 October night (`claude/kevin-sherry-showcase`, local tests on macOS)
- Gate: `pnpm typecheck` clean; vitest 8624 passed, 327 skipped (the Postgres-gated suites, not run); 14 GUI QA scripts pass. That covers qa-austin-showcase, maintenance-review, w2-calendar, weekly-bills, morning-mail, w1-simulated, workflows-dryrun, bank-bytes, bank-amendments, rei-signin-wait (3/3 reruns), inspections, desktop-shell, workspace-tabs and desk-narrow-empty.
- Real Austin data, kept outside the repo. Only counts below:
  - W1 on the ANZ export: 14/14 rentable rows matched, 0 wrong, 11 correctly held with reasons; only the last column changed.
  - W2 on Property.csv: 131 rate and levy numbers imported, 4 rejected with reasons, 1 shared number flagged, 111 quarterly patterns suggested.
- W4 trusts a supplier only when Gmail's mx.google.com Authentication-Results confirms DMARC or DKIM for the From domain (for Xero relays, Xero's signature), and ambiguous From or Authentication-Results headers fail closed. Imports the REI Suppliers export and flags the same email on two supplier records.
- Waiting on: Kevin's REI Tenants export (so the last column holds REI's tenant Reference and payer names can match), the REI Suppliers export, and a Windows installer from CI followed by an install on a Windows PC.

Checkpoint links: `docs/KEVIN-SHERRY-WORKFLOWS-2026-10-04.md`.
