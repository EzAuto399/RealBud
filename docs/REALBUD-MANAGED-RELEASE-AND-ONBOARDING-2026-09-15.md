# Managed releases and customer onboarding

15 September 2026 · Architecture decision and implementation handoff · Not a deployed portal or release service

## Decision and ownership

Extend the existing [update strategy](REALBUD-UPDATE-STRATEGY-2026-09-14.md), not a second updater. Distribute one approved release set: RealBud desktop/host/companion, exact stock Hermes commit and runtime, CUA executable/SDK/helpers, workflow packs and database/protocol compatibility. Customers choose when a compatible release activates; they do not independently choose upstream engine/driver versions in the supported product. Do not alter their unrelated Hermes installs, browser updater or operating system. Detect unexpected component drift and hold only affected execution pending repair.

Coordinated with the active task **Plan RealBud multi-desktop agents** (01a09daf-87ab-7e60-9ad3-23f8313c4cd6). This task owns this planning document only; the active build task retains runtime/UI/register ownership. Its current 65-task execution register, selective-sharing plan and two-device acceptance plan govern implementation. Requested that it map this work into existing N12/R04–R06 lifecycle/release work and report remaining ownership/gaps.

## Current evidence, not assumptions

- `server/hermes-pin.ts`, `hermes-releases.ts`, `hermes-update.ts` and runtime-selection modules already implement an admitted release list and isolated managed runtime selection. A version-string match alone is not bundle identity proof.
- `scripts/prepare-cua.mjs` currently stages 0.19.3 native assets, checks SDK alignment and pinned archive hashes. Extend this foundation to bundle admission; do not add a floating installer.
- `electron/updater.mjs` uses electron-updater with automatic download and install-on-quit disabled. `electron-builder.yml` points at a GitHub release feed and explicitly lacks final Windows signing configuration. A portal login does not secure that existing feed or prove licence enforcement.
- The current goal document records two-Mac synthetic host/join proof but explicitly leaves Windows, installed background services and complete native/workflow acceptance open. Historical memory had less proof; current source/status takes precedence.
- No website repository, deployment host, identity provider or portal domain was selected in this planning pass. Do not silently modify the portfolio website or promise the portal exists.

## Customer journey

1. **Portal: Your setup.** Invite the customer owner to sign in. Show service status, approved Windows x64 download (macOS arm64 only when admitted), a short setup guide, release notes and support contact. No engine terminology in the primary flow. Website identity grants download/account access, not automatic office membership or remote control.
2. **Desktop one: Set up office.** Check supported OS, disk, network and permissions; install owned host/database components through a reversible installer; create the office owner and recovery material. Explain that this computer must be on and reachable for shared work. Closing the window should not stop a successfully installed host service; unattended startup and user-session boundaries must be tested.
3. **Desktop two: Join office.** Use a short-lived, single-use invitation approved by the owner. Authenticate the office host with its pinned identity, enrol the device and sign in as a separate member. Do not expose PostgreSQL to clients or the internet. Do not rely on LAN proximity or an IP address as trust.
4. **Each desktop: Connect this computer.** Keep credentials/browser sessions and native control on that device; request its OS permissions there. Show which computer a job will use. A private member context remains private unless an explicit reviewed result/handoff is shared.
5. **Try the workflow.** Rehearse source-bound CSV references, bills and daily priorities with synthetic/redacted fixtures, then agreed client examples. Kevin demonstrates operation, Stop and recovery. Installed success is not office acceptance.
6. **Updates.** Show “Up to date”, “Update ready”, “Waiting for work to finish”, “Restart needed” or a specific hold. Default to notification/manual safe activation during pilot; offer owner-enabled automatic compatible updates within a maintenance window after recovery is proven. Routine download may happen in the background; active computer jobs cannot be interrupted merely to meet an update time.

The host may coordinate several isolated workers, but each desktop has a device-bound companion and attended computer session. Two desktops must not both control one foreground session. A sleeping/offline host produces a clear paused/unavailable state, not an independent second company database. No mandatory third PC or hosted operational database in the baseline. A cloud download/account portal does not move customer operational data to the cloud.

## Release operator workflow

**Candidate → tested → signed → internal pilot → approved → staged → activated → healthy**, with held/withdrawn/recovery states.

Build immutable artifacts from an exact source commit and lockfile in clean platform-specific CI. Create a release manifest containing release ID/sequence/channel, expiry, OS/architecture, component versions/commits/hashes/sizes, supported host-client protocol ranges, schema/profile versions, required capabilities, migration and rollback rules, release notes and QA receipt digests. Use a signed metadata system with root rotation, freshness and replay protection; do not invent a bespoke signature protocol. Code signing and update-metadata signing are separate controls.

Use protected publishing credentials and reviewer-approved promotion. Upload artifacts first, verify origin/download identity, then atomically promote metadata. Pilot is explicitly opt-in; Auston is not an automatic experimental cohort. Never reuse an artifact URL/version for different bytes. Withdrawal stops new activation and triggers an explicit safe response for already active installations; it must not erase office data.

Proposed scripts/commands below are implementation targets, **not existing runnable commands**:

| Target | Purpose | Required receipt |
|---|---|---|
| `release:check --candidate <manifest>` | Verify pins, provenance, dependency licences, schemas and component compatibility | Exact source/component IDs; every required check pass/fail/not-run |
| `release:qa --platform <target>` | Run isolated integration plus installed platform tests | Platform/hardware, artifact hashes, scenarios and captured failures |
| `release:package --candidate <manifest>` | Build/sign installer and update artifacts | Publisher/signature verification, hashes, install/uninstall/repair proof |
| `release:promote --channel stable` | Recheck evidence and publish approved signed metadata | Human approval, rollout cohort, signed manifest identity |
| `release:withdraw --release <id>` | Stop further admission and communicate recovery policy | Withdrawal record, affected devices, recovery eligibility |

Scripts must exit nonzero on missing mandatory evidence, not only failures. Mocked UI or synthetic source tests cannot satisfy installed Windows or native CUA gates. Existing `pnpm qa`, Hermes update tests, CUA staging/smoke and macOS package checks are ingredients, not a complete release gate. No candidate installer or customer-effecting QA runs as part of this planning task.

## Admission and recovery gates

- Exact stock Hermes ACP/model/file/memory/skill behavior; `HERMES_SAFE_MODE=1` configured-versus-explicit tool isolation; no permission expansion.
- Exact native CUA executable/SDK/helpers; device identity, observe/control/Stop acknowledgement; wrong-device and locked/session-loss failures. Safe local test surface only.
- Both users independently run the three agreed workflow categories with correct source/private scope; no send/pay/sign/statutory work and no duplicate replay after reconnect.
- Host/client same-release and supported mixed-release tests, offline companion reconnect, expired invitation, revoked member, host restart/sleep and bounded host move/recovery.
- Signed Windows x64 clean install, upgrade, repair and recovery on actual Windows; macOS signing/notarization and permission continuity on admitted Mac hardware. Cross-compiling an EXE is not Windows acceptance.
- Invalid signature/hash, expired/replayed feed, tampered cache, unavailable portal/feed, insufficient disk, conflicting updater, interrupted download/activation, still-running worker, failed migration and unavailable rollback target.

The host maintenance controller owns a durable update journal and fences new work. Stage candidates separately, verify before execution, obtain acknowledged Stop and drain active effects, take a consistent backup, then activate atomically. Never infer Stop from a timeout. Recheck each returning companion before dispatch. The manifest specifies update order; there is no universal “host first” assumption.

Health checks cover actual selected/running identities, schema, membership, worker/driver readiness and safe persistence. Roll back executable selection only when retained release approval and current data compatibility allow it. Never overwrite newer office records with an old snapshot to make rollback appear successful. Hold and forward-repair or perform an explicitly approved restore when migrations cannot be reversed.

## Portal scope and licence separation

Keep the public website; add a small authenticated `/account` area rather than replace the whole site. Portal MVP: customer invitations/sign-in, approved downloads, onboarding checklist, release notes, subscription/invoice status and support request. Admin view: release approval/withdrawal, customer eligibility and minimal device version/health metadata. Remote desktop access, customer files and arbitrary remote command execution are excluded.

Prefer an established authentication service and managed object storage after checking the actual website stack; provider choice is deferred. Use short-lived download authorisation, tenant-scoped access checks, admin MFA and audit logs. No permanent release credentials in the app. The updater consumes signed metadata through machine-scoped, revocable authentication where needed; it cannot depend on a browser login cookie or expiring download link embedded permanently in metadata.

Separate release authenticity from service entitlement. A portal outage must not immediately lock a working office. A proposed signed, cached entitlement lasts 30 days and refreshes daily; stale state triggers contact/review, not automatic punitive lockout. Implement contractual nonpayment notice and cure before operational suspension, retain export/recovery and data, and prevent duplicate AI billing. Cancellation does not authorise data deletion or withdrawal of third-party open-source rights. Confirm entitlement timing against the final contract before shipping it.

The A$150/month includes routine updates and in-scope maintenance; AI usage is separate. It does not buy unrestricted new features, guaranteed uptime or a bespoke portal per client. Keep a shared minimal portal; measure support, signing, hosting and maintenance costs. Review existing distribution licences (including root package MIT declaration) before asserting proprietary software restrictions or repackaging upstream binaries.

## Build order and completion

1. Active build task finishes reliable host/join, private member/device boundaries and installed host lifecycle.
2. Introduce one release manifest/admission gate and integrate all current app/Hermes/CUA update entry points with it. Remove bypasses in the supported production flow; keep explicit development overrides visibly unsupported and unavailable to customer jobs.
3. Add maintenance journal, safe staging/activation, mixed-version negotiation and recovery tests.
4. Complete signed Windows/macOS packaging and installed two-device acceptance.
5. Add portal MVP using the confirmed website stack; wire real downloads to approved releases and onboarding guides.
6. Internal pilot, then agreed Auston installation/training/acceptance. Enable automatic activation only after the recovery gate passes and owner policy is selected.

Revisit hosting/provider decisions after website inspection, release cadence and measured costs. Revisit host topology if uptime or contention cannot meet the agreed workflow needs on desktop one. Customer hardware/platform and website repository remain configuration inputs, not reasons to pause this architecture work.

References: [electron-builder v26 Windows configuration](https://www.electron.build/v26/docs/api/app-builder-lib.interface.windowsconfiguration/) and [TUF security model](https://theupdateframework.io/docs/security/). Consult documentation matching the installed dependency version before implementation; current upstream examples may target a newer major version.

## Confirmed coordination and task mapping

The active build task acknowledged this handoff on 15 September, confirmed no ownership conflict, and retained ownership of its runtime/UI/tests and active register. It identified the current baseline at `outputs/realbud-orchestrated-completion-2026-09-15/` and confirmed Windows installed/updater acceptance and the off-device managed gateway remain open. It will receive this document for register linking; this task does not concurrently edit that register.

| Requirement | Existing contract |
|---|---|
| Version/capability manifest and exact CUA bundle | N01, N06 |
| Safe signed staging, withdrawal, activation and recovery | N12 |
| Set up / Join / Devices / Recovery journeys | U01, U02, U04 |
| Signed Windows and macOS distributions | R04, R05 |
| Installed host/peer, workflow and rollback evidence | R06 |
| Portal identity, downloads, entitlement and managed gateway | Build owner to map into the current integration/service-administration contracts; no invented I-series task IDs |

The portal is supporting distribution infrastructure, not a substitute for the host lifecycle, private member identity or local device permission contracts.
