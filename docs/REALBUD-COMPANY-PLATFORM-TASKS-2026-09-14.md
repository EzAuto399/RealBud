# RealBud company platform: 61 implementation tasks

14 September 2026 · All tasks are **planned**, not completed.

Read the [architecture plan](REALBUD-COMPANY-PLATFORM-PLAN-2026-09-14.md), [native integration contract](REALBUD-NATIVE-INTEGRATIONS-2026-09-14.md) and [update strategy](REALBUD-UPDATE-STRATEGY-2026-09-14.md). The [JSON register](REALBUD-COMPANY-PLATFORM-TASKS-2026-09-14.json) is the structured source. Owners name functional responsibilities; proposed paths and evidence are implementation targets. Task numbering is stable; execution follows dependencies rather than display order.

## M0 — Foundation decisions

### D01 — Freeze the three workflow contracts and the new company/device target without changing the quoted customer agreement.

**Owner:** Product + engineering · **Depends on:** None · **Status:** Planned

**Done when:**

- Map all three outcomes and included assistance to source acquisition, permissions, reviewer, persistence and recovery checks.
- Record host/client OS and architecture, people versus devices, source/account inventory, availability and capacity assumptions; real values remain pending where unknown.

**Affected modules:** `docs/REALBUD-COMPANY-PLATFORM-PLAN-2026-09-14.md`, `docs/AUSTIN-ENGAGEMENT-2026-09-10.json`

**Record:** `scope-matrix.json`, `deployment-worksheet.md`

### D02 — Close the QM reuse choice within a two-engineer-day planning budget.

**Owner:** Backend · **Depends on:** D01 · **Status:** Planned

**Done when:**

- Compare atomic grant and memory revision extraction with small local implementations; record dependency and migration owners.
- Demonstrate concurrent revision rejection, revoke denial and duplicate claim behavior on synthetic data; retain notices if code is copied.
- No QM runtime adoption, Docker install or source fork is a prerequisite; record no-reuse if dependencies outweigh benefit.

**Affected modules:** `proposed: server/company/grants.ts`, `proposed: server/company/knowledge-repository.ts`, `docs/AUSTIN-QM-HOST-ASSESSMENT-2026-09-14.md`

**Record:** `qm-reuse-decision.md`, `qm-primitives-test-results.txt`, `third-party-source-register.json`

### D03 — Select and prove automatically provisioned Postgres plus a confined stock-Hermes worker substrate on Windows and macOS.

**Owner:** Platform + security · **Depends on:** D01 · **Status:** Planned

**Done when:**

- Exercise installation, restart, cancellation and preserved data after failed setup on clean Windows and Mac.
- Native tools, terminal, execute_code and network attempts cannot read another context, host keys, database credentials or raw device endpoints.
- Name the exact native/VM/container boundary, administrative requirements, resource cost and rollback; do not infer confinement from profiles.
- If either host OS fails, mark that host unsupported pending a fix; no claim that the full requested cross-platform host target is complete.

**Affected modules:** `proposed: service/`, `server/worker-bootstrap.ts`, `server/hermes-runtime-selection.ts`, `electron/main.mjs`

**Record:** `host-substrate-decision.md`, `windows-host-spike.json`, `macos-host-spike.json`, `confinement-evidence.json`

### N01 — Define native Composio, Cua, browser, CLI and utility contracts with a versioned platform capability matrix.

**Owner:** Architecture + integrations · **Depends on:** D01 · **Status:** Planned

**Done when:**

- Each operation names source/account requirements, route, exact version/schema, supported OS/architecture, action policy, cancellation, verifier and lifecycle status.
- Separate current 0.19.3 MCP support from newer Cua candidate and Hermes native-wrapper requirements; no discovered capability is executable by default.

**Affected modules:** `proposed: shared/capability-manifest.ts`, `docs/REALBUD-NATIVE-INTEGRATIONS-2026-09-14.md`

**Record:** `native-capability-matrix.json`

### N06 — Admit a complete Cua driver/SDK/manifest combination and select one Hermes computer facade.

**Owner:** Desktop platform + runtime · **Depends on:** N01, D03 · **Status:** Planned

**Done when:**

- Evaluate newer pinned candidate against current baseline; verify official hashes and Windows executable canonical/runtime-path regression.
- Native Hermes computer_use requires at least 0.20 plus required capabilities and is excluded from pinned ACP bundle; prove an actual governed integration or retain brokered MCP.
- Set authoritative admitted driver command/endpoint, disable uncontrolled repair/update and default telemetry; verify every launch path.
- Revalidate semantic/login fields, tool schemas/refusals and native libraries together; preserve complete previous version for rollback.

**Affected modules:** `package.json`, `scripts/prepare-cua.mjs`, `electron/cua-login-check.mjs`, `server/cua-bounded.ts`, `server/drivers/acp/core.ts`

**Record:** `cua-version-admission.json`, `hermes-computer-facade-decision.md`

## M1 — One company and two people

### H01 — Define company, member, session, device, source, job, decision and scope identifiers and authorization contracts.

**Owner:** Backend · **Depends on:** D01 · **Status:** Planned

**Done when:**

- A person may own two devices; device enrolment does not create a new member or grant source/admin rights.
- Every shared record, command and result has an explicit owner/audience and revision.

**Affected modules:** `shared/contracts.ts`, `server/contracts.ts`, `proposed: shared/company.ts`

**Record:** `company-contract-tests.txt`

### H02 — Introduce asynchronous repositories around current data owners without rewriting workflow algorithms.

**Owner:** Storage · **Depends on:** H01 · **Status:** Planned

**Done when:**

- Existing domain behavior runs through repository interfaces; no hidden synchronous global access bypasses the scope boundary.
- A storage failure remains a failure, not an empty store or sample fallback.

**Affected modules:** `server/workflow-database.ts`, `server/store.ts`, `server/job-runs.ts`, `proposed: server/storage/`

**Record:** `repository-contract-tests.txt`

### H03 — Implement PostgreSQL storage, unique occurrence/action keys, scoped queries and transactional updates.

**Owner:** Storage · **Depends on:** H02, D02, D03 · **Status:** Planned

**Done when:**

- Concurrent claims produce one active occurrence; conflicting revisions reject safely.
- App database role cannot bypass scope policies; missing company/scope parameters fail.
- Artifact metadata references protected blobs rather than copying credentials or entire source collections into records.
- Actor/scope context is transaction-local and cleared between pooled requests, including scheduled service actors; interleaved-principal isolation passes.

**Affected modules:** `proposed: server/storage/postgres/`, `proposed: server/storage/migrations/`

**Record:** `postgres-integration-results.txt`, `schema-and-role-review.md`

### H04 — Migrate current JSON/encrypted SQLite and artifact references through one verified cutover.

**Owner:** Storage · **Depends on:** H03 · **Status:** Planned

**Done when:**

- Stopped writers, hash-verified complete backup, strict dry-run, retained IDs/corrections/sample labels and explicit unknown actors.
- Before cutover, a fault leaves the original recoverable; after new-store activation/accepted writes, freeze and recover the latest authority rather than falling back to stale JSON/SQLite. One authority, invalidated legacy grants and no dual-write.

**Affected modules:** `server/store.ts`, `server/desk-store.ts`, `server/workflow-database.ts`, `proposed: server/storage/migrate-office.ts`

**Record:** `migration-fault-matrix.json`, `migration-reconciliation.json`

### H05 — Extract company service lifecycle from Electron windows.

**Owner:** Platform · **Depends on:** H03, D03 · **Status:** Planned

**Done when:**

- Closing both clients keeps the service/clock alive; bounded crash restart reconciles persisted work.
- Service runs with separate permissions from GUI companion; host reboot/unlock and failed startup have visible diagnostics.

**Affected modules:** `electron/main.mjs`, `server/index.ts`, `proposed: service/host-main.ts`

**Record:** `service-lifecycle-windows.json`, `service-lifecycle-macos.json`

### H06 — Add the encrypted company entry point and named-member authentication.

**Owner:** Security + backend · **Depends on:** H01, H03 · **Status:** Planned

**Done when:**

- Existing per-boot loopback/admin endpoint remains private; clients never receive its boot token or database credentials.
- Member roles and exact resource grants enforced on every operation; expiry/revocation invalidates active and queued work.
- Use maintained auth/crypto libraries; rate-limit credential/pairing attempts; recovery does not bypass member authority.

**Affected modules:** `server/session-auth.ts`, `server/index.ts`, `proposed: server/company/auth.ts`, `proposed: server/company/grants.ts`

**Record:** `company-auth-negative-tests.txt`, `transport-review.md`

### H07 — Add expiring one-use invites, separate member sign-in and revocable device keys.

**Owner:** Security + backend · **Depends on:** H06 · **Status:** Planned

**Done when:**

- Wrong-company, wrong-host, reused, expired and guessed invites fail; trust bootstrap verifies the host.
- Device revocation closes dispatch access and invalidates grants; same member can add a second PC without duplicating schedules.
- Invite binds company ID, host public key/certificate, intended authenticated member, nonce and expiry; discovery/link possession alone is insufficient. Verify host-key rotation and recovery.

**Affected modules:** `proposed: server/company/enrollment.ts`, `proposed: server/company/devices.ts`

**Record:** `enrollment-negative-tests.txt`

### H08 — Scope conversations, queues, selections, events, artifacts, search and counters.

**Owner:** Backend + frontend · **Depends on:** H06, H02 · **Status:** Planned

**Done when:**

- Two concurrent private sessions never receive one another's content through API, websocket/event, file, search or logs.
- A deliberately shared case works for both; wrong-ID access fails; active conversation selection belongs to the client/member.
- Legacy conversation ownership is explicitly resolved before exposing migrated data.

**Affected modules:** `server/store.ts`, `server/index.ts`, `src/state/store.tsx`, `proposed: server/company/projections.ts`

**Record:** `private-shared-projection-tests.txt`

### H09 — Persist exact decisions, command attempts and event outbox transactionally.

**Owner:** Backend · **Depends on:** H03, H06 · **Status:** Planned

**Done when:**

- One-use approval binds payload/source/scope/device revisions and expiry; stale or differently scoped decisions fail.
- Restart after an external effect but before receipt yields needs-checking; no blind replay or exactly-once external-effect claim.

**Affected modules:** `server/job-runs.ts`, `server/remote-decisions.ts`, `proposed: server/company/action-attempts.ts`, `proposed: server/company/outbox.ts`

**Record:** `action-finality-fault-matrix.json`

### N02 — Implement the native host Composio adapter and stable company/member/account ownership.

**Owner:** Integrations + security · **Depends on:** H06, H03, N01 · **Status:** Planned

**Done when:**

- Use a pinned official SDK or maintained typed REST; no model-provider replacement. Exact provider/account/auth-config/toolkit versions validated.
- Choose isolated office-owned project credentials or a managed platform connection broker; never distribute one shared platform key to customer hosts, renderers or workers.
- Record supported credential provisioning; no invented automatic provider API or default first/latest-account selection.

**Affected modules:** `server/composio.ts`, `server/composio-gmail.ts`, `proposed: server/composio-client.ts`, `proposed: server/connected-sources.ts`

**Record:** `composio-provider-contract-tests.txt`, `composio-provisioning-decision.md`

## M2 — Isolated Hermes and connected desktops

### W01 — Resolve server-owned member/office worker contexts on every launch.

**Owner:** Runtime · **Depends on:** H01, H06, D03 · **Status:** Planned

**Done when:**

- Ask, Prepare, manual and scheduled runs receive exact company/member/context/source authority.
- No caller-controlled profile path; private native state persists under one exclusive home; no personal Hermes checkout changes.

**Affected modules:** `server/drivers/acp/hermes.ts`, `server/recipe-draft.ts`, `proposed: server/worker-context.ts`

**Record:** `worker-context-tests.txt`

### W02 — Implement selected enforceable worker confinement and scoped input mounting.

**Owner:** Runtime + security · **Depends on:** W01 · **Status:** Planned

**Done when:**

- Direct native file/code/terminal/session-search attempts cannot reach other contexts, host admin data or unrestricted network/device tools.
- Allowed sample files, stock memory/skills and explicitly mounted RealBud tools remain functional.
- No copied browser cookies or broad host mounts; configured MCP/plugins/hooks remain suppressed by supported safe mode.

**Affected modules:** `proposed: service/worker-runner/`, `server/hermes-pack.ts`, `server/drivers/acp/hermes.ts`

**Record:** `worker-confinement-admission.json`

### W03 — Centralize worker lifecycle, exclusive home ownership, fair queues and bounded capacity.

**Owner:** Runtime · **Depends on:** W02, H03 · **Status:** Planned

**Done when:**

- Concurrent Ask/Prepare cannot start independent writers to the same Hermes home.
- Restart resumes or holds exact runs; cancel waits for acknowledged execution stop before releasing ownership.
- Measure idle memory, two-user latency and resource impact; queue overload instead of blocking staff's PC.

**Affected modules:** `server/drivers/acp/core.ts`, `server/procs.ts`, `proposed: server/worker-supervisor.ts`

**Record:** `worker-supervisor-concurrency.json`, `host-capacity-baseline.json`

### W04 — Bind each connection to exact owner/account/resources and operation grants.

**Owner:** Integrations · **Depends on:** H06, W01, N02 · **Status:** Planned

**Done when:**

- Verify OAuth account on completion and dispatch; prevent account substitution and scope expansion.
- Revoke invalidates warm workers, queued jobs and decisions; shared source grant never exposes refresh tokens to workers.

**Affected modules:** `server/composio.ts`, `server/composio-gmail.ts`, `server/connected-apps-broker.ts`, `proposed: server/company/source-grants.ts`

**Record:** `source-account-isolation-tests.txt`

### W05 — Use one execution service for Ask, Run now, routines and future delegated jobs.

**Owner:** Runtime + backend · **Depends on:** W03, W04, H09, N04 · **Status:** Planned

**Done when:**

- All paths use the same source, artifact, approval, budget and result-verification boundary.
- A model answer alone cannot mark an external result saved or financial work completed.

**Affected modules:** `server/job-executor.ts`, `server/recipe-draft.ts`, `server/drivers/acp/core.ts`, `proposed: server/execution-service.ts`

**Record:** `execution-entrypoint-parity-tests.txt`

### C01 — Create an outbound authenticated companion channel with device/session capability reporting.

**Owner:** Desktop platform · **Depends on:** H07, H05, N06 · **Status:** Planned

**Done when:**

- Only enrolled keys connect; signed-in session, OS/architecture/version, control readiness and heartbeat are explicit.
- Helper endpoints stay local; locked/logged-out/offline state cannot report ready.

**Affected modules:** `electron/cua-control.mjs`, `proposed: companion/transport.ts`, `proposed: companion/session-state.ts`

**Record:** `companion-auth-session-tests.txt`

### C02 — Enforce durable per-device GUI leases and action envelopes at actual dispatch.

**Owner:** Backend + desktop · **Depends on:** C01, H09 · **Status:** Planned

**Done when:**

- Check company/actor/job/run/source/account/device/session/epoch/generation/target/payload/expiry before every native operation.
- Reject repeated command IDs, wrong devices, expired/revoked grants and competing controllers; never treat timeout as old-controller death.
- Companion persists accepted intent before native execution and terminal/unknown outcomes after it; restart consults the protected journal before any repeated command.

**Affected modules:** `server/computer-lease.ts`, `proposed: server/computer-broker.ts`, `proposed: companion/action-dispatch.ts`, `proposed: companion/command-journal.ts`

**Record:** `device-fencing-race-tests.txt`

### C03 — Make local Stop, takeover, disconnect and resume observable and safe.

**Owner:** Desktop platform · **Depends on:** C02 · **Status:** Planned

**Done when:**

- Local Stop prevents further actions immediately; host Stop remains pending until acknowledged; asynchronous taskkill completion is observed.
- Lost connection prevents new actions, uncertain in-flight effects require reconciliation, and the next lease waits for stop proof.
- Login/MFA occurs under human control; resume checks same account, app, session and current grant.

**Affected modules:** `server/procs.ts`, `electron/cua.mjs`, `server/cua-human-control.ts`, `proposed: companion/stop-controller.ts`

**Record:** `stop-takeover-disconnect-matrix.json`

### C04 — Replace raw ACP Cua mounting and bind every computer path to the RealBud broker.

**Owner:** Runtime + desktop · **Depends on:** C02, C03, W05 · **Status:** Planned

**Done when:**

- Ask, Prepare and schedules cannot reach raw Cua/native transport outside the job fence.
- Native/code attempts to call helper endpoints directly fail; per-instance Submit cannot authorize pay/sign/notice/send.

**Affected modules:** `server/drivers/acp/core.ts`, `server/portal-fence.ts`, `server/cua-bounded.ts`, `server/portal-handoff.ts`, `proposed: server/computer-broker.ts`

**Record:** `all-computer-routes-inventory.md`, `broker-bypass-negative-tests.txt`

### C05 — Support device-bound file reads and authorized artifact staging/read-back.

**Owner:** Desktop + backend · **Depends on:** C02, H08 · **Status:** Planned

**Done when:**

- A path on PC A never resolves against PC B; approved copies preserve origin, hash, actor and audience.
- Download/preview and upload routes enforce membership; changing input invalidates prepared output approval.

**Affected modules:** `server/local-computer.ts`, `server/import-inspect.ts`, `proposed: companion/artifacts.ts`

**Record:** `cross-device-file-provenance-tests.txt`

### C06 — Verify native Windows app/browser execution through the enrolled companion.

**Owner:** Windows platform · **Depends on:** C04, C05, N07, N08 · **Status:** Planned

**Done when:**

- Exercise supported Windows 11 hardware, target window/account, foreground changes, Excel/file workflow, UAC/lock/logout, Stop and recovery.
- Preserve exact installer/runtime/driver evidence; CI on Windows Server is not Windows 11 acceptance.

**Affected modules:** `electron/cua.mjs`, `scripts/prepare-cua.mjs`, `server/local-computer.ts`, `.github/workflows/package-win.yml`

**Record:** `windows11-companion-acceptance.json`

### C07 — Verify native macOS app/browser execution through the enrolled companion.

**Owner:** macOS platform · **Depends on:** C04, C05, N07, N08 · **Status:** Planned

**Done when:**

- Exercise Accessibility/Screen Recording permission grant/denial/repair, correct app/session, lock/logout, Stop and recovery.
- Use supported hardware and final identity/signing; Mac success does not satisfy Windows cells.

**Affected modules:** `electron/cua.mjs`, `electron/capabilities.cjs`, `build/entitlements.mac.plist`

**Record:** `macos-companion-acceptance.json`

### V01 — Demonstrate two clients, private conversations, one shared bill case and one stoppable Windows read.

**Owner:** Integration · **Depends on:** H04, H05, H08, W05, C06 · **Status:** Planned

**Done when:**

- One company/clock/store; two members cannot read private markers; shared job visible to both permitted people.
- Correct enrolled PC supplies harmless source, isolated Hermes prepares answer, result persists and reloads with verified receipt.
- Wrong-device, revoked grant, disconnect, duplicate request and unknown-outcome paths produce expected holds.

**Affected modules:** `proposed: scripts/qa-company-vertical-slice.mjs`

**Record:** `company-vertical-slice.json`, `company-vertical-slice-recording`

### N03 — Build account-specific native Connect, Complete, Check, Reconnect, Disable and Revoke without an idle Ask dependency.

**Owner:** Integrations + frontend · **Depends on:** N02, W04 · **Status:** Planned

**Done when:**

- Durable actor-bound link intent, exact connection ID, nonce/expiry and independently verified provider principal; forwarded/wrong/duplicate links cannot bind arbitrary accounts.
- Ordinary polling stays LAN-compatible; optional public verifier uses a narrow managed relay when required, not an exposed office API.
- Persist lifecycle across restart; reconnect produces new revision; local denial and actual provider revoke/delete are distinct verified outcomes.
- Connect from both OSs using their browser return path; developer keys/auth-config IDs remain restricted setup details.

**Affected modules:** `src/components/ConnectedAppsCard.tsx`, `server/index.ts`, `server/connection-intent.ts`, `proposed: server/connection-auth.ts`

**Record:** `native-connections-windows-macos.json`, `oauth-binding-negative-tests.json`

### N04 — Enforce exact Composio operation manifests and locked prohibitions before review or dispatch.

**Owner:** Integrations + security · **Depends on:** W04, H09, N01 · **Status:** Planned

**Done when:**

- Unknown/prohibited operations, send-containing batches, generic proxy/workbench and account substitution fail before an Allow decision; all subactions validated.
- Bounded Gmail patterns extend to accepted Calendar/Drive/Docs/Sheets actions, including coverage and permitted attachments.
- Actor/account/grant/payload/toolkit versions and durable attempt IDs recorded; schema drift holds; timeout/cancelled writes require result reconciliation.
- Automatic arbitrary upload/download disabled; approved artifact transfers have exact path/hash/destination verification.

**Affected modules:** `server/connected-apps-broker.ts`, `server/connected-app-operations.ts`, `server/composio-gmail.ts`, `proposed: server/office-app-operations.ts`, `proposed: server/office-app-executor.ts`

**Record:** `composio-dispatch-negative-tests.txt`, `composio-timeout-result-matrix.json`

### N07 — Bind browser utilities to the exact job-owned device, browser, account, window and tab.

**Owner:** Desktop + runtime security · **Depends on:** C04, N01, N06 · **Status:** Planned

**Done when:**

- Existing Chrome/Edge attachment checks ownership and consent; unsupported browser/locale and ambiguous tab return explicit refusal or attended fallback.
- Reconnect invalidates refs/generation; background read/type does not imply supported trusted click/drag/scroll.
- Native Hermes browser_exec, CDP, console, profile and endpoint routes cannot bypass the RealBud broker or access credential-bearing browsers from worker code.

**Affected modules:** `electron/cua.mjs`, `server/drivers/acp/core.ts`, `proposed: companion/browser-broker.ts`

**Record:** `browser-targeting-bypass-tests.json`

### N08 — Implement device-owned browser profile/session persistence with protected metadata and human sign-in.

**Owner:** Desktop + security · **Depends on:** C01, W02, H07 · **Status:** Planned

**Done when:**

- Existing browser retains its cookies; dedicated profile starts with human sign-in. No automatic profile copy, cookie export or cross-person/OS session sync.
- Verify selected browser storage encryption separately from metadata protection; Keychain/DPAPI does not replace worker confinement. No raw secrets in prompts, memory, logs, packs or ordinary backups.
- Detect expiry/logout/account changes; one profile owner; Forget verified locally, provider revocation reported separately; replacement device reauthenticates.
- Suspend screenshots/accessibility/recording during login/MFA; restart/permission-denial/locked-store tests run on both OSs.

**Affected modules:** `proposed: companion/browser-profile-store.ts`, `proposed: companion/session-secrets.ts`, `electron/main.mjs`

**Record:** `browser-session-vault-windows-macos.json`

## M3 — Complete proposal workflows

### F01 — Complete reusable pack installation including dependencies, schemas, scripts and private bindings.

**Owner:** Workflows · **Depends on:** W05, C05, H09 · **Status:** Planned

**Done when:**

- Clean office installs everything required for three outcomes without manual support-file copying.
- Private settings/accounts/samples/live state are distinct; pack export excludes credentials/customer data; update retains bindings/corrections.
- Sample acceptance and exact live cadence activation remain separate.
- Use a capability registry and validated versioned manifest for operator-described or demonstrated new workflow proposals; unsupported operations cannot be activated before adapter/verifier acceptance.

**Affected modules:** `server/workflow-packs.ts`, `pack/workflows/austin-accounts/`, `proposed: server/pack-installation.ts`

**Record:** `clean-office-pack-install.json`

### F02 — Build complete approved mail/calendar acquisition for morning priorities.

**Owner:** Integrations + workflows · **Depends on:** F01, W04, N04, N05 · **Status:** Planned

**Done when:**

- Persist per-member filters, source coverage/cursors and freshness; retain urgent work and incomplete-source warnings.
- No mailbox mutation; retries/pagination do not omit or duplicate threads; private accounts remain isolated.

**Affected modules:** `server/composio-gmail.ts`, `proposed: server/mail-collection.ts`, `proposed: server/morning-preferences.ts`

**Record:** `morning-source-acquisition.json`

### F03 — Connect inbox to invoice evidence and continuing bill cases.

**Owner:** Workflows · **Depends on:** F02, H03 · **Status:** Planned

**Done when:**

- Accepted invoice evidence updates the durable case through typed validators, not by trusting model prose.
- Deduplicate attachment/invoice/source observations; retain corrections and unresolved work across days; reports link original sources.

**Affected modules:** `server/job-executor.ts`, `proposed: server/invoice-intake.ts`, `proposed: server/morning-work.ts`

**Record:** `inbox-invoice-bill-pipeline.json`

### F04 — Complete expected/missing-bill follow-through with current source evidence.

**Owner:** Workflows · **Depends on:** F03 · **Status:** Planned

**Done when:**

- Staff confirms expectations; received/processed/funded/arranged/paid remain separate; stale/ambiguous evidence holds.
- Two authorized members see one shared case with owner/reviewer; independent payment evidence required for paid status.

**Affected modules:** `pack/workflows/austin-accounts/`, `proposed: server/bill-follow-through.ts`

**Record:** `bills-e2e-member-os-matrix.json`

### F05 — Acquire the agreed ANZ export through an authorized session/source.

**Owner:** Desktop + workflows · **Depends on:** F01, C06, C07, N09 · **Status:** Planned

**Done when:**

- Human login/MFA and exact account/format verification; original preserved and hashed before processing.
- Automatic acquisition must pass actual-device acceptance; manual-upload fallback labelled and cannot pass this gate.

**Affected modules:** `server/portal-fence.ts`, `pack/workflows/austin-accounts/`, `proposed: server/bank-export-acquisition.ts`

**Record:** `anz-acquisition-member-os-matrix.json`

### F06 — Produce human-reviewed reference corrections and a verified REI-checkable copy.

**Owner:** Workflows · **Depends on:** F05, H09 · **Status:** Planned

**Done when:**

- Every change reviewed against current batch/original digest; ambiguous candidates held.
- Dates, amounts, row count, row order and all untouched fields match original; saved copy read-back verified.
- Staff confirms actual REI preview/recognition; no autonomous financial import, payment or money movement.

**Affected modules:** `pack/workflows/austin-accounts/`, `proposed: server/bank-reference-review.ts`

**Record:** `anz-reference-invariants.json`, `rei-preview-acceptance.json`

### F07 — Implement scoped Calendar preparation and exact-approved internal entries.

**Owner:** Integrations · **Depends on:** F01, W04, H09, N04 · **Status:** Planned

**Done when:**

- No attendees/invitations/outgoing notifications; current item revision and explicit one-use approval required for edits.
- Persist and read back exact saved result; uncertainty reconciled without duplicate entries.

**Affected modules:** `proposed: server/calendar-preparation.ts`, `server/connected-apps-broker.ts`

**Record:** `calendar-acceptance.json`

### F08 — Deliver scoped file lookup, five templates, new draft copies and summaries.

**Owner:** Integrations + workflows · **Depends on:** F01, W04, H09, N04 · **Status:** Planned

**Done when:**

- Read only approved source tree; write new copies only to accepted output folder; no overwrite/move/delete/permission change.
- Five agreed templates plus on-demand/weekly summary render from granted sources; verify saved outputs and duplicate protection.

**Affected modules:** `proposed: server/drive-drafts.ts`, `proposed: server/work-summaries.ts`, `pack/workflows/austin-accounts/`

**Record:** `file-template-summary-acceptance.json`

### F09 — Enable one company clock with per-member briefs and shared-source occurrence dedupe.

**Owner:** Backend + workflows · **Depends on:** F04, F06, F07, F08, H05 · **Status:** Planned

**Done when:**

- Concurrent manual/scheduled requests produce one shared occurrence; missed-run catch-up is bounded and honest.
- Ready-by accounts for measured collection/runtime budget, timezone/DST, source lateness and host outage; no hidden second clock.
- No automatic live activation; readiness and current source approval required.

**Affected modules:** `server/routines.ts`, `server/job-runs.ts`, `proposed: server/company/scheduler.ts`

**Record:** `company-scheduler-race-recovery.json`, `ready-by-measurement.json`

### F10 — Bind the selected phone continuation route to authenticated member and exact job.

**Owner:** Channels · **Depends on:** H08, H09, F09 · **Status:** Planned

**Done when:**

- Private reply/decision route cannot disclose another member's task; stale or reused approvals fail.
- Phone Stop shows acknowledged/unreachable state; uncertain send receipt is inspected before retry; no tenant route.

**Affected modules:** `server/channels/telegram.ts`, `server/remote-decisions.ts`, `server/human-handoffs.ts`

**Record:** `phone-continuation-member-tests.json`

### N05 — Feed accepted Composio triggers or durable polling into the single RealBud job clock.

**Owner:** Integrations + backend · **Depends on:** N02, N04, H05, H09 · **Status:** Planned

**Done when:**

- Validate raw webhook signature, age, account/company mapping and event ID; persist before acknowledgement and deduplicate out-of-order retries.
- Public webhook receiver is a narrow managed relay; office host connects outbound. Without relay, use explicitly labelled scheduled polling; prototype subscriptions are not production push.
- Account/workflow revocation disables event grants; events trigger fresh source checks, not business action authority; missed events recover through bounded source queries.
- Measure delivery latency and coverage against ready-by requirements; pending work survives unchanged source input.

**Affected modules:** `proposed: server/source-event-inbox.ts`, `proposed: server/source-polling.ts`, `server/routines.ts`

**Record:** `source-events-catchup-tests.json`

### N09 — Deliver Attach, dedicated profile, Continue, Reconnect, Change account, Forget and verified browser file utilities.

**Owner:** Product design + desktop · **Depends on:** N07, N08 · **Status:** Planned

**Done when:**

- Actions work from native UI with clear source/device/account state and recoverable permission errors on both OSs.
- Scoped snapshots/waits/navigation/forms/dialogs and approved downloads/uploads have verifiers; clipboard, all-tab inventory and cookie/profile exports are distinct denied-by-default capabilities.
- Output locations and transfer hashes match intended device; no silent browser switch or duplicate write during fallback.

**Affected modules:** `src/components/DesktopCapabilities.tsx`, `src/components/YouPage.tsx`, `proposed: src/components/BrowserSessionCard.tsx`, `proposed: companion/browser-files.ts`

**Record:** `browser-qol-windows-macos.json`

### N11 — Admit useful Hermes file/code/browser/CLI utilities and deterministic change checks through RealBud.

**Owner:** Runtime + workflows · **Depends on:** W05, N01, C04 · **Status:** Planned

**Done when:**

- Use scoped workrooms, argument arrays, pinned dependencies and output schemas; Windows paths/encoding/newlines and Mac behavior tested.
- Script-only transforms and stable-source checks feed one RealBud clock; pending failures/deadlines still trigger work; no independent cron/gateway.
- Memory/skills remain useful while raw browser_exec/CDP/vault/terminal routes cannot gain credentials or expand source/action authority.
- Process-tree cancellation and saved-result verification pass; native tool availability is checked under actual ACP rather than assumed from profile toolsets.

**Affected modules:** `server/job-executor.ts`, `server/recipe-draft.ts`, `server/hermes-pack.ts`, `proposed: server/utility-runner.ts`

**Record:** `hermes-utility-platform-admission.json`

## M4 — Shared knowledge and cooperation

### K01 — Add private, team/case and company knowledge with grants and provenance.

**Owner:** Backend · **Depends on:** H03, H08, W04 · **Status:** Planned

**Done when:**

- Read/search/edit/revoke share use current scope; entries have author/source/freshness/version/correction links.
- Concurrent edits reject stale revisions; outdated memory cannot override authoritative source or workflow evaluator.
- Revoke ends affected warm sessions and invalidates derived caches/indexes/procedure versions; retained historical evidence has explicit audience/retention.

**Affected modules:** `proposed: server/company/knowledge-repository.ts`, `proposed: server/company/knowledge-broker.ts`

**Record:** `knowledge-scope-revision-tests.txt`

### K02 — Implement bounded typed helper subtasks on shared cases.

**Owner:** Runtime + workflows · **Depends on:** K01, W05, H09 · **Status:** Planned

**Done when:**

- Effective rights intersect job/delegation/recipient grants; no borrowing credentials or approval power.
- Parent/child lineage, output schema, depth/budget/deadline and dedupe enforced; cycles/cancel/partial failure reconcile.
- Start with one helper per parent; no uncontrolled agent chatter or roster UI.

**Affected modules:** `proposed: server/delegated-work.ts`, `proposed: server/company/handoffs.ts`

**Record:** `delegation-boundary-fault-tests.txt`

### K03 — Promote learned procedures through reviewed versions and replay.

**Owner:** Runtime + product · **Depends on:** K01, K02 · **Status:** Planned

**Done when:**

- Private candidate sanitized, replayed on representative cases, approved by owner, published by version and rollback tested.
- Learned content cannot expand tools, source grants, budgets, schedules or locked actions; measure actual benefit.
- Do not persist revocable shared content into private native memory until provenance-based purge/rebuild is proven; ephemeral job contexts and broker references are the initial safe route.

**Affected modules:** `server/hermes-pack.ts`, `proposed: server/procedure-promotion.ts`

**Record:** `procedure-promotion-replay.json`

### N10 — Adapt Hermes HAR-derived API-client ideas into reviewed website-to-CLI connector creation.

**Owner:** Connector engineering + security · **Depends on:** N07, N08, W02, N01 · **Status:** Planned

**Done when:**

- Use exact approved tab/operation capture and sanitize before model/output/persistence; stock scripts and Hermes source stay unmodified.
- Remove secrets in headers, URLs/query/body/response; reject substring-host matches; preserve query parameters; never replay login/MFA.
- Generated typed client references scoped credential handles; exact host/path/method/schema, redirects and private-network access constrained.
- Verify actual read/write semantics, drift/CSRF/idempotency/unknown-result cases and both-OS execution before versioned promotion; no automatic generate-and-run live client.

**Affected modules:** `proposed: server/connector-admission.ts`, `proposed: scripts/sanitize-web-capture.py`, `proposed: pack/connector-fixtures/`

**Record:** `website-cli-admission-fixtures.json`

## M5 — Repeatable setup and delivery

### U01 — Build resumable Set up a company using the existing visual system.

**Owner:** Product design + frontend · **Depends on:** H05, H06, F01, D03, N03 · **Status:** Planned

**Done when:**

- No terminal/database/container instructions in supported flow; dependencies and human OS/account steps clearly separated.
- Restart/resume does not duplicate company/database; three sample outcomes and recovery setup have persisted completion receipts.
- Render/inspect supported desktop window sizes and keyboard accessibility.

**Affected modules:** `src/components/Onboarding.tsx`, `src/components/BudSetupCard.tsx`, `src/components/you/OfficeCard.tsx`

**Record:** `host-onboarding-usability.json`, `host-onboarding-screenshots`

### U02 — Build Join a company and optional local computer permission setup.

**Owner:** Product design + frontend · **Depends on:** H07, H08, C01, N08 · **Status:** Planned

**Done when:**

- Clear company/host verification, member identity and device identity; joining creates no extra clock or model setup by default.
- Expired invitation, wrong host, offline service and denied OS permission offer correct recoverable states.
- New operator completes join and harmless capability test against the provisional five-minute target after download.

**Affected modules:** `src/components/Onboarding.tsx`, `src/state/store.tsx`, `proposed: src/components/JoinCompany.tsx`

**Record:** `join-company-usability.json`, `join-company-screenshots`

### U03 — Show private/shared work, owner/reviewer, device, partial results and acknowledged Stop in existing navigation.

**Owner:** Product design + frontend · **Depends on:** H08, F09, K02, C03 · **Status:** Planned

**Done when:**

- All three capabilities visible where granted; shared job status consistent across clients.
- No private-data leakage in counts/previews; host-offline/late/needs-checking states are truthful; no duplicate UI decision path.

**Affected modules:** `src/components/DeskPage.tsx`, `src/components/ChatView.tsx`, `src/components/RoutinesPage.tsx`, `src/components/desk/JobRunFeed.tsx`

**Record:** `company-work-ui-qa.json`, `company-work-screenshots`

### U04 — Expose People, Devices, Sources and Recovery under You with progressive disclosure.

**Owner:** Product design + frontend · **Depends on:** H07, W04, R01, R02, N03, N09 · **Status:** Planned

**Done when:**

- Owner can inspect/revoke device/member/source grants and see consequences; normal staff have only granted controls.
- Set up/Join/Move/Restore workflows preserve four-place product navigation; implementation settings remain Advanced.

**Affected modules:** `src/components/YouPage.tsx`, `src/components/you/OfficeCard.tsx`, `proposed: src/components/CompanyDevices.tsx`

**Record:** `company-settings-ui-qa.json`

### R01 — Produce consistent encrypted backups of database, artifacts, keys and worker state.

**Owner:** Storage + operations · **Depends on:** H04, K01, W03 · **Status:** Planned

**Done when:**

- Backup captures coherent work/knowledge/pack/runtime metadata and recoverable keys; failure cannot report success.
- Restore on another machine validates referential integrity, hashes, private scope and unresolved state; no live data-dir copying.
- Measure agreed recovery targets and off-device backup age.

**Affected modules:** `proposed: service/backup.ts`, `proposed: scripts/qa-company-restore.mjs`

**Record:** `backup-restore-rehearsal.json`

### R02 — Move or recover the host with old-authority fencing and safe re-enrollment.

**Owner:** Platform + security · **Depends on:** R01, C03, H07 · **Status:** Planned

**Done when:**

- Planned move stops/fences old host; disaster path rotates trust, re-enrolls and pauses activation until old controllable paths are excluded.
- No automatic failover; epoch alone is not split-brain prevention; stale devices/commands cannot resume.
- One company, preserved identities, no duplicate occurrences; uncertain effects held.

**Affected modules:** `proposed: service/host-transfer.ts`, `proposed: companion/host-trust.ts`

**Record:** `host-transfer-partition-tests.json`

### R03 — Measure and cap ordinary-PC load, model usage and helper cost.

**Owner:** Platform + runtime · **Depends on:** W03, F09, K02 · **Status:** Planned

**Done when:**

- Two active members plus normal staff work fit declared resource budget; fair queued overload and disk-pressure holds.
- Cost attributed once to parent/child/member; approved provider identity and refresh ownership preserved.
- Record baseline and scaling limit; no unlimited-desktop or speed claim without measured evidence.

**Affected modules:** `proposed: server/usage-ledger.ts`, `proposed: service/resource-budget.ts`

**Record:** `two-user-load-usage-report.json`

### R04 — Package and sign the complete Windows host/client/companion distribution.

**Owner:** Windows release · **Depends on:** U01, U02, U03, U04, C06, R03, N12 · **Status:** Planned

**Done when:**

- Build exact reviewed source including intended dirty changes; record revision/digests.
- Clean Windows 11 install, service/session separation, permissions, upgrade rollback and preserved user state pass.
- No customer deployment or publication until separate authorized release gate.

**Affected modules:** `electron-builder.yml`, `.github/workflows/package-win.yml`, `scripts/prepare-cua.mjs`, `proposed: service/windows/`

**Record:** `windows-release-manifest.json`, `windows11-clean-install.json`

### R05 — Package and sign/notarize the complete macOS host/client/companion distribution.

**Owner:** macOS release · **Depends on:** U01, U02, U03, U04, C07, R03, N12 · **Status:** Planned

**Done when:**

- Exact reviewed artifact; clean supported Mac install, permissions after update, system/GUI-service separation and rollback pass.
- Verify supported CPU architecture and host restart/unlock behavior; no speculative automatic-login requirement.

**Affected modules:** `electron-builder.yml`, `build/entitlements.mac.plist`, `scripts/notarize-mac.mjs`, `proposed: service/macos/`

**Record:** `macos-release-manifest.json`, `macos-clean-install.json`

### R06 — Run the full member, workflow, host/client OS, revocation and recovery matrix.

**Owner:** QA + security · **Depends on:** R04, R05, K03, F10 · **Status:** Planned

**Done when:**

- All three workflows available to each authorized member from Windows and macOS clients, routing native steps to a compatible enrolled execution device; all four host/client OS pairs. Prove both native adapters with representative supported apps; Windows-only apps remain on Windows.
- Wrong-ID, leaked events, raw MCP bypass, stale decision, duplicate job, unknown external effect, host partition and malicious skill cases.
- Record actual failures and fixes against final artifacts; do not collapse test/build/install/live proof.
- Verify native Composio lifecycle/identity/batch denials, Cua version/permission contracts, exact browser target/session persistence, secret-safe website-to-CLI and dependency retirement on both OSs.
- Verify final signed Windows/Mac update, crash reconciliation, withdrawn candidate/rollback holds, offline eligibility and preservation of current company data/native learning against the accepted maintenance policy.

**Affected modules:** `proposed: scripts/qa-company-platform.mjs`, `docs/REALBUD-COMPANY-PLATFORM-PLAN-2026-09-14.md`

**Record:** `company-platform-acceptance-matrix.json`

### R07 — Complete named-office live acceptance, training and operating handover for agreed expanded scope.

**Owner:** Delivery + customer owner · **Depends on:** R06 · **Status:** Planned

**Done when:**

- Before live access, confirm named source/device/reviewer rights and any required scope variation; prepare all independent work first.
- Observe accepted schedules and all three outcomes with source/result evidence, correction rate, latency and staff review time.
- Deliver configured pack, five templates, account/permission register, backup/restore guide, two training sessions or newly agreed equivalent and agreed observation/check-ins.
- No signoff from synthetic-only or manual bank-upload-only evidence.

**Affected modules:** `proposed: docs/REALBUD-COMPANY-HANDOVER.md`, `docs/AUSTIN-IMPLEMENTATION-AND-CARE-AGREEMENT-DRAFT-2026-09-13.md`

**Record:** `named-office-acceptance.md`, `handover-checklist.json`, `observation-results.json`

### N12 — Implement compatible native-capability updates, durable maintenance recovery and supported-version lifecycle on Windows/macOS.

**Owner:** Release + security · **Depends on:** N04, N06, N09, N10, N11, W03, H05, R01, R02 · **Status:** Planned

**Done when:**

- Track RealBud/Electron/Chromium/Hermes/Cua/browser/Composio versions as tested sets with source/advisory review and retirement policy.
- No fabricated upstream EOL dates; unsupported/vulnerable capability holds only affected work, preserves recovery and never silently weakens protection.
- Upgrade and rollback preserve supported permission identity, session metadata and queued jobs; retired targets/keys/refs cannot resume.
- All native integration/browser/utility gates feed the final clean-install and named-office matrix.
- Automatically discover and stage exact admitted stable bundles; owner-configured idle activation needs no repeated permission. Distinguish upstream, approved, staged and active state; no floating main/latest.
- Use the existing compiled approval catalog or a verified signed compatibility manifest with digests, trusted roots/rotation, expiry, monotonic replay protection, withdrawal and OS/protocol/schema eligibility. Any enabled remote feed must pass these checks.
- Verify resumable downloads; every interrupted Hermes install retry gets a fresh candidate directory. Freeze versions per job and retain bounded viable rollback bundles separately from private state.
- Persist maintenance intent before transitions; pause new affected dispatch, checkpoint work and wait for acknowledged worker/companion settlement. Unknown effects remain held; reconcile selected/running state after crash before dispatch.
- Revalidate approval/withdrawal/freshness before activation and rollback, with explicit offline eligibility. Health failure recovers only to an admissible data/profile-compatible runtime; otherwise hold and forward-repair without restoring stale office data.
- Preserve native memory/skills, supported session metadata and work across updates; verify signed final artifacts and installed update/rollback in R04/R05/R06. No update policy implicitly grants new privileges.

**Affected modules:** `proposed: docs/REALBUD-CAPABILITY-LIFECYCLE.md`, `scripts/qa-hermes-contract.mjs`, `scripts/prepare-cua.mjs`, `docs/REALBUD-UPDATE-STRATEGY-2026-09-14.md`, `server/hermes-update.ts`, `server/hermes-runtime-selection.ts`, `electron/updater.mjs`, `proposed: service/maintenance.ts`

**Record:** `native-lifecycle-acceptance.json`, `update-maintenance-failure-matrix.json`, `signed-admission-and-withdrawal.json`, `installed-update-rollback.json`
