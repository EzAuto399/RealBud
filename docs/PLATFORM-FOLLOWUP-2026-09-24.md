# Platform follow-up — 24 September 2026

This checkpoint does not establish Windows 11 device acceptance, two physical
computers, live hosted accounts, notarized distribution or customer readiness.
It extends [integration QA](INTEGRATION-QA-2026-09-23.md). Earlier packages,
failed runs and the sealed `689dfc60` installer kit remain unchanged.

## Fresh welcome and private restore

The actual native Mac application compiled from
`689dfc609c7f7fdfa57e756362b00e1b753ef53c` confirms a restore-entry defect.
Fresh welcome hides the backup screen. Completing its sample path writes the
office contact, advancing the sample book from revision 1 to 2; the existing
fresh-workspace restore gate then correctly refuses restoration. Earlier
backup checks entered through a scoped onboarding fixture and did not cover
this visible path. The sealed installer kit therefore has this known limitation.

The native reproduction used real welcome buttons and no onboarding API fixture,
restore attempt or backup mutation. Its receipt intentionally says
`passed: false`, `reproductionMatched: true`, `productAcceptance: false`.
Root inspected the native refusal screenshot and verified cleanup. Evidence:
`outputs/platform-followup-2026-09-24/welcome-restore-before-689dfc60-v3/`;
receipt SHA256 `1aff09a6317a99ef81538cc957617789ce61123ecd1eb867d6fcac5de9c7f1ed`.
Two earlier failed QA attempts remain preserved: an incorrect snapshot-field
assumption and an incorrect post-welcome heading expectation. They are not
product failures or passes.

The source correction adds **Restore a private backup** to both welcome steps.
It saves only the existing scoped recovery stage, then opens the existing
backup card; it does not modify profile, agency or book data or relax restore
admission. Refresh keeps this explicit backup destination. Failed, uncertain,
stale or mismatched saves cannot enter it; pending actions cannot race profile
completion. **67 / 0 / 0** focused tests pass, independently repeated by root.
Exact input hashes and commands:
`outputs/platform-followup-2026-09-24/welcome-private-restore-controls/local-result.json`.
The broader renderer regression passes **1002 / 0 / 0** across 107 files;
`outputs/platform-followup-2026-09-24/renderer-regression.json`. Full app/server
typechecking also passes.
The fresh `4c0c203f` Mac package now passes **12 / 0 / 0** native welcome/restore
groups. Six checkpoints preserve revision 1, restore availability and target
key custody through entry, reload, wrong passphrase, cancellation and preview.
Actual preload/main restart restores the backup, imported office contact, exact
bank bytes, bill/mail history, draft edits and interrupted-work holds. Three
restarts retain target custody and an alternative recovery key. Root inspected
desktop/390 px entry, cancellation and completed-restore screenshots and verified
all owned PIDs exited. Evidence: `welcome-restore-4c0c203f-v2/` under the current
output root. OS keychain/DPAPI is an in-memory AES test fixture, not device proof.

The first new-package attempt is preserved in `welcome-restore-4c0c203f/`.
Its QA assertion expected a specific incorrect-passphrase message; the existing
coordinator deliberately maps status-400 authentication/integrity failures to
`invalid-backup`. Only the assertion was corrected to the exact generic refusal;
all freshness, failed-operation, cancellation and successful-restore checks remain.
No production backup change or timeout increase was made.

A subsequent review found a remaining cancellation lifecycle gap in this sealed
`4c0c203f` build: cancelling the file picker or removing a temporary upload leaves
the saved onboarding stage at recovery, with no route back to ordinary welcome.
Root confirmed the stage bypass and transfer-only cancellation in source. The
successful native cancellation checks above prove temporary-file removal and
preserved freshness, not return-to-welcome. The canonical owner is implementing
a guarded return path and lifecycle tests; that follow-up is not yet verified or
included in these packages. Keep the sealed artifacts unchanged.

## Packaged Mac two-service team proof

The selected `689dfc60` app's own Electron 43.4.0 / Node 24.18.1 executable now
runs both services with its shipped PostgreSQL 16.15. **14 grouped checks,
94 HTTP requests and five service generations pass**, including private
isolation, invitation replay/revocation, shared revision conflicts, ownership
transfer/cancellation, host outage/reconnect, credential rotation and persisted
revocation. All owned processes and listeners were confirmed stopped.

Evidence: `outputs/platform-followup-2026-09-24/mac-689dfc60-electron-team/`;
receipt SHA256 `a1c1e4ea4a90088d3852d93d5037927628e9755e5ebe301f740e06551f0ee0ee`.
The same 14 groups / 94 requests / five orderly generations also pass with the
fresh `4c0c203f` package and its shipped PostgreSQL; root independently checked
all PIDs/listeners again. Evidence: `mac-4c0c203f-electron-team/`. All 424 compiled
server/shared/pack files match the new ZIP byte-for-byte.

This is the packaged executable in Electron-as-Node mode on one Mac. It does
not establish two rendered windows, installed application lifecycle or two
physical devices. Nine runtime-admission/cleanup controls also pass.

## Restricted Windows startup diagnostic

The three recorded office-fixture attempts remain stopped. The last failed
executable was the CLR4/x64 C# QA inspector invoked with `--inspect`, before
PowerShell and before ordinary office service startup. It returned
`3221225794` / `0xC0000142` with no stdout; it succeeded from the elevated
parent. Every observed restricted token already had the user as default owner.
The failing DLL and cause remain unknown.

A distinct, no-office microprobe is prepared to compare native Node, managed
`--version` and managed `--inspect` startup beneath elevated and same-SID
restricted parents, plus a direct restricted managed child. Read-only default
DACL and owned-child handle observations help distinguish hypotheses without
changing ACLs, token defaults or product admission. All launches use the
installed Worker's Job and bounded cleanup. **27 / 0 / 0** portable control
groups pass. Native execution and installer cleanup now pass as a diagnostic. An independent review found that reserved Worker exit 125 could mean failed
Job cleanup; the diagnostic now records and refuses it, with a regression
control preserving the actual DLL-startup status separately. Diagnostic
completion always keeps `officeAcceptance: false`.

Design, limitations and exact source hashes:
`outputs/platform-followup-2026-09-24/restricted-startup-probe/`.
Native [run 35926450799](https://github.com/EzAuto399/RealBud/actions/runs/35926450799)
uses harness `4c0c203f` and the unchanged selected `689dfc60` installer. All three
elevated starts and restricted native Node start pass. Managed version and
inspection beneath restricted Node, plus a direct restricted managed version
child, each fail with `0xC0000142` and no stdout. Thus the query body and extra
Node-parent hop are unnecessary to reproduce failure. Both observed tokens
already had the user as owner. Read-only self-handle opens allow query, VM read,
synchronize and token access; process duplicate-handle access is denied with
Win32 5. The specific DLL and causal relationship remain unproved.

Three installed-worker containment controls pass, all 14 recorded PIDs are gone,
scratch/helper removal and uninstall pass. Root verified four linked receipt
hashes and five committed QA input hashes; `windows-startup-4c0c203f/`. This is
not another unchanged office attempt or a normal-user Windows test.

## Fresh compiled installers

Both new artifacts contain application source
`4c0c203fd5e951c4cd03422b97511546db8d345d`.

| Artifact | Bytes | SHA256 |
|---|---:|---|
| Mac Apple Silicon DMG | 292,832,022 | `8d9a2b43c8e95ef1f65e17cb8b82f7bf138d34608b826628e5d073efc5df6acb` |
| Mac Apple Silicon ZIP | 292,096,182 | `9bd44af8a9939b894b3f941632bf7d2d05a05cd6a54f7bbc34e85ddf74472e68` |
| Windows x64 NSIS | 161,205,156 | `6e0b90c3f062fa0b52afd2dd7a5ef1d6d3ed16cf1cc36bb0d6a3141da6deeccb` |

Mac Developer ID verification, 69 deployment-target checks, renderer, four
service checks, nine backup checks and seven boundary checks pass. Root verified
2,497 package inventory entries, 2,465 app entries and 9,388 tracked source inputs.
Mac notarization was not retried. Evidence: `mac-4c0c203f/`.

Native [Windows installer run 35926437885](https://github.com/EzAuto399/RealBud/actions/runs/35926437885)
passes compilation, NSIS installation, **12 runtime, four service, six backup and
15 memory-primitive checks**, and uninstall. One POSIX-only backup check is
skipped. Root verified the EXE and all four linked receipt hashes. No PE
certificate table is present: this installer is unsigned. The managed-runtime
job was explicitly excluded; its earlier download failures remain open.
Evidence: `windows-4c0c203f-installer/` and `windows-4c0c203f-installed/`.

The fresh test-kit assembler requires both packages to match this exact compiled
source and the successful visible-welcome receipt, with full copy/hash validation.
It adds a focused restore checklist and blank device results. The sealed old
`689dfc60` kit remains preserved with its known welcome limitation. Kit preparation
or CI success does not establish ordinary-user Windows office acceptance.

## Existing proof and remaining gates

The current regression status is available in [draft PR 6](https://github.com/EzAuto399/RealBud/pull/6). Fresh package results above are separately source-bound; do not substitute historical CI for changed-source checks.

Current compiled-source [CI run 35926417555](https://github.com/EzAuto399/RealBud/actions/runs/35926417555)
has passed Mac **5872 / 0 / 281** and Ubuntu **5867 / 0 / 286**. Ubuntu also
passes its separate coverage rerun, PM e2e battery and production UI/server
builds. Three Windows unit/contract shards remain running at this checkpoint.
Root verified the tested merge `cd4d214568eb7cd3a5d709804d625e7d5e92248d` has
the same tree as compiled source `4c0c203f`, and parsed the completed raw logs.
Evidence: `outputs/platform-followup-2026-09-24/ci-4c0c203f/`.
Linux packaging and launch were explicitly skipped, not tested successfully.

The prior full [CI run 35886041597](https://github.com/EzAuto399/RealBud/actions/runs/35886041597)
passes for head `2590ad8160c167b465e5bd45d83b9c3e1a369783`'s tree (use the exact
source binding in its receipt): Mac **5850 / 0 / 281**, Windows shards combined
**5826 / 0 / 305**, Ubuntu **5845 / 0 / 286**. These results predate this
checkpoint's UI and diagnostic changes; skipped tests are not passes. Linux
packaging was explicitly skipped. Evidence:
`outputs/integration-qa-2026-09-23/ci-final-2590ad81/REPORT.md`.

No hosted deployment or authenticated account workflow was performed in this
continuation. The website's local contract/build results remain separately
attributed in integration QA. Windows signing, normal Windows 11 office setup,
Mac notarization, another Mac, real permissions/upgrade, managed-worker download
recovery and two-device acceptance remain open. The recorded download and
notarization failures were not retried; Windows memory review remains held.
