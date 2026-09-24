# Windows memory journal candidate proof

This harness does not establish production Windows memory support. The TypeScript host and Python public helper continue to return `platform-unverified` on Windows. It exercises the private journal candidate with actual Windows storage and an admitted, unmodified Hermes runtime, using fictional disposable profiles. A passing receipt is a review input; it does not remove either admission hold.

## Run the native candidate

Use a native Windows x64 session, local NTFS temporary storage, Windows PowerShell 5.1, and the managed Windows Hermes runtime selected by `MEMORY_REVIEW_RUNTIME` in the matching `server/hermes-memory-review.ts` (or packaged `.js`). Prepare that runtime through the existing verified `runWorkerBootstrap` installer with a disposable runtime root and `privateRuntime: true`. Do not substitute a mock runtime, change the runtime pin, use a customer profile, configure a model, or copy an existing worker home. The harness itself performs no downloads or hosted calls. Ordinary user access is sufficient; the ACL and junction fixtures do not require administrator or Developer Mode access.

From the checkout, after the separate bootstrap has completed:

```powershell
python scripts/testing/hermes-memory-windows-journal-native.py `
  --runtime "$runtimeDirectory" `
  --helpers-dir server/helpers `
  --admission server/hermes-memory-review.ts `
  --source-revision "$env:GITHUB_SHA" `
  --receipt "$env:RUNNER_TEMP/windows-memory-journal-native.json"
```

`$runtimeDirectory` is the explicit admitted `hermes-agent` directory containing `venv/Scripts/python.exe`; the supervisor launches that interpreter with `-I -B`. The initial `python` only needs the standard library and Python 3.10 or later. `--source-revision` is optional outside CI; when supplied it must be the full 40-character revision. The same value defaults from `REALBUD_BUILD_SHA`, then `GITHUB_SHA`. It is a reported build association, accompanied by actual input hashes, not a substitute for those hashes.

For a separately authorized installed-app probe, supply the installed `resources/server/helpers` directory and the matching `resources/server/hermes-memory-review.js` with the same flags. Both paths are required: the harness never substitutes source helpers for missing packaged helpers. Keep the existing native primitive acceptance and installer lifecycle receipts as separate proof layers. Running this script against installed helpers does not prove the GUI, installation, upgrades, or customer-data preservation.

Every run requires a fresh receipt filename. Exit `0` means all 28 checks passed, selected sources remained unchanged, and temporary files were removed. Exit `1` is failure; exit `2` denotes unsupported platform or CLI usage failure. A non-Windows run writes an `unsupported` receipt with `native_windows_validation: false`, zero checks and no helper/runtime imports. CLI errors such as a reused receipt path preserve prior evidence and do not write a new receipt.

Allow **17 minutes for this harness**, in addition to runtime bootstrap. Journal children have a 60-second limit, ACL/junction setup commands 120 seconds, and the supervised suite 900 seconds. On timeout the owner attempts `taskkill /T /F`, then kills/reaps its direct child; a timeout always fails the run. If a parent has already exited with inherited pipes open, descendant cleanup is explicitly unverified. Cleanup failure also fails acceptance. Keep this candidate job independent so a held or failed memory experiment cannot suppress ordinary package/install receipts.

## What the 28 cases exercise

- Actual admitted Hermes parsing, configuration, dry-run semantics, proposal publication, preview, approval/rejection, signed receipts, exact retries, and interrupted-intent closure. Public JSON and direct-dispatch calls still refuse Windows; unknown request/payload fields cannot select the internal seam.
- Thirteen intentional real child-process exit boundaries: prepared proposal intent, proposal stage, before/after pending publication, before/after publication receipt, review intent, before/after memory publication, before/after final review receipt, and before/after claim cleanup. Retries check no duplicate memory rewrite, exact proposal identity, and flush-before-final-receipt ordering where required.
- Preservation when both stage and pending names exist, a signed intent or stage is missing, memory changes after an interrupted write, or a human completes review before the producer records publication. An unsigned orphan stage is never adopted.
- A native review lock held by an independent process, broad-ACL refusal without ACL repair, a real junction ancestor refusal without changing its target, and refusal of outside-profile, ADS, parent-traversal and UNC paths. Each profile is created with the production native protected ACL API under a new temporary root containing Unicode and spaces.
- Real `WindowsJournalIO` → `WindowsMemoryStorage` → `Win32Native` operations. A subclass only records observations and exits at named boundaries; every intercepted operation delegates to the unchanged implementation. An upstream path-writer tripwire and a forbidden `FakeWindowsIO` constructor fail acceptance if a fallback is used. Locks and request storage must be released after each normal child dispatch; later processes also exercise recovery after actual termination.

The script reuses applicable assertions from `scripts/testing/hermes-memory-windows-journal.py`. It replaces that suite's fixture creation and child runner, **not** native storage. Its original POSIX-backed fake IO is not native evidence. The separate `scripts/testing/hermes-memory-windows-native.py` covers leaf storage primitives; neither suite should be reported as replacing the other.

## Receipt and verification boundary

The JSON records each completed check and duration, the active check on interruption, expected count, pass/fail/skip counts, native execution flag, runtime version/architecture, selected paths, admitted runtime commit, elapsed time, cleanup outcome and explicit limits. SHA-256 values bind the harness, shared scenario assertions, admission table, all five selected helper files, all eight admitted Hermes source files and selected venv Python. The input set is checked again after the suite. No skipped, timed-out or partial suite can pass. A native flag on a failed receipt only says native fixture creation started; the overall `passed` field and complete checks remain decisive.

Evidence files must be retained by the caller even on failure. The harness deletes only the unique temporary root it created; it neither repairs nor deletes a real profile or the selected runtime. Per-case evidence is summarized into the receipt before disposable cleanup. If filesystem cleanup fails, the receipt records that failure and leaves the root for investigation rather than claiming clean completion.

The accepted boundary is application-process crashes between native facade operations. It does **not** establish physical power-loss durability, every mid-syscall crash, disk exhaustion, network/removable filesystem behavior, forced deferred deletion/sharing denial throughout the full journal, adversarial same-user races, an installed GUI workflow, live models/providers, or customer acceptance. The real independent-process lock case is bounded concurrency evidence; it is not an adversarial concurrency proof. Keep the production holds until their separate review and native acceptance criteria are satisfied.

## Portable checks

```sh
python3 -B scripts/testing/hermes-memory-windows-journal-native.test.py
```

These nine checks cover harness control flow, admission-table parsing, environment isolation, checkpoint classification, receipt preservation and timeout behavior. They use no native backend or Hermes runtime. They passed locally on macOS while adding this harness; no native Windows execution is claimed by this document. See [Windows build and test](WINDOWS-BUILD-AND-TEST.md) for the broader compile, package and installed-device proof layers.
