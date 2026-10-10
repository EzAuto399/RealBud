# Release 0.1.50 (draft, not cut)

**This does not establish:** a cut release, a packaged or installed build, customer acceptance, or user-tested benefit. The proof so far is source, local tests and local renderer QA with fictional data.

## Why
- **Desk didn't fit the office's workflows.** Mail, bills and bank work each sat behind their own panel. Nothing showed what needed a person across all of them, and notices were all-or-nothing per job.
- **Bud could start before the office was linked.** An unlinked computer went straight to Bud's setup and Desk. Bud and the workflows then failed later for a reason the person couldn't see.

## What changed
- **One work-area tab per workflow** (mail priorities, bills and calendar, bank references, shared work). Each tab has one status line and a collapsed Setup, and the tab shows its own count. An office's workflow pack can preset the areas' titles, layouts and notice levels, and a person's choices on this computer win. Design and record: [Desk work areas](DESK-WORK-AREAS-2026-10-10.md) §3 and §11.
- **Needs you on Tasks.**
  - Desk reads one server projection of what needs a person, problems first.
  - A source that can't be read is named, never shown as empty.
  - Mail and bills are read only when the office shows those areas.
- **Notices per area.**
  - Choose each new item, one summary per run, or problems only.
  - Problems always notify.
  - A click opens the area that sent the notice.
- **Arrange Desk** splits into "Work areas" and "Cards on Tasks". It has Reset to office default and "Undo last tab or card change".
- **Bud arranges Desk through the same route** as the sheet. That includes each area's notice level and layout.
- **The office link comes first.**
  - An unlinked or revoked computer opens on "Connect this computer to your office" before Bud's setup. The screen is laid out like Bud's setup screen.
  - Recovery never waits behind it.
  - The link step can no longer be skipped.
  - An exit for this app session opens the sample desk, or saved work once the computer is disconnected.

## Upgrade notes
- **Desk layouts move to v3 on first save.** Bank references is appended. A layout RealBud applied automatically and nobody changed gets the work-area tabs back once, at startup. An older core that opens a v3 layout sends it to recovery.
- **The pre-rename data folder** is moved only into the default `~/.realbud`, never into a custom `REALBUD_DATA_DIR`.
- **A pack that declares `desk`** needs core 0.1.50. Packs have no minimum-core field yet.

## Evidence
| Check | Result | Tier |
|---|---|---|
| Full desktop suite at `b1148c26` | 11,068 passed; 5 PDF-worker files fail only through a symlinked `node_modules` | local tests |
| Typecheck and focused suites after the link-gate merge | clean; 232 files, 2,931 passed | local tests |
| `check:electron` | 34/34 at `b1148c26` | local tests |
| Renderer QA after the link-gate merge | 12 of 13 scripts pass; `qa-clean-walkthrough` step 6 fails the same way on `main` ([§11](DESK-WORK-AREAS-2026-10-10.md#11-what-was-built-10-oct-2026)) | local QA |
| Packaged build, Windows installer, installed device | not run | not established |

## Before cutting
1. Owner approval to push `claude/desk-work-areas` and open the PR.
2. Bump `package.json` to 0.1.50 on the release commit.
3. Run Package Windows as a `workflow_dispatch` at the release SHA. Merge nothing into `main` while it builds.
