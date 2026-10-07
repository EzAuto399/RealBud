# Owner-away work session — 7 October 2026

**This checkpoint does not establish** any installed-device run on Windows (the VM sat at its sign-in screen all session), notarised or signed builds, live REI writes, live Jev from an installed RealBud, or customer acceptance. Evidence tiers are named per line.

The owner granted standing authority (7 Oct) to make every decision and approval needed to finish RealBud core and the Austin Realty (Kevin / Sherry) packs, merge gated PRs, use Hermes and Jev to the full, and run macOS + Windows QA. Every PR below was gated on this Mac (GitHub "CI" is disabled manually) with one full `vitest run` at a time, then merged. `main` is the only branch; no PRs are open.

## Merged today (in order)
| PR | What |
|---|---|
| #113, #120, #121, #130 | Watch and learn ("Show Bud a task"), learned confirmations scoped per task and re-checked by the press guard (`learnedReadSafe`), one label normaliser |
| #114 | Austin attended: pack integrity (recipes digest pin, CRLF, error copy, #54 jobs hidden until their role pack, honest export), W1 readback for REI's real Telerik Receipt Register (date + exact amount + payer surname; scope from page account checks; reversals block until labelled), W1 tenant-list freshness gate, backup accepts tenant-list/source records (fixed a main bug: offices with a saved REI tenant list could not back up) |
| #115 | Jev client (Modelvia `/v1/decisions`, `jev-1.13-decisions`) + payer→tenant hints for unmatched bank lines (suggestions only; owner approved payer names/amounts to Jev) |
| #116 | REI read recipes use no unnamed control; filtering via pack `rowFilter`; tenant list read Active-only |
| #124, #126 | Austin packs built from committed JSON; neutral core Bud identity, PM wording/skills moved into the Austin pack (austin-office r6, austin-accounts r2) |
| #125, #136, #138, #141 | QA scripts brought up to date with today's behaviour |
| #127, #128, #129 | Dead code: ~4.5k lines of unused UI, unused exports + `startRepair` bash path, legacy driver fleet + `PRODUCT_MODE` (~3.2k lines); Linux packaging dropped; one address normaliser |
| #131 | Jev fallback chooser for drifted REI controls (Ask only, guarded, never under loop-read, receipt `chooser` + `map-drift`) |
| #132 | Hermes: broken native `web` removed, Sonnet vision for Flash offices, `guard_agent_created`; law watch honest when no search provider |
| #133, #137 | Onboarding: pack import selects the workflow, built-in role-pack fallback, Get started shows next need, shared Gmail copy, setup failure names its stage, window opens before the service, restart / support-file buttons, first run lands on Desk |
| #134, #140 | Pack export carries only its own jobs; demo seed per role; pack import never overwrites a chosen setting; Schedule loads without flicker |
| #135 | Jev pre-screens obvious mail noise before morning priorities |
| #139 | Windows test fixtures (learned-recipe private dir, setup-cancellation test) |

Modelvia (separate repo): Jev `/v1/decisions` route, rate card r5 (cost + 30%, price only shown), deployed at api.modelvia.dev; route enabled for client `realbud` and 9 office projects; canary passed.

## Evidence
- **macOS local tests**: last batch gate tree = main `644ddbf8` + #141 scripts: full vitest 9110 passed / 0 failed / 328 environment-gated skipped; check:electron 33/33; qa:e2e green; qa-rei-refresh 12/12; chaos 14/14; austin-day-one 20/0; kevin-sherry-day 13/13 each; clean-walkthrough 13/13; onboarding setup/restart, first-install, customer-packs, hermes-updates, austin-pack, austin-showcase green; austin-workflow 17/17, rei-login-wait 9/9, rei-map-sim 32/32.
- **macOS packaged build (ad-hoc, not notarised)**: 0.1.36 package:mac:qa + smoke OK; launched on scratch data, `/api/health` 200, clean quit (main `4baf06b3`).
- **Windows (GitHub windows-latest, targeted)**: 78 Windows-sensitive files on `4baf06b3` → 1459 passed; the 3 learned-recipe fixture failures and the setup-cancellation test fixed in #139 (110/110 on Windows). 4 private-backup process-kill tests also fail on the pre-today baseline (runner environment, pre-existing). Final run on `f6fbca00` (run 37620931958): 46/46 files, 954 passed / 0 failed / 10 skipped. The targeted workflow was enabled for these runs and disabled again afterwards.
- **Live REI (read-only, owner-authorised)**: open-session passes; the original read recipes failed on unnamed controls (fixed by #116); Receipt Register export layout recorded in [REI-LIVE-READ-2026-10-07](REI-LIVE-READ-2026-10-07.md). No live run of the merged recipes yet.

## Owner to-do (blocking or before Friday)
1. Sign in to the Windows VM (`realbud QA`) so the installed-app Windows run (Kevin onboarding + W1–W3) can happen; Claude does not enter passwords.
2. Re-sign and upload the role packs (austin-office r6 / austin-accounts r2 / austin-property) with `scripts/sign-pack.mjs` (key `realbud-pack-signing-key` in Keychain); until then the built-in role-pack fallback (#133) lets staff import them.
3. Website: apply migration `202610070001`, then merge RealBud-website #26 (link codes 1 h, operator pack upload, staff copy-message).
4. Code signing (Windows SmartScreen) and Mac notarisation remain open.
5. Confirm Jev's OpenRouter price (US$0.042 per 1M input tokens was derived from OpenRouter's example).
6. Leave one real bank import unprocessed for a minute so the Bulk Receipting pending view can be mapped (W1 pending check is "unknown" until then).

## Known follow-ups
- Search provider for Bud (web search is off; law watch reports it plainly).
- Tenant emails from REI so Jev mail screening protects tenant mail.
- Pack r3: rules + REI files carried by the role packs, Sherry's "Mock" workflow renamed.
- Unreachable peer-agent comms code (agents-proxy, chief-of-staff) and Electron `cua-control` env left after #129.
- 4 private-backup process-kill tests on GitHub's Windows runner.

## One list: what's left (evening hand-over)

The two working sessions were consolidated into one ("Enterprise onboarding optimization") on the evening of 7 Oct.

**State of the code**
- RealBud `main` is the only branch, and no RealBud PRs are open.
- Website: [RealBud-website#26](https://github.com/EzAuto399/RealBud-website/pull/26) is open. It is waiting on the owner because merging deploys realbud.app.
- Leftover worktrees whose work was already on main were removed.

**Uncommitted work preserved, nothing reset.** Copies are kept as local branches only; they are not pushed, because the RealBud repo is public:
- `backup/shared-checkout-2026-10-07`: the shared `/Users/yo-da/projects/RealBud` checkout. It sits on old local `main` 8bfb143a with 461 changed paths, mostly earlier drafts of work merged since (for example the watch-and-learn port, #113).
- `backup/codex-plugin-core-2026-10-07` and `backup/codex-gmail-read-approval-2026-10-07`: two Codex worktrees, each 7 days old.
- `backup/website-checkout-2026-10-07`: the website checkout, 22 commits behind, with 30 changed files from the 4 Oct computer-cap work.

**Owner actions** (only the owner can do these)
1. Sign in to the Windows VM (`realbud QA`). This unblocks the installed Windows run.
2. Re-sign and upload the role packs on realbud.app → Offices → Workflow packs.
3. Website: apply migration `202610070001`, then merge #26.
4. Code signing (SmartScreen) and Mac notarisation.
5. Confirm Jev's price, and leave one bank import unprocessed so W1's pending view can be mapped.
6. Decide:
   - whether the shared checkout may be reset to `origin/main` (its backup is above);
   - whether to hide Hermios for offices without it (Windows issues #27, #52);
   - whether to re-enable GitHub CI (#25).

**Tests still to run** (each waits on an owner action above)
- Windows VM installed run:
  - Kevin onboarding with a link code
  - time to the first window (98.5 s before #137)
  - automatic resume after an update (#28)
  - the 14 s stall (#43)
  - W1–W3
- Live REI read of the merged recipes.
- Packaged macOS: a Dock click while "Getting your office ready" is showing.
- A notarised build smoke test.

**Engineering follow-ups** (small, not blocking Friday)
- Search provider for Bud.
- Tenant emails from REI for Jev mail screening.
- Pack r3.
- Remove the dead peer-agent comms code.
- The four Windows-runner backup tests.
- A live Jev check on a release build.
- Bud's install competes with onboarding for CPU (#11).
- Copy for a busy service versus a down service (#13).
- Measure `startCuaControl()` before the first window.
- The invite page needs one Try again after the owner confirms the first month.
