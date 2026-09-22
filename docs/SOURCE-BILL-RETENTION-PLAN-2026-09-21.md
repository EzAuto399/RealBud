# Source-linked bill retention slice

Implemented in source on 21 September 2026. The design below records the original limit and migration contract. Domain, API, backup and browser verification are recorded here; packaged and customer proof remain separate gates.

## Immediate limit

Previously, the source-bill register stored every bill, recurring pattern and revision in one encrypted `bill-register` row. Its 500-bill and 100-pattern bounds counted paused and cancelled entries forever. One recurring bill for each of 101 properties already exceeded the pattern bound; 300 properties with one monthly bill reached the occurrence bound within two months. The underlying 8 MB per-record guard was another independent limit. Raising those aggregate limits would retain the same growing-read and growing-write design.

## Bounded next implementation

Move only source-linked bills to individually encrypted heads in the existing `WorkflowDatabase`: one stable occurrence ID and one stable recurring-series ID per row. Keep the existing 50 revisions per entity and 8 MB record guard initially. Preserve every old source alias, cancellation, pause, review and correction. No status may imply that evidence is safe to delete.

Use deterministic opaque lookup IDs for historical source identities, active account/property/type/vendor pattern reservations, and occupied series/date arrivals. Store sensitive lookup payloads encrypted. Commit affected heads and lookup reservations together through SQLite `BEGIN IMMEDIATE` and existing create/CAS operations. A repeated old source identity must find the original bill after correction, cancellation, restart or pagination.

Validate the complete legacy register before migration. In one transaction create heads and derived lookup records, validate the resulting graph, then replace the legacy aggregate with a version-2 marker holding the original revision, source digest and counts. Mixed or orphaned state holds for recovery; transaction failure leaves the original register intact. Do not dual-write two competing authorities. An older binary must refuse the new marker. Rollback requires restoring the pre-migration backup into a fresh supported installation.

## Required integration

- `source-bills.ts`: direct identity/pattern/arrival lookups, counts and stable cursor pages instead of complete aggregate snapshots.
- `source-bills-api.ts`: resolve originating bills and patterns directly, rather than searching the first loaded page.
- `SourceBillsPanel`: paged bill/pattern lists with explicit totals and retained staff review controls.
- Calendar and `index.ts` projections: range/property-bound cursors and direct occupied-arrival lookup. An incomplete page cannot establish that no actual bill exists or that a predicted arrival should be emitted.
- A pure backup graph validator/rekey adapter accepts exact legacy v1 or exact v2 state. Every source alias, review revision and pattern must survive different-key restoration.

## Capacity and evidence

Backup v1 still refuses more than 5,000 logical records, 48 MB of collected content or a 96 MB encrypted envelope, with separate file limits. Normalization does not make backup capacity unlimited. Derived indexes may be reconstructed only from validated immutable facts; otherwise they count against the existing physical-record bound. Expose export capacity and an explicit assisted-backup result. Streamed backup v2 remains a separate slice, described in `EXECUTION-HISTORY-2026-09-21.md`.

Required checks include actual legacy migration/reopen; the 501st bill and 101st pattern; paused/cancelled identity preservation; corrupt/mixed/orphaned graph rollback; two SQLite handles racing on source acceptance, corrections, pattern uniqueness and series/date occupancy; stale CAS; old aliases after source correction; pagination with interleaved inserts; calendar suppression across page boundaries; and exact source/history roundtrip under a fresh key. Store failures must retain original bytes.

Mail's 2,000-thread/1,000-scan and 1.4 MB journal constraints, bank's 500-batch list/create limit, the 1,000 invoice-proposal requests and 50 edits per entity remain explicit separate constraints. This plan does not silently remove any of them or provide current native Windows proof.

## Implemented verification

- Individually encrypted occurrence and series heads now replace the aggregate, with permanent old-source aliases, pattern/arrival reservations and originating-bill lookups. Strict v1 migration is atomic and preserves the original source revision and digest. No history is removed to admit new work.
- Domain/storage gate: **125/125 passed**, including real Node 24 worker threads with independent SQLite handles, 501 occurrences, 101 patterns, migration failure/corruption, conflicting corrections and arrival reservations. `outputs/source-bill-retention-2026-09-21/domain-storage-tests.log`.
- Independent transaction-cache tests reproduced and fixed post-commit external-write and enclosing-transaction rollback invalidation. Calendar continuations bind register revision; mutation returns 409 instead of skipping entries. Occurrence/series cursors freeze insertion highwater and report exact totals, while allowing current corrections.
- API/projection gate: **60/60 passed**, including exact off-page lookups and second-handle mutations between projected pages. One response cannot silently mix register revisions. `outputs/source-bills-retention-2026-09-21/api/receipt.json`; full contract in `SOURCE-BILLS-PAGED-API-2026-09-21.md`.
- Backup/cache gate: **34/34 passed**, including encrypted 501/101 different-key restoration, old aliases, paused/cancelled history, orphan-byte preservation, legacy restoration and explicit 5,000-record refusal. `outputs/source-bill-retention-2026-09-21/backup-final.log`.
- Independent backup review reproduced a valid imported head that fit the old plaintext limit but exceeded the live encrypted-record limit. All normal writes, imported envelopes and transformed restore writes now share the exact 8,000,000-character encrypted-envelope ceiling. The regression proves preview/staging rejection with unchanged target bytes and no partial stage. The historical failing test is retained as `oversize-backup-red.log`.

The register validates its complete encrypted graph on first use or external change. Steady-state direct lookups and writes are incremental; filtered historical counts still scan encrypted heads in bounded pages. This is not an unbounded-memory or constant-time guarantee for every read. Backup v1 remains a bounded format, and its UI now explains physical-record capacity and assisted backup before exhaustion.

Final integration: **3,353 full-suite tests passed, 143 environment-gated skipped, zero failures**; source browser/HTTP **12/12**; fresh unsigned Mac build and package smoke passed. Native packaged restore **5/5** includes exact normalized bill history, paused pattern and old identity under a different key through compiled HTTP readers. All captured native fixture PIDs exited and scratch was removed. Receipts, screenshots, build log and provenance are under `outputs/source-bill-retention-2026-09-21/`. `safeStorage` remains a labelled fixture, not real OS keychain acceptance. These proof sets overlap.
