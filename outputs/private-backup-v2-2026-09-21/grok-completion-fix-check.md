**Verdict: PASS / PASS.** No concrete blocker on the two named findings. Cold coordinator and UI remain unwired — not a release.

### (1) Cold completion vs journal ingest — **PASS**

Pending encrypted completion is not replaceable by another v2 restore.

- Staging bails if `PRIVATE_BACKUP_COMPLETION_FILE` exists (`Finish recording the previous restore…`).
- Apply reads the proof first. A non-matching operation/workspace/digest/receipt **holds** and does not write. A match only `assertCurrent()`s; it does **not** `encryptJson` / `atomicBytes` the completion file. `restoredAt` is taken from the existing proof. Matching replay therefore keeps the original ciphertext.
- `readBackupColdCompletionProof` returns `null` only on `ENOENT`; any other parse/decrypt/identity failure **holds**, so a live file cannot be treated as absent and renamed over.
- `withRestoreLock` serializes stage/apply (`BEGIN IMMEDIATE`, `busy_timeout=0`). A second writer is excluded, not a takeover.

Journal ingest-then-consume:

- `createBackupOperationStore` runs the owner/workspace/completion work inside `tx()` (`BEGIN IMMEDIATE` … `COMMIT`), then `fault('completion-committed')`, then `completion.consume()` (`unlink` + `fsyncDir`).
- If already `phase === 'completed'`, it does **not** bump `revision` or rewrite the row; it still sets `consumeCompletion` and unlinks.
- Ingest explicitly keeps `restoreHeld` and reservation (completion is not artifact cleanup). `validate` still requires completed upload + `restoreHeld` + prepared ref.

Kill after commit, before consume, reopen under the **new** identity:

- Control `workspaceId` is already the restored id; proof `workspaceId` must match the opener (`readBackupColdCompletion`).
- `matchingCompletion` is true via `proof.workspaceId === header.workspaceId` and the operation row.
- Phase is already `completed` → no second revision, no reservation release → consume the leftover file.

(Apply may still hold the journal out until the v2 stage file is gone; that is apply replay, not this ingest window. The preserved-applying-stage test is outside the 87 and belongs in the full gate.)

### (2) Restore-lock empty init — **PASS**

`restore-lock.sqlite` is only a process mutex: `restore_owner (id INTEGER PRIMARY KEY CHECK(id=1))`, no rows, no operation/journal/business payload.

Empty first create:

1. `wx` 0o600 (or `EEXIST`)
2. `BEGIN IMMEDIATE`
3. Init **only if** `stat.size === 0 && schema.length === 0 && user_version === 0`
4. `CREATE TABLE` + `user_version=1` → `fault('initializing')` → **COMMIT**
5. New `BEGIN IMMEDIATE`, exact-schema check, **then** `work()` (stage/apply)

`stat` is from **before** `DatabaseSync`, so a crash before COMMIT on a still-zero file is re-initialized under the lock. After a successful init COMMIT, a later crash is a normal mutex take: schema already valid.

Unknown nonempty files skip init and **hold** if schema/sql/`user_version` is not exactly that one table. No timeout steal: live `BEGIN IMMEDIATE` failure is “Another process is preparing or applying…”. `finally` rolls back and closes; a dead process drops the OS lock.

Fault seams `'created'` and `'initializing'` match the claimed kill tests.

**Not claimed:** product release, UI/coordinator wiring, or the extra applying-stage replay test until the full gate runs it.