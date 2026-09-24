# Next slice: an enrolled person can approve a disclosed preparation from the portal

Read-only planning, 22 September 2026. This document is the only file changed for this task. It is based on the current local source; it does not claim implementation, deployment, remote approval or customer acceptance. Keep the current skill-history and website-request source freeze intact.

## Outcome and scope

Build an end-to-end **private-workspace remote approval** capability on top of the existing request service. An attended local person explicitly enrolls a particular authenticated portal person, chooses supported preparation operations and approves exactly what preview data may leave the computer. That enrolled person can review the disclosed work on the portal and approve one current preparation while the desktop is running. The desktop remains the execution authority for its current local plan, source and service bindings.

The first implementation should cover a deliberately eligible `prepare-recipe` and `morning-review` through their existing adapters. Each descriptor is remote-reviewable only after its complete relevant review content passes a local disclosure review. Keep local review available for other plans. A redacted title plus an opaque digest is insufficient approval of undisclosed instructions or sources. If either adapter cannot produce a complete permitted review, expose why it needs local review and do not advertise remote approval for it.

Shared-department execution is a separate required adapter slice below. Sending, bank posting, REI submission, arbitrary Ask/shell/browser commands and live ACP approvals remain outside these preparation operations. Neither remote approval nor a billing role activates a schedule, supplies a connector credential or renews service access.

## What the current code actually provides

| Current source | Consequence for this slice |
| --- | --- |
| [Protocol next-stage requirements](../../docs/WEBSITE-COMMAND-PROTOCOL-2026-09-22.md:117) | Explicit person-to-workspace authority and disclosure are already required. Local-only review is the current implementation. |
| [Portal session](../../website/lib/session.ts:56), [OTP callback](../../website/app/auth/callback/route.ts:19), [account gate](../../website/lib/portal-auth.ts:20) | The signed seven-day cookie contains email and expiry. The verified OTP user ID is not retained. Each request looks up a currently enabled billing row by email. This is authentication/account lookup, not a stable workspace-member binding. |
| [Billing identity](../../website/lib/billing-accounts.ts:3) | The provisioned row has `clerkUserId`, company, email and owner/reader role. The field name does not mean the current login runs through Clerk. Provisioning can change email/company under the same key. |
| [Wire protocol](../../shared/website-commands.ts:1) | Protocol 1 deliberately excludes instructions and source data. Its request actor is a display email, and its exact claim has no remote approver/decision fields. Do not loosen the existing parsers or infer a remote decision from a status event. |
| [Local preview](../../server/website-work-adapters.ts:108) | `details` contains full plan description, steps, origins, evidence, site notes, full instruction context, Gmail account ID, agency and mail limits. `binding` contains private recipe identity and authority/source fingerprints. This object must never be uploaded wholesale. |
| [Local decision/claim](../../server/website-requests.ts:329) | A serialized decision saves local intent, reconciles the stable executor key, obtains a 60-second online claim, rechecks local bindings and dispatches the existing adapter. Reuse this path; do not add another worker launcher. |
| [SQL authority/claim](../../website/supabase/migrations/202609220001_installation_commands.sql:44) | Transactional company/installation/grant/request locks, exact JSONB body/envelope matching, current requester checks, immutable claim receipts and expiry already exist. They currently authorize requests and a desktop-local decision, not a person enrolled to approve remotely. |
| [Restore invalidation](../../server/website-requests.ts:87), [backup test](../../server/private-backup-website-requests.test.ts:55) | Restored history is evidence; it cannot control work. Existing report and command credentials are excluded. New remote approval authority must follow that boundary. |
| [Shared work](../../server/company/work-items.ts:1), [department access](../../server/company/departments.ts:82) | Shared-work acceptance is responsibility for a handoff. Department membership/scope access and fenced case claims exist, but neither is currently connected to the website preparation adapters. |

## 1. Stable identity and attended enrollment

Reuse the current sign-in provider and provisioned account identity; do not invent a second identity provider. Add a versioned remote-approval session containing an immutable portal subject, verified authentication-provider subject, authentication time and account identity epoch. Map the stable portal subject explicitly to the provisioned `clerkUserId`. Check that mapping, current enabled state and current company on every sensitive route/RPC. Persist an explicit provider-subject mapping rather than remapping a grant whenever the same email appears. Email/name changes, email reuse, identity reprovisioning or company reassignment cannot inherit a previous person's permission.

Legacy email-only sessions may keep their existing account-view behavior; they must complete a fresh sign-in before enrollment or remote approval. Add a narrow `requirePortalPerson` gate alongside `requireBillingAccount`. It returns server-derived immutable actor identity; no browser-provided actor/company/member ID is authoritative. For the first slice, recipients can be existing explicitly provisioned accounts, including a billing reader if locally enrolled. A reader's billing role gives no approval permission by itself. Supporting employees with no billing-account row requires explicit portal-person provisioning, not giving them a billing role as a workaround.

Use a two-party enrollment challenge:

1. The desktop, under its existing local authenticated session and active command grant, creates and durably saves an enrollment ID and random one-use challenge before publishing its hash. Bind it to installation, command grant/generation, workspace, frozen worker identity and proposed capabilities. Expire it after a short fixed interval, for example ten minutes; rate-limit attempts and never log the secret.
2. A freshly authenticated portal person accepts that challenge. The website records the server-derived stable subject and company as a **pending candidate**, not an active approver. A stolen/displayed challenge alone cannot activate permission.
3. The desktop retrieves the authenticated candidate over its existing fixed-origin outbound transport. The attended person sees the portal person's verified account identity, website company, this exact private workspace, operations, disclosure categories and expiry. They confirm the exact candidate digest locally. Local OS/desktop possession is the authority used by current private-workspace review; do not describe it as a proved company-member identity.
4. Save the local enrollment confirmation/outbox before the website commit. The SQL transaction checks the candidate, grant/install/account state, challenge expiry and exact immutable fields. Identical retries return the original enrollment; changed retries conflict. Poll/receipt reconciliation activates the local record only after the same committed identity returns.

Use a separate `approverGrantId` and generation, subordinate to the existing command grant. Bind the local record to the full frozen worker profile; publish only an opaque worker binding if needed, not its local key/path. Multiple expressly enrolled people can have separate grants. No billing owner or office owner receives a member's private permission implicitly. Disable locally first, then deliver remote revocation; a remote revoke must immediately deny new portal reads/decisions/claims even while the desktop is offline. Commands and remote approvals remain separate toggles.

A reasonable first grant expiry is 30 days with explicit attended renewal. Renewal creates a new generation and invalidates outstanding reviews; it never silently extends old decisions. Treat this as a proposed product default, to be set centrally and covered by boundary tests.

## 2. Separate permission to disclose from permission to execute

Create a typed `RemoteReviewDisclosure` projection owned by each adapter. Do not serialize `WebsiteRequestPreview`, its generic `details`, or its `binding`. Keep the complete local preview and execution binding encrypted locally, with a random review UUID linking them to the disclosed projection.

The disclosure review must say that selected plan/instruction/source configuration will be stored on the RealBud website and shown only to the named enrolled people. Show the exact outgoing content before enabling it. Results, mail content/subjects, customer records, provider secrets, filesystem paths, raw connector account IDs and free-form worker failures remain excluded. Billing status/history readers must not inherit access to the disclosed preview.

For each descriptor, pin an exact disclosure template digest and scope generation:

- `prepare-recipe`: full action steps, capabilities, limits, source classes and relevant instructions/evidence/site notes. A plan whose instructions contain private information requires explicit permission for that complete text or stays local-only. Never use an LLM to decide that redaction preserved execution semantics. Initially disallow remote review of an implicit `read-book`/company source until the adapter can expose a sufficient scoped source description and bind its current revision.
- `morning-review`: a locally reviewed unique mailbox alias/opaque source reference, agency label if approved, timezone, message count/history bounds, sent-mail and attachment-metadata policy, preparation-only effects and full relevant reviewed instructions. Raw Gmail account identifiers stay local. The local binding still pins the exact real account and managed-source permission, including the gateway expected-account precondition. State whether the scan window is relative to dispatch time; do not present an exact fixed date range if the existing adapter actually computes it later.

A changed instruction, plan, source/account, disclosure template, approver set or private-book binding invalidates the remote review. Do not automatically upload changed free text because the operation name is still permitted. Attended approval of a new template enables later per-request remote reviews of that exact template without someone at the computer.

Suggested bounds: dedicated upload route capped at 64 KiB UTF-8, exact typed fields, at most 64 review sections, per-section bound consistent with current 8,000-character UI chunks, and a whole-object limit. Reject overlarge or incomplete review rather than truncate it. Keep the existing 16 KiB command route limit unchanged. Upload one projection once and store replay/audit metadata separately. Proposed retention: disclosed content available until seven days after request terminal state, then delete only that content while retaining its digest, decision/replay IDs and minimal receipt. Revoke read access immediately on grant/account revocation. Storage backups have their own retention; do not promise immediate deletion from all backups.

## 3. Minimal durable additions and API seam

Add a small versioned remote-approval protocol/module rather than changing protocol-1 exact objects in place. Preserve old clients' local-review operation and require explicit remote feature negotiation/enrollment. Use protocol 2 for newly remote-enabled command grants/requests (including stable requester identity and decision mode), with explicit v2 poll/claim parsers; do not retrofit authority into an unchanged protocol-1 envelope. Persist a corresponding local grant/record version gate so a downgraded desktop holds the grant instead of dropping its constraints. Do not allow a new remote-authorized request to fall back to a legacy claim that ignores its approver requirement.

| New durable object | Required immutable identity / binding |
| --- | --- |
| Enrollment challenge | Challenge ID/hash, active command grant/generation, opaque target, candidate subject when claimed, capabilities/disclosure digest, expiry and exact local confirmation digest. |
| Approver grant | ID/generation, stable portal subject + identity epoch, portal company, installation, command grant/generation, workspace/opaque worker binding, permitted descriptors, disclosure policy/template digests, expiry/revocation. Local record also stores true worker/member identity. |
| Remote review | Review ID, request/envelope identity, local preview digest and immutable local review revision, approver grant generation/audience, descriptor/template/source binding digests, complete permitted projection, exact projection digest, creation/expiry and current decision revision. |
| Decision receipt | Stable decision UUID, server-derived subject/identity epoch, exact review ID/digest/revision, choice, grant/generation, server time/expiry, immutable decision body and authoritative receipt. |
| Local acceptance | Exact received decision receipt, associated local review snapshot, accepted decision ID, stable existing claim ID and executor request key. Persist before acknowledging acceptance or claiming. |

Suggested endpoints, finalized through exact shared parsers before parallel implementation:

- Portal `POST /api/account/remote-approvers/accept` and grant revoke/list: authenticated person, exact challenge, same-origin JSON gate. No implicit activation.
- Desktop `POST /api/installations/remote-approvers/{begin,confirm,revoke}`: command credential, active parent grant and exact IDs; reporting token insufficient.
- Desktop `POST /api/installations/command-reviews` publishes an allowed review; portal `GET /api/account/command-reviews/:id` returns it only to its currently authorized audience.
- Portal `POST /api/account/command-reviews/:id/decision`: `{decisionId,expectedReviewRevision,reviewDigest,choice}`; company/subject derived server-side. Refresh after conflict.
- A versioned desktop poll/ack returns decisions and grant revocation state. A versioned claim adds the exact remote decision/review/grant identity. Old claim RPC must reject any request marked as requiring remote authorization; local-only protocol-1 requests keep their existing behavior.

All sensitive responses use no-store caching and bounded errors; request/response bodies and bearer/session material are excluded from logs. New SQL tables/RPCs remain service-role-only with RLS enabled and public/anon/authenticated access revoked. Reuse the existing company transaction/advisory lock convention and a documented installation→parent grant→approver grant→request/review row lock order. Avoid reversed-order paths in decision/revocation/cancel RPCs. SQL, not only Next handlers, checks all exact relationships, identity epochs, current actor state, request/approval/grant expiry, enabled installation and current cancellation.

Compare exact JSONB immutable bodies in SQL and canonicalize digests in shared code, as current claims do. Do not invent a SQL serialization hash that differs from JavaScript. A receipt authenticated by the server/session and delivered over the authenticated command channel is sufficient for this trust model; do not add a homemade cryptographic signature scheme or accept browser assertions as signed authority.

## 4. Decision ordering, stale work and execution

Use one decision slot per current review revision. The first authorized approve or reject to commit under the row lock wins; an identical decision UUID/body retry returns its receipt, including after a lost response. Another actor/body or an old review revision gets a conflict and must refresh. This also arbitrates desktop-local versus portal decisions: invalidate/replace the remote review under the same request CAS before accepting a different local decision. No last-writer-wins overwrite and no two active approvals for the same execution.

An approval receipt alone does not set command phase `accepted`; only the online claim does. The portal should say “Approved, waiting for this computer” until that claim/receipt arrives. Keep request phase separate from remote-review decision state. No worker-supplied text can approve or complete the protocol.

The desktop validates and saves the approval, then enters a factored internal version of the existing `decide`/claim flow. Never call its local HTTP route with fabricated credentials. Reuse `check`, existing encrypted database/CAS, execution lookup, intent, stable request key, short-lived claim, `check` again and synchronous adapter dispatch guard. At claim, SQL rechecks the exact enrolled subject and current identity epoch, approver grant generation/revocation, disclosure/review digest, decision winner, request cancellation and all expiries. A copied receipt or command token without the matching live approval cannot satisfy those checks.

Capture a local authority/mutation epoch around every awaited step. After the claim, repeat member/source/recipe/instruction/service checks and require an unexpired permission before enqueue; existing source and worker admissions remain active during execution. A source rebind must cause zero provider calls on the new account, not a post-read rejection. Status outbox semantics remain unchanged: emit running before a terminal receipt where required, use stable run reference and report only enumerated outcomes.

Keep the existing claim ordering boundary explicit. Cancel/revoke committed before claim prohibits dispatch. After claim, revocation cannot undo already accepted work; the desktop stops new claims and requests safe cancellation when it learns of the change. It cannot promise instantaneous revocation while offline. Shared-office membership has an additional authoritative fence described below.

Crash/lost-reply rules remain exact:

- Retry publication/decision/claim with the same IDs and bodies; never renew a claim's validity by retrying.
- Crash with saved intent but no executor run: show interrupted, invalidate the consumed review, require a fresh preview/decision before another claim under the same logical request.
- Crash after enqueue: lookup and attach the existing run by the saved request key; do not enqueue another run.
- A new review generation cannot reuse a previously approved decision, even when content returns A→B→A or a removed skill/plan is reintroduced with reused numeric revision.
- While offline, expired approval/grant/claim cannot start work. Reconnecting does not revive it automatically.

## 5. Shared-department adapter is an explicit follow-on

Do not add a department ID to the private-workspace adapter and call it complete. Portal company IDs, office database company IDs, private workspace IDs, worker identities and department IDs are different namespaces. An attended/current authenticated company-member proof must bind them explicitly.

Before advertising department execution, implement a typed adapter that:

1. Resolves the stable portal person to an active company member in the intended office authority, verifies current department access/lifecycle and a distinct remote-execution capability granted by the appropriate current authority. Owner/admin status cannot grant access to another member's private sources.
2. Reads the relevant plan/source data through existing company authenticated/authorized-scope operations under that member's authority. Never use a broad service-admin token or a different recipient's private worker because a website owner selected their computer.
3. Pins office/member identity, department/scope revision, source/data generation, plan/instruction digest, assigned executor identity and the relevant durable case/request key. An accepted shared-work handoff supplies responsibility, not execution approval.
4. Obtains/reconciles the existing durable case claim and fencing token, checks membership/scope and claim validity at source acquisition and every result write, and writes shared results only to the authorized department. Revoked membership, removed scope access, retired department, ownership transfer or restored office generations fence old claims.
5. Uses stable command→case→run linkage for recovery. An expired lease or missing run with uncertain effects requires existing department recovery, not another worker or a stolen claim. Resolve multi-computer ownership so two installations cannot execute the same department case.

The portal cannot atomically transact with a separate local office database. The portal's claim proves its side of authorization; the company kernel must issue/check its own current scope/fencing authority. Offline/stale membership caches are insufficient. If no appropriate durable scoped delegation/session mechanism exists, that is implementation work and a release gate, not permission to store/replay an ordinary member browser token as a robot credential. Keep department remote approval unavailable until this adapter is verified end to end.

## 6. Restore, migration and retention

Add exact validators and graph checks for new local review/decision records to both private backup formats. Preserve historical request→review→decision→run evidence and immutable digests; exclude challenges, command/report credentials, live approver bindings and execution capabilities. Restore cancels pending approval publication/acceptance outboxes, clears all usable intents and marks records historical/interrupted. It never republishes a private preview or remotely acknowledges an old decision. Require fresh report/command and attended approver enrollment under the destination identity. An unchanged restored workspace UUID does not reactivate a former enrollment.

Keep old v1 request records readable and local-only. New records get explicit version admission; unsupported authority-bearing versions must fail closed in an older application. Current grants do not migrate into approver grants. Preserve replay IDs/terminal receipts within declared capacity limits; dropping old decisions must not make old request IDs executable again.

## Implementation ownership and acceptance

Agree the small canonical protocol/types and threat/race tests first. Then split disjoint ownership: website identity/RPC/routes/portal UI; desktop durable enrollment/review/decision domain; typed adapter disclosure and execution fencing; root integration/desktop UI/backup/full application QA. Read `website/AGENTS.md` and relevant installed Next documentation when implementation begins.

Required proof before enabling the feature:

- Disposable actual PostgreSQL: service-role/RLS restrictions, stable identity and email reassignment, disabled/moved accounts, cross-company/grant/workspace isolation, role-without-grant denial, two approvers, local-versus-remote decision races, exact lost-reply replay, revoked audience reads, cancel/revoke/expiry versus claim and capacity bounds.
- Domain/cold restart: every publication/enrollment/decision/claim/enqueue boundary, exact repeated IDs, expiry without lease renewal, changed plan/instructions/disclosure/member/source, true A→B→A, local disable during awaits, and zero extra source/worker calls.
- Privacy canaries in mail bodies/subjects, account IDs, paths, connector/provider keys, undisclosed instruction sections and worker errors: zero upload/log/status exposure. Complete authorized review and absence of unauthorized review are both asserted.
- Actual Next→desktop→existing executor with fictional sources and two agencies/installations; both enabled adapters; approve/reject/cancel, offline/reconnect, short claim expiry and lost final receipt. A request, login, enrollment challenge or disclosure alone performs no source read/worker call.
- Both encrypted backup versions and destination restore: no usable grants, no restored automatic approval, preserved evidence and fresh enrollment succeeds independently.
- Render portal at mobile/desktop and local enrollment/recovery UI; verify identity/target, exact disclosure, full review, expiry, stale refresh, competing decisions and unknown-outcome wording. Final package/native Windows and macOS proof remain separate gates.

Suggested delivery order: stable person session + attended enrollment; explicit disclosure/template approval; durable remote reviews/decision transactions; existing claim/dispatch integration; privacy/recovery/backup and actual dual-adapter GUI proof. Shared-department execution follows with its real scoped/fenced adapter. Hosted deployment, installed-device commissioning and real-office acceptance remain later authorized gates.
