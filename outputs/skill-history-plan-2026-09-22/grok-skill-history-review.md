# Grok reviewed instruction history advice

One 1,952-byte sanitized source/design packet. No tools, web, MCP, customer data or secret contents were supplied. This is advice, not implementation or test evidence.

Actual model bucket: grok-4.7-build; effort xhigh; 1 call, 1 turn; end_turn; 221.543 seconds including cleanup.
Usage bucket: input 32923, output 15445, reasoning 15031, total 48368. Top-level terminal total separately returned 48377.

## 1. Reintroduced-skill revision ABA

Revert binds G1, rev 4, Da, and Ha, then crashes. Absent rollback restores Ha and the hot window reuses rev 4. Apply then writes Db with approvals intact. Resume matches 4/Da or treats Db as done.

- Recheck generation, scope, revision, digest, hot versions, and head; hold on mismatch.
- Apply or restore reaching Db must not complete revert or skip approval clearing.
- New epoch must stop hot-window reuse of an old revision-digest pair.
- Present overrides beat snapshot heads; missing head must not match Ha.

## 2. Journal full before intent

Journal is at 2MB with newest-two, receipts, and holds. Apply drops a receipt or archives history to fit the intent, then crashes before fsync, no batch written. Retry sees unchanged active bytes and revision while archive-pending blocks backup.

- No archive, prune, or batch write until intent fsync succeeds.
- Do not delete receipts or holds to free the intent slot; an unrecorded conflict must not proceed.
- Mid-compaction crash restores prior bytes, revision, approvals, and content.
- Retry keeps a single receipt and must not block backup.

## 3. Shared-graph crash durability

Current and archived config share B. Durable intent, B2 fsynced, crash before head and hot-list replace. Backup scans both roots during resume. Roots are acyclic; their union cycles. Resume then commits and clears approvals.

- One point-in-time cut: no new head with a missing batch or torn hot list.
- Allow diamonds; reject merged cycles, foreign, detached, missing, or tampered batches.
- After commit, replay must not bump revision or clear later approvals.
- No-head legacy journals restore text only, with no approval or schedule authority.

## Source-review adjudication

- Advice case 1 is a proposed ABA stress test, not an observed defect. The proposed archive preview already binds generation, active revision/digest, exact hot list and head. Revert needs equivalent durable binding. No extra epoch should be added unless those identities cannot uniquely bind the operation.
- Advice case 2 says a retry must not block backup. That is only correct after archival completion: an unresolved durable intent intentionally blocks backup. Before the journal commit, old referenced history plus exact pending intent must remain recoverable; automatic rollback of every journal byte is not the design.
- Advice case 3 assumes archival clears approvals; this is incorrect. Metadata-only archival preserves all approval/schedule/active-instruction values. A reviewed revert, separately, clears approvals and pauses schedules.
- Advice case 3 says every root is acyclic while their union cycles. With complete traversal and canonical immutable node identity, that cannot happen: a reachable cycle belongs to a root traversal. Implement path-local cycle detection plus global validated-node memoization; the real risk is confusing repeated valid references with cycles or skipping validation after incorrect identity deduplication.
- The review gives test suggestions only. No source implementation, test execution, release approval, provider call or customer acceptance was performed by Grok.

Owned process group independently checked empty; temporary private home removed; global configuration SHA-256 unchanged. Authentication used an opaque symlink; the harness did not read/copy authentication contents. No retries. These are process/configuration checks, not an OS sandbox claim.
