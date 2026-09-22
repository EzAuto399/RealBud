# Website requests, desktop approval and execution receipts

Status: **first private-workspace/local-review feature implemented and locally verified; not deployed**. Updated 22 September 2026. Both operation adapters, command endpoints, tables/RPCs, encrypted local history, both UIs and backup/recovery are implemented; see [implementation and evidence](WEBSITE-REQUESTS-IMPLEMENTATION-2026-09-22.md). Private-workspace remote approval is now implemented in the later checkpoint below; shared-department execution remains required. The original inventory and proposed ownership table are retained as a dated design baseline; canonical current wire shapes are in `shared/website-commands.ts`.

The later [attended enrollment checkpoint](REMOTE-APPROVER-ENROLLMENT-2026-09-22.md) implements the protocol-2 parent, person candidate/confirmation, local typed disclosure consent and revocation recovery. Current enrollment shapes are in `shared/website-remote-approvers.ts`; its SQL migration is `202609220003_remote_approvers.sql`. Enrollment itself does not publish work or approve execution. The later [remote work checkpoint](REMOTE-WORK-2026-09-22.md) implements request/review publication, decisions, online claims, both existing executors and recovery in `shared/website-remote-work.ts`, `server/website-remote-work.ts` and migration `202609220004_remote_work.sql`. The original protocol-1 path remains partitioned from upgraded targets.

The implemented first feature lets an authorized website account owner request one preparation on an opted-in computer, let that workspace's person review the exact local work, and return a durable status to the website. A reporting link, a billing role, a received request and a worker's approval text are not execution authority. Protocol-2 website approval uses an explicitly enrolled person-to-workspace capability, described below. Do not turn the current reporting credential into a general remote API key.

The subsequent [company-member identity checkpoint](COMPANY-PORTAL-BINDING-2026-09-22.md) connects verified portal people to company members through independent online proof redemption and attended member/owner decisions. Its two mapping purposes in `shared/company-portal.ts` and migration `202609220005_company_portal_proofs.sql` grant no execution authority. Company schema `0007`, certificate rotation, restore fencing and actual source/compiled two-database flows are verified at that checkpoint. Department case admission and a separate effect-proof purpose remain to implement.

## Pre-implementation inventory (historical baseline)

Both products are in `/Users/yoda/projects/RealBud`, repository `EzAuto399/RealBud`. The account portal is the `website/` Next application. Its installation backend is Next route handlers plus Supabase tables/RPCs in the same checkout; this audit found no need to locate or change another portal repository. The model/billing gateway remains separate work; commands must not provision or replace it.

| Existing component | Current behavior and boundary |
| --- | --- |
| `server/office-link.ts` | Outbound HTTPS to fixed `https://realbud.app/api/installations/`; rejects redirects, 10-second timeout, five-minute reporting. Own random UUID/token saved before redemption. Private `office-link/link.json`, 0600/0700 plus Windows privacy checks. Report includes only app/worker versions and readiness. Link status never exposes the token. |
| `server/index.ts` `/api/office-link` GET/POST/DELETE and `/api/office-link/report` POST | Local desktop session/origin boundary. Optional website association, independent of local office membership. Link report uses the workspace's frozen worker profile. No inbound website connection or browser-to-localhost bridge. |
| `src/components/you/WebsiteLinkCard.tsx` | Pair, report, disconnect UI; explains reporting-only behavior and separates local collaboration and service access. |
| `website/lib/session.ts`, `portal-auth.ts`, `billing-accounts.ts` | Signed email session; current billing account lookup rejects disabled rows. Roles are `billing_owner` and `billing_reader`; there is no portal workspace-member role. |
| `website/lib/installation-api.ts` | Exact allowed browser origin and JSON requirement for browser mutations; streaming JSON bounded to 4 KiB. Private JSON is `no-store`. |
| `website/app/api/account/installations/route.ts` | Account-scoped inventory GET; owner-only pairing POST and revoke DELETE. Server-derived company/actor sent to RPC. No commands or results. |
| `website/app/api/installations/redeem/route.ts` | Pairing redemption using code, installation UUID and desktop-created token; hash-only persistence upstream. |
| `website/app/api/installations/report/route.ts` | Bearer-authenticated report or device disconnect; no browser session dependency. No command delivery. |
| `website/supabase/migrations/202609200001_installations.sql` | `office_pairings`, `office_installations`; service-role-only grants/RLS; issue/redeem/report/revoke RPCs. Owner/company/disabled-account checks repeated in transactions. Pairing expires after ten minutes; exact id/token replay survives a lost response for the bounded replay window. |
| `website/app/account/installations/installations-panel.tsx` | Account computer cards; minute refresh; ten-minute report freshness. Correctly says a recent report is not proof of current connectivity. No workspace selection, work submission, decision or execution history. |

The installation link saves a portal company ID, but **does not bind a local workspace, company member, department or approved plan**. This is intentional for inventory. Portal company identifiers and local office identifiers are separate namespaces; do not compare them as if the same ID or infer member identity from a matching email/name.

## Reuse rather than a parallel execution system

- `server/workspace-identity.ts` / `companyHost.workspaceIdentity()`: immutable workspace UUID and `workerMemberKey`, restored before serving work. Joining an office does not move the person's private worker. Pin both in the command grant and execution receipt.
- `server/workflow-database.ts`: encrypted records, revision/CAS updates, transactions and stable paging. Store command inbox/decision/delivery receipts here, with exact validators and recovery behavior. Do not add an unrelated queue/database framework.
- `server/routines.ts` (`LoopManager.runNow`) and `/api/mail-workspace/review` in `server/index.ts`: actual manual morning review accepts `requestId` and `expectedRevision`, mints a durable loop receipt and uses the existing mail acquisition/review pipeline. `server/mail-ingestion.ts` and the index wiring already revalidate reviewed agency/account/settings and use cancellation plus authority checks.
- `server/manual-job-request.ts`, `server/job-runs.ts`, `server/job-executor.ts`: exact request keys, immutable job snapshots, preparation-only capabilities, durable execution results and startup interruption handling. The existing `/api/recipes/:id/prepare` path checks pack readiness, current plan revision, approval and active state. Reuse its domain admission and executor through a narrow internal helper; do not fabricate a localhost session token or bypass it with a second worker launcher.
- `server/customer-packs.ts`: approved instruction binding and active-run exclusion. A command preview must capture the relevant pack instruction/plan binding and revalidate it before dispatch.
- `server/company/work-items.ts`, `shared/company-work.ts`, `SharedWorkPanel.tsx`: useful UI/revision/idempotency patterns for reviewed handoff. Their acceptance state is only responsibility for shared work. It is **not** an execution approval, a portal login or permission to read the recipient's private workspace. Do not silently repurpose it.
- Existing ACP approval cards remain local, live worker/tool approvals. Their transient request map cannot serve as a durable website command queue. A website request cannot grant a pending ACP tool approval.
- Both private backup versions validate logical-record kinds and recover execution history. Add new command-record admission, source/run graph checks and restore invalidation there; unknown kinds currently are not an implicit extension mechanism.

## Concrete first vertical feature

Implement two explicit operation adapters under one small protocol:

1. `morning-review`: run the currently reviewed Morning priorities scan/preparation through `LoopManager.runNow('inbound-triage', ...)`. The remote payload cannot supply account IDs, mail queries, arbitrary dates, message limits, model instructions or schedule changes. The local preview shows the exact reviewed source scope, plan and current clock revision.
2. `prepare-recipe`: prepare an existing, locally published, current approved recipe through the existing prepare executor. Only genuinely supported preparation recipes are advertised. Do not advertise an Austin source-acquisition recipe as generic preparation if that would skip its dedicated ingestion adapter. Portal/attended execution, sending, payments, bank posting and arbitrary Ask/shell/browser commands are unavailable through this operation.

Implementing only the protocol types or a portal queue is not completion of this slice. Completion includes actual Next submit, actual outbound desktop retrieval, persisted local preview/decision, existing executor dispatch, persisted status reconciliation and both rendered UIs. If implementation starts with one adapter, `morning-review` gives the strongest end-to-end source-ingestion proof; the second remains an explicit follow-up, not a claim of universal workflow operation.

Preparation results stay in the local workspace. The website displays phase, timestamps, stable run reference and a bounded enumerated outcome; it does not receive mail, subjects, customer names, prompts, drafts, output text, source URLs, local filesystem paths or free-form worker errors. Later selected-result sharing is a separate reviewed data-transfer feature with its own recipient and retention contract.

## Enrollment and separate authority

1. Preserve the existing reporting link unchanged for existing users. Commands are disabled by default.
2. The local person opens Website account, reviews the linked website office and enables **Requests for this workspace**. Show that an account owner can request the selected work and that each request requires a local decision. Let the person choose supported operations/recipes to publish; labels are reviewed outgoing metadata.
3. Persist a separate random command credential and pending enrollment before calling the website, following the existing redemption recovery pattern. Website stores only its hash. Register using the active reporting installation credential with exact retry ID/digest; the response returns the same grant generation. A reporting token alone never authenticates command polling, claims or results.
4. The grant binds installation ID, workspace UUID, immutable worker profile key, local grant generation, allowed operation descriptors and descriptor revisions. Store private authority details locally; publish only opaque workspace/grant/descriptor IDs, reviewed labels and protocol version. A malicious enrollment made with a stolen reporting token cannot make the desktop accept another grant: it uses only its own persisted command credential and approved local grant.
5. Register, mutate, poll and claim transactions all require the installation and portal account to remain active and in the same portal company. The local grant is also checked independently on every approval/dispatch. Relinking or changing workspace/profile never transfers this grant.
6. A billing owner can submit or cancel a request for the published catalog. A billing reader can view the account's bounded request statuses if desired, but cannot submit, approve, claim or revoke capability grants. Submission is not workspace-member authority. Subscription and connector/model authorization remain checked by the existing execution paths; neither this grant nor the reporting link activates service access.

For the first version the approved target is the opted-in person's **private workspace**, displayed clearly. Do not imply that the website can select arbitrary local departments or colleagues. Shared department work needs a real scoped adapter and current company membership authorization. A local office administrator is not automatically the owner of every member's private workspace.

## API and durable data contract

The implemented endpoints follow the contract below; exact canonical parsers live in `shared/website-commands.ts`. Local enrollment, disable, sync and cancellation endpoints also exist. Keep bounded exact-field parsers shared by website and desktop. Do not accept executable text, a URL/path to execute, an arbitrary local endpoint, user-supplied actor identity or a free-form tool list.

| API | Authorization and purpose |
| --- | --- |
| `POST /api/installations/command-grants` | Reporting credential plus desktop-created pending command identity; enroll exact locally enabled catalog. Exact retries recover the same grant. |
| `POST /api/installations/commands/poll` | Separate command credential; grant generation and bounded cursor; returns a page of immutable envelopes plus current revocation/cancellation state. Outbound desktop HTTPS only. |
| `POST /api/installations/commands/ack` | Command credential; CAS phase receipts / exact idempotent event replay. Delivery ack means saved locally, never approved. |
| `POST /api/installations/commands/claim` | Command credential; request digest, grant generation, accepted local decision/preview digest and stable claim ID. Atomic current authority/expiry/cancellation check before one dispatch permission. |
| `GET /api/account/installation-commands` | Signed website session; derive company server-side; account catalog and paged bounded statuses. |
| `POST /api/account/installation-commands` | Browser origin/JSON gate plus current account owner; UUID request key, target grant/catalog descriptor and descriptor revision. RPC rechecks ownership/install/grant. |
| `POST /api/account/installation-commands/:id/cancel` | Same website gate; expected request revision. Cancels before claim or records a cancellation request for running work; never claims a completed effect was undone. |
| Local `GET /api/website-requests` | Current desktop session; inbox/history and transport status. No credential exposure. |
| Local `POST /api/website-requests/:id/preview` | Captures exact local plan/source/authority binding and returns reviewable description plus digest; no dispatch. |
| Local `POST /api/website-requests/:id/decision` | Approve or reject exact current record/preview digest; persist intent before claim/dispatch. Approval never allows arbitrary parameters or auto-enables a schedule. |

The `202609220001_installation_commands.sql` migration adds command grants, immutable requests and ordered request events. Use transactional RPCs and service-role-only grants/RLS like installation pairing. Immutable request fields: protocol version, UUID, installation/grant/generation/opaque workspace target, operation descriptor/revision, server-derived actor reference and display identity, company, created/expires timestamps and canonical payload digest. A reused request ID with different immutable content is a conflict. Bound active requests per grant and per company; return capacity errors rather than silently dropping work.

Local encrypted records retain the complete received envelope, its canonical digest, exact grant/workspace binding, local revision, immutable preview, decision, stable claim ID, execution request key and linked loop/job run ID. Store reporting events/outbox with monotonic event revision; website acknowledges exact event ID/digest. No worker-supplied output may set a protocol phase.

## End-to-end flow and state meaning

1. Portal owner selects an advertised computer/workspace and work descriptor, reviews the effect and submits with a browser-generated request UUID retained across retry. Portal persists `queued`; shows “Waiting for this computer” and expiry, not “Running”.
2. Desktop polls only while open, enrolled and outside backup/restore barriers. Bound page size/body bytes/timeouts, serialize the pump and decisions, reject redirects/off-origin responses. Poll remains independent of worker readiness; it can show a request even when execution is unavailable.
3. Validate all envelope fields, exact target/grant generation, supported protocol/operation and descriptor revision. Save inbox record **before** delivery ack. An identical delivery reuses the row; conflicting duplicate content is held for recovery, never overwritten.
4. Local inbox shows server-authenticated requester label, website office, computer/workspace, requested action, requested/expiry times, and source/plan limitations. Show full current local plan fields, capabilities and limits; for morning review show reviewed Gmail scope and settings locally. Mark why something is blocked. Opening a preview performs no worker call or source read.
5. Reject persists the local decision and queues a rejection receipt. Approve requires the exact current record and preview digest; recheck expiry, local grant, workspace/profile, agency/source/recipe/pack bindings, service entitlement, readiness and recovery barriers. Any changed authority or plan requires a new preview and decision.
6. Save the approval/dispatch intent and stable executor request key before contacting `claim`. Claim RPC serializes against cancel/revoke/expiry and returns a short-lived dispatch permission for this exact request/digest/decision. A lost claim reply is reconciled with the same claim ID, never a new request. A timed-out or expired permission cannot start fresh work offline.
7. Immediately recheck local bindings after awaited admission/claim calls, then enqueue through the existing loop/job mechanism with the saved request key. Never mint a new executor key on retry. Bind the actual loop/job receipt durably. Add origin metadata to command history rather than relabeling unrelated local runs.
8. Existing execution owns source acquisition, worker, approvals, cancellation and business-result persistence. The command service observes authoritative receipts and maps them into bounded status events. Local “needs review”, “partial”, “failed” and “interrupted” remain distinct; receiving a terminal worker message is not proof of saved business results.
9. Send persisted status events through an outbox. Exact event retry is accepted; obsolete event revisions cannot regress portal state. Display both latest confirmed phase and last receipt time. Missing contact after claim is “Outcome not yet confirmed”, not assumed failure/success or permission to rerun.

Use these user-visible phases: `queued`, `delivered` (awaiting local review), `accepted` (dispatch authorized), `running`, `completed`, `needs-review`, `partial`, `failed`, `interrupted`, `rejected`, `cancelled`, `expired`, `stale`. Storage may need an internal `claim-uncertain`/`dispatch-uncertain` marker, but should not conflate transport failure with execution failure. Only valid phase transitions and exact duplicate events are admitted by RPC and local validation.

The claim transaction is the ordering point for remote cancellation/revocation. Before claim, cancellation or revocation wins and prohibits dispatch. After a valid claim, a later website revocation cannot retroactively undo already accepted local preparation. Stop newly delivered/unclaimed work immediately; request cancellation of a running operation through its existing safe mechanism where available, retain effects/evidence, and report the resulting receipt. Do not promise instantaneous cutoff while a computer is offline or imply that cancelling means financial/external effects were reversed.

## Failure and recovery requirements

| Condition | Required result |
| --- | --- |
| Submit reply lost | Same portal request UUID returns the existing immutable request; changed payload conflicts. |
| Delivery ack lost | Envelope redelivered; same local row and decision; no second worker attempt. |
| Claim reply lost | Reconcile same claim ID and digest; no dispatch until accepted authority is confirmed. |
| Crash before executor enqueue | On startup reconcile saved intent and authoritative run lookup. Do not auto-start an old approval. If no run exists, show interrupted request for renewed review/claim under the same logical request. |
| Crash after enqueue but before command row stores run ID | Lookup existing loop/job by saved request key, attach its receipt; no second enqueue attempt with another key. |
| Crash while work runs | Existing execution startup recovery determines interrupted state. Do not turn it into automatic retry; any known/unknown effects remain in local history. |
| Terminal result ack lost | Persisted outbox retries same event; portal eventually reflects the existing run. Worker is not rerun. |
| Plan/settings/source/account/pack changes | Published descriptor becomes stale; pending approval is invalidated. The remote request cannot force the older plan or silently adopt the new one. |
| Member/profile/workspace/office change | Revoke or hold affected grants/requests according to the pinned identity. Never retarget to a new profile or newly joined office. Private workspace continuity alone does not authorize newly available company data. |
| Request expires before claim | Mark expired and deny dispatch. Bounded clock skew uses server timestamps; no renewal by merely receiving again. |
| Disable local requests | Durable local invalidation first, then remote revocation outbox. Stop polling/accepting commands even if website cannot be reached. Preserve local business records/history. |
| Website revoke/disconnect or account disable | RPCs deny new delivery/claim; desktop marks the link/grant revoked when observed. A new link requires new opt-in, not transfer of old approvals. |
| Subscription/source authorization changes | Existing managed-service/source admission denies work independently; no bypass through command claim or website billing role. |
| Disk-full/corrupt history/privacy failure | Hold command execution and preserve records. Do not ack unsaved delivery/decision/result or reset to an empty inbox. |
| Private backup/restore | Snapshot existing command history consistently with its linked execution receipts. Restore outcomes as historical, invalidate all grants and pending approvals, and require fresh command enrollment. Do not restore usable command/report credentials or resume remote work. |
| Capacity/retention reached | Page history, retain immutable replay/terminal receipts and fail explicitly at declared bounds. Do not delete active or uncertain work to make room. A later reviewed archival policy must preserve replay identity. |

## Fully remote approval: original requirements and current scope

The requirements in this section are now implemented and locally verified for private workspaces by the remote-work checkpoint; company-member/department-case scope remains separate work.

Local review is a legitimate first operation mode, but is not the final “operate from the website” experience when nobody is at that computer. Add a separate, explicit **remote approver enrollment** before offering website approval:

- Authenticate a portal person and prove their authority in the relevant workspace through an attended local enrollment or the existing authenticated company-member session. Persist a stable portal-person binding to workspace/member and allowed company/department scope. Email/name matching and billing ownership are insufficient.
- The local person or appropriate current company authority grants specific operation capabilities and data-disclosure scope, with generation/revocation. No grant covers other private members or service administration. Membership/role/department removal invalidates affected grants at authoritative boundaries.
- Desktop publishes an exact, bounded, reviewable execution preview for a submitted request only after that scope permits its disclosure. The portal approver sees the complete relevant action/spec/source limits and target; the approval is bound to its digest, local revision, immutable person binding, expiry and grant generation.
- Persist the signed/authenticated approval event in the portal and delivery/acceptance receipt locally. Desktop revalidates current membership, grant, source/plan, entitlement and expiry before claim/execution. A valid website session is only authentication; the scoped grant supplies authority.
- Remote approval covers only the named typed operation. Sending, banking/REI import/posting and live browser checkpoints need their own reviewed evidence/action adapters and effect-reconciliation contracts. Do not tunnel transient ACP permission requests or arbitrary worker requests to an owner-wide approve button.
- Add explicit revocation, approval replay, competing approver, membership-change, offline expiry and lost-reply tests. Do not enable “Approve remotely” until this stage works end to end. No unattended mode should be implied by first-stage local-review UI.

## File ownership for implementation

Keep these responsibilities disjoint; root owns integration points shared with active pack work.

| Owner responsibility | Files |
| --- | --- |
| Protocol/persistence and transport | New `shared/website-commands.ts`, `server/website-commands.ts`, `server/website-commands.test.ts`; narrowly extend `server/office-link.ts`/`.test.ts` only for safe command grant enrollment and access to authenticated outbound transport. Do not expose saved credentials to renderer code. |
| Website backend and UI | New `website/lib/website-commands.ts` and contract tests; new `website/supabase/migrations/202609220001_installation_commands.sql`; proposed route handlers above; new small request panel under `website/app/account/installations/`; existing installations panel receives its entry point. Read installed Next guides before edits per `website/AGENTS.md`. |
| Desktop review UI | New `src/components/you/WebsiteRequestsCard.tsx` (or separate component imported by current `WebsiteLinkCard.tsx`) with exact preview/decision/history. Reuse existing settings controls, meaningful request states and accessible review patterns. |
| Root integration | `server/index.ts`: enrollment scope callbacks, serialized polling lifecycle, local endpoints, shared admission helpers, existing loop/recipe dispatch and result lookup, recovery/backup barriers, shutdown cancellation. Relevant `shared/contracts.ts` changes only if actual execution provenance needs a new field. Do not reinterpret old receipt trigger values. |
| Recovery/backup | `server/private-workspace-backup.ts`, `server/private-backup-catalog.ts` and relevant restore application/validation helpers: new logical kind validators, graph references, grant exclusion and restore invalidation; focused v1/v2 cold-restore tests. |
| End-to-end proof | New `scripts/qa-website-commands.mjs`; extend or sibling `website/scripts/test-installations-postgres.mjs` for new RPCs with disposable real PostgreSQL. Use the latest actual-desktop/fictional-provider harness pattern; avoid old UI-only route interception as command execution proof. |

This is one vertical capability, not a generic remote task framework. Keep operation dispatch an explicit exhaustive switch over the two admitted adapters. More capabilities are added only with real execution, authority and recovery adapters.

## Verification and acceptance gates

1. Domain: exact schema/size limits, immutable request/preview digest, stale revisions, generation/profile/workspace changes, concurrent approve/reject, conflicting duplicate request, replay after each persisted boundary, invalid server responses and cold restart.
2. SQL: real disposable PostgreSQL tests for owner/reader/company isolation, disabled accounts, active installation/grant, RPC permissions/RLS, enrollment retries, request deduplication, row-lock races, cancel-versus-claim, expiry, phase CAS and late/duplicate outcome events.
3. Execution: actual local server with known fixture sources/Hermes; portal request alone causes zero worker/provider calls; local approved request produces exactly one existing run; repeated requests/restarts/status failures do not create another. Source-scope/profile/entitlement mutations hold work at existing authority boundaries.
4. Application flow: actual Next routes + desktop outbound transport + local database/executor, two agencies and two installations, local-review UI, reject, stale preview, permission/error recovery, and portal status. Test both morning ingestion and actual recipe preparation when each adapter is advertised.
5. Privacy: vendor/provider/command/report/session secrets, mail body/subject, private paths and full worker errors never appear in portal/catalog/results/logs. Explicit reviewed labels are the only free text published initially. Reject unrecognized fields and overlarge/chunked bodies.
6. Backup/restore: v1 and v2 preserve historical request-to-run evidence and replay receipts, invalidate authority, and cannot reactivate a grant/approval on a restored computer.
7. Render desktop and 390px mobile portal/desktop review surfaces; verify target identity, full preview, status distinctions, keyboard focus, confirmation/retry affordances and no browser errors. Build/type/test both apps.
8. Packaged macOS proves packaged desktop transport/worker path separately. Native Windows private credential/record storage, lifecycle and GUI proof remains a Windows gate. No native result may be inferred from POSIX tests.
9. Hosted migration/deployment, installed devices against the deployed website, real account/mail/LLM consent and customer acceptance remain explicit external gates. A fixture run, current model review or unsigned package is not production commissioning.

The original design audit performed no external effects. Subsequent implementation and disposable integration tests are recorded in the implementation receipt, including a bounded Grok development review. No production migration/deployment or live customer operation is proved by this protocol document.
