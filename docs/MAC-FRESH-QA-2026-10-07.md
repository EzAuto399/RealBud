# macOS fresh-user QA: 7 October 2026

**What this does not establish.** This is an unsigned, un-notarized `release/` build launched from a shell, not a DMG installed through Finder. Gatekeeper, quarantine, TCC prompts (Accessibility, Screen Recording, microphone), linking, Bud setup and any live office are untested here. The shell that launched the app already held Accessibility and Screen Recording, so the computer-use daemon started without prompting. A fresh Mac user opening RealBud from Finder may see those prompts at first launch, because `startCua()` runs `requestMacOSPermissions()` before the window opens. That needs an installed-device check.

Evidence tier: **packaged build** (local). Screenshots: `outputs/mac-fresh-2026-10-07/` (gitignored, kept on the build Mac).

## Build

- Source: `origin/main` 5d9832aa, branch `claude/mac-fresh-qa`. Node 24.21.0, pnpm 10.33.0.
- `pnpm install --frozen-lockfile` took 2 s (warm store). Electron 43 downloads its dist lazily, so `node_modules/electron/dist` is empty until first use. That is expected and does not affect packaging.
- `pnpm package:mac`: **exit 0 in 2 min 38 s** (cold Postgres download, 423 MB). Rebuilds took 1:25 and 1:15.
- Output: `release/mac-arm64/RealBud.app`, version **0.1.34** in both `CFBundleShortVersionString` and `server/app-version.json`. Ad-hoc linker signature (no Developer ID). Also `RealBud-0.1.34.dmg` and `RealBud-0.1.34-arm64.zip`.

## Isolation (test rig, not product)

On macOS `HOME=` alone does **not** isolate a packaged run. Electron's `app.getPath("home")`, `"logs"` and `"userData"` ignore `HOME`. The first attempt read the real `~/.realbud`. The mock keychain refused the wrapped key ("needs recovery"), so nothing was opened or written. It did append about 12 lines to the real `~/Library/Logs/RealBud/server.log`. The working recipe:

- env `HOME`, `REALBUD_DATA_DIR`, `REALBUD_LOG_DIR`, all pointing at scratch
- flags `--user-data-dir=<scratch>` and `--use-mock-keychain`, which keeps the real "RealBud Safe Storage" keychain item untouched

Checked after the runs: the real `~/.realbud` and `~/Library/Application Support/RealBud` are unchanged. `~/Library/Preferences/com.realbud.app.plist` is still touched by Cocoa defaults, keyed by bundle id, and that can't be avoided.

## Timings (scratch home, ports 8799 free)

| Run | First `/api/health` | First office window |
|---|---|---|
| 2 (original build) | 1.25 s | 1.71 s |
| 3 (first fix attempt) | 3.79 s | 4.32 s |
| 4 (final fix) | 4.34 s | ~4.8 s |

Runs 3 and 4 shared the machine with other builds. Step 1 → step 2 took 1.6 s, and "Open the sample desk first" reached Desk in 0.8 s. Quitting the window left the detached office service running, as designed.

## Walk (screenshots)

1. `01-first-window.png`: Step 1 of 3 "Make the desk yours" with name, optional email, "Explore the sample desk" and "Restore a private backup".
2. `02-step2-connect.png`: "Connect this computer to your office" shows the link-code box, "Connect with this code", "I'm the office owner: approve in my browser" and "Owners: realbud.app → Computers → Pair a new computer." No code was entered.
3. `03-desk.png`: Desk (Sample book) shows Get started at 0 of 5 done, with step 1 "Paste the link code your office sent you · Now".
4. `04-bud-status.png`: the Bud status dialog shows Download Bud / Turn on approvals / Connect your office's AI / Test Bud, plus the link-code box and the owner hint.
5. `05-workspace.png`: Workspace (⌘4).
6. `06-schedule.png`: Schedule shows 8 jobs: 2 scheduled (Morning money check, Friday owner letter) and 6 paused.
7. `07-schedule-packs.png`: Workflow setup drawer with "Packs from your office", reading "Connect this computer to your office first." plus Check again.
8. `08-work.png`: Work (⌘2).

## Findings

| # | Finding | Status |
|---|---|---|
| 1 | The bundled `cua-driver` 0.19.3 registered a vendor telemetry installation id (`~/.cua-driver/.telemetry_id`, `.installation_recorded`) and checked GitHub for updates on every launch, printing "cua-driver v0.34.0 is available… Update with: cua-driver update". RealBud pins 0.19.3 for bounded sessions, and GATES says there are no remote diagnostics. The SDK starts the daemon with a fixed env allowlist, so main's env never reaches it | **Fixed** (this PR): the macOS grant launcher exports `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` and `CUA_DRIVER_RS_UPDATE_CHECK=0`, and the MCP proxy's `mcpEnv` carries the same values. Packaged run 4: no `.cua-driver`, no `.cua-driver-rs`, no notice, and the daemon still serves. Windows daemon not covered (its launcher can't take env); see open item |
| 2 | Bud status lists "Download Bud · **Needs attention**" for a brand-new person who simply hasn't linked yet. The other rows say Waiting | Open (copy, cross-platform; `ManagedBudStatus.tsx` maps a `current` step to "Needs attention") |
| 3 | Work says "Service setup needed: Finish Bud's installation before starting work." while unlinked. The actual next step is the link code, which Bud status says correctly | Open (copy, cross-platform) |
| 4 | The Bud status dialog, opened from Desk ("Back to Desk" in its header), also offers "Back to Work" | Open (minor) |
| 5 | The status bar says "Connected" on an unlinked computer (meaning the local service) | Open (ambiguous copy) |
| 6 | The unlinked packs drawer says "Connect this computer to your office first." with no way to connect from there | Open (minor). The "hasn't shared any packs yet" empty state needs a linked office: unverified |
| 7 | Desk shows a Hermios tab, and 8 Auston jobs exist before any pack import | Known: Windows log #27/#52/#54 |
| 8 | TCC prompts at first launch from Finder | Unverified (see top) |

## Tests

- `pnpm exec vitest run electron/cua-lifecycle.test.mjs electron/cua-launcher.test.mjs electron/cua-connection.test.mjs electron/cua-bounded.test.mjs electron/cua-windows-host.test.mjs`: 42 passed / 0 failed / 9 environment-gated skips (the native Windows launcher suite, which is not evidence).
- `pnpm check:electron`: 32/32 ok.
