## Findings

### 1. Single completion slot can be overwritten before journal ingest (permanent rebind hold)

**Trigger.** Bound cold apply is durable without the journal. `applyStagedPrivateRestoreV2Unlocked` writes `private-workspace-restore-v2-completion.json` via `atomicBytes` (replace/rename) whenever `stage.operation` is set. It never refuses an existing completion. The journal never deletes that file after rebind. `stagePrivateRestoreV2Unlocked` also never looks at it.

Sequence:

1. Journal header `A`, live `workspace.json` `A`
2. Stage+apply restore `A → B` with binding `{ operationId, previousWorkspaceId: A }`
3. Business tree is now `B`; completion is `{ previous: A, workspace: B }`; v2 stage is gone
4. Journal is **not** opened
5. Stage+apply restore `B → C` (stage correctly checks live identity `B`)
6. Completion is replaced with `{ previous: B, workspace: C }`

**Effect.** Next `createBackupOperationStore({ workspaceId: C, restoreDirectory })` reads header `A` and proof `previous=B`. Rebind requires `proof.previousWorkspaceId === header.workspaceId`. That fails closed. Business files are already `C`. The only authenticated proof that `A` was restored is gone. Same-workspace replay cannot help (`header !== C`). Public receipt cannot rebind. Reservations/held rows for the original upload stay in the journal and stay invisible to `C`.

This is the composition of the two modules, not an HTTP coordinator guess.

**Narrow fix.** Treat completion as a one-shot ingest, not a scratch file.

- Apply: if `PRIVATE_BACKUP_COMPLETION_FILE` already exists, `hold()` (do not overwrite).
- Journal: after a verified rebind/idempotent complete, `unlink` that file (same empty-stage discipline you already use), `fsyncDir`.
- Stage: if a completion exists, `hold()` until the journal has consumed it.

Test: apply `A→B` (with binding), skip journal open, apply `B→C`, then open journal as `C` — must hold **before** the second completion publish, not after. Positive path: apply `A→B` → journal open as `B` (ingest+delete) → apply `B→C` → journal open as `C`.

---

### 2. Restore lock first-publish is empty-create, not complete-then-link

**Trigger.** Kill (or crash) after `open(restore-lock.sqlite, 'wx')` and before `CREATE TABLE restore_owner` / `user_version=1`.

**Effect.** Next `withRestoreLock` sees `EEXIST`, `first=false`, empty schema, `hold()`. Unlike `operations.sqlite`, there is no complete candidate, exclusive hardlink, or authenticated empty extra-link takeover. Cold stage/apply cannot run until the lock file is manually removed. That is the window the journal init rewrite was meant to close.

**Narrow fix.** Same pattern as the journal: build a private complete lock DB, `file.sync()`, exclusive `link`/`rename` onto `restore-lock.sqlite`; on open, only an authenticated empty initializer may be recovered. Test: kill between `wx` create and schema publish; a second process must recover or fail in a documented repair path, not a generic 503 on a 0-byte lock.

---

## Remaining integration limits (exact)

- **Public v2 HTTP/UI coordinator is unwired.** These modules are an internal component. No native Windows/macOS product acceptance from local checks. Kill tests for **publication** boundaries are still being added; do not treat the 45/41 unit counts as that coverage.
- **Call order is mandatory and not enforced in one function:** `applyStagedPrivateRestoreV2` (unlink v2 stage) **before** journal open. `readBackupColdCompletion` `hold()`s if `private-workspace-restore.json` or `private-workspace-restore-v2.json` exists. Crash after completion publish and before stage unlink is recoverable only by applying again first.
- **Binding is required for rebind.** Stage/apply without `operation` still replaces business bytes and writes the plaintext receipt; it does **not** write encrypted completion. Journal will not rebind from that receipt. Host must pass an internal `operationId + previousWorkspaceId` and the same installation key used for the journal.
- **Host must pass `restoreDirectory` as the live business root** for any header ≠ current workspace. Omit it and cross-workspace open fails. `workspace.json` must remain exactly `{ id, version, workerMemberKey }`.
- **Journal directory must not be a restore target path.** Apply hashes/replaces manifest paths; a journal inside that tree can be replaced or can fail `inspectTarget`.
- **Old rows stay owned by the old workspace id.** Rebind may mark that upload `completed` but does not rewrite `operation.workspaceId`. New `get`/`list`/`update` 404 those ids. `update` cannot lower that reservation. `prune` never drops `restoreHeld`. **Global `records` + `reservedBytes` still include them until physical cleanup, which is still coordinator work.** Lifetime restore-held rows also consume the 1000-record cap with no delete API.
- **Same-workspace completion replay is idempotent** only when proof matches the held upload (phase in `staging|staged|applying|failed|completed`, prepared ids/digest, preview workspace, artifact `archiveDigest`, preview/receipt bytes). A decryptable completion whose id exists but bytes do not match fails the **entire** store open (not a skip), including same-workspace opens with `restoreDirectory` set.
- **Init leftovers are manual.** Unpublished `.operations-init-*.sqlite` (and possible `-journal` sidecars) are not deleted except the publisher’s own temp on a cooperative finally, or the extra hardlink of an authenticated empty initializer (`owner==null`, `records==0`, same ino/dev, `nlink==2`). A 33rd directory entry fails closed. Empty/truncated fixed `operations.sqlite` is held (`!size`).
- **Ownership:** live `kill(pid,0)` including this PID → 409; takeover is **ESRCH only**. PID reuse by an unrelated live process 409s until that PID dies. `SQLITE_BUSY` (`busy_timeout=0`) on a concurrent opener is not mapped to that 409.
- **Cold lock:** no timeout takeover of a live restore writer (by design). Interrupted first lock create is Finding 2.
- **Windows/macOS:** hardlink + `nlink` 1|2 admission, dir `fsync`, and ACL work assume a **local** NTFS/APFS volume (not FAT, sync-folder, or cross-device). `atomicBytes` already refuses cross-dev scratch/target. Do not infer enterprise Windows acceptance from Unix nlink tests. `windowsFilePrivacy` is required for ACL; POSIX `0o700` is ignored on Windows.
- **Prepared/capture/archive** still own business-byte integrity; this review did not re-audit those modules.