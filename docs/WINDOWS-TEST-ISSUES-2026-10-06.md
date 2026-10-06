# Windows test issues: 6 October 2026

**What this does not establish:** customer acceptance, or any timing on a real x64 PC. Evidence comes from an emulated Windows VM, installed-device tier.

The owner asked (6 Oct) that every issue and inconvenience hit while testing RealBud on Windows be recorded here, so all of them get fixed. Add new ones as they appear. Close an item only with evidence.

**Test machine:** UTM VM "RealBud-Win11" running Windows 11 Home on Arm, with 6 GB RAM and 4 cores. The x64 RealBud runs emulated, so expect it to be slower than Kevin's x64 PC. The test profile is "Kevin Test", linked to the QA office on realbud.app.

## Product issues

| # | Issue | Cause | Status |
|---|---|---|---|
| 1 | Window stuck on "The office service did not start" while the service was healthy | Packaged server had no package.json above it, so `/api/health` reported version "unreported" and `serviceCompatible()` never matched | **Fixed.** PR #74 + #75 (`server/app-version.json`). VM reinstall reports 0.1.34 and opens the desk |
| 2 | PR #74's fix built no Windows installer | A `package.json` extraResource broke electron-builder's app.asar check | **Fixed** in PR #75. CLAUDE.md lesson: run `electron-builder --dir` before merging builder changes |
| 3 | CI missed #1 | The Windows GUI install proof never did a normal launch + version match | **Partly fixed:** `test-windows-installer.ps1` refuses "unreported". No CI test yet of the window adopting its own service |
| 4 | Service freezes 26–35 s at a time; every UI call made during a freeze times out | Each new private file runs a fresh synchronous PowerShell lockdown (`restrictNewSync` → `windowsFilePrivacyBatchSync` → `execFileSync`). That takes 2–3 s per launch on the VM, and the launches stack up. 40-sample health probe: mostly 0.0 s, with stalls of 32.7 / 35.2 / 9.1+29.3 / 26.2 s | **In progress:** branch `claude/privacy-sync-host` makes sync calls reuse the long-lived host |
| 5 | Link code shows "RealBud's local service is not responding yet", then the retry says "Disconnect the current website link…" even though linking had succeeded | The window gives up at 130 s; the service finished later. The window never re-read the link | **Fixed** in PR #76: a lost answer waits up to 5 min for the saved link. The root cause is #4 |
| 6 | "Continue to Bud setup" fails with "did not respond within 15 seconds"; reloading then shows "Your saved setup did not answer in time" | 15 s onboarding budget (`Onboarding.tsx` `FINISH_TIMEOUT_MS`) plus the #4 freezes | Open. Re-check after #4; consider a lost-answer re-read like #5 |
| 7 | "Connect to your office" (browser link) has a 20 s budget | Same exposure as #5/#6; not observed yet | Open: re-check after #4 |
| 8 | The service's own log doesn't say what blocked it; Electron's log only flaps "alive but not answering" / "answering again" | No event-loop stall diagnostics in the service | Open: log stalls above a threshold with the operation name (no paths or data) |
| 9 | Every server module is parsed twice on start (`MODULE_TYPELESS_PACKAGE_JSON` warning seen) | Compiled `.js` has no `"type": "module"` above it, so Node tries CommonJS first, then reparses as ESM | Open: ship a `{"type":"module"}` marker the builder accepts (not a root package.json extraResource, see #2), then measure cold start |
| 10 | Slow first start: 61–122 s to healthy on the VM | Emulated x64 on Arm, Defender scanning, plus #9. CI x64 was about 30 s | Open: re-measure after #4 and #9 |
| 11 | Bud's automatic install starts right after linking, while the person is still in onboarding, and competes for CPU (uv, git, node, python, venv, dependencies) | `onLinked → workerAutoSetup.ensure("provisioned")` | Open: decide whether to show progress or defer; it compounds #4 |
| 12 | Windows Defender used 650–820 CPU-seconds during install and setup | Real-time scanning of every new file (Python and git trees) | Open: measure on x64; document whether a customer exclusion is advisable (owner decision, never automatic) |
| 13 | Health reports `busy: true` during setup, but the window says "not responding" | The UI treats a slow answer as an outage | Open: tie the copy to busy vs down |
| 14 | Bud status card shows "Return to Ask" while the service reconnects | Stale copy: Ask was renamed Work | Open |
| 15 | During each freeze the status bar shows "Offline — reconnecting" and Bud's checklist resets to "Not checked" | Symptom of #4; the UI drops known state while the service stalls | Open: keep the last known state, labelled as stale |
| 16 | Electron's main process (the window) also ran a synchronous PowerShell check each time it read the local session (seen: `powershell.exe` with RealBud's main process as parent) | `windowsKeyPrivacy` uses `execFileSync`; the session read already awaits its verifier | **Fixed on branch** `claude/windows-issues`: `windowsKeyPrivacyAsync` for every awaited caller. Startup key custody stays synchronous |

## Test-rig issues (not product, but they slowed testing)

| # | Issue | Workaround |
|---|---|---|
| R1 | Typing into the UTM VM garbles text | Write the Mac clipboard, then Ctrl+V in the VM |
| R2 | Background (app_*) clicks don't reach the VM | Use full-screen control |
| R3 | The WebDAV shared folder has a 50 MB limit, smaller than the installer | Serve installers over HTTP on 192.168.64.1:8765 |
| R4 | The VM keyboard layout is UK | Paste instead of typing |
| R5 | Cua cloud was closed; moving the VM onto the external drive failed in the UTM GUI | The VM stays on the internal disk |
| R6 | The x64 app is emulated on Arm Windows, so timings are pessimistic | Confirm timings on a real x64 PC before Friday |
| R7 | Messages to peer sessions failed (stale socket); a follow-up chip was started in parallel | Do the work in one session |
