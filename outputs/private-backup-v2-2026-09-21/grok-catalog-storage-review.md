**Scope.** This module’s `catalog.sqlite` + DELETE rollback journal only: `create`/`open`/`insert`/`validate`/`seal`/bounded reads. Not coordinator/global disk quota, not prepared/builder journals. Hostile raw-SQLite edits are out of scope except where this API can strand its own previous committed bytes.

**Not PASS.** Returned connections do not raise `max_page_count` above declared storage, and `BEGIN IMMEDIATE` + rollback on error does not commit a partial seal. Several reachable paths still break the claimed bound, 8MiB admission, or reopen of valid bytes.

### 1. Pager settings contradict 8MiB admission (reachable)
`cache_size=-2048` (2MiB) and `cache_spill=OFF` are required. SQLite then returns `SQLITE_FULL` when dirty pages exceed cache mid-transaction. One `<=8MiB` TEXT overflow row is ~2k pages; it cannot sit in a 512-page unspillable cache.

`insert` only checks `MAX_ENTRY_BYTES` / logical `maxBytes`. The failure is mapped as declared catalog capacity (413). Prior committed rows should still roll back. This does not enlarge the file bound; it makes the stated per-mutation admission uncommittable (tests likely never wrote 8MiB).

### 2. Open/recovery is not under the claimed main+rollback cap
`new DatabaseSync` recovers any hot journal with **defaults** (spill on, essentially uncapped pages) **before** `configure`. Then `open` sets `max_page_count` to **64GiB**, reads the header, then tightens.

A connection **returned** from `open`/`create` is tight, and `cache_spill=0` is checked. During recovery it is not. `journal_mode=DELETE` is never checked; if it did not stick, WAL would sit outside `rollbackBudget` (`DBpages*(4096+8)+2*65536`), which is only valid with spill off and one DELETE segment.

`legacyJournalMax` allows a huge `-journal` on disk, then recovery runs, then a tighter `rollbackBudget(storage)` check. A leftover **cold** journal in `(rollbackBudget, legacyJournalMax]` fails `open` even if SQLite would ignore it and `catalog.sqlite` is intact. That strands valid bytes. Do not delete it.

`lstat(main).size > storage` after recovery also `invalid()`s. A crash during a growing commit can leave a longer file while the header page-count is rolled back; with a tight cap that size should still be `<= storage`. The realistic strand is a **legacy two-field** file larger than `defaultMaxStorageBytes` (2×plain + 16KiB×entries + 256KiB, ceiled to 4KiB, cap 64GiB). Two-field JSON still parses; physical reopen is the new derived cap, not the old uncapped file.

### 3. `SQLITE_FULL` mask does not seal partially; it can abandon a valid catalog
`validateAndSeal` updates `sealed` in the same IMMEDIATE txn and `COMMIT`s after graph checks. `COMMIT`/`UPDATE` `SQLITE_FULL` hits `rollbackQuietly` then 413. Auto-rollback is preserved; a sealed header is not committed on that path.

`isSqliteFull` also treats **errcode 13 / message `SQLITE_FULL`** from:
- the 64MiB `:memory:` lookup DB,
- pager cache FULL (defect 1),

as “catalog reached declared capacity. No partial backup is valid.” Main txn rolls back (unsealed data remains). Callers can still discard a good catalog.

Non-FULL SQLite errors become “duplicate identity,” including `BUSY`/`IOERR`/`CORRUPT`. That does not corrupt rows; it hides integrity failures.

### 4. Bounded reads vs this writer
`entry()` / `header()` force TEXT and cap metadata 16KiB / payload 16MiB / header 16KiB. This writer always `JSON.stringify`s envelopes into TEXT; BLOB payloads would `invalid()` (no evidence this class wrote BLOB).

Gaps:
- **`insert` never enforces `ENTRY_PAYLOAD_MAX`.** An 8MiB body whose envelope is `>16MiB` commits, then every `entry()`/`validate` fails. Base64 AES envelopes fit; hex/`Buffer` JSON would not.
- **`filePaths()`** leaves `category,lookup,kind` unbounded (unlike `entry()`). Oversized TEXT there is a large JS alloc; not a missed legacy path encoding.
- **`rows()` / public iterate** is two statements and not a txn. Under `validateAndSeal` the outer IMMEDIATE snapshot still covers graph/order/digest. Entries are append-only, so this is not a seal-integrity hole.

### Integrity / concurrency (these changes)
Seal/insert re-read the header inside `BEGIN IMMEDIATE`; a reopened writer sees `sealed`. Lookups are a separate page-capped `:memory:` DB, not scratch tables in the catalog txn. Kind iterate uses the covering index; unfiltered iterate is `NOT INDEXED` on the rowid PK; `rejectTempSort` only plans the unfiltered query (kind path is `INDEXED BY`, so it errors rather than silently sorting).

`close()` does not `ROLLBACK`; SQLite close aborts an open txn. `synchronous=FULL` is the durability story for insert/seal (no `fsyncDir` after those).

**Bottom line.** A **returned** catalog connection does not keep `max_page_count` above persisted/derived storage, and `SQLITE_FULL` does not expose a sealed partial backup. The claimed **physical bound does not cover open/recovery**, leftover journals can **strand** valid main bytes, and **8MiB admission is incompatible** with the 2MiB unspillable cache, with the same 413 used for scratch/cache FULL.