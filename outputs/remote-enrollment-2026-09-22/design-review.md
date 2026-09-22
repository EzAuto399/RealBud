# Protocol 2 enrollment boundary — independent design review

22 September 2026. Read-only review of the current enrollment integration map, `shared/website-commands.ts`, `server/website-requests.ts`, and the installation/command/portal-person SQL migrations. This is a contract recommendation for the requested implementation, not evidence that enrollment or remote execution exists. No production files changed.

## Minimal safe transition using the existing command grant table

Use a new protocol-2 parent grant, new grant UUID, fresh command token, and monotonically advanced local generation. Keep the existing protocol-1 validators exact. Never reinterpret or mutate an existing v1 grant into v2, reuse its token, or change historical request envelopes. The partial unique index must continue to guarantee one active grant for the installation/workspace across both protocols.

Transition under the existing local coordinator/activity barrier:

1. Freeze the exact old grant identity, installation/company/workspace and full current worker authority. Reconcile old requests; resolve/cancel active work and hold upgrade while any potentially executing work is uncertain. An enrollment upgrade must not silently discard an existing accepted execution.
2. Durably disable the old grant locally and retain its exact revoke outbox/token. Complete or reconcile the existing server revoke. A lost response is an exact revoke retry, not permission to publish another grant. Preserve v1 historical records.
3. Persist a version-2 `grant.json` containing a resumable transition identity **before any v2 server effect**. Then save the matching private enrollment state. Cross-file identity/version disagreement holds recovery. A crash after marker but before companion state must have a deterministic transition-resume path; it must never reset to v1.
4. Persist the immutable v2 parent creation intent/token before publication. Repeated begin/status calls reconcile only the same immutable parent spec/token. Verify exact receipt plus current local authority after awaits before recording active parent state.
5. Once upgraded, retain the v2 marker even when disabled/revoked. Current v1 enrollment must explicitly reject it, not interpret it as absent/disabled v1. A companion remote state without a marker also holds; no silent repair that manufactures permission. Older apps already reject a non-v1 root, so do not remove that downgrade gate during ordinary cleanup.

The reporting credential may establish a fresh command parent, as today. It cannot accept a candidate, confirm an approver, retrieve private enrollment state, or replace the command token. Subsequent desktop enrollment operations require the exact v2 command credential and active ancestor identity.

## Complete SQL protocol partition

The current v1 `realbud_submit_command` has no grant protocol check and always writes a protocol-1 envelope. Admitting v2 rows without changing that function creates a direct legacy bypass. Partition the table in the **same migration that admits v2**, with type/column constraints and explicit SQL checks; HTTP parsers alone are insufficient.

- V1 enroll accepts only v1 exact spec and cannot overwrite/revive a v2 ID or active target. Retain a server-side minimum protocol per installation/workspace (or reject when any historical v2 grant exists). The active-workspace index alone stops protecting the target after v2 revocation; an old client/report credential must still be unable to enroll v1 for that target. A new attended installation identity starts independently and inherits no approver authority.
- V1 submit, poll, claim and ack reject a v2 parent. Claim also rejects any non-v1 request/envelope before replay lookup or mutation. A forged protocol-1 body referencing a v2 grant is rejected.
- V1 cancel/revoke/account-revoke must either explicitly reject v2 or be a separately named generic revocation operation with its own current authority contract. Do not accidentally expose cross-version mutation via an unmodified helper or idempotent early-return branch.
- V1 account catalog contains only v1 grants, requests and target references. Query pagination and `hasMore` over that same filtered population; otherwise hidden v2 rows can consume pages or leave an incoherent cursor. No v2 object is downgraded into a v1 response.
- Current `realbud_expire_commands(company)` touches all company requests. Partition it before future v2 requests exist; enrollment-only v2 currently creates no requests. The v1 account read path must not later mutate v2 lifecycle implicitly.
- Keep the legacy authority helper v1-only. Factor common installation/company/current-owner checks beneath separate exact v1/v2 helpers if useful; do not globally relax it to accept either version, which would reopen untouched callers.
- V2 command request submission/claim/execution stays explicitly unavailable until its own decision/review contract is implemented. A v2 parent or enrolled approver is not a preparation request and never enters existing v1 executor dispatch.

Replays remain identity-bound: same UUID plus changed immutable body, generation, token, actor epoch, ancestor or workspace conflicts. Exact historical receipt replay must never resurrect an expired/revoked grant; expose committed history separately from current usability. Expiry never extends on retries. Account/grant/source A→B→A remains stale even if display text and content digest return to an old value.

## Lock order and revocation linearization

Current person assertion takes the global `realbud_portal_people` advisory lock; account mutation triggers take it before row locks. Current command authority takes `commands:<company>` advisory lock, installation row, billing owner SHARE lock, and parent grant row. New operations must not call person assertion after command locks.

For every new accept/confirm/status/revoke effect that uses person identity, use this order:

1. Require READ COMMITTED and acquire the identity advisory lock; assert the exact stable subject/provider/account/company/epoch where applicable.
2. Acquire the company command advisory lock.
3. Lock and revalidate the installation row.
4. Acquire any existing billing-account SHARE locks consistently with command authority, then lock/revalidate the parent grant.
5. Lock challenge/candidate row, then subordinate approver grant row (deterministic UUID order when touching multiple grants).
6. Future review/request/decision rows come after the ancestor locks, in one documented order shared by decision, cancel, revoke and claim.

Use nonlocking lookups only to discover immutable lock keys, then reselect/revalidate under the locks. Token hash, company, installation, workspace, parent generation and current revocation must all still match. Do not allow an arbitrary browser company to choose authoritative lock scope.

Desktop confirm must reassert the saved candidate's current identity in the same transaction as grant creation, even though the endpoint itself authenticates with a command credential. This catches disable/move/reprovision between portal accept and attended confirm. Candidate acceptance binds its exact identity epoch; a fresh identity requires a new challenge/review rather than mutating the existing candidate under an old digest.

Existing v1 routines that never take the identity lock may remain as-is after protocol partition. Do not retrofit a call to identity assertion after they already hold the command lock. Existing installation report/revoke paths only hold an installation row and do not currently lock subordinate grants. If adding synchronous cascading writes there, reorder those paths first to avoid installation→company versus company→installation deadlocks. The smallest consistent approach is to make every v2 authority check reject inactive ancestors; physical subordinate cleanup is secondary and cannot reactivate authority.

Commit ordering defines the result: account/ancestor revoke committed before enrollment confirmation causes denial; confirmation that committed first remains historical but immediately becomes unusable once ancestor/current identity is revoked. The portal can revoke while the computer is offline. The desktop can locally disable immediately and retain a revoke outbox; it must not claim the website knows until reconciliation. No offline cached current-member or person proof substitutes for online SQL checks.

## Two-party identity and disclosure invariants

A challenge publishes only a random secret's hash and bounded allowed enrollment metadata. Browser body supplies secret/challenge IDs; server derives subject/account/company/epoch from a validated v2 person session and rechecks it in the effect transaction. Legacy sessions, billing owner status, and challenge possession alone never activate an approver.

Acceptance creates one pending candidate, not authority. Local review must show the complete verified person identity, company, target workspace/worker, exact selected operations and disclosure policy, and expiry. Confirmation pins the exact reviewed candidate body/digest and local revision, plus full frozen local worker authority. A stale/changed candidate or any local authority change invalidates the checkbox/confirmation. Save exact confirmation intent before HTTP; activate locally only after matching committed receipt and post-await local checks.

Selected descriptor revisions and disclosure-template digests in an enrollment are **inert permission constraints**. They do not themselves prove a disclosure was attended-approved. Before any future work preview publication, the adapter must resolve the exact current typed template, prove its separate local attended approval under the current generation, compare its canonical digest and source binding, and show complete permitted content. Missing/changed template stays local-only. Never upload generic `preview.details`, execution binding, raw account IDs, provider keys, private worker keys, source content or instructions as a side effect of enrollment. Do not advertise `canExecute` or `remoteApprovalReady` solely because the approver is enrolled.

Centralize challenge lifetime, fresh-authentication window and grant expiry. The seven-day cookie lifetime is not an enrollment freshness rule. Check the signed authentication age at portal acceptance and enforce authoritative server expiry at every mutation. Same immutable retry does not renew any deadline. A lost confirmation receipt must be recoverable as committed-but-now-inactive history when necessary, never presented as fresh usable permission.

## Durable failure and rate-limit pitfalls

- Use the same command coordinator and restore/activity barrier for both files and commands. Separate busy flags do not prevent concurrent disable, restore or worker replacement.
- Persist local-disabled state before awaited revoke. Check a mutation/authority epoch around every network await so a late success cannot re-enable a locally revoked or replaced enrollment.
- Preserve immutable replay IDs and revoked generations. Capacity exhaustion returns a hold; deletion of history must not free old IDs for reuse.
- SQL `attempts = attempts + 1` followed by `RAISE` rolls back the counter. Wrong-secret throttling needs a committed bounded denial receipt/result or a separately committed admission mechanism. Browser handler throttling alone is not the database contract. Capacity also bounds historical failed/pending challenges without exposing candidate/private identity to a guessed ID.
- Private credential files remain outside backups. History is explicitly inert on either backup format's restore; no challenge secret, confirmation outbox, usable grant or command token returns. The restored same workspace UUID is not the same authority generation. Destination preflight/restore cleanup must include both marker and companion authority state; failure holds rather than leaving one old live file behind.

## Required focused red/green cases

Actual PostgreSQL: every v1 RPC against v2; downgrade-shaped submit/claim; filtered catalog pagination; competing acceptors; stale identity between accept/confirm; revoke versus confirm; mixed v1 command/identity/account mutation lock contention; replay after expiry/revoke; committed wrong-secret attempt accounting; and separate service-role privileges.

Desktop durable fixtures: crashes between marker/state/publication/confirmation writes; dropped receipts; no automatic v1 overwrite; marker-without-state and state-without-marker; local disable/worker replacement during each await; offline revoke; source/template revisions A→B→A; and both backup restore formats. Every enrollment operation must yield zero provider/source reads, zero worker calls and zero work-preview uploads.

Actual application proof: two fictional agencies/persons, portal accept and attended desktop confirm, full identity/policy review, stale confirmation reset, keyboard/mobile recovery, and bounded unknown-outcome wording. These proofs establish enrollment only; real hosted deployment, live provider identity, remote review/execution and installed Windows/macOS acceptance remain separate gates.
