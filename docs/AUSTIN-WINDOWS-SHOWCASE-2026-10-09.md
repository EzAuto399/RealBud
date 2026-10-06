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
  - the installer is unsigned: before Friday, check on Kevin's Windows 11 PC that **Smart App Control is Off** (Settings › Privacy & security › Windows Security › App & browser control › Smart App Control) and the PC is **not in S mode** (Settings › System › About must not say "S mode"). With Smart App Control On, Windows blocks an unsigned installer outright. Peer session result, 6 Oct: the installer installs silently in 57 s on Windows Server 2025, health 200 about 30 s cold

Demo rehearsal (Mac, fake providers): `scripts/qa-austin-showcase.mjs` passes 8/8 (W1–W5 plus a rule-change card). The demo screens are not labelled "fictional"; only the data says so ("Fictional …" addresses), so say it out loud.

## Branch status, 5 October night (`claude/kevin-sherry-showcase`, local tests on macOS)
- Gate: `pnpm typecheck` clean; vitest 8624 passed, 327 skipped (the Postgres-gated suites, not run); 14 GUI QA scripts pass. That covers qa-austin-showcase, maintenance-review, w2-calendar, weekly-bills, morning-mail, w1-simulated, workflows-dryrun, bank-bytes, bank-amendments, rei-signin-wait (3/3 reruns), inspections, desktop-shell, workspace-tabs and desk-narrow-empty.
- Real Austin data, kept outside the repo. Only counts below:
  - W1 on the ANZ export: 14/14 rentable rows matched, 0 wrong, 11 correctly held with reasons; only the last column changed.
  - W2 on Property.csv: 131 rate and levy numbers imported, 4 rejected with reasons, 1 shared number flagged, 111 quarterly patterns suggested.
- W4 trusts a supplier only when Gmail's mx.google.com Authentication-Results confirms DMARC or DKIM for the From domain (for Xero relays, Xero's signature), and ambiguous From or Authentication-Results headers fail closed. Imports the REI Suppliers export and flags the same email on two supplier records.
- Waiting on: Kevin's REI Tenants export (so the last column holds REI's tenant Reference and payer names can match), the REI Suppliers export, and a Windows installer from CI followed by an install on a Windows PC.

## Overnight, 5–6 October (`claude/kevin-sherry-showcase`, PR #59; local tests on macOS + Windows CI install)
- **REI login wait (W1 and the supplier check):** waits on REI's sign-in page until 18:00, detects the sign-in itself (no button), checks the saved REI business code silently, reopens the page after a restart ("Resumed after restart"), reloads a stale login page every 10 minutes, notifies once plus one midday reminder, and settles "missed" if nobody signs in. Upload still needs its per-instance approval. `qa-rei-login-wait` 9/9.
- **Austin pack:** six workflows at Brisbane times, all off until reviewed: W3 weekdays 07:30, W2 Monday 08:00, W4 weekdays 08:30, W1 every 2 days 08:00, the supplier check every 14 days (Monday 08:15), and a new monthly W5 inspection draft. Setup checklist in Schedule. `qa-austin-pack` 9/9. Design: `docs/AUSTIN-WORKFLOWS-OPERATING-DESIGN-2026-10-06.md`.
- **Browser tasks:**
  - Root cause of the live failure: our MCP server was named `browser`, a toolset name Hermes already uses and that the pack disables, so Bud never received its browser tools (`unoffered_tool_call`). Renamed `workbrowser`, with a test.
  - Start now opens the site's sign-in, and a read-only REI task is Start + sign-in + one account confirm the first time.
  - Engine errors show in plain words.
- **Security review fixes (all with regression tests):**
  - the link shortcut needs a visible, safe, same-site address;
  - one strict address parser;
  - the account check is pinned to the portal origin;
  - classification reads the whole control name;
  - approval cards show and bind the real record;
  - real paths stay on the local card and approval record (event log and call speech now masked);
  - learned paths never become standing permission.
- **Gate:** typecheck clean; vitest 8762 passed / 327 skipped (the Postgres-gated suites, not run); all 21 GUI QA scripts pass (qa-shell-purpose needs `QA_BASELINE`); `Package Windows` passes install checks on each rebuild.
- **Known limits:**
  - The production browser engine doesn't report link addresses, so ordinary REI links ask; reviewed REI menus don't.
  - The live REI exploration isn't done yet.
  - No Windows VM: the external drive needs plugging in.
  - The local private event log keeps short numeric ids and name-like path segments in masked paths. Owner call whether to mask those too.

Checkpoint links: `docs/KEVIN-SHERRY-WORKFLOWS-2026-10-04.md`.
