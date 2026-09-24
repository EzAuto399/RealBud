# Execution history and retry identity

RealBud now separates the recent activity projection from permanent execution receipts. This is a local implementation checkpoint, not a claim that indefinite business retention or customer production acceptance is complete.

## Authority and migration

- Job and routine receipts, manual request bindings and stream checkpoints live as encrypted logical rows in the existing `workflow-state.sqlite` schema. Request bindings include the reviewed plan and execution inputs. A duplicate request resolves to its original outcome; a changed request cannot borrow that identity.
- SQLite commits the execution intent before dispatch or compatibility-file replacement. A failed or uncertain write pauses the store. Restart accepts only the recorded before/after projection hashes, reconciles the durable state and interrupts unfinished execution. Unexpected JSON edits and damaged records hold without overwriting their bytes.
- Valid legacy history migrates transactionally. The original file is retained until an ordinary committed update replaces its projection. Migration cannot recover receipts already discarded by an older release; durable protection applies to migrated and newly recorded requests.
- Recent projections remain bounded to 1,000 jobs and 2,000 routines when settled records can be removed. Queued/running work is never evicted from active-work guards. Removing a settled result from this projection does not remove its encrypted receipt or request binding.
- The authenticated history endpoints use stable, bounded cursors. Schedule exposes earlier jobs and routines on demand, including outcome and evidence. Reading history does not initiate execution. Recent activity and history browsing are separate UI state.
- Invoice proposals resolve their original result through the permanent request lookup, including after the recent projection has moved on.

Encryption is not universal at rest: SQLite receipt payloads and portable backups are encrypted, while the existing recent `job-runs.json` and `loops.json` compatibility projections still contain plaintext work payloads with private filesystem permissions. Do not describe the whole workspace as encrypted solely because the new ledger is encrypted. Removing or encrypting those payload-bearing compatibility projections belongs in the next retention migration.

## Backup and restore

The existing version-1 private backup recognizes execution records and validates their full request/receipt/checkpoint graph against compatibility files. Restore preserves request identities, interrupts every unfinished saved execution, disables all clocks, and regenerates checkpoint/file hashes together under the destination key. It cannot restore an orphaned request, a missing receipt or a mismatched projection as valid work.

The version-1 backup's 96 MB envelope, 48 MB plain/file collection, 5,000 logical record and per-file bounds still apply. The new ledger makes those limits more visible; it does not make that format suitable for indefinite history. Export fails explicitly before creating a partial backup. Mail, bill, bank and proposal lifetime caps are still separate unfinished retention work.

## Evidence

- `server/execution-history.test.ts`: migration, rolling-window crossings, stable page cursors, active work, changed inputs, stale writers, fault recovery, restore graph and clocks off.
- `server/private-workspace-backup.test.ts`: actual 1,001-job ledger export, different-key restore and production-reader reopen; oldest request remains a completed duplicate; incomplete graph rejected.
- `scripts/qa-execution-history.mjs`: actual isolated source bootstrap and built UI; 55 fictional legacy results paged without loss, session checks, invalid requests, text evidence, failed-read recovery, desktop and 390px layout. Receipt: `outputs/execution-history-2026-09-21/receipt.json`.
- The integrated source suite and packaged/native proof are recorded in `REAL-ESTATE-CORE-2026-09-21.md`; earlier package receipts do not prove newer source changes.

## Next retention slice

Do not raise aggregate lifetime caps or discard evidence to admit more work. Move mail items/scans, accepted bills/patterns and bank batches to individually paged encrypted entities while retaining permanent source identities and immutable revisions. Validate each legacy aggregate and commit its migration with a source digest before switching readers.

Backup v2 should use streamed, bounded authenticated chunks and a complete authenticated manifest, retaining the exact v1 reader. Use built-in crypto/streams/SQLite. Snapshot through a cross-store write barrier; export portable logical content without a source master key. Upload by offset/digest with idempotent chunk retries; verify the complete footer and all content before trusted preview. Prepare target-key records and immutable staged files, then let cold bootstrap resume atomic replacement using baseline/intended hashes. Bound scratch disk, request size and memory; preserve business evidence and held restores on cancellation. Prove large archives, truncation/splice/reorder, disk-full, interrupted apply, exact bank bytes and real Windows installation separately.
