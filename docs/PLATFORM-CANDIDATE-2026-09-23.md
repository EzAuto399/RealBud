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
