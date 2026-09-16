# QM reuse decision and implemented company kernel

14 September 2026. D02 bounded decision: **adapt the inspected PostgreSQL semantics in RealBud-owned modules; do not import the QM deployment CLI, daemon, harness, pool manager or scheduler.**

This decision now has a working PostgreSQL implementation and focused database evidence. It is not a claim that the complete company platform, shared business brain, authentication provider, worker isolation or desktop delivery is finished.

## Source and dependency decision

Reviewed official QM commit `361a6c0095dcd3d156aca91353f3ffba0bb8b69b` (14 September, 00:54:44 UTC). The saved assessment sources are under `outputs/qm-architecture-review-2026-09-14/sources`; the additional grant/memory/run sources were inspected in the read-only clone at `/tmp/realbud-qm-review.kNI4if/qm`. Their exact URLs and SHA-256 digests are retained in the accompanying evidence.

The published `@yc-software/qm` 0.1.11 is a deployment CLI exporting `./contract`; its checked-in CLI package currently says 0.1.6. The root package is private. Neither is a reusable identity/knowledge/claim SDK. Installing the CLI would not supply these repository interfaces. [Published 0.1.11 metadata](https://registry.npmjs.org/@yc-software/qm/0.1.11), [source package](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/cli/package.json).

The inspected stores depend on QM's shared pool/migration machinery, branded scope types and other internals; the run store additionally consumes `OrchestratorInput`, `TurnResult`, origin resolution and its tool ledger. Pulling those modules in unchanged would import product assumptions and migration ownership that RealBud must replace. The new kernel uses the repository's `pg` dependency and Node built-ins only. It adds no QM, `pg-boss`, Docker, harness or scheduler dependency.

QM's [MIT licence](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/LICENSE) identifies “Copyright (c) 2026 QM contributors” and requires retaining its copyright/permission notice in copies or substantial portions. This implementation adapts reviewed semantics with a new RealBud schema/API; it does not vendor or import a QM source module. Any later literal extraction must add the complete MIT notice and exact upstream provenance before shipping.

## Adopted semantics and changes

| Source | Reused idea | Concrete RealBud implementation and difference |
|---|---|---|
| [Grant store](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/src/acl/postgres-grant-store.ts#L104) | Serialize grant replacement even when the old grant set is empty; reject concurrent stale edits. | Per-company/per-scope transaction advisory lock; monotonic scope revision; exact member and permission validation. Every protected scope operation shares that lock. No global grant cache or tuple-only comparison. |
| [Memory revisions](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/src/memory/postgres-memory-service.ts#L35) | Append attributed revisions under a scope lock; replace only the expected head. | Explicit company/scope/key identity, source references, immutable history and decimal-string revisions without JS number precision loss. No QM notebook parser, trusted-author prefix, automatic capture or Hermes-home writes. |
| [Run claims](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/src/runs/postgres-run-store.ts#L212) | Make claim acquisition atomic and reject the previous holder's writes after ownership changes. | One durable case row is locked for targeted claim acquisition; a monotonic fence, hashed claim token, member and database-clock expiry gate renewal/settlement. This is a case-ownership primitive, not a work queue. `SKIP LOCKED` queue selection and runtime scheduling are deliberately absent. |
| [QM expiry and ledger](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/src/runs/postgres-run-store.ts#L353) | Separate ownership fencing from later work recovery. | Expired claims cannot renew, settle or automatically requeue; they report recovery required. Receipt records are append-only to the application role. The QM `(run,attempt,callIndex)` output cache is not adopted as an exactly-once external-effect mechanism. |

QM's general run-store test file currently exercises its memory backend; its PostgreSQL grant and memory suites require `DATABASE_URL`. Source tests are evidence of intended semantics, not evidence that RealBud's new database code works. RealBud therefore has its own real-PostgreSQL integration suite.

## Implemented module boundaries

- `server/company/schema.ts`: one transactional, checksum-verified initial migration; migration lock; separate administrative/application-role contract; forced RLS for scoped content; append-only knowledge/claim/audit records.
- `server/company/index.ts`: trusted service kernel, opaque sessions and one-use invitation enrollment, principal/membership checks, scope grants, knowledge revisions and targeted shared-case claims.
- `server/company/types.ts`: explicit contracts and error codes; compatible with native Node TypeScript stripping.
- `server/company/postgres.integration.test.ts`: real PostgreSQL tests, activated only with `REALBUD_COMPANY_TEST_URL` pointing at an explicitly named disposable test database.
- `server/company/testing-postgres.ts`: reusable test-only fixture using existing PostgreSQL 16 executables, a private Unix socket, no TCP listener, and owned-directory cleanup.

`migrateCompanySchema(adminPool, { applicationRole })` requires an existing non-superuser/non-BYPASSRLS runtime role. `createCompanyKernel(applicationPool)` rejects a superuser, BYPASSRLS or table-owning/inheriting role. The kernel cannot substitute for OS isolation: the database credentials belong to the trusted service, never a worker.

The exported kernel provides:

- `createCompany({name, ownerName, singleHost?})`, `getBootstrapState()`, `recoverOwnerSession({companyId, reason})`.
- `issueInvitation(sessionToken, input)`, `redeemInvitation(invitationToken)`, `revokeInvitation(sessionToken, id)`.
- `authenticateSession(sessionToken)`, `revokeSession(sessionToken)`, `revokeMember(sessionToken, memberId)`.
- `createScope`, `listScopes`, `setScopeGrant`.
- `readKnowledge`, `replaceKnowledge`, `knowledgeHistory`.
- `createCase`, `claimCase`, `renewClaim`, `settleClaim`.

Bootstrap/status are trusted host-controller methods. Before exposing them over HTTP, the controller must authenticate its service administrator, bind the configured host company itself and reject caller-selected identities. **Owner recovery is held:** `recoverOwnerSession` always refuses with `owner_proof_required` before any database mutation. Service administration does not establish the owner's personal identity, and issuing a normal owner token would grant access to private notes even if the recovery method itself never reads them. Independent owner proof is not implemented. Existing sessions and private records remain intact. `singleHost: true` serializes competing first-company creation.

Invitation/session/claim tokens are generated with 256 bits of randomness and only SHA-256 hashes are persisted. Invitation redemption is transactional, expiring and single-use. It establishes enrollment by possession; it does **not** verify an email account or replace an external identity provider. Sessions currently last 24 hours; device-bound renewal/login requires the host/session integration.

Private scopes cannot be granted to another member, including the company owner. Share a reviewed copy through a team/company scope. Company scopes are readable by active company members; writing still requires scope ownership or an explicit write grant. Team scopes require ownership or an explicit grant. An owner can revoke a member without gaining a private-note read API.

Authoritative methods authenticate again per transaction, then set transaction-local company/member context. Shared member/session locks make revocation wait for already-authorized operations, while later operations fail. Scope locks make grant revocation linearizable across separate pools. RLS additionally fences company/scope content; bootstrap and credential tables remain trusted-service internals, not an independently exposed SQL authentication API.

## Verification

On 14 September, the focused suite passed **14 tests on PostgreSQL 16.15 with no skips**. It used two application pools under a restricted runtime role and a separate administrative fixture connection. Coverage includes:

- Concurrent single-host bootstrap and one-use invitation redemption; expired/revoked invites and sessions; owner-recovery refusal without session minting/revocation, with private-note confidentiality preserved.
- Cross-company rejection, private-note denial even for company owners, company read/write distinction and invalid cross-company grants.
- Concurrent knowledge/grant edits, immutable revision history, warm-instance revocation and RLS denial.
- Pooled actor-context cleanup after both successful and rejected operations.
- Competing claims, lease renewal, stale generation rejection, expiry holds, member revocation and durable receipts.
- Concurrent session revocation without a lock-upgrade deadlock; member revocation waiting for an already-authorized write and denying the next write.

`pnpm exec tsc -p tsconfig.server.json --pretty false` passed. Native Node 24 `--experimental-strip-types` imported the public kernel successfully. The reusable PostgreSQL fixture is separately exercised before handoff. Evidence: `outputs/realbud-core-implementation-2026-09-14/qm/`.

## Limits and next wiring

This closes the narrow D02 reuse decision and proves this kernel's database behavior. It does not complete the broader migration, company service, setup or release tasks. Existing JSON/SQLite records have not been migrated by this kernel.

There is no worker, queue, second clock, computer-use controller or external action in these modules. Claim completion records only a scoped case-holder decision; it is not proof of a payment, message, native process stop or other external result. Expired/revoked work remains held until a later trusted recovery controller can verify stop and reconcile effects. Do not add a timer that silently frees it.

Shared knowledge promotion, derived-source revocation/purge, search, artifact isolation, device enrollment, credential provisioning, backup/restore, OS confinement and Windows/macOS installed acceptance remain separate work. PostgreSQL data-at-rest encryption and authenticated remote transport are host-provisioning requirements, not established by this Unix-socket test.

## Dated official upstream refresh

Rechecked 14 September 2026, approximately 03:50 UTC, without installation or update:

- Hermes latest stable: **0.21.2**, tag `v2026.9.11`, commit `939e45c91d751fadd94dcd1b873ac3cb44846213`; published 11 September, 19:20:31 UTC. [Official release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.11).
- Cua Driver stable npm channel: **0.28.1**, published 12 September, 08:48:52.475 UTC. Release `cua-driver-rs-v0.28.1` targets `d8028a7943087ee258dc1b4d19dc12a7cd27669c`; GitHub's prerelease label does not change the npm stable-channel fact. [Exact npm metadata](https://registry.npmjs.org/@trycua/cua-driver/0.28.1), [official release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.1).
- QM HEAD remains the reviewed `361a6c0095dcd3d156aca91353f3ffba0bb8b69b`; published deployment CLI remains **0.1.11**, published 12 September, 05:18:25.323 UTC. [Official commit](https://github.com/yc-software/qm/commit/361a6c0095dcd3d156aca91353f3ffba0bb8b69b).

These are dated source facts, not authorization to change installed runtimes or claims of newly admitted RealBud compatibility.
