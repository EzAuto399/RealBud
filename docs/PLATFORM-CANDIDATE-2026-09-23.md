# macOS and Windows candidate — 23 September 2026

This candidate combines the latest local core fixes with native Windows build
preparation. It is prepared in an isolated checkout on
`readiness/mac-windows-2026-09-23`; the existing working checkout is preserved.
It is not a published release or an update-feed change.

## Current handoff

Both final installers contain application source
`0f4edd5f7deff900651251e5889941f4d06e5fa9`. Later documentation changes do not
change the compiled application. The corrected artifacts are the Mac DMG under
`outputs/platform-candidate-2026-09-23/mac-0f4edd5f/` and the Windows EXE under
`outputs/platform-candidate-2026-09-23/windows-eighth-installer/`.

| Proof layer | Current result |
| --- | --- |
| Mac build and packaged execution | Developer ID signature, 69 native deployment-target checks, renderer lifecycle, 4 service, 9 backup UI and 7 backup-boundary checks pass. |
| Windows build and disposable installation | Native x64 compilation, NSIS install, 12 runtime, 4 service, 6 backup and 15 memory-primitive checks, and uninstall pass. One POSIX-only backup check is skipped. |
| Managed worker and held memory journal | Earlier unchanged production setup passed all 12 stages; its journal passed 26 checks, failed in one test fixture and left one unrun. The last two attempts were blocked at download by HTTP 429, including a final retry after a 19-minute cooldown. |
| Full regression CI | Mac and Ubuntu jobs pass at `f6ccae58`; a complete final-candidate Windows result is not established. The standalone Windows privacy probe at `9ec09b6` passed 1,460 checks with 31 skips. These are revision-specific results; follow the draft PR for current checks. |
| Distribution and device acceptance | Mac notarization is blocked by rejected saved credentials. Windows is unsigned. Windows 11 owner-device, another-Mac, live permissions, upgrade and two-computer acceptance are open. |

Use the build guides to reproduce compilation and the manual acceptance
checklists to record the remaining device results. A passing CI installation
does not complete those device checks.

The local handoff is `outputs/platform-candidate-2026-09-23/installer-test-kit/`
and its adjacent `RealBud-0.1.19-installer-test-kit.zip`. It contains the two
installers, both build guides, device checklists, blank acceptance results,
source-bound receipts and SHA256 verification. Its manifest distinguishes the
historical successful setup/journal attempt from all three later download
failures. Neither installer nor update metadata has been publicly published.

## Supported build targets

| Target | Build environment | Distribution status |
| --- | --- | --- |
| macOS 13+ Apple Silicon | Native arm64 Mac, Node 24, pnpm 10.33.0, Xcode tools, RealBud Developer ID | Signing identity available. The saved `realbud-notary` profile was rejected by Apple with HTTP 401 during this task. |
| Windows x64 | Native Windows, Node 24 x64, pnpm 10.33.0, Git, Framework C# compiler and System.Speech | NSIS and ZIP built; installed NSIS checks and uninstall passed. Authenticode signing is not configured. Windows 11 owner-device acceptance remains open. |

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
  Completed native compilation, packaged checks and final artifacts are
  recorded below with their source revisions.

### Packaged Mac proof

The current signed package at `0f4edd5f7deff900651251e5889941f4d06e5fa9`
passes all 69 checked native deployment targets against macOS 13.0, strict deep
signature verification, packaged renderer/startup/shutdown, four compiled-service
checks, nine backup UI checks and seven backup-boundary checks. The completed
390-pixel restore view was inspected; there were no renderer errors. Artifacts
and the adjacent source/check receipt are preserved under
`outputs/platform-candidate-2026-09-23/mac-0f4edd5f/`:

| Artifact | SHA256 |
| --- | --- |
| `RealBud-0.1.19.dmg` | `10b8868ba9eb512f577290b3d7be8ba55678732bd950224d7f9532d599b24776` |
| `RealBud-0.1.19-arm64.zip` | `0c3021c6285ff49224f23f043fa6af53038e2b654db5fdd1ce00a7946855665b` |

This corrects the deployment mismatch below. It remains unnotarized because the
saved Apple credentials were rejected. Native deployment metadata and successful
execution on the build Mac do not establish execution on a physical macOS 13
computer or another Mac's Gatekeeper/permissions acceptance.

A later deployment-target audit found a compatibility defect in the `f6ccae58`
package: its app plist advertised macOS 12, the speech helper required macOS 26,
and the pinned CUA driver/SDK required macOS 13. The speech compiler now targets
arm64 macOS 13 explicitly, and both app and helper declare that minimum. The
packaged smoke inspects native load commands before launching the app; its
negative control rejects the unchanged old package. The fresh package above
passed this additional check; the earlier artifacts are retained as historical
evidence, not handed over as the corrected candidate.

The earlier package at `f6ccae588ba492ff9fe3c270c7b1d232609b1fc6` passes strict
deep signature verification, packaged renderer/startup/shutdown, four compiled
service checks, nine backup UI checks and seven backup-boundary checks. The
390-pixel completed-restore view was inspected, with zero renderer errors.
The same source also passed the full Mac CI job (5,799 tests passed, 281
platform/environment skips) in
[run 35851457484](https://github.com/EzAuto399/RealBud/actions/runs/35851457484).
The Developer ID signed artifacts are preserved under
`outputs/platform-candidate-2026-09-23/mac-f6ccae58/`. Their SHA256 values are:

| Artifact | SHA256 |
| --- | --- |
| `RealBud-0.1.19.dmg` | `3ad75326c8494600e006304b54a77f90a750cf7726ad1c264da8ba747a677082` |
| `RealBud-0.1.19-arm64.zip` | `3460d0758c389d9bc7837fb974bb724f6174a200252259c1b32ee3675b4b9fe5` |

The adjacent package receipt records the input revision and checks. These
artifacts are not notarized; the saved credential failure remains unresolved.
The builds below are retained historical evidence. Their successful execution
on the build Mac does not waive the deployment-target defect found afterward.

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

[Run 35854230714, installer job](https://github.com/EzAuto399/RealBud/actions/runs/35854230714/job/107158811321)
passed at the same final application revision as the Mac package,
`0f4edd5f7deff900651251e5889941f4d06e5fa9`. Installation, all 12 installed-runtime
checks, four compiled-service checks, six backup checks, 15 memory-primitive
checks and verified uninstall passed. The one skipped backup check is POSIX-only.
The installed factory exercised two real CUA generations; native process/control
tests passed 87 cases with four platform skips, and all 31 packaging fixtures
passed. The lifecycle receipt binds the exact source, installer and child probe
hashes. The unsigned installer is 161,202,389 bytes, SHA256
`602bcd3455199b8b39164d124f557b6cf0daece756d1fe190f93bdf36a8eb542`.
Receipts are under `outputs/platform-candidate-2026-09-23/windows-eighth-installed/`.
The workflow's separate managed-runtime job was blocked by HTTP 429, detailed
below; the overall workflow is not reported as green.

[Run 35851518494](https://github.com/EzAuto399/RealBud/actions/runs/35851518494)
at `f6ccae588ba492ff9fe3c270c7b1d232609b1fc6` built the NSIS installer and passed
installation, all installed probes and verified uninstall. The 12 runtime
checks include two real CUA host generations through the installed GUI factory,
worker cancellation and descendant cleanup, speech protocol, SQLite and pinned
native resources. Four compiled-service checks, six backup-boundary checks and
15 held memory-primitive checks passed; one POSIX-only backup check was skipped.
The lifecycle receipt binds all child receipt hashes to the installer and source.
The unsigned installer is 161,202,486 bytes, SHA256
`b706e63b048e4616ab22682ac0df072413aea649436c514bfa72f0d52ac49901`.
Native launcher controls passed 87 tests with four platform skips; packaging
fixtures passed all 31 tests. This remains disposable Windows CI evidence.

The same run passed all 19 native diagnostic
controls and all 30 bootstrap controls, with zero skips. Production-managed
setup completed all 12 private-runtime stages in 270 seconds, including the
repository pin and dependency installation. Its receipt verifies runtime
`345cd2b057a452236de401d3534b8502a7465e8d`, Python 3.11.16 and the reviewed file
hashes. The original repository attempt exited zero with a successful protocol
receipt and no surviving child; it was not replayed.

The first real native journal run passed 26 checks, then failed in creation of
the disposable junction fixture before exercising product refusal. One final
check was not reached. Cleanup completed and reviewed sources remained
unchanged. The original fixture discarded the exit code and stderr details,
so this result does not establish the cause. Its receipt is preserved under
`outputs/platform-candidate-2026-09-23/windows-sixth-memory/`. Public memory
review, proposal and decision holds remain enforced.

The diagnostic-only follow-up at `467a9442d2cf1fbca3a0e8204f3d799b733101e8`
adds fixture progress suppression, bounded exit/stream diagnostics and a verified
real-junction precondition, while continuing to reject nonzero exit or any
remaining stderr. All 14 portable harness controls pass. Its first native retry,
[run 35853206966](https://github.com/EzAuto399/RealBud/actions/runs/35853206966),
failed after 456 ms at setup download, before the journal ran. The original
response status was not retained, so no particular HTTP failure is asserted.
The setup harness now observes the original request's status and body presence
without consuming the response, replacing its error or adding retries. That
observer passed 21 local controls, with three native controls deferred to the
next run below.

[Run 35854230714](https://github.com/EzAuto399/RealBud/actions/runs/35854230714)
at `0f4edd5f7deff900651251e5889941f4d06e5fa9` passed all 24 native diagnostic
controls and all 30 bootstrap controls, with zero skips. Its download observer
then recorded HTTP 429 with a response body at step zero, after 2.637 seconds.
No installer stage or journal test ran in that managed-runtime attempt. This
confirms an upstream rate-limit response for this attempt only; the seventh
attempt's unrecorded HTTP status remains unknown. The current admission file
and all five production memory helpers still hash-match the sixth native
journal receipt. The failed attempt is preserved under
`outputs/platform-candidate-2026-09-23/windows-eighth-memory/`.

[The final bounded retry, run 35856196491](https://github.com/EzAuto399/RealBud/actions/runs/35856196491),
used the same application revision after a 19-minute cooldown. It again received
HTTP 429 with a response body at setup download, after 517 ms; no setup stage or
journal check ran. Its receipt is preserved under
`outputs/platform-candidate-2026-09-23/windows-ninth-memory/`. Attempts stopped
after three consecutive download failures. The assumption that another fresh
runner could obtain the setup script did not hold. This is an external setup
availability blocker, not a passing journal result or a reason to change the
checksum, retry, cleanup or public memory-hold policies.

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
tests passed, including the real Git regression; the next native run passed all
30 controls and actual managed setup, as recorded above. Independent review
found no remaining blocker, and server typechecking passed. The real journal
result is recorded separately from setup success.

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
repository stage; at that point its error was still undiagnosed. This focused
historical run did not build an installer. The subsequent diagnostic observed
the original repository attempt once, with bounded redaction before writing
and again at the receipt boundary, without replaying a repository mutation.
That led to the Git correction and passing setup recorded above. The initially
pending native diagnostic controls and journal have since run; their current
results are recorded above rather than inferred from this earlier attempt.

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
