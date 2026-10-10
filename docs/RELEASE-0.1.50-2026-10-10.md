# Release 0.1.50, 10 October 2026

**This does not establish:** an installed or upgraded customer PC, a live office link with realbud.app, a Mac release, or customer acceptance. The proof is source, local tests and local renderer QA with fictional data; Windows packaging runs in CI at the release commit.

## Why
- **Desk didn't fit the office's workflows.** Mail, bills and bank work each sat behind their own panel. Nothing showed what needed a person across all of them, and notices were all-or-nothing per job.
- **Bud could start before the office was linked.** An unlinked computer went straight to Bud's setup and Desk. Bud and the workflows then failed later for a reason the person couldn't see.

## What changed
- **The office link comes first.**
  - An unlinked or revoked computer opens on "Connect this computer to your office" before Bud's setup. The screen is laid out like Bud's setup screen.
  - There is no way past it except recovery (owner decision, 10 Oct). The sample-desk exits in first run are gone.
  - Recovery never waits behind it. A protected book offers "Open recovery" beside linking, and a link that can't be read offers Try again and Open recovery after 20 s.
  - Spec: [Office link gate](OFFICE-LINK-GATE-2026-10-10.md).
- **One work-area tab per workflow** (mail priorities, bills and calendar, bank references, shared work). Each tab has one status line and a collapsed Setup, and the tab shows its own count. An office's workflow pack can preset the areas' titles, layouts and notice levels, and a person's choices on this computer win. Design and record: [Desk work areas](DESK-WORK-AREAS-2026-10-10.md) §3 and §11.
- **Needs you on Tasks.**
  - Desk reads one server projection of what needs a person, problems first.
  - A source that can't be read is named, never shown as empty.
  - Mail and bills are read only when the office shows those areas.
- **Notices per area.** Choose each new item, one summary per run, or problems only. Problems always notify, and a click opens the area that sent the notice.
- **Arrange Desk** splits into "Work areas" and "Cards on Tasks". It has Reset to office default and "Undo last tab or card change". Bud arranges Desk through the same route.
- **Bank references are reviewed in one place.** Schedule's bank job opens the Desk area when the office offers it, or offers "Show … on my Desk" when it is hidden. It reviews in the drawer only when the office has no such area.
- **Accessibility.**
  - Muted text passes WCAG 2.2 AA (4.5:1) on every surface.
  - The Tasks drawer keeps keyboard focus inside it.
  - Closing Arrange Desk returns focus to where it was opened.
- **Smaller fixes.**
  - Desk's code loads as soon as the local service answers, so a slow service start no longer leaves Desk failing until a reload.
  - A missing work-browser bundle now says it needs repair instead of "could not use its saved files".

## Upgrade notes
- **Every computer must be linked.** After updating, a computer that isn't linked to its office opens on the link screen and stays there until it is. Before updating an office, check each computer is linked, or have a link code ready for it. Offices are limited to 5 computers.
- **Desk layouts move to v3 on first save.** Bank references is appended. A layout RealBud applied automatically and nobody changed gets the work-area tabs back once, at startup. An older core that opens a v3 layout sends it to recovery.
- **The pre-rename data folder** is moved only into the default `~/.realbud`, never into a custom `REALBUD_DATA_DIR`.
- **Workflow packs are unchanged.** A pack that declares `desk` needs core 0.1.50, and packs have no minimum-core field yet. Only the three built-in pack ids can be the office pack, and none of them ships `desk`, so every office sees the core Desk preset.

## Evidence
| Check | Result | Tier |
|---|---|---|
| Typecheck, `check:electron`, UI build at `d2ac6297` | clean; 34/34 electron modules | local tests |
| Full suite (`pnpm test`) at `d2ac6297` | 11,107 passed, 335 skipped, 0 failed (679 files) | local tests |
| Renderer QA, 29 scripts on one build of the branch (fictional data, isolated homes) | 29 of 29 pass: 27 in one full run, and `qa-bud-status` (10) and `qa-telegram-ask-ux` (11) on the same build after a QA-only update for the 9 Oct composer lock. Highlights: link-gate 26, setup-stages 29, kevin-sherry-day 28, clean-walkthrough 13/13 steps, source-bills 30, austin-workflow 17, austin-showcase 16. Receipts: `outputs/release-0.1.50-2026-10-10/` | local QA |
| Package Windows (`workflow_dispatch` at the release SHA) | runs at the merge commit; recorded after the build | CI packaging |
| Installed or upgraded Auston PC, live office link | not run | not established |

Not run: `qa-native-private-restore` (needs a packaged Mac build), `qa-shell-purpose` (needs `QA_BASELINE`), `qa-browser-link-e2e` (needs Postgres and a website build).
