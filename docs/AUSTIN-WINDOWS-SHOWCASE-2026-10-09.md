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

## 6 October: live REI Cloud read and site map (owner-approved, read-only)
Evidence tier: live integration, read-only. Nothing in REI was clicked to change, typed, saved, sent or uploaded.
- **Bud reads live REI pages now.** Two of our own bugs had blocked every read. The page reader refused REI's "clickable" boxes, and the account check looked for a banner REI doesn't have. Now Bud reads the Suppliers and Dashboard pages and finds the top-bar business code. Tests cover both fixes.
- **Banking-page check fixed.** REI's sidebar always lists "Banking" and "Bank Reconciliation", which made every REI page look financial and blocked plain filters. Exact menu links no longer count; the page's own words still do.
- **Site map in Bud's REI pack:** `pack/workflows/austin-accounts/support/rei-cloud-navigation/site-map.json` → `live2026_10_06`. It holds:
  - the full menu tree (143 routes, Settings and My Profile marked hand-over and not visited)
  - 48 screens with their filters, columns and Action menus
  - grid behaviour and the report catalogue (15 categories)
  - the report parameter box (Output "Export Only", never Email)
  - Austin's bank format "ANZ(csv file)"

  UI labels only: no rows, names, values, office zones or account codes.
- **Recipes corrected to the live menu:**
  - Arrears and Bank Reconciliation are under Process.
  - "Bulk Receipting" and "Tenant" are under Receipts.
  - The live Action-menu items are now consequential labels.
  - The arrears filters are read-only.
  - The REI map simulation passes 32/32 with a clean lint.
- **Directory refresh, the next step:**
  - No list has an Export item.
  - Suppliers: the grid shows all 60 rows, so W4 can read it directly with no download.
  - Tenants: the grid shows 90 of 106 rows until the grid scrolls, so W1 needs a scroll-aware read or the "Tenant Listing (Contact Details)" report through Preview. The viewer's export formats are not seen yet.
  - Until then, tenant-list and supplier-list are tier U and stop at "control missing".

## Friday install click path (unsigned installer, seen 6 Oct on a Windows 11 VM)
1. In Edge, the download shows "RealBud-0.1.34-setup.exe isn't commonly downloaded". Open Downloads (⋯), then **Keep**, then **Show more**, then **Keep anyway**.
2. Run it. If Windows shows "Windows protected your PC", choose **More info**, then **Run anyway**. Smart App Control must be Off (see above).
3. The installer runs one-click and opens RealBud: first-run screen in about 2 minutes on the emulated VM (around 30 s on x64 in CI).
4. Step 2, connecting the office: have a **link code ready from the billing owner** (realbud.app → Computers → Pair a new computer). Paste it under "Use a link code instead"; the green button then switches to "Connect with this code". The browser-approval path needs a billing-owner sign-in.

## 7 October: release 0.1.35 and the verified Friday install path
Evidence tier: installed device (Windows 11 Arm VM, x64 emulated) with live realbud.app, live gateway and the public GitHub release. Mac: packaged build only.

**Release.** `v0.1.35` is GitHub's latest release, with Windows `RealBud-0.1.35-setup.exe` (sha256 `5e3c0282…`) + `latest.yml` and Mac `RealBud-0.1.35.dmg`/zip + `latest-mac.yml`. realbud.app/download offers "Download for Windows" on Windows and shows Version 0.1.35. Before this, the latest release was v0.1.18 with no Windows file.

**Kevin's click path (walked on Windows 11, 7 Oct):**
1. realbud.app/download → **Download for Windows**.
2. Edge: "RealBud-setup.exe isn't commonly downloaded" → hover the download → **…** → **Keep** → arrow next to Delete → **Keep anyway**.
3. Open the file → "Windows protected your PC" → **More info** → **Run anyway**. (The download page has the same steps under "Windows says the file isn't commonly downloaded?".)
4. Installer runs (upgrade: "RealBud is running. Click OK to close it" → OK; about 80 s on the emulated VM).
5. RealBud opens. Step 1 name → step 2 **Paste the link code your office owner sent you** → **Connect with this code** (or the owner approves in their browser; code shown on both screens must match).
6. "This computer is connected" → **Continue to Bud setup**. Bud sets itself up unattended behind a full-window "Setting up Bud" screen (Download Bud / Turn on approvals / Connect your office's AI / Test Bud → all Ready); the rest of RealBud opens when Bud is ready.
7. Desk **Get started**: 1 linked ✓, 2 Bud set up ✓, 3 Import your office's pack (needs the signed packs uploaded), 4 Gmail (needs shared office Gmail set up by the owner), 5 review and switch on workflows.

**Timings (emulated VM; a real x64 PC should be faster):** silent install 61–87 s; first window and first health 33–41 s; owner approval links in under a minute; Bud answers a first question in about 60 s; health latency p95 under 100 ms.

**Before Friday (owner):**
- Upload the two signed role packs (realbud.app → Workflow packs).
- Turn on Shared office Gmail and allow Kevin's and Sherry's computers (realbud.app → Computers).
- Have a link code ready for each PC (realbud.app → Computers → Pair a new computer).
- On Kevin's PC check Smart App Control is Off and the PC is not in S mode (an unsigned installer is blocked outright otherwise).

QA tooling: `scripts/windows-qa.ps1` (one-line receipt) and `docs/WINDOWS-QA-RUNBOOK.md`; issues in `docs/WINDOWS-TEST-ISSUES-2026-10-06.md`.
