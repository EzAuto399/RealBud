# Broad local QA — 23 September 2026

Scope: reusable core, persistence/recovery, local authorization and office isolation, three synthetic workflows, performance, and a fresh Mac package. No real bank, mailbox or customer records were used. Bank scope ends at CSV; REI upload is deferred.

This working-tree evidence started from `fb6cebed63aaed9d81f9112005ac938644d2fa86` plus local fixes; it is not a release or customer acceptance claim. A concurrent session committed the three Windows test-only changes as `e82ea2f067b7aa73d9bdc6e355a9bc4f1f1694c7` while QA was running. The package manifest starts at that newer commit plus local fixes; its before/after content digest matches across 1,284 input files. The installed `/Applications/RealBud.app` was not replaced. Source hashes and individual negative attempts are retained.

## Results

| Check | Result and evidence |
|---|---|
| Broad regression | **5,536 passed, 0 remaining failed, 252 skipped**, 415 files. This is an amended full run: four suites initially could not start because the new onboarding handler was constructed before workspace identity. Moving construction after identity restoration fixed it; all four affected files then passed (121 tests). Not a fresh immutable full run. [Report](regression/README.md), [exact accounting](regression/amended-summary.json). |
| Core HTTP workflows | **245 passed** across five fixture suites; Electron syntax 23 modules, evidence checker 27 tests and release guards 6 tests passed. [Report](regression/README.md). |
| Built-renderer workflows after the chat change | Bank bytes 13, CSV amendment/restart 7, source bills 25 and morning mail 4 assertion groups passed; second-office contract **16/16** passed. [Final renderer report](workflows/post-chat/SUMMARY.md). The later long-history spacing correction has its own visual check. |
| Team/company database integration | Initial 3 files/16 tests plus disjoint expanded 12 files/111 tests: **127 unique PostgreSQL tests passed**, no failures/skips in these selections. Covers joining, separate offices/departments, permissions/revocation, private notes, restart, lost replies and recovery. These are local fixture hosts, not two physical laptops. [Expanded receipt](workflows/company-expanded/runner.json). |
| Local model gateway | **146 tests passed** with fictional upstreams. [Log](gateway/tests.log). This does not prove a new production Modelvia inference request. |
| Configuration recovery | 94 config/session checks passed. Independent before/after probe confirms a malformed settings file is now refused without replacement, and deliberate repair allows a save while preserving other settings. [Before](recovery/config-before.json), [after](recovery/config-after.json), [tests](recovery/config-tests.log). |
| Onboarding persistence | **28 focused tests passed**; six rendered scenarios across eight changed-port starts, no page errors. Completion, interrupted setup, sample profile and recovery state survive the applicable restart paths. [Report](onboarding/README.md). |
| Long-history behavior | **21 focused tests passed**, followed by rendered checks for paging, complete history retention, scroll anchoring, approvals, edited branches and keyboard focus. [After timing/behavior receipt](performance/ui-history-after.json), [final spacing visual receipt](performance/ui-history-visual.json). |
| Fresh Mac package | **Build, strict deep signature verification and packaged smoke passed** (renderer, capabilities, embedded service and shutdown). Version 0.1.19 arm64, signed but not notarized; source digest `618248de93fa456e1c6372850e73fc92e879038d6f23cbe7630af0d63eddc6a7` remained unchanged. [Receipt](package-result.json), [smoke log](package-smoke.log). |
| Deeper native onboarding/restart | **Unverified.** Two bounded automation attempts failed before UI assertions: the Electron main-process bridge lost its promise; the retry hit an inspector import restriction and a fixture DNS rule that blocked its own loopback origin. These are test-harness failures, not reproduced onboarding defects. Both negative receipts are retained; owned apps/services and scratch were cleaned. [Native report](native/README.md), [cleanup receipt](native/cleanup-confirmed.json). |

## Reproduced defects and corrections

- Damaged configuration was treated as empty and an ordinary profile save could replace it. Only a genuinely absent file is now fresh; malformed or unreadable files raise `config_recovery_required` and preserve the original bytes. This follows the earlier conversation-store recovery fix.
- Welcome completion depended on browser origin storage and repeated after the local service changed ports. It now persists privately per workspace/member, with revision checks and separate incomplete/recovery states. A restored office contact is preserved. This preference intentionally is not business backup data.
- Disconnect swallowed a failed model-access withdrawal, then discarded recovery records and reported success. The failure now propagates; records remain available for a repaired retry. Focused worker/link regression: 52 passed. No live link or key was changed during tests.
- The 10,000-message rendered history stress case exposed severe UI work despite fast local HTTP. Chat now initially renders the newest 200 messages, with explicit loading of earlier history; unresolved decisions, errors and active edit/version targets remain reachable. Request versions are indexed once rather than scanning the entire history per message. Full history remains in memory and on disk. Initial observation: draft input 4,723 ms, screen switch 23,352 ms, 285,225 DOM nodes. Retest: **37 ms input, 132 ms screen switch, 6,128 DOM nodes**. Initial render fell from 4,980 to 1,111 ms; sampled browser JS heap fell from 194.3 to 33.3 MiB. [Before](performance/ui-history.json), [after](performance/ui-history-after.json). These are one-run observations with the same fictional dataset, not a performance SLA.

Two outdated workflow harness assertions were corrected to current contracts: one manual mail collection increments the prior scan count exactly once; malformed second-office inbound requests return exact 400 and create no run. UI fixtures now seed explicit scoped onboarding through its API. Initial failures remain in the baseline report.

## Performance observations

These are small samples on this Mac with fictional data and no provider calls; they are not service guarantees or Windows measurements.

| Dataset | Observation |
|---|---|
| 26 / 106 / 506 / 996 properties | Desk read p95: **3.73 / 8.74 / 32.56 / 56.26 ms**. Every saved book survived actual service restart. |
| 996-property CSV | Preview **1,121 ms**, import **1,381 ms**. Initial bulk intake itself took **9,509 ms**; this is distinct from ordinary desk reads. |
| 100-message active history | HTTP history p95 **4.74 ms**. |
| 50 tasks, 100 messages each | Active-history HTTP p95 **5.97 ms**; inactive tasks are not all returned in that response. |
| 10,000-message active history, about 11 MB | HTTP p95 **42.46 ms** serial / **207.61 ms** with four concurrent reads; health p95 under that load **101.46 ms**; sampled server RSS after load **308.59 MiB**. History and onboarding survived restart. |

[Scale receipt](performance/scale/receipt.json), [history receipt](performance/history.json). HTTP timing includes body download and parsing; it does not measure renderer paint or model latency. Server startup across these runs was roughly 0.5–1.7 seconds; tests are warm-machine observations, not clean-install timings.

## Remaining acceptance boundaries

- Real Commonwealth Bank sign-in/MFA and CSV export are still owner acceptance. ANZ needs its own bank-specific run. No real email/bill/calendar or morning-priority integration is claimed.
- The owner should complete onboarding in the final native Mac app, quit/reopen it, and confirm completion/profile persist. Browser restart fixtures passed; the deeper native automation did not reach this assertion. Packaged startup smoke is a separate passed check.
- The separate [own-bank preflight](../own-bank-qa-2026-09-23/README.md) found live Modelvia health/readiness and approved routes, but no active project/key for this QA installation. A real model request still requires the normal account link/provisioning path.
- [Windows package CI](https://github.com/EzAuto399/RealBud/actions/runs/35806671985) passed at committed `fb6cebed`; it does **not** contain these uncommitted recovery, privacy, onboarding or performance fixes. Native Windows acceptance of the final candidate remains open.
- Corrupt settings/history can stop startup safely; a complete guided repair experience is not supplied by these fixes. Fresh-machine worker setup and generic core/pack separation remain in the [core checkpoint](../../docs/CORE-READINESS-2026-09-23.md).

This QA task did not commit, push or deploy its fixes. A passing fixture, package smoke or signed app is not proof of a completed live workflow.

## Owner Mac QA launcher

Open [launch-qa.command](launch-qa.command) for this exact package. It creates a fresh workspace at `~/Library/Application Support/RealBud QA/broad-qa-2026-09-23`, including separate data, desktop profile, logs and worker profile. It deliberately uses the existing verified supported Hermes 0.21.3 executable; that executable selection disables in-app runtime updates for this QA launcher and does not establish a clean-machine installation path. Normal account linking/model provisioning is still required before assistant execution.
