# Retained mail work and source evidence

Status: implemented and verified through source, actual HTTP/browser, different-key backup and a fresh unsigned native macOS package. See `MAIL-RETENTION-2026-09-21.md` for current evidence and remaining limits. This document preserves the implementation contract and original failure rather than treating the earlier audit as current behavior.

## Daily-use problem

`server/mail-ingestion.ts` rewrites a single encrypted `mail-workspace` journal. Its admission checks cap history at 2,000 items, 1,000 scan receipts and 1,400,000 plaintext bytes. Completed/reference items and failed scans still count. Its existing multilingual growth test reaches the byte refusal within at most four 100-thread batches. These are live-work limits shared by morning priorities and source-bill collection; exporting does not release capacity, and deleting evidence is not an acceptable workaround.

Keep separate per-operation limits: 100 acquired threads, 500 messages, 20 pages and 800,000 result bytes per scan; 1.4 MB per source bundle and the vault's 2,000,000-byte encrypted reader bound; five morning batches of 20 conversations with a 950,000-byte prepared input. Coverage gaps remain visible when a scan is bounded. Normalizing retention does not claim complete Gmail coverage or increase model budgets.

## Implementation and compatibility contract

1. Use individually encrypted workspace metadata, task heads, scan receipts, source bundles and prepared-input bindings. Reuse the existing workflow database and private-key custody. Preserve permanent IDs; never evict finished tasks, failed receipts or older sources to admit new work. Define each record's exact size and schema limits.
2. Validate the complete legacy journal/source graph before atomic migration. Retain original files and an origin fingerprint/marker. Reject malformed, conflicting and partially migrated state without rewriting it. A committed marker prevents stale legacy state from becoming authoritative again. Imported normalized state must not be mistaken for an unfinished local migration.
3. Preserve item IDs/revisions, manual priorities, owner, notes, completion, snooze, first-seen time, message/source digests and old receipt links. Substantive new source evidence may reopen completed work; lost scan coverage must not. Failed/interrupted acquisition and its source bundles remain evidence.
4. Persist acquisition intent before provider access. Recheck current source/authority after asynchronous operations. Commit receipt, source references and affected task changes atomically. Use current database state under transaction for cross-process writes; an instance-local promise queue is insufficient. Recovery and snooze expiry must not depend on free aggregate history capacity.
5. Expose bounded metadata/counts, filtered task pages, scan-history pages and direct task/source lookup. Search covers retained records, not just loaded rows. Priority/status/snooze edits change ordering; bind continuation to a workspace revision and return a clear stale-page response. Do not accumulate every decrypted source during summary reads.
6. Integrate morning execution and both GUI consumers together. Preserve their source authority, bounded batches and drafts. A selected off-page conversation remains selected. Refresh/failure must not discard staff notes, bill decisions or uncertain proposal request IDs. Compact Desk summaries use authoritative counts and a bounded page.
7. Extend backup's kind allowlist, graph validator and rekey/restore dispatch for legacy and normalized mail. Resolve every task-to-receipt-to-message/source link and every complete/partial receipt's source bundle. Reject missing, conflicting and unexplained orphan records before trusted preview. Preserve exact retained source content. Restore still clears live source selection/approval and pauses clocks.

## Affected components

| Area | Current files and dependency |
| --- | --- |
| Storage/domain | `server/mail-ingestion.ts`, `server/mail-workspace-integrity.ts`, new normalized store/graph modules |
| Contract/API | `shared/mail-ingestion.ts`, mail routes and source-bill adapters in `server/index.ts`, session admission for added routes |
| Clock/workflow | `server/morning-mail-workflow.ts` currently derives totals from `state.items.length`; replace with authoritative metadata |
| Mail UI | `MailWorkPanel.tsx` currently fetches, filters and sorts all retained items; its load-more only reveals already fetched rows |
| Bill source picker | `SourceBillsPanel.tsx` fetches all mail and renders a complete select list; use bounded search/pages and retain off-page selection/drafts |
| Mounted views | `WorkspaceSavedView.tsx`, `DeskPage.tsx`, `ExpectedBillsBoard.tsx`; preserve saved filters and direct links |
| Backup | `private-backup-mail-validation.ts`, `private-workspace-backup.ts`, cold restore and native fixture |
| Proof | Mail ingestion/scheduler/workflow, source-bill/proposal, backup suites; `qa-morning-mail.mjs`, `qa-source-bills.mjs` and backup browser/native scripts |

Use exclusive domain/HTTP/UI ownership when delegating implementation. Agree shared contracts before concurrent edits. The existing backup-v2 plan needs an iteration adapter for normalized mail; its assumption that mail journal metadata is bounded becomes obsolete after this migration.

## Acceptance evidence required

- More than 2,000 retained tasks and 1,000 receipts, including completed items, failed scans and multilingual content; no silent pruning.
- Exact legacy migration, interrupted migration/restart, conflicting origins, corruption with original bytes preserved, and real independent database handles.
- Stale staff edits, source/authority changes during reads, stopped scans, snooze expiry, lost coverage and substantive-new-evidence behavior.
- Old source retrieval, source-bill correction and proposal replay after newer scans and page changes.
- Real HTTP counts/search/pages and stale continuation; actual desktop/mobile UI, keyboard access, draft preservation and failed-read recovery.
- Different-key backup/restore, complete graph attacks and current authority resets, then a fresh compiled/native Mac checkpoint. Windows needs its own execution evidence.

Private backup v1 retains its 5,000 physical-record, 3,000-file and aggregate-size bounds. Normalization can reach those bounds sooner. Streamed backup v2 must follow with its own authenticated format, graph, memory and recovery proof; neither plan nor a successful bounded backup proves indefinite retention. Live Gmail, customer REI acceptance, native Windows and signed distribution remain separate gates.
