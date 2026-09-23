# macOS and Windows candidate — 23 September 2026

This candidate combines the latest local core fixes with native Windows build
preparation. It is prepared in an isolated checkout on
`readiness/mac-windows-2026-09-23`; the existing working checkout is preserved.
It is not a published release or an update-feed change.

## Supported build targets

| Target | Build environment | Distribution status |
| --- | --- | --- |
| macOS Apple Silicon | Native arm64 Mac, Node 24, pnpm 10.33.0, Xcode tools, Developer ID | Signing identity available. The saved `realbud-notary` profile was rejected by Apple with HTTP 401 during this task. |
| Windows x64 | Native Windows, Node 24 x64, pnpm 10.33.0, Git, Framework C# compiler and System.Speech | NSIS and ZIP workflow prepared. Authenticode signing is not configured. Windows 11 owner-device acceptance remains open. |

The new Windows launchers use Windows 10+ Job Object creation attributes; the
intended desktop acceptance target is Windows 11 x64. Intel Mac and Windows ARM
are not supported build targets. See [Windows build and test](WINDOWS-BUILD-AND-TEST.md)
and [Mac build and test](MACOS-BUILD-AND-TEST.md).

## Changes being verified

1. One-shot worker calls own capture, timeout, cancellation and descendant
   cleanup. Windows uses a bundled native Job Object supervisor; POSIX uses an
   owned process group. Cleanup failure cannot become a successful answer.
2. The Windows CUA grant path uses a native Job supervisor and a host adapter
   that authenticates the actual daemon through the pinned SDK. The GUI and
   installed smoke share the same factory. Human release requires confirmed
   cleanup of every process in the Job.
3. Installer acceptance binds the source revision and installer hash to probe
   receipts, then verifies uninstall removes the disposable app and resources.
4. A separate native job exercises the production-managed pinned worker setup
   and real Windows memory journal. Memory review's public Windows holds remain
   enforced while that candidate is evaluated.

The legacy pilot-contract object is not an active HTTP gate for Windows browser
work. Desktop startup is already enabled on Windows; actual actions and selected
profiles still require their own permissions and device evidence.

## Evidence recorded so far

- Before the new native changes: **5,725 tests passed, zero failed, 252
  environment-gated skips**. The skip count is not native or integration proof.
- Build prerequisite contracts: **15 passed, one native-Windows skip**. Release
  guards: **6 passed**. Managed connector contracts: **19 passed**.
- Source-renderer onboarding: all six restart/recovery scenarios passed, with
  zero renderer page errors and no horizontal overflow at 390 pixels.
- Pinned Mac browser, CUA, PostgreSQL, speech and updater dependencies staged.
  Native Windows compilation, installed acceptance and final artifacts are
  recorded separately when they complete.

### Packaged Mac proof

The refreshed build at `9ec70d19b990e07cc98c5d1cd3e417fdb968ba3a` passes strict
deep signature verification, packaged renderer/startup/shutdown, four compiled
service checks, nine backup UI checks and seven backup-boundary checks. The
390-pixel completed-restore view was inspected; no renderer errors were
recorded. The signed DMG and ZIP and their hashes are preserved under
`outputs/platform-candidate-2026-09-23/mac-9ec70d19/`, with the adjacent package
receipt. This package still requires notarization. An initial service probe
used the wrong resources directory and failed before starting a child; the
corrected invocation passed on the unchanged package, with both receipts kept.

The native Apple Silicon build at `9ec09b6a3ad8fd76015fd3ee5dd10243ef67f0e6`
produced a Developer ID signed DMG and ZIP. Strict deep signature verification,
the packaged renderer/startup/shutdown smoke, and four compiled-service checks
passed. The same package passed nine backup UI checks and seven backup-boundary
checks using fictional data, including cold-bootstrap restore and exact bank
file bytes under a different local key. Desktop and 390-pixel views were
inspected; there were no renderer page errors. These checks use the packaged
Electron 43.4.0 / Node 24.18.1 runtime.

The initial backup UI fixture still used the retired browser onboarding flag.
Its failure is retained; the corrected fixture completes scoped onboarding
through the real API before exercising the unchanged package. This is a fixture
repair, not a product exemption. Mac notarization and another-Mac Gatekeeper
acceptance remain unproven.

### Windows native findings

[Run 35849470076, installer job](https://github.com/EzAuto399/RealBud/actions/runs/35849470076/job/107143448372)
at `9ec70d19b990e07cc98c5d1cd3e417fdb968ba3a` passed native launcher compilation,
87 focused tests (four platform skips), packaging, installation, all installed
probes and verified uninstall. All nine Windows CUA native cases passed. The
installed GUI factory authenticated two real SDK generations and stopped each
before the next. The installer SHA256 is
`d88b558570b5606058b289ba195a3493c703c7957d4b78fe7184b4b7258914a5`.
Its lifecycle receipt binds the source revision, installer and probe hashes.
This is disposable Windows CI proof, not Windows 11 owner-device acceptance.

The separate managed-runtime job passed all 19 diagnostic controls and 25
bootstrap controls. The original repository attempt then failed when Git
refused to overwrite apparent local changes while selecting the pinned commit.
SSH fell back to a successful HTTPS clone; the final failure was at checkout.
The pinned installer changes `core.autocrlf` only after cloning. A fictional Git
regression reproduces the exact error when CRLF checkout is followed by that
configuration change; an installer-only global config before clone preserves
LF bytes and succeeds. The original offending filenames were not captured.
The production runner now creates a private, temporary Git global config with
`autocrlf=false` before each Windows stage, using Git's documented
[`GIT_CONFIG_GLOBAL` boundary](https://git-scm.com/docs/git-config#Documentation/git-config.txt-GITCONFIGGLOBAL).
The installer's global writes stay in that owned file, which is removed after
completion or failure. User global configuration is neither copied nor changed;
system transport settings remain available. Conflicting inherited command/global
overrides are removed only from the stage environment. Twenty-six focused local
tests pass, including the real Git regression; four native controls await the
next run. Independent review found no remaining blocker, and server typechecking
passes. The exact Windows installer and real journal still require verification
of this correction.

The first candidate run compiled both native launchers and passed the worker
Job Object tests. A fictional C# stdin reader changed Unicode through the
Windows console code page; it now reads raw bytes and also checks all 256 byte
values. The second run passed the launcher fixtures and reached packaging.

[Run 35844973263](https://github.com/EzAuto399/RealBud/actions/runs/35844973263)
built the NSIS and ZIP at `27ab764ddbfeea121604d59560e0df5aff40711a`.
It passed 52 focused process/launcher tests (four platform skips), 31 packaging
fixtures, and nine native diagnostic controls. Installation and verified
uninstall passed. Installed helper acceptance then timed out in speech.
The helper initialized speech and the microphone before checking an already
present stop file; the candidate now checks cancellation first. The third run
passed the native cancellation controls and installed speech check. The original
timeout does not identify which Windows initialization call stalled.

The first three independent managed-worker attempts failed in the actual pinned
`uv` installer stage. A bounded diagnostic replay retained the failure evidence;
it never turns the original failure into a passing result. The source revision
and retained receipts identify each attempt under the local evidence directory.

The third attempt retained the installer's bounded redacted failure tail:
both `uv` download paths failed because nested Windows PowerShell could not
load `Microsoft.PowerShell.Security` for `Get-ExecutionPolicy`. The candidate
now pins the inbox PowerShell 5.1 module directory at the production setup
boundary, matching RealBud's existing privacy subprocess isolation. A native
regression checks incompatible inherited modules and parent/nested module
loading; it runs before managed setup. Microsoft documents this
[PowerShell 7 through Node inheritance behavior](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-7.6#starting-windows-powershell-from-powershell-7).

[Run 35847717417](https://github.com/EzAuto399/RealBud/actions/runs/35847717417)
at `0351f3f5f9acb17826423a2d4650ce0837691311` passed that native regression and
the actual `uv`, Git, Node and system-package stages. It then failed in the
repository stage; its error has not yet been diagnosed. This focused run did
not build an installer. The next diagnostic observes that original repository
attempt once, with bounded redaction before writing and again at the receipt
boundary. It does not replay a repository mutation. Sixteen local diagnostic
controls pass; three Windows controls still require the native run. The native
memory journal has not run yet.

The third package passed the speech cancellation tests and progressed past
installed speech, then the SDK rejected the CUA wrapper's process ID because
it differs from the actual daemon. The Windows adapter now connects through the
SDK's supported transport and validates the real child PID from its owned
supervisor, the host identity, and every pinned metadata version. The helper
reports that identity only after atomic Job assignment and before the driver
runs; the driver cannot write to that control pipe. Normal shutdown succeeds
only after the Job is empty. Forced or abnormal helper exit keeps a recovery
hold instead of reporting successful release. The SDK's pipe authentication and
RealBud's task/account approvals remain intact. Mac uses its existing SDK host
and `exec` grant shim. The fifth run above passed native compilation and
installed SDK acceptance of this correction.

Independent source inspection also found a later setup-order defect: the
reviewed 0.21.2/0.21.3 installers place managed Python inside the repository
directory, while the repository stage parks any existing non-repository
directory. Windows setup now creates the repository before Python. The older
0.20.3/0.21.0 installer hashes were verified too; their repository stages have no
Python dependency, so the common order remains compatible. Two filesystem
regressions failed before this correction and passed after it; 32 focused tests
passed. This does not explain or waive the separate `uv` failure.

Local receipts live under `outputs/platform-candidate-2026-09-23/`. Historical
receipts referenced by the earlier readiness documents remain in the original
checkout; they were not copied into this candidate or promoted to new evidence.

## Remaining acceptance boundaries

Public distribution needs valid Mac notarization and the agreed Windows signing
decision. Device acceptance still covers Windows 11 capture/input, personal
browser profiles and MFA, microphone use, upgrade/data preservation, normal
managed setup through the GUI, and office joining between two computers. No live
account, customer workflow or paid model request is implied by fixture checks.

The rejected `execFile` interception approach remains historical diagnostic
evidence in [Windows readiness](WINDOWS-READINESS-2026-09-23.md); the new containment
implementation is evaluated independently. Microsoft documents the native
cleanup semantics in [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
and the atomic creation attributes in
[UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

Manual handoff checklists: [Windows 11](WINDOWS-INSTALL-ACCEPTANCE.md) and
[macOS Apple Silicon](MACOS-INSTALL-ACCEPTANCE.md).
