# Department case lifecycle — 21 September 2026

Department cases now support reviewed creation, assignment or unassignment, explicit human closure, and reversible department retirement. They use the existing PostgreSQL cases, scope permissions, claim fences and immutable receipts. Assignment does not start Hermes, establish account access, or dispatch work to another installation. Each person's private workspace, Bud, credentials and evidence remain private unless explicitly shared by an existing reviewed flow.

## Product rules

- A department writer can create a case and assign an active member who already has write access to that department. Assignment never adds a grant. Owner implicit write access counts while the department is active.
- The responsible person and the current execution holder are separate. An assigned case can be claimed only by its assignee; an unassigned case can be claimed by a current writer. Claims still require the existing live lease, member, token and fence checks.
- Assignment changes require an open case and its current fence. Live claims, expired claims and recovery-required work cannot be reassigned or manually closed through the ordinary case controls. The existing owner recovery flow must resolve uncertain work first.
- The current assignee or owner can close an open case as done or cancelled, with a nonempty note. The receipt explicitly records a human decision; it is not proof that an external system completed a transaction.
- Retirement requires the current owner, scope revision and an explicit note. Every open, claimed or recovery-required case blocks retirement. Retirement does not silently cancel work or erase records.
- Retired departments retain readable history and the existing audience. All new record writes are denied through `scope_allowed`, including generic case creation, claims and knowledge writes. Access can be reduced or revoked while retired; adding or upgrading access requires reactivation.
- Explicit owner reactivation changes only the department lifecycle state. It starts no jobs, schedules or external effects. Previous successful request retries remain receipt lookups and do not reapply a prior retirement.
- A removed or downgraded assignee remains visible historically and an open case needs reassignment. Assigned or interrupted held work prevents voluntary departure even after department read access is revoked. A narrow no-argument database predicate returns only this caller's unresolved-work boolean; hidden records remain unreadable. It uses a pinned search path and fails closed if its owner lacks the required database authority.

## Contracts

All operations require the authenticated current office member. IDs are normalized UUIDs; fences and scope revisions are decimal bigint strings. Titles are at most 240 characters, descriptions 4,000, and review notes 2,048. The server enforces these bounds.

| Method and route | Input |
|---|---|
| `POST /api/company/departments/cases/create` | `departmentId, requestId, title, description, assigneeMemberId` |
| `POST /api/company/departments/cases/assign` | `departmentId, caseId, requestId, expectedFence, assigneeMemberId` |
| `POST /api/company/departments/cases/close` | `departmentId, caseId, requestId, expectedFence, resolution, note` |
| `POST /api/company/departments/assignees` | `departmentId, offset?` |
| `POST /api/company/departments/lifecycle` | `departmentId, requestId, expectedRevision, retired, note` |

Assignee may be `null`; resolution is `done` or `cancelled`; retired is a boolean. Case mutations return `{item,receiptId,replayed}`. Lifecycle returns `{department,receiptId,replayed}`. The assignee endpoint returns existing active writers in pages of 100 and never exposes credentials. Existing department case and access routes remain compatible, with additional explicit lifecycle and action fields.

The department case response includes description, assignee, current action permissions, assignment attention, last human closure and existing recovery evidence. It excludes claim tokens, hashes and arbitrary internal outcome objects. Lists include retired departments; clients must honor retirement and authoritative action flags rather than interpret a retained write grant as permission to edit.

## Transactions and recovery

Mutations preserve the established order: authenticated company lifecycle lock, request lock, scope lock, then protected case/member rows. Retirement takes the exclusive lifecycle lock, serializing against ordinary operations and membership or role changes. Assignment and closure increment the case fence; retirement and reactivation increment the scope revision.

Case creation uses the request UUID as the case ID and stores its normalized input in the immutable creation receipt. Assignment, closure and lifecycle receipts similarly bind the original actor and normalized input. Same request and input reconcile the current item; a changed command conflicts even after later edits. A different member cannot adopt a new mutation's request identity. Existing recovery receipts retain the prior policy permitting the current successor owner to read the original reviewed outcome, after current owner authentication.

A database failure rolls the mutation and its receipt back together. There is no optimistic local completion, automatic retry with a new identity, background execution, or implicit grant. The local client outbox and its restart/archive handling are a separate integration owned by the host workflow.

## Upgrade and office backup

Checksummed migration `0006` adds description and nullable responsibility to cases, the cancelled terminal status, and department retirement metadata. Existing cases remain unchanged, with an empty description and no inferred assignee. Existing scopes remain active. Applying the migration does not resume, finish or refence existing execution claims.

Company backups still contain data-only rows, not uploaded SQL. Restore accepts the exact current canonical schema or a narrowly recognized canonical `0001`–`0005` manifest. A legacy restore must have exactly the old scope and case fields before neutral new defaults are applied. Unknown migrations, altered checksums, omitted fields and forged post-0005 states are rejected transactionally. Current backups retain descriptions, responsibility, cancellations and retirement. Restore continues revoking sessions and fencing unfinished claims.

The office backup remains bounded at 32 MB of plaintext or 100,000 records. This slice does not add bulk archival, permanent deletion, or claim unlimited retention capacity. Department queues retain the existing bounded offset pagination. SharedWork remains a separate explicit reviewed-content handoff; this slice does not broaden its audience or convert it into department execution.

## Verification

The focused real PostgreSQL lifecycle suite covers request replay and changed-input conflicts; current writer selection; no implicit access grant; generic claim bypass; explicit human closure; assignment and claim races; no-access departure holds for assigned work and legacy unassigned claims; misprivileged predicate failure; retirement versus generic and typed creation races; retired RLS write denial; reactivation; owner transfer; SharedWork compatibility; and an actual pre-0006 database shape upgraded by the production migrator.

The backup integration suite covers old/current snapshots, exact trusted migration identity, strict legacy fields, new lifecycle roundtrip, unchanged restored claim fencing, and retired-scope RLS. Pinned TLS tests exercise the product HTTP contracts and status codes, including strict unknown-field rejection and retries after retirement.

Verification completed: **99/99** in the ten-file backend PostgreSQL/TLS gate (zero skips), followed by **8/8** real HTTP host tests and **26/26** transport tests after adding explicit local-journal LAN rejection coverage. The 26 transport tests supersede the 25-test transport subset in the 99-test gate; these totals should not be summed as distinct tests. Machine-readable results are in `outputs/department-lifecycle-2026-09-21/backend-final/{receipt,vitest}.json`, `host-vitest.json` and `transport-final-vitest.json` under the same parent output directory. All disposable clusters stopped and removed their data. These are synthetic local PostgreSQL and HTTP proofs. The frontend walkthrough, packaged application, installed Windows behavior and real-office acceptance must each be reported separately by the corresponding integration gate.

## Desktop journal and rendered acceptance

The installation now stores one encrypted typed department request before forwarding it. It records only the normalized operation, office/member binding and minimal validated receipt; session tokens are not persisted in this journal. Uncertain requests retain their original identity across restart. A confirmed receipt must be acknowledged before another department change. Pending requests block leaving, host replacement and offline detachment. These actions serialize with in-flight department writes, so an archive records the settled local proof rather than racing it.

Connection and work recovery can archive a pending request locally after explicit acknowledgement, including when office access is lost. Unknown results remain unknown; archival never cancels a remote action. A confirmed archive records saved status. Repeating an archive preserves its original bytes and timestamp. A request already acknowledged by another window cannot produce a false successful archive: the service requires an actual matching archived record or returns a conflict. Local journal/archive routes remain unavailable over office LAN transport.

The rendered desktop/390px rehearsal passed **12 checks**, with no renderer errors, using the actual source bootstrap, installation wrapper, HTTP routes and PostgreSQL 16.15. It covers assignment/unassignment, human closure, stale fences, revoked sessions, retirement holds, retained read-only history, access reductions/revocation while retired, explicit reopening, and private archive downloads. A browser-aborted response had already reached durable confirmation and is tested as acknowledgement. The retry branch uses an explicitly prepared encrypted pending-journal fixture, restarts the owned service and replays the exact request against the existing PostgreSQL case. Both fixture layers are documented in `outputs/department-lifecycle-2026-09-21/receipt.json`; neither is presented as a live network outage or customer proof.

Client API and event-subscription tests passed **71 tests**. Installation binding/recovery passed **21 tests**, including deferred in-flight mutations versus departure, host replacement and archival (`concurrent-installation.log`). These are separate, overlapping gates. Current normalized-bill work will require a new integrated source/package gate; the earlier packaged application does not include this department slice.
