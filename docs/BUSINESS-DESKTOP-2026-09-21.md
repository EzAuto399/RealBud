# Business desktop review — 21 September 2026

Latest continuation: [memory recovery and private profile provisioning](HERMES-MEMORY-RECOVERY-PROFILE-2026-09-22.md), [held Windows memory journal integration](HERMES-WINDOWS-MEMORY-JOURNAL-2026-09-22.md), [22 September typed conversational memory proposals](HERMES-TYPED-MEMORY-PROPOSALS-2026-09-22.md), [pending Hermes memory review](HERMES-PENDING-MEMORY-REVIEW-2026-09-22.md), [backup/application/package evidence](PRIVATE-BACKUP-V2-COORDINATOR-2026-09-22.md) and [current reusable-core status](REAL-ESTATE-CORE-2026-09-21.md) supersede the older backup-unavailable and lifecycle gaps below. The remainder is the historical 21 September business-desktop checkpoint.

This pass compiles the current Mac arm64 desktop and checks its everyday business controls with fictional people and a disposable PostgreSQL office. It does not deploy, install over `/Applications/RealBud.app`, connect a customer office, use bank accounts or call a model.

## Implemented

- Department access administration under **You → Office → Local office collaboration → Departments and access**. The current office owner creates departments and assigns read-only, read/edit or no access. Reductions require confirmation. Stale edits are rejected and require refreshed state. Ownership changes invalidate the old management view. Department scopes explicitly exclude individually reviewed handoffs.
- Each installation keeps its private Bud/workspace, browser sign-ins and local files. Departments share selected office records; joining one does not move private work or start another computer's agent.
- Offline detachments leave encrypted, append-only receipts. The recovery panel continues to explain after restart that local disconnection does not prove remote access was revoked. Receipt readback contains no host certificate or session credential.
- Service shutdown verifies the current process capability and installation identity, then asks that service to stop itself. A saved PID never authorizes an OS signal. The secret is removed from the server environment before worker launch. Shutdown is idempotent within the process.
- Service controls explain outage uncertainty, show stop impact and cancellation, and require a confirmed resulting state before claiming success. A running legacy or external service without verified control authority remains visible but unmanageable.
- Startup selects an available loopback port without adopting a foreign service, serializes simultaneous start requests, and verifies the process capability after launch.
- Corrected missing `shared/service-identity.mjs` in the Electron ASAR package. The native package smoke checks startup and shuts down its owned disposable service before removing its data.
- Settings now distinguish saved-job exports, office backups and the unavailable complete private-workspace restore. Removed the false automatic 90-day retention and obsolete browser-profile wording.
- Settings controls have explicit accessible names. The document cannot scroll the app shell out of view when focus moves into deep settings; page scroll regions remain independent.

## Verification

The focused business suites passed **149 tests across 14 files**, with real PostgreSQL enabled. These cover department rights, pinned TLS transport, ownership, member revocation, stale edits, backup/recovery, offline departure journals, authenticated service shutdown and client validation. Type checking, UI build and Electron syntax checks passed. The unsigned packaged Mac app passed the native renderer/preload/service startup and shutdown smoke.

The full suite then passed **2,785 tests across 248 files**, with **53 tests in five suites skipped** by their separate environment gates. No skipped test is counted as passed. The final accessible-label and scroll changes are covered by the rebuilt native GUI check, including 390px browser layouts. Seven native/browser journeys passed with no renderer errors.

Native GUI evidence and the final run receipt are stored under `outputs/business-desktop-2026-09-21/`. `scripts/qa-business-desktop.mjs` uses the packaged Electron binary, its compiled server and UI, and a real disposable PostgreSQL database. It creates and changes department permissions through the renderer and checks the persisted database state, including stale-edit recovery. The narrow browser check serves the same packaged assets. Screenshots are fictional examples, not customer acceptance evidence.

The optional `--keep-open` preview is managed by the QA controller: closing its window stops the fixture service and removes the temporary database. It leaves the installed application and real user data alone. Desktop control is paused and model assistance is unavailable in this preview.

## Remaining lifecycle gates

| Area | Current boundary | Required before claiming full business lifecycle support |
| --- | --- | --- |
| Department work | Access administration and protected records API | Department record/work queue UI, department-aware handoffs, rename/archive/retirement |
| Instances | Private workspace per installation; office membership | Device enrollment/revocation and verified remote-command authority; website status is not remote execution |
| Recovery | Office host backup/cutover and local pending-work receipts | Complete private-workspace backup/restore, tested lost-device recovery |
| End of life | Member removal, ownership transfer, local disconnection | Durable office closure, record export/retention decisions and verified credential/key retirement |
| Host availability | Service survives window closure | OS-managed reboot recovery and independent crash supervision for detached service; keep host awake |
| Delivery | Local unsigned Mac package and disposable same-Mac tests | Signed/notarized distribution, physical Windows/Mac and multi-computer acceptance, named-office rollout |

See [OFFICE-LIFECYCLE.md](./OFFICE-LIFECYCLE.md) and [OFFICE-RECOVERY-RUNBOOK.md](./OFFICE-RECOVERY-RUNBOOK.md) for the operating rules. These limits are delivery gates, not claims that the underlying customer workflow has been proven live.
