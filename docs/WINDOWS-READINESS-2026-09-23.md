# Windows readiness — 23 September 2026

This checkpoint does **not** establish Windows 11 GUI acceptance, complete feature parity, fresh-device worker/model setup, upgrade/data preservation, live account integration, or customer acceptance. The user has no Windows PC available and asked for the installer and test steps first. The existing Windows-tested installer is prepared; the new working-tree changes still require a fresh Windows build and native tests.

## Prepared handoff

- [Windows baseline test kit](../outputs/windows-readiness-2026-09-23/RealBud-Windows-0.1.19-baseline-fb6cebed.zip): installer, build metadata, checksum receipt and five-step checklist. This is the previously tested `0.1.19` / `fb6cebed` build, **not** a newly compiled candidate.
- [Manual Windows 11 test steps](../outputs/windows-readiness-2026-09-23/WINDOWS-TEST-STEPS.md).
- [Build requirements and commands](WINDOWS-BUILD-AND-TEST.md).

## Native evidence checked during this task

| Layer | Verified revision / result | Limit |
| --- | --- | --- |
| Windows CI | [`e82ea2f0`, run 35811751670](https://github.com/EzAuto399/RealBud/actions/runs/35811751670): all three Windows unit/contract shards successful | Does not include newer working-tree changes |
| Windows packaging | [`fb6cebed`, run 35806671985](https://github.com/EzAuto399/RealBud/actions/runs/35806671985): native x64 NSIS build and installed-runtime probes successful | Hosted runner, not an office Windows 11 desktop |
| Installed resources/service | Downloaded receipts: **9 / 0 / 0** resource checks and **4 / 0 / 0** compiled-service checks | No normal Electron GUI, DPAPI relaunch or real worker login |
| Installed backup/restore | **6 / 0 / 1** checks; the skipped check is explicitly POSIX chmod-only | No customer-data restore or Windows performance acceptance |
| Memory candidate | **15 / 0 / 0** native primitive checks | Production memory review/journal holds remain |

The source revision in the downloaded resource receipt matches the successful package run. The installer is 160,730,532 bytes; SHA256 is `0ba39f09bb5a0caf935a8acf92081c7ceee57f89d998baf127c4e83b307f8f63`. Its SHA512 and size match the workflow's `latest.yml`. [Baseline receipt](../outputs/windows-readiness-2026-09-23/baseline-installer-receipt.json) and [kit assembly receipt](../outputs/windows-readiness-2026-09-23/test-kit-receipt.json) preserve the distinctions.

The earlier harness ran the uninstaller without checking its exit code or completed removal. Do not interpret that old green workflow as verified uninstall completion; this task adds that missing check.

## Working-tree changes

`pnpm check:windows-build` checks the native Windows x64 host and required Node, pinned pnpm, Git, system PowerShell/tar, Framework compiler and System.Speech tools without installing or downloading anything. `--proof` adds PowerShell 7 and Python for the disposable acceptance harness. The checker is now first in `package:win`, before any generated outputs can be changed. CI runs the portable checker tests and Windows package CI checks real tools before dependency installation. The existing speech locators are reused.

The Windows `execFileCli` timeout change was **rejected and removed** after three lifecycle review failures. The doubtful assumption was that adapting Node's timeout/pipe handling could reliably reap Windows descendants while preserving callback semantics. Controlled Node 24 models reproduced early launcher exit, orphaned descendants, a success-after-timeout race, and an unbounded wait when a descendant retained pipes after the launcher exited. Those are model/source findings, not native Windows observations. Only this task's process edits were restored; other work was preserved. The [held candidate and review](../outputs/windows-readiness-2026-09-23/held-timeout-candidate/README.md) remain as diagnostic evidence. Process-tree cleanup is an unresolved runtime gate, not a delivered fix.

The installer harness requires a full source revision and a fresh receipt directory. It records the installer digest, links child receipts by hash, checks uninstaller exit status and waits for app/resources removal. Cleanup failure fails acceptance without hiding the original probe error. The new PowerShell harness has not been executed or parsed with PowerShell here. The Windows artifact upload now includes the already-built x64 ZIP. Stale Windows speech/CSV-only guidance was corrected.

The CUA candidate replaces the Windows `.cmd` grant wrapper with a dedicated `RealBud CUA.exe`, compiled after the pinned driver is staged. The SDK receives a real executable; the launcher only runs its adjacent driver and inserts the existing-profile grant for `serve`. It forwards every argument and the SDK liveness stdin, mirrors the driver's exit, and assigns the child atomically to an owned Windows Job before running it. GUI startup and installed smoke use the same factory. The new smoke imports that factory from the installed app and checks two start/stop generations. This is candidate implementation, not evidence that the baseline installer contains or passed it.

## Local verification and remaining gates

[Local verification](../outputs/windows-readiness-2026-09-23/local-verification.json) records the final focused test counts and common app/server build results. The checker contracts passed **15 / 0 / 1**; the skip needs native Windows `.cmd` execution. The real Mac `package:win` invocation refused before staging, and all existing build outputs were unchanged. Local simulations and Mac compilation are not new Windows proof. An early checker-test invocation before its file was written is retained as `preflight-tests-incomplete.log` and is superseded by the completed test run.

The earlier statement that `server/pilot-contract.ts` holds attended CUA at runtime was inaccurate: it is descriptive eligibility data, and [the pilot contract](PILOT-CONTRACT.md) explicitly excludes using it as an HTTP gate. Electron already starts CUA on Windows; attended browser tasks retain their account, task and broker permissions. The baseline package smoke bypassed the GUI grant wrapper, so its result cannot validate that path. The new candidate now shares that path, but its native SDK/launcher run remains required. Local fictional tests cover argument preservation and GUI start/stop/release/restore; Windows Job, native SDK identity and installed behavior are not established by Mac results.

Memory review/proposal/decision remains held in `server/hermes-memory-review.ts` and its Python helper; the legacy migration function also refuses Windows, although the current startup does not call that function. Fresh worker setup and model login, actual browser/native actions, tray/sign-in supervision, DPAPI relaunch, upgrade/data retention and two-computer office joining remain device tests.

No source was committed or pushed, no release or updater was published, and no new hosted build was dispatched. The next build must include the intended reviewed working-tree changes and run both Windows CI and **Package Windows** on that exact candidate. Project `CLAUDE.md` requires explicit authority before commit/push. Existing Mac/source evidence and this baseline kit cannot substitute for that build.
