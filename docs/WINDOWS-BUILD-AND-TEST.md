# Windows build and test

Use a native **Windows 11 x64** computer or a disposable x64 Windows CI runner. The supported package target is `win32-x64`; WSL, Wine, macOS cross-compilation and native Windows ARM64 are not accepted build hosts. A hosted Windows Server runner verifies Windows binaries, but does not establish Windows 11 GUI or office acceptance.

Current evidence and the downloaded installer: [23 September Windows checkpoint](WINDOWS-READINESS-2026-09-23.md). That checkpoint identifies which revision each result covers. Do not assume that the downloadable installer contains newer uncommitted fixes.

## 1. Prepare the build computer

| Requirement | Purpose |
| --- | --- |
| Node.js **24 x64** | Matches CI; the package requires Node >=24. [Official download](https://nodejs.org/en/download). |
| pnpm **10.33.0** | Exact `packageManager` pin. Install with `npm.cmd install --global pnpm@10.33.0`. |
| Git for Windows | Source checkout and revision recording. |
| Windows PowerShell 5.1 and `%SystemRoot%\System32\tar.exe` | Windows privacy checks and archive extraction. |
| .NET Framework C# compiler and `System.Speech.dll` | Builds the native CUA launcher, worker supervisor and speech helper; the speech helper also needs the reference assembly. If absent, install the [.NET Framework 4.8.1 Developer Pack](https://learn.microsoft.com/en-us/dotnet/framework/install/guide-for-developers), then rerun the check. The modern `dotnet` SDK alone does not supply the required Framework reference assemblies. |

The disposable installer acceptance harness additionally needs PowerShell 7 (`pwsh`) and Python 3.11+. Those are test-harness tools; they are not customer prerequisites for launching the packaged app. Bud's first setup separately downloads its reviewed worker runtime and dependencies.

Use an ordinary local NTFS checkout, with a writable build/cache directory and internet access to the package registry and the pinned release downloads. Keep development state separate from an installed customer's data. The checker does not test network access, available disk space or enterprise endpoint policy.

## 2. Check before compiling

From the reviewed source checkout in a fresh PowerShell terminal:

```powershell
node scripts/check-windows-build.mjs
```

Fix any reported blockers, then rerun. This command reads tool availability; it does not install tools, change execution policy or download runtimes. `--json` emits a receipt without local paths or environment values. `--proof` also checks the installer harness tools.

## 3. Compile the reviewed candidate

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd test:windows-build
pnpm.cmd typecheck
pnpm.cmd check:electron
pnpm.cmd package:win
```

Run each command only if the previous one exits successfully. `package:win` starts with the prerequisite check, then builds the renderer, compiled server, updater, BrowserSkill helper, Windows speech executable, worker supervisor, CUA driver/SDK and grant launcher, and PostgreSQL runtime. The CUA launcher must be compiled after CUA staging because staging replaces `dist-native`. Runtime downloads are version-pinned and checked by the preparation scripts. It builds an NSIS installer and x64 ZIP under `release/` with publishing disabled.

Record the source revision (`git rev-parse HEAD`), whether the checkout has changes (`git status --short`), and the installer hash:

```powershell
Get-ChildItem release/RealBud-*-setup.exe | Get-FileHash -Algorithm SHA256
```

A dirty checkout must be recorded as a working-tree candidate, not attributed solely to its HEAD commit. Keep the `.exe`, `.exe.blockmap` and `latest.yml` together for release preparation. Do not upload update metadata as part of this local build procedure.

## 4. Verify on a disposable Windows runner

The repository's **Package Windows** workflow builds the selected Git revision, installs to an isolated path containing spaces, checks the packaged resources, starts the compiled service, checks fresh private-profile creation, exercises backup/restore, and records the held native-memory primitive tests. Its cleanup now checks uninstaller exit status and app/resources removal, and links the installer digest and source revision to the receipts. A native run is required to validate that new harness behavior.

The workflow exports `windows-installer` and `windows-installed-proof` artifacts. The installer artifact now includes the ZIP as well as the NSIS files. Unit/contract CI runs separately, including three Windows shards. Preserve failed receipts and skipped cases.

The installed CUA smoke imports the GUI's launcher factory from the installed `app.asar`, starts the actual SDK through the adjacent `RealBud CUA.exe`, stops it, and repeats with a fresh connection generation. The native launcher contract tests separately use a fictional adjacent executable to check all arguments, exact exit status, stdin/EOF and descendant cleanup. These checks make no browser or desktop actions. A skipped native launcher test is not Windows proof.

`scripts/test-windows-installer.ps1` is deliberately restricted to disposable Windows CI and refuses an existing RealBud installation. **Do not set `CI=true` on your everyday PC to bypass that guard.** Use the manual checks below on a normal test PC.

## 5. Test the installed app on Windows 11

Use the [five-step manual checklist](../outputs/windows-readiness-2026-09-23/WINDOWS-TEST-STEPS.md) with fictional data and a separate Windows test account. Record the installer SHA256 and source revision alongside results.

The installer is currently unsigned. Code signing, normal SmartScreen acceptance, upgrade/data preservation, actual signed-in worker/browser use, two-computer office joining and customer acceptance are separate gates. The existing uninstall probe only concerns its disposable installation; it does not prove retention of a real user's data.

Electron already starts the embedded CUA host on Windows. `server/pilot-contract.ts` describes pilot eligibility; it is not a runtime CUA switch, as [the pilot contract](PILOT-CONTRACT.md) explains. The existing-profile grant only permits the host attachment boundary; connected account, task, browser-broker and human approval controls still govern actions. Actual browser/native actions and release for human sign-in still need installed-device acceptance. Memory review/proposal/decision remains explicitly held by `server/hermes-memory-review.ts` and its Python helper; native primitive tests alone do not justify removing that hold.
