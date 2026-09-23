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
Fresh packaging and actual visible failed/cancelled/successful restore are
separate pending checks, not established by those unit tests.

## Packaged Mac two-service team proof

The selected `689dfc60` app's own Electron 43.4.0 / Node 24.18.1 executable now
runs both services with its shipped PostgreSQL 16.15. **14 grouped checks,
94 HTTP requests and five service generations pass**, including private
isolation, invitation replay/revocation, shared revision conflicts, ownership
transfer/cancellation, host outage/reconnect, credential rotation and persisted
revocation. All owned processes and listeners were confirmed stopped.

Evidence: `outputs/platform-followup-2026-09-24/mac-689dfc60-electron-team/`;
receipt SHA256 `a1c1e4ea4a90088d3852d93d5037927628e9755e5ebe301f740e06551f0ee0ee`.
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
groups pass; native compilation/API execution remains pending. An independent review found that reserved Worker exit 125 could mean failed
Job cleanup; the diagnostic now records and refuses it, with a regression
control preserving the actual DLL-startup status separately. Diagnostic
completion always keeps `officeAcceptance: false`.

Design, limitations and exact source hashes:
`outputs/platform-followup-2026-09-24/restricted-startup-probe/`.
This is not another unchanged office attempt or a normal-user Windows test.

## Existing proof and remaining gates

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
