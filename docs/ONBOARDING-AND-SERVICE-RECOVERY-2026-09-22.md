# Onboarding checklist and office-service recovery — 22 September 2026

This checkpoint fixes locally verifiable gaps in guided agency onboarding and in the desktop's office-service start/recovery path, and adds the Claude Code instruction layer used to do it. It does **not** exercise a packaged or installed app, Windows, a real account, a model or a customer; the Electron main-process wiring is syntax-checked and reviewed, not run. It changes no company, department, website or worker-execution code, which the concurrent department-execution work owns.

## Instruction layer (tooling continuation)

- `CLAUDE.md` gains a "Working in this tree" section (commands, environment gates, shared-checkout etiquette, evidence tiers) and a "Models and delegation" section: the interactive session stays on Fable for scope, integration and verification; bounded surveys, implementation packets, test runs and reviews go to Opus 5 subagents with explicit file ownership. `.claude/settings.json` sets `CLAUDE_CODE_SUBAGENT_MODEL=opus`.
- `.claude/rules/` holds eight path-scoped rule files (server+shared, src, electron+packaging, website, managed-gateway, packs, scripts, docs) written from a source survey with file pointers; they load only when matching files are read.
- `.claude/agents/` defines `repo-surveyor`, `implementer`, `test-runner` and `reviewer`, all `model: opus`. The user-level `~/.claude/CLAUDE.md` carries the same delegation policy for every project, and `~/.claude/settings.json` the same default (backup: `settings.json.bak-2026-09-22`).

## Implemented behaviour

Office service (Electron, `electron/service-lifecycle.mjs`, `electron/main.mjs`):

- A detached service this session spawned but never heard from is re-probed on the next start attempt; if it answers late it is adopted, otherwise it is abandoned through the `ChildProcess` object this process holds (never a pid from a file), its record is cleared only when it still matches pid and control token, and the start waits up to ten seconds for that port to free. If the port stays held, no second service is started: the port is remembered across attempts and the attempt returns false. Previously a slow start followed by Retry spawned a second service on the next port over the same data directory and overwrote the first one's only management handle.
- `shouldStartService` now takes the recorded handle, whether its port is free, pid liveness and boot time: a live pid still holding its recorded port holds startup; a record older than the current boot (`systemBootedAt`) is stale and is cleared, so a reused pid after a reboot cannot block a launch.
- In packaged mode the recovery page is a bounded wait: the window polls for the office service every 2 s for up to 3 min and opens the desk when it answers; a main-frame load failure on the app origin restarts the same wait with a cooldown; when the wait expires a second page says checking has stopped. Closing the window stops the poll.
- `REALBUD_LOG_DIR` must be a drive-letter or UNC root on win32 (`path.isAbsolute` accepted `/logs`). `pnpm check:electron` now runs `scripts/check-electron.mjs`, which enumerates every `electron/*.mjs|cjs` entry (20 modules; the hand-written list had drifted to 13).

Onboarding (renderer):

- The Desk/You "Workspace setup" checklist gains a "Review your agency workflows" row read from `GET /api/agency-setup` through the store's `api()` with an abort-bounded request. Unknown, unreadable or unselected states never read as done; the row is done only when every selected workflow is `readyForRun`. An "Open Agency workflow setup" control opens Schedule at `#schedule-packs`. `doorHashToWrite` now preserves Schedule deep links (`#schedule-*`, `#job-*`, `#bud-job-builder`) until that lazy screen mounts; before this the door mirror rewrote them to `#/schedule` first, so neither this control nor the existing Ask links scrolled anywhere.
- You → This office shows the recorded book timezone or says it is not recorded and names the computer's zone; the renderer no longer substitutes `Australia/Sydney`.
- Replaying first run over a book whose office contact is already named (the first-run flag lives in browser storage) enters the workspace without writing a new name over the saved one; a named agency with an empty contact still saves the typed name.

Onboarding (server):

- The legacy v1 book cutover stamps the host timezone instead of a hard-coded `Australia/Sydney` (v2 books already carried their own zone).
- Agency setup: an expired Gmail verification says how many minutes ago it was checked and that checks expire after five minutes; a review is refused before the first save; the bank-references mapping check states that the installed preparation plan accepts ANZ exports only. Customer-pack setup checks that the host has not observed render honest labels instead of raw ids, and stay `unknown`.

## Verification (source and local tests only)

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm exec vitest run src/ electron/ server/desk-store.test.ts server/agency-setup.test.ts server/customer-packs.test.ts server/office-core-pack.test.ts server/desk-v3-commit.test.ts` | 112 files, 1,067 passed, 0 failed, 0 skipped |
| `pnpm exec vitest run electron/` | 15 files, 146 passed |
| `pnpm exec vitest run src/` after the router change | 92 files, 840 passed |
| `pnpm check:electron` | 20 modules ok |
| `scripts/qa-onboarding-setup.mjs` (rendered, source server + Vite, headless Chrome, Node 24.19.0) | 7 checks passed, 0 page errors; receipt and screenshots in `outputs/onboarding-setup-2026-09-22/` |
| `node scripts/qa-e2e.mjs --quick` (Node 24.19.0) | desk and pm-exceptions fail on three pre-existing loop expectations, see below |

The quick HTTP battery's failures (`three named loops, inbound stays Planned`, `planned loops refuse to run`, `inbound Run now stays 409`) predate this checkpoint: `server/routines.ts` (edited 22 September, 05:55) makes `inbound-triage` available and manually runnable, while `scripts/e2e-desk.mjs` (31 August) and `scripts/e2e-pm-exceptions.mjs` (17 September) still expect it planned-only. None of the files changed here touch loops; the expectations belong to the inbound-triage change.

An independent read-only review (Opus) of the whole diff produced eleven findings. Fixed: the abandon path could scan past a still-held port; the wait-expired page still claimed to be checking; no escape from a stale record after a reboot; the first-run guard also matched an agency name and discarded a typed contact; a `floor` rendered "5 minutes ago … expires after five minutes"; the ANZ sentence claimed a hold that lives in the plan. Accepted as pre-existing or out of scope: the property-export row is gated on a workflow no caller passes (earlier uncommitted work), `configureLogDirectory` throws before logging exists (earlier uncommitted work), the "not recorded" timezone branch is unreachable for fresh v3 books because the store stamps the host zone, and the checklist's fetch effect is covered only by the rendered run, not by the static-markup tests.

Unit tests ran under the shell's default Node 22.22.0; the HTTP battery and the rendered run used Node 24.19.0 via nvm (`package.json` requires 24).

## Limits and remaining gates

- `electron/main.mjs` is not exercised: no packaged Mac build was made (a build was already running in this checkout), so the late-adopt, abandon, post-reboot and bounded-wait paths have no runtime evidence beyond their pure helpers' tests. Run `pnpm package:mac` and `scripts/smoke-mac-package.mjs` before relying on them; a smoke whose app URL fails now writes `ok:false` instead of hanging.
- The win32 log-root rule and every other Windows behaviour are proven by platform-argument tests on macOS only.
- Nothing here is customer, installed-device or live-integration evidence; the fictional receipts under `outputs/onboarding-setup-2026-09-22/` are examples.

Reproduce:

```sh
pnpm typecheck
pnpm exec vitest run src/ electron/ server/desk-store.test.ts server/agency-setup.test.ts server/customer-packs.test.ts server/office-core-pack.test.ts server/desk-v3-commit.test.ts
pnpm check:electron
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/qa-onboarding-setup.mjs
```

Gates register: [docs/GATES-2026-09-22.md](GATES-2026-09-22.md) separates client inputs, owner decisions, resolved product gates and open product work.

## Second wave (same day): Windows custody, sign-in start, QA hygiene

- `electron/desk-key-custody.mjs` applies the same env-passed PowerShell ACL policy as the server to the key directory it creates and to every key file: restrict the temporary file before key bytes exist, rename within the same directory, then verify the published file and fail closed. A byte-parity test pins the copied script to `server/windows-file-privacy.ts`. A Grok 4.7 design review (one prompt, no tools, 207 s; `outputs/windows-key-custody-2026-09-22/review-summary.md`) conditionally accepted the design and listed the Windows-only runtime checks that remain.
- `electron/package-files.test.mjs` cross-checks the Windows smoke inventory against `electron-builder.yml` on every OS; `package-win.yml` now also runs on push to `main`.
- `electron/service-persistence.mjs` plus a You → Account card add an opt-in sign-in start of the office service (`--service` host on Windows; on macOS the login item opens the app because Electron passes no arguments there) and an opt-in `prevent-app-suspension` blocker. Copy states that a closed lid, a switched-off computer or the sign-in screen still means missed work. Login items and power blockers were never registered on this Mac; only the pure modules and static markup are tested.
- The three e2e suites carrying stale loop expectations now assert the current inbound-triage contract (available, disabled until agency setup enables it, manual runs accepted and settled as held on plan approval, schedule never silently enabled). `scripts/mac-release.test.mjs` runs as `pnpm test:release-guards`, inside `pnpm qa` and in CI. README rewritten to the 21 September direction. `.gitignore` now excludes packaged bundles under `outputs/`.

| Check | Result |
| --- | --- |
| `pnpm typecheck` (Node 24.19.0) | clean |
| `pnpm exec vitest run src/ server/desk-store.test.ts server/agency-setup.test.ts server/customer-packs.test.ts server/office-core-pack.test.ts server/desk-v3-commit.test.ts` | 98 files, 938 passed |
| `pnpm exec vitest run electron/` | 16 files, 189 passed, 1 win32-gated skip |
| `pnpm check:electron` | 21 modules ok |
| `node scripts/qa-e2e.mjs` | desk, pm-day, pm-exceptions, walkthrough green (205 ok); portal-jobs fails at `POST /api/recipes/run-nav/attend` on the in-flight customer-pack readiness gate in `server/index.ts`, outside this checkpoint |

Open items and who resolves them: [GATES-2026-09-22.md](GATES-2026-09-22.md).
