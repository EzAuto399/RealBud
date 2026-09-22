# Private backup operation store review

Read-only review of the unwired control journal (`createBackupOperationStore`), with the public transfer contract and cold-restore completion path as the integration boundary. No tools, no file changes. Comments treated as intent, not proof.

**Verdict:** Fail-closed ownership, SQL length bounds, and sticky `restoreHeld` vs cancel are mostly right. Do not wire a coordinator until completion/artifact freezes and workspace-identity reconcile exist. Author suspicions are **confirmed**; two completion/identity holes are higher value than the async callback issue.

---

## Author suspicions

| Suspicion | Result |
|---|---|
| Async `change` callbacks accidentally accepted | **Confirmed.** `update`’s `change: (record) => void` is invoked inside `BEGIN IMMEDIATE` and the return value is ignored. In TypeScript, `async` functions are assignable to `() => void`. A thenable returns immediately; the tx commits a no-op revision bump (or only pre-`await` mutations). Later mutations hit a clone that is never saved. Same-process `get`/`list` can also interleave after that commit. |
| Invalid completion from unheld exports | **Confirmed, and broader.** `failed → completed` is in `transitions` for **both** kinds. Exports cannot have `restoreHeld`. Uploads can complete from `failed` **without** `restoreHeld`. `staged → completed` skips `applying`. Export happy path is `ready` only (`ready → completed` is absent), so `completed` is not a real export success state; it is reachable only via the illegal `failed` edge. |
| Incomplete workspace-change reconciliation | **Confirmed, and blocking after cold restore.** Open requires `control.workspaceId === options.workspaceId`. Cold apply writes the **archive** UUID into `workspace.json` before HTTP bootstrap. The journal stays bound to the **destination** UUID, so post-restore open is 503. There is no explicit reconcile. A control-only rebind would still brick the file: `totals()`/`list()` validate every row against the new id. |

---

## Findings (priority order)

### 1. `failed` / `staged` → `completed` without a held restore (and export `completed`)

**Trigger:** `update` with `failed → completed` on an export, or on an upload with `restoreHeld === false`. Also `staged → completed`, which skips `applying`. `validate` requires `restoreHeld` only for `staging|staged|applying`, not for `completed`. Closed-phase artifact checks are skipped (finding 2).

**Consequence:** Journal can say the transfer finished when no export succeeded and no cold apply ran. `reservedBytes` may go to 0 (`restoreHeld && phase !== 'completed' && !reservedBytes` is the only reservation invariant). That contradicts sticky staging reservations and “cancel keeps staged artifacts.” A later cold apply can still fail while HTTP believes the op is done.

**Fix/test:** Tighten `transitions`: `completed` only from `applying` (upload). Reject `kind === 'export' && phase === 'completed'` in `validate` (success stays `ready`). Require `restoreHeld === true` for upload `completed`. Test: export `failed`+artifact cannot complete; upload `failed` without hold cannot complete; `staged → completed` 409s; `applying`+hold → `completed` with `reservedBytes === 0` is the only release path.

### 2. Artifact (and prepared refs) mutable on the way to `completed`

**Trigger:** `before.operation.artifact && !closedPhases.has(next.phase)` is the only freeze. `completed` is closed, so digest/bytes can change in the same write. `references.capture|preview|prepared` are never frozen. A restore-held update can retarget `prepared.storeId` / `digest`.

**Consequence:** Control record can name a different archive or prepared store than the one staged on disk. Coordinator/HTTP would trust the swapped digest. This module does not hold bytes, but it is the only durable binding the coordinator will have.

**Fix/test:** Once `artifact` is set, require deep equality forever (cancel/expire still **delete** it; parser forbids artifact on those phases). Once `restoreHeld`, freeze `references` and `reservedBytes` except `reservedBytes → 0` on the applying→completed path. Test: `applying` → `completed` with a different `archiveDigest` or `prepared.digest` fails; cancel from `ready` may drop artifact.

### 3. Post-restore journal is unreadable; silent UUID rebind is unsafe

**Trigger:** Successful `applyStagedPrivateRestoreV2` writes `PRIVATE_RESTORE_RECEIPT_FILE` (archive `receipt.workspaceId`), deletes the v2 stage file, does not touch `operations.sqlite`. Next `createBackupOperationStore({ workspaceId: archiveUuid })` fails at `control()`. If someone only patches `control.workspaceId`, `validate(..., newId)` 503s on every old row (`op.workspaceId` and `references.capture.workspaceId`).

**Consequence:** After every successful restore, `/api/private-backup/v2` cannot open the store. Destination exports still in the file are not the new workspace’s transfers. Silent rewrite of `operation.workspaceId` would publish foreign history under the restored identity.

**Fix/test:** See reconciliation boundary below. Test: open with new UUID + no receipt proof → 503, owner row unchanged. Open with proof of **only** the new UUID (wrong/missing previous id) → 503.

### 4. Thenable `change` is committed as success

**Trigger:** `await store.update(id, rev, async (r) => { await check(); r.operation.phase = 'applying'; })`.

**Consequence:** Caller observes a new revision and the **old** phase. Passphrase/progress work in the continuation never lands. Two in-process stores are already refused; this is the remaining same-PID “publish after we own the journal” hole. The takeover comment is not enforced for this path.

**Fix/test:** After `change(next)`, if `result` is thenable, `fail(..., 400)` and do not bump revision. Keep the type `void` (not `Promise<void>`). Test: async callback leaves row at old revision/phase; sync callback still works.

### 5. First-create crash leaves a permanent 503 file

**Trigger:** `open(path, 'wx')` succeeds, process dies before `first` schema `INSERT`. Next open sees `EEXIST`, `first === false`, schema/user_version check fails → 503. Files are preserved, including an empty `operations.sqlite`.

**Consequence:** Backup HTTP is dead until the file is removed by hand. Unlike live-owner 409, there is no documented recovery. Same class as a truncated payload (correct fail-closed) but here the file was created by this module and never valid.

**Fix/test:** If the file size is 0 (or schema missing and size ≤ page) **and** no `control` row, treat as `first` and create schema, or refuse to `wx`-create until schema is written in the same tx as a durable non-empty header. Test: empty existing file + valid key/workspace becomes a fresh store **or** a dedicated 409 with an explicit recreate API; it must not loop 503.

### 6. `list`/`totals` vs `active` on resume (lower)

**Trigger:** `create` enforces `active` / `records`; `update` does not. Not a bypass of `records` (rows already exist). `failed` and `interrupted` count as active, so this is mostly OK.

**Consequence:** Low. Resume cannot raise the row count. Worth a guard only if a future phase can leave `closedPhases` without `create`.

**Fix/test:** Optional: after `change`, recompute active from the would-be set and 409 if `> limits.active`. Not a ship blocker vs 1–4.

### Not defects (for this contract)

- **Same-PID live owner refused; ESRCH-only takeover:** `kill(pid, 0)` success → 409, including `process.pid`. Non-`ESRCH` (e.g. `EPERM`) does not take over. `assertOwner` requires pid **and** nonce. Matches the stated rule.
- **Cancel vs staged artifacts:** `staging` has no `cancelled`; `restoreHeld` cannot clear; `cancelled`/`expired` + `restoreHeld` fail in both `validate` and `update`. `prune` never deletes `restoreHeld` or `reservedBytes > 0`.
- **SQL bounds:** payload selected only if `length(payload) <= 2 * recordBytes`; iterate `LIMIT records+1`; `max_page_count` from `journalBytes`. Oversized/too-many → 503, not unbounded read.
- **No keys/passphrases in records:** only `requiresPassphrase` boolean and error codes. Keep it that way in reconcile.
- **`uploading` not flipped to `interrupted` on takeover:** consistent with resumable ciphertext; do not “fix” unless the coordinator requires a crash flag.

`validate` failures during `update` use generic 503. Prefer 400/409 for in-memory callback violations vs on-disk poison so coordinators are not told to “recover files” for a bad transition. Secondary.

---

## Reconciliation boundary (do not silent-rebind)

Cold restore already publishes proof: `PRIVATE_RESTORE_RECEIPT_FILE` `{ receipt.workspaceId, restoredAt, rekeyed, reviewRequired }` **after** files match intended hashes. Use that, plus the journal’s existing header, as a **third** explicit input. Do not infer from `options.workspaceId` alone. Do not write target key or passphrase into control/ops.

Recommended `open` / one-shot `reconcile` arguments:

1. `previousWorkspaceId` must equal `control.workspaceId` (destination journal).
2. On-disk receipt `receipt.workspaceId` must equal `options.workspaceId` (current `workspace.json`) and the receipt body already parsed by the existing receipt helper (no new secret fields).
3. Only then rewrite **control** `workspaceId`.
4. **Do not** rewrite `operation.workspaceId` to the archive UUID. Those rows are destination-side transfer history.
5. Disposition, in the same IMMEDIATE tx:
   - If any row is `restoreHeld` and phase is `staging|staged|applying`, either keep the file unreadable (503) until apply/receipt is consistent, or mark that **one** upload `completed` with `restoreHeld` still true and `reservedBytes === 0` **without** changing `operation.workspaceId`, and **exclude it from `list()`** for the new workspace (forensic row, not a current-workspace item).
   - All other rows: `failed` + `error.code = 'restore-unavailable'` (or move the old sqlite aside as a sealed copy and create a **new empty** operations table for the restored workspace). Empty-new-table is the safer HTTP contract: post-restore export/upload starts clean; old metadata is not advertised as this workspace.
6. Refuse if receipt workspace ≠ `options.workspaceId`, previous id mismatch, or owner is live (same 409 as today).

Coordinator writes `completed` **only after** receipt is on disk (apply already did that) and reconcile has run—not `staged → completed` before restart.

---

## Eight highest-value behavior tests

1. **Owner:** Second `createBackupOperationStore` on the same dir while the first is open → 409, including same PID. After `close()`, reopen works. After crash (owner pid dead), ESRCH takeover rewrites nonce; `EPERM` on `kill` does not take over. Interrupted rewrite: `capturing`/`sealing`/`checking` → `interrupted` + `error.interrupted`; `uploading` and `staged`/`applying` with `restoreHeld` unchanged.

2. **Thenable `change`:** `update(..., async r => { await 0; r.operation.phase = 'sealing' })` throws 400; revision/phase unchanged. Sync `change` that only bumps allowed fields succeeds.

3. **Export completion:** From `failed` (with artifact) and from `ready`, `phase = 'completed'` is rejected. Happy path `capturing → sealing → ready` works. `ready → cancelled` with `reservedBytes = 0` then `prune` removes it.

4. **Upload completion:** `failed` without `restoreHeld` cannot go `completed` or `applying`. `reviewed → staging` must set `restoreHeld` and `canCancel === false` in one update. `staged → completed` rejected. `applying` + hold → `completed` may set `reservedBytes = 0`; `restoreHeld` stays true.

5. **Cancel vs hold:** Any `restoreHeld` update to `cancelled`/`expired` or `restoreHeld: false` → 409. `prune(now)` count 0 while held, even if `updatedAt` is old and phase is `failed`.

6. **Freeze:** After artifact is set, changing `archiveDigest` on `applying → completed` fails. After `prepared` is set, changing `storeId`/`digest` while `restoreHeld` fails. Cancel from `ready` may omit artifact.

7. **Identity:** Store created for destination UUID D. Open with archive UUID A and no receipt → 503; control still D. Reconcile with `{ previousWorkspaceId: D, receipt.workspaceId: A }` matching the cold receipt file → control becomes A; `list()` for A does not return destination export rows (empty or forensic-only). Reconcile with only A (wrong previous) → 503.

8. **Bounds / idempotent create:** Payload/`records` over limit → 503, no partial write. `create` same id + same kind (+ same upload `totalBytes`) returns the existing row and does not add reservation. Different kind or upload size → 409. `reservedBytes` sum over cap → 507. `create` with `reservedBytes === 0` or wrong initial phase → 400.

---

**Wire order:** freeze completion + artifacts (1–2), reject thenables (4), then explicit receipt-gated reconcile (3) with a new empty operations table for the restored workspace. Until those exist, hosted v2 export/upload should not depend on this journal across a cold restore.