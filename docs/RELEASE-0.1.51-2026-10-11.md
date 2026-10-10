# Release 0.1.51, 11 October 2026

**This does not establish:** an installed or upgraded customer PC, an automatic restart seen on a real Windows PC, a Mac release, or customer acceptance. The proof is source, local tests, local renderer QA with fictional data, and CI Windows packaging with an installed-runtime check on a disposable Windows runner.

## Why
- **Kevin's PC stayed on 0.1.48 after 0.1.50 shipped.** It had downloaded 0.1.49, and the updater stops checking once an update is downloaded, so it never saw 0.1.50.
- **Nothing installed unless someone clicked.** A PC left open all day kept an old version with fixed bugs.
- **The click could lose work on Windows.** The installer started before RealBud asked about unsaved work.
- **"Is Bud busy?" was a hand-kept list.** Two reviews and a survey kept finding work it missed. Manual job runs were among them, and that is the path every workflow pack's work takes. Each new workflow would have brought the same bug back.

## What changed
- **Updates install themselves at a safe moment.** RealBud restarts to update when nobody has used the keyboard or mouse for 5 minutes, or the screen is locked. It waits while there is unsaved work, Bud is working, or an approval is waiting.
  - When the screen isn't locked, a 60-second countdown shows first. Any keyboard or mouse use, or "Not now", cancels it.
  - "Later" holds the automatic restart for 4 hours. After 24 hours the update is required: "Later" goes away, but it still never cuts unsaved work or a running task.
  - "Restart now" always stays available, and still asks about unsaved work first.
- **The newest version wins.** RealBud keeps checking while an update waits, and a newer download replaces the older one.
- **After the update** the first launch says "Updated to 0.1.51" once, with a link to what's new. If an install doesn't land, it says so with "Try again" and "Download from realbud.app", and doesn't retry that version by itself.
- **One ledger of work.** Everything a restart would cut registers itself where it runs:
  - job runs (manual, scheduled, workflow packs, departments), loops, bank imports and REI refreshes;
  - batches, mail scans, Desk checks, backups, pack changes and Bud setup;
  - Ask turns, including room turns.
  - Approval cards, sign-ins (Hermios and connectors), portal-task recordings and unsaved REI previews count as waiting on you.
  - New workflows are counted without code of their own.
- **Every form with typed text counts as unsaved work** through one shared check: shared work, chat edit requests, reminders, learned recipes, department cases, connector review, inspection moves, website requests, agency setup, approval rules, schedule timing, job plans and bank reviews.
- **The update card also shows before setup is finished**, including on the office link screen.
- Spec and edge cases: [Updates that install themselves](UPDATES-2026-10-10.md).

## Upgrade notes
- **0.1.50 and older still need one click.** The automatic restart starts working once 0.1.51 is running. On those versions the card says "Restart to update"; a PC stuck behind an older download (like Kevin's on 0.1.48) is quickest to fix by installing from realbud.app/download.
- **Retiring old versions.** A release can add `minimumVersion: <x.y.z>` to `latest.yml` by hand. A PC below it shows "This version is no longer supported" and the update becomes required at once. 0.1.51 doesn't set it.
- **Workflow packs are unchanged.**

## Evidence
| Check | Result | Tier |
|---|---|---|
| Typecheck, `check:electron`, UI build at `31aaf946` | clean; 35/35 electron modules | local tests |
| Full suite (`pnpm test`) at `31aaf946` | 11,246 passed, 335 skipped, 0 failed (683 files) | local tests |
| Renderer QA, 32 scripts on one build (fictional data, isolated homes) | 32 of 32 pass in one run at `31aaf946`. Highlights: update-restart 25 (card states, the window's unsaved answer before the shell, docked card at 390 and 1280 px), link-gate 28, setup-stages 29, kevin-sherry-day 28, w1-simulated 13, source-bills 30 | local QA |
| Updater unit tests (fake electron-updater, fake clock) | 98 passed: safe moment, countdown, Later, required, the re-check after the service stops, abort restarts the service, failed install, newest version wins | local tests |
| Package Windows ([run 38064814923](https://github.com/EzAuto399/RealBud/actions/runs/38064814923), rehearsal, at `14f427f7`) | NSIS installer, managed runtime and installed lifecycle passed; `latest.yml` sha512 and size match the uploaded setup.exe. Published as v0.1.51 (latest), 10 Oct 2026 15:59 UTC (11 Oct, Brisbane); realbud.app/download serves it | CI packaging |
| Independent reviews | Round 1: 2 high, 5 medium, 5 low. Round 2: 0 high, 4 medium. Ledger review: 0 high, 1 medium, 3 low. All fixed except two that were already there: an Ask browser task counts as working while it waits on the person, and a hung loop holds restarts until its own time limit | source review |
| Automatic restart on an installed Windows PC | not run | not established |

Not run: `qa-native-private-restore` (needs a packaged Mac build), `qa-shell-purpose` (needs `QA_BASELINE`), `qa-browser-link-e2e` (needs Postgres and a website build).
