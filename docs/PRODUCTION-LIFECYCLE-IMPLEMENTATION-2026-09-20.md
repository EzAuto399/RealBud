# Production lifecycle implementation

Updated 20 September 2026. The user authorised implementation of the solo/local-office review. This pass implements the core membership, continuity, sharing-recovery and host-recovery workflows in the existing checkout. It is not an assertion that every enterprise capability or release gate is complete. No production deployment, customer data operation or installed-app replacement was performed.

Read the [operating and recovery runbook](OFFICE-RECOVERY-RUNBOOK.md) for the supported product journeys. The [original review](SOLO-AND-LOCAL-OFFICE-REVIEW-2026-09-20.md) retains its historical findings.

## Implemented

| Area | Result |
|---|---|
| Private Bud continuity | Immutable workspace manifest preserves the existing solo or legacy member worker selector. Joining/leaving no longer changes private model, OAuth, ACP or connected-app profile selection. Startup validates this manifest before work resumes. No profile copy or merge occurs. |
| Enrollment | Non-secret journal precedes host mutation. Bound workspaces cannot consume another invitation. An uncertain result resumes by same-username sign-in across restart. Host/company identity is checked before credentials return to the renderer. Invalid input and a rejected fresh different-member sign-in do not strand the original member. |
| Members and invitations | Paginated owner management, invitation cancellation, access removal, and recipient-accepted ownership transfer. Current roles are checked at the host. Transfer changes company scopes only and cancels unused invitations. |
| Leave/disconnect | Open owned/assigned work and outstanding claims block leaving; the last owner must transfer first. Leaving revokes all member sessions; disconnecting revokes the current session. Encrypted departure state and capability receipts reconcile response loss. Explicit offline detach records that remote revocation is unknown. |
| Shared work | Encrypted outbox retains the exact request ID, reviewed payload, audience and evidence across restart. Current identity/authority are checked again on retry. Changed payloads cannot replace an uncertain or already-confirmed request. Unknown outcomes can be explicitly archived, listed and exported as private receipts. |
| Backup and restore | Owner plus local service-admin authority; AES-GCM/scrypt encrypted data-only office backup with hash/manifest, row and byte limits. Restores require an empty host and compatible migration checksums; they validate fixed tables and office IDs inside one transaction. Uploaded SQL is never executed. |
| Host cutover | Source retirement is durable. Restore begins in standby, revokes old sessions/invitations/offers and fences claims for recovery. Lost local restore receipts reconcile from the committed database audit. Missing lifecycle state on a previously restored/retired host causes a hold. Owner activation requires explicit previous-host shutdown confirmation. |
| Network recovery | Expired certificates hold network admission while keeping local storage recoverable. Explicit certificate/address renewal issues a new host identity. Companions explicitly re-pair only to the same office and keep their private workspace. Pending shares must be resolved or archived first. |
| Interface | Progressive solo/join/host choices, semantic settings headings, owner controls, held-host explanation, backup/download distinction and an offline local recovery view. Protected or destructive membership actions have explicit confirmation. A successful archive remains visible instead of collapsing its receipt. |

The company database receives additive migration `0004`. Existing migrations remain unchanged. Only disposable test databases were migrated during this work. Protected local lifecycle files are atomically replaced and fsynced. Production journals use the existing protected Desk key; development key creation is exclusive and never overwrites an existing key.

## Verification receipts

All checks used synthetic data or disposable local profiles/databases.

- Full root test suite with real PostgreSQL enabled: **241 files passed; 2,712 tests passed; 53 tests in the full report explicitly skipped**. Five files were skipped. Skips are not acceptance evidence.
- Final focused HTTP/host-recovery/client checks: **37 tests passed** after the final authority-boundary review.
- Additional real TLS/owned-host lifecycle journey: **6 tests passed**, including certificate renewal, failed old pin, explicit re-pair, open-work leave denial, successful leave, restart, joining a different office, old-session denial and preserved private workspace/files. This last added journey follows the full-suite receipt above; counts are not additive unique coverage.
- PostgreSQL integrity cases cover transactional rollback on foreign-office rows and unknown fields, migration mismatch, restored-session revocation and fencing of in-flight claims.
- Concurrency tests cover ownership acceptance versus member revocation, and leaving versus a new shared write. Fault-injection tests cover lost enrollment/departure/share responses and restart.
- `pnpm build` and `pnpm build:server` passed. The latter generated the packaged JavaScript server and bundled company dependencies. Vite's existing large-chunk/static-versus-dynamic-import warnings remain; build success is not a performance or installer receipt.
- Browser walkthrough passed at **1365px and 390px**: keyboard activation of setup choice, join error mapping, member-removal confirmation, encrypted backup download request, standby activation gate, and explicit archive of an unknown share while the host is offline. No browser errors or horizontal overflow were found in those flows. Company responses in this browser walkthrough are synthetic; real mutation proof is in the PostgreSQL/TLS suites.
- Screenshots were visually inspected. Dark OS preference was exercised; the product currently retains its light palette, so these are not dark-theme implementation or contrast-audit receipts.
- Final `git diff --check` passed. Existing unrelated work was preserved. No commit, PR, release, installer deployment, website migration or paid model invocation was made.

Browser artifacts and source fingerprints: `outputs/production-lifecycle-2026-09-20/`.

## Important limits and remaining work

1. **Installed device acceptance:** macOS and Windows installs still need a real two-computer walkthrough, including firewall, sleep/sign-in, service lifetime, reboot, permission denial, backup-file transfer and owner cutover. Local Unix/macOS PostgreSQL/TLS fixtures are not those receipts.
2. **Device enrollment:** the host pins its TLS identity and authenticates members. Individual device credentials, device-level revocation and execution admission are not yet implemented. Company worker/desktop execution remains gated.
3. **Website authority:** installation reporting is separate from verified local-office association. Remote command delivery/execution is unimplemented. Define and test explicit device consent, office binding, scoped authority, expiry, idempotency, local approval, cancellation and completion receipts before exposing controls.
4. **Full workspace lifecycle:** this backup covers office-host data, including access-restricted host records and sign-in verifiers. It excludes private Buds/books/files/connections. Private workspace restore and durable office closure/retention/key-destruction orchestration remain separate unfinished work. Do not represent source retirement or offline detach as complete offboarding.
5. **Operational scale:** built-in backup is bounded at 32 MB plaintext/100,000 records/48 MB encrypted JSON. Larger-office backup, automated scheduling/retention, monitoring and capacity admission need separate work. An isolated LAN has no automatic global fencing for an unreachable old host; verified operational cutover remains mandatory.
6. **Provider capability proof:** this pass preserves existing Hermes integration and release-admission gates. It does not introduce a new upstream release or prove a live DeepSeek/model/tool workflow. Source/permission/result/recovery receipts are required for each admitted workflow; a configured provider label is insufficient.

These are implementation and acceptance limits, not requests to waive the existing safeguards.
