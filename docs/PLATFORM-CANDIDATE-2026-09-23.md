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
are not supported build targets. See [Windows build and test](WINDOWS-BUILD-AND-TEST.md).

## Changes being verified

1. One-shot worker calls own capture, timeout, cancellation and descendant
   cleanup. Windows uses a bundled native Job Object supervisor; POSIX uses an
   owned process group. Cleanup failure cannot become a successful answer.
2. The Windows CUA grant path uses a real native launcher. The GUI and installed
   smoke share the same launcher factory, preserving arguments and exit codes.
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
present stop file; the candidate now checks cancellation first. Native
verification of that correction remains required. The timeout does not identify
which Windows initialization call stalled.

The independent managed-worker job currently fails in the actual pinned `uv`
installer stage. A bounded diagnostic replay confirms that the stage runs and
returns failure; it does not turn the original failure into a passing result.
The real journal test has not run yet. The source revision and retained failure
receipts identify each attempt under the local evidence directory.

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
