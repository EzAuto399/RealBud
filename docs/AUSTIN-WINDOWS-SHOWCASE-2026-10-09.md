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

Checkpoint links: `docs/KEVIN-SHERRY-WORKFLOWS-2026-10-04.md`.
