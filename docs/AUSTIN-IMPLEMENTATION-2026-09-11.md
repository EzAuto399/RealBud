# Austin routine implementation and verification

11 September 2026 · Internal delivery evidence · Hermes + Cua, owned by the RealBud harness

The saved sign-in handover, explicit step recovery, bank-reference review and Windows packaging are now implemented in RealBud. **The complete daily Austin routine is not yet accepted for Kevin.** Automatic bank acquisition, a calibrated Austin account/window, accepted REI import format and actual Windows 11 browser/native-app operation remain open.

## What changed

### Sign-in, MFA and recovery

- RealBud saves an encrypted, revisioned checkpoint before releasing computer control. A password/code tool request or a worker explicitly asking the person to sign in opens the handover; Work activity also offers a manual pause.
- The private desktop parent stops its owned Cua daemon. A failed release stays in recovery and does not claim that credentials can be entered safely. A separately owned standalone Cua app cannot satisfy private release.
- A pause marker survives application restart, keeping the computer descriptor unavailable. The packaged app cannot fall back to a legacy standalone descriptor while paused. Harness-only control credentials and the workflow encryption key are stripped from child CLIs.
- Continue is one bounded, read-only check of a saved browser window, HTTPS origin, full visible account label and signed-in page label. A wrong account, ambiguous tabs, truncated readback, changed window, timeout or unsupported response remains held. No screenshot is requested by this check. The driver is released again after checking.
- The Cua 0.19.3 semantic response was checked against an actual fictional browser window, not invented from a fixture schema. A fresh private host reacquired new target identifiers after restart.
- After verification, the operator selects **one next reviewed step** from the original approved plan. A new attempt contains only that step, links to the interrupted attempt, and uses a stable deduplication key. Changing or pausing the approved plan prevents recovery. A sign-in check older than one minute must be refreshed.
- This is explicit human-reviewed step recovery. RealBud does not infer that all earlier steps succeeded. An uncertain dispatch is held for receipt review; restarting never automatically replays it.
- Two connected browser clients reflect the same saved state. Revision checks reject old Continue, Stop and review actions. This is not a claim of mobile push delivery.

Implementation: `server/human-handoffs.ts`, `server/workflow-database.ts`, `server/cua-human-control.ts`, `server/index.ts`, `electron/cua.mjs`, `electron/cua-control.mjs`, `electron/cua-login-check.mjs`, `src/components/HumanHandoffPanel.tsx`.

### Bank-reference preparation

- Schedule now contains a dedicated bank review. It accepts a CSV with an explicit date, signed-amount, narrative and reference-column mapping, plus an approved property/reference directory. The last saved mapping and directory are reused for the next export.
- The source CSV is retained unchanged in encrypted storage. SHA-256 identifies repeated source downloads; a repeated exact file opens its saved review rather than creating a second copy.
- Matching uses explicit payer aliases and token boundaries. Ambiguous or absent matches, existing references, possible duplicates and non-incoming amounts are called out. Amounts alone never identify a property. Duplicate rows remain separate.
- Every row needs an explicit assign/keep decision and review reason. Only a directory-approved reference can be assigned. Dates, amounts, other cells, row order, quoting outside changed cells, BOM and line endings remain intact. Leading-zero reference values stay strings.
- Export is unavailable before review. Concurrent or stale reviews are rejected. The output has its own digest and change list. The UI pages larger batches rather than rendering every transaction at once.
- Limits: 750 KB / 3,000 rows / 100 columns per CSV; explicit `YYYY-MM-DD` or `DD/MM/YYYY` dates and one signed decimal amount with exactly two cents digits. XLSX, separate debit/credit columns and other export formats require another calibrated mapping. No claim of REI compatibility is made before an actual import-preview check.
- This prepares and downloads a copy. It does not download from the bank automatically, import into REI, post receipts, make payments or reconcile the bank balance.

Implementation: `server/bank-reference.ts`, `server/bank-reference-store.ts`, `/api/bank-reference`, `src/components/schedule/BankReferenceReview.tsx`.

### Windows delivery

- `pnpm package:win` now stages the pinned Windows x64 Cua executable, native UIA helper, cursor helper, native SDK and runtime files. The official release archive checksum and actual companion filenames were verified.
- Windows starts an embedded private Cua host using the packaged DLL. macOS-only permission calls are kept on macOS. The desktop and server availability checks recognise a Windows helper while preserving unsupported-platform holds elsewhere.
- The private repository's Package Windows workflow builds an exact source revision, runs workflow safety tests, silently installs the actual NSIS output on the clean Windows Server runner, and executes the installed Electron runtime against packaged resources.
- The installed-runtime check verifies required files, pinned executable version, SQLite persistence, native SDK loading, private Cua host startup, browser/native tool registration and clean host shutdown. It records the source revision, installer digest and actual runner OS. These checks do not substitute for Windows 11 GUI acceptance.
- Source snapshots include the necessary pre-existing local product work. They exclude interview videos, outputs and customer runtime data; the original working tree and staging area were preserved. No Hermes source code was changed, no new engine was added, and no public release was published.

## Evidence layers

| Layer | Result | Boundary |
| --- | --- | --- |
| Focused source tests | 215 tests across 14 files passed | Bank integrity, encrypted persistence, login recovery, concurrency, stale decisions, worker setup, process credential isolation and existing server behaviour |
| Built application browser journey | 15 checks passed | Real React/API/persistence with scripted ACP and private-host responses; fictional bank CSV |
| Real Hermes canary on macOS | Passed | Provider ping, plan preparation, real fictional-file reading, calculation, durable output, ACP warm/fresh-process context recovery |
| Real pinned Cua desktop smoke on macOS | Passed | Embedded SDK → private daemon → official MCP proxy; 54 tools and a real desktop image returned |
| Real Cua sign-in check on macOS | Passed | Exact fictional HTTPS tab, correct account accepted, similar wrong account refused, private host stop/restart and fresh target binding |
| First Windows installer build | Passed: run 34493915519, source c85d4f27180e696747af47c380f79b41edbbe834 | Actual NSIS installed and packaged runtime tested on Windows Server, not Windows 11 |
| Final Windows installer | Passed: run 34495517086, source a3561c1b82c6c4e14488c48e5d7af1987af15009 | Actual NSIS installed and runtime verified on Microsoft Windows Server 2025 Datacenter x64 |
| Full Hermes + Cua Austin routine | Not yet verified | Separate component successes are not proof of the complete customer workflow |
| Windows 11 and customer devices | Not tested | No Windows test PC/VM has been identified in this session; x64 is the built target |
| Bank / REI / mobile push | Not accepted | No customer logins, payments, REI mutations or external notifications were performed |

Evidence directory: `outputs/austin-implementation-2026-09-11/`. It contains `foundation-tests.log`, `build.log`, `browser/result.json`, browser screenshots, `hermes-contract.log`, `cua-live-smoke.log`, `cua-live-login-proof.json`, upstream archive receipts and the exact Windows source record. Grok 4.6 xhigh supplied the Windows source review. Its larger bank-generation and follow-up review attempts did not yield a completed implementation review; they are not counted as validation.

Installer receipt: [private build and artifact](https://github.com/EzAuto399/RealBud/actions/runs/34495517086). SHA-256: `6C0B754399C35F5628244CA9006E5D339B7DFF7D471CB80051CEA17B9E93E007`. The downloaded installer matches this digest. `windows-runtime-proof.json` and `windows-build-proof.json` record the checks and explicit unverified behaviours. TypeScript, production build and Electron syntax checks also passed.

## Remaining handover gates

1. **Calibrate Austin's real inputs.** Obtain an authorised example bank export, a property/reference directory, one REI import example or preview specification, the real bank/REI sites and exact Windows applications. Confirm the daily or every-two-days coverage period, timezone and duplicate-coverage rules. Use approved test data until Austin authorises a controlled real run.
2. **Calibrate access on the intended device.** Kevin signs in directly; no password or MFA code needs to be sent to us. Bind the exact browser window/site and visible account/page labels. Verify incomplete login, wrong account, MFA, expiry, multiple tabs, relaunch and reattachment. The current native-app sign-in verifier is browser-specific; native dialogs still need their own adapter.
3. **Finish daily acquisition and REI handoff.** Wire the approved bank download action into the saved source batch with source-coverage receipts, bounded retry/backoff and uncertain-download recovery. Calibrate the actual Cua action shapes against the RealBud permission boundary. Compare the reviewed copy with the original, check REI's import preview and totals, and require the agreed human approval before posting anything.
4. **Use the actual Windows installer on Windows 11.** Match Austin's x64/ARM architecture; an ARM VM does not certify x64 PCs. Cover clean install, pinned Hermes setup, model login, persistence, restart/update, website control, the named native application, approvals, Stop, human takeover and failure recovery. Record the installer hash, OS build and architecture alongside the results.
5. **Verify the chosen phone route.** Deliver a real approval/sign-in alert, resolve it on one device, reject a stale action on the other, and demonstrate the notification's resolved state. Browser-client synchronisation alone is insufficient.
6. **Run a supervised office acceptance.** Start with one recurring payment preparation workflow. Measure staff active time, automated time, waiting time, unmatched rows and actual API usage. Keep ambiguous outcomes held. Kevin accepts the result and recovery behaviour before it becomes an enabled daily routine.

The initial stack remains Hermes + Cua. RealBud owns the routines, saved state, approvals, source files, account bindings and recovery. CRM remains a phase-two add-on; engine replacement, billing and optional hardware remain separate decisions.
