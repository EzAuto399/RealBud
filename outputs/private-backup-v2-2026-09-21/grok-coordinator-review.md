# Private backup v2 coordinator — architecture review and minimal plan

This slice is the **authoritative host snapshot lease + durable export/preview coordinator + authenticated loopback HTTP**. It does not replace v1 UI, does not ship a transfer panel, and does not claim packaged/Windows proof. Codex owns implementation. Public JSON must keep parsing under `shared/private-backup-transfers.ts`.

The existing domain stack is already the worker. The coordinator is the missing owner: admission, exclusive mutation, process ownership, lease lifetime, passphrase custody, artifact identity, and projection. Do not add a second archive stack or a generic job framework.

---

## 1. What this slice owns

| In | Out |
|---|---|
| Snapshot lease acquire/drain/release | v1 envelope/reader/UI (keep as-is) |
| Durable operation journal + public projection | Browser/UI panel, native save bridge |
| Export: admit → capture → verify → **release lease** → graph/seal → `ready` | Cloud, publish, retention-deletion of business evidence |
| Upload wrap of the existing sliced store | Raw SQLite attach/execute |
| Preview bound to reviewed archive digest | Persisting passphrase / archive key / source key |
| Confirmed stage into **fresh** install | Cancel/delete after stage |
| Loopback binary routes + download tickets | Browser-supplied filesystem paths |
| Aggregate scratch reservation | Changing cold apply / bootstrap dispatch |

Cold apply, prepared-store crypto, codec, catalog, and bootstrap already exist. The coordinator **calls** them; it does not reimplement them.

---

## 2. Reuse vs new code

### Reuse as-is (do not fork)

| Module | Coordinator use |
|---|---|
| `shared/private-backup-transfers.ts` | **Only** public shape. Every status/list/ticket response must `parse*` successfully. |
| `server/private-backup-transfer.ts` | Byte store for `kind: 'upload'`: intent-before-write, identical-chunk receipts, prefix commitment, process ownership, cancelled retention, target-key journal. |
| `server/private-backup-capture.ts` | `capturePrivateWorkspace` + `verifyPrivateWorkspaceCapture`. Keep `assertLease()` on every yield/mutation. Release lease **only after verify resolves**. |
| `server/private-backup-catalog.ts` | Installation-key encrypted catalog. Capture target. Graph lookups after lease release. |
| `server/private-backup-archive.ts` | `encodeBackupCatalog` / `decodeBackupCatalog({ expectedArchiveDigest })`. |
| Codec + graph validators | Footer/EOF, complete graph, v1 adapters untouched. |
| `server/private-backup-prepare.ts` + `private-backup-prepared.ts` | Target-key prepared artifacts. |
| `server/private-backup-cold-restore.ts` | `stagePrivateRestoreV2` under host write barrier; idempotent same-stage; hold on conflict. |
| `server/bootstrap.ts` | v1/v2 stage dispatch, conflicting-stage reject, completion receipt. Coordinator **projects** `staged` / `applying` / `completed`; it does not apply. |
| Session/Host/Origin helpers | Same policy as existing authenticated loopback APIs. |
| Fixed scrypt + Node AEAD | Already in codec. No new KDF. |

`createBackupTransferStore` is **not** the coordinator. Its states (`uploading | uploaded | staged | cancelled`) are internal to the blob journal. Map them into v2 phases in the coordinator record.

### New (minimal)

| File | Responsibility |
|---|---|
| `server/private-backup-lease.ts` (or equivalent host seam in `index.ts` **only** if that is where writers already live) | Reversible snapshot lease: block new work, drain, pause clocks/bridges **without** queue-clearing stop, allowlist status/cancel/recovery. |
| `server/private-backup-v2.ts` | Operation owner: journal, reservation, ownership, phase machine, passphrase memory, orchestration, projection. |
| `server/private-backup-transfer-api.ts` | `/api/private-backup/v2` JSON + binary + tickets. Paths/IDs/digests only. |

Do not add: plugin runner, second sqlite upload path, independent scratch key, generic workflow engine, or a v2 JSON reader fallback through v1.

### Host gaps (lease) — new code required

Current stop methods are **not** a snapshot:

- Bridge / office-link stop does **not** prove in-flight async work drained.
- Telegram / Discord / Slack stop **clears inbound queues and pending relays** — forbidden for export pause.
- v1 export idle/epoch/second-read is insufficient; capture already demands a real write lease.
- Restore write barrier is a **different** hold. Export must not take it, not clear it, and must refuse admission if a restore hold/stage exists.

Reuse `startTurn`, executor, mail, background-bridge, and request-accounting **boundaries** as the block/drain set. Add: (1) a generation/epoch, (2) writer drain that waits for in-flight work to **finish or abort-without-commit**, (3) pause that keeps queues/receipts, (4) an allowlist so poll/cancel/status are not “business work”.

---

## 3. Public contract (do not “fix” in the coordinator)

Projection bugs will fail the shared parser. Encode these as coordinator invariants, not UI convenience.

**Kind split**

- `export`: backup production only. **Illegal** phases: `uploading`, `uploaded`, `checking`, `reviewed`, `staging`, `staged`, `applying`. Illegal fields: `receivedBytes`, `prefixCommitment`.
- `upload`: restore path. **Illegal** phases: `capturing`, `ready`.

**Export phases:** `capturing` → `sealing` → `ready` → (`cancelled` \| `expired` \| `completed` if you keep a downloaded-and-retained terminal) plus `interrupted` / `failed`.

Treat export `completed` as optional later; **`ready` is the downloadable state**. Do not invent a restore on an export id.

**Hard parser rules**

- `canCancel === false` for `staging | staged | applying | completed | cancelled | expired`.
- `requiresPassphrase === true` **only** for `interrupted | failed | uploaded`.
- Therefore: live `capturing` / `sealing` / `checking` **must not** advertise passphrase. The owner process holds it in RAM. After crash, the durable phase is `interrupted` (or `failed`), never a live phase with `requiresPassphrase`.
- `artifact` forbidden on `capturing | uploading | cancelled | expired`; **required** on `ready | uploaded | checking | reviewed | staging | staged | applying | completed`.
- `preview` only with `artifact`, only on `ready | reviewed | staging | staged | applying | completed`, and `preview.digest === artifact.archiveDigest`.
- `preview` **required** on `reviewed | staging | staged | applying`.
- Upload: `receivedBytes === total` for every phase after `uploading`; incomplete prefix must be chunk-aligned; `artifact.archiveBytes === totalBytes`.
- No scratch paths, keys, passphrases, raw exceptions, or business bodies in the projection.

Error codes: only `PRIVATE_BACKUP_TRANSFER_ERRORS`. Map ENOSPC → `insufficient-space`, live lease conflict → `workspace-busy`, staged/fresh failure → `restore-unavailable`, journal/lock/malformed op → `recovery-required`, bad footer/graph → `invalid-backup`, KDF/passphrase → `incorrect-passphrase`.

---

## 4. Durable state machine

One coordinator record per operation. Encrypted with the **installation/target key** (same class as the transfer journal and catalog). Never write archive key, source key, or passphrase into that record.

### 4.1 Internal vs public

Keep a small internal status; project the public phase.

```
Internal                         Public          Lease
-------------------------------- --------------- --------
admitted                         capturing       acquire
capturing / verifying            capturing       held
captured_verified                sealing         released
sealing_archive                  sealing         off
ready                            ready           off
export_interrupted_preverify     interrupted     must be off
export_interrupted_preseal       interrupted     off, requiresPassphrase
failed / cancelled / expired     same            off

upload_receiving                 uploading       off
upload_complete                  uploaded        off, requiresPassphrase
previewing                       checking        off (RAM passphrase)
reviewed                         reviewed        off
staging                          staging         restore barrier, not snapshot lease
staged / applying / completed    same            restore hold
```

`checking` is **owned**. If the process dies, do not leave `checking` on disk — recover to `interrupted` + `requiresPassphrase: true` + artifact intact.

### 4.2 Export transitions

```
start(passphrase in RAM)
  → serialize admission
  → reject if restore hold/stage, another capturing export, or reservation fail
  → create op dir (server UUID, never client path)
  → acquire lease (sync after admission)
  → capturing

capturing
  → capturePrivateWorkspace(assertLease)
  → verifyPrivateWorkspaceCapture(assertLease)   // still held
  → persist: catalogId, catalogDigest, sourceDigest, counts
  → RELEASE LEASE                                 // invariant: before graph/seal
  → sealing

sealing
  → complete graph validation on immutable catalog
  → encodeBackupCatalog (passphrase still RAM-only)
  → footer, fsync file + dir, whole-file digest
  → publish artifact { archiveBytes, archiveDigest }
  → publish preview receipt (digest === archiveDigest)
  → zero passphrase buffer
  → ready

ready
  → issue download ticket (new ticket allowed; do not recapture)
  → cancel → cancelled (delete *this op’s* downloadable scratch only)

cancel during capturing
  → close writers, RELEASE LEASE, mark cancelled, delete unstaged scratch
  → never clear restore hold, never touch business files

cancel during sealing
  → abort encoder, delete partial archive, cancel catalog scratch
  → lease already off
```

**Idempotency**

- `POST export` while this workspace already has a live export owner → return that operation (or `workspace-busy` if another tab tries a second *new* export). Do not start a second capture.
- Poll is read-only and allowlisted under the lease.
- `ready` download ticket may be reissued for the same artifact + current service generation. Ticket failure must not reseal or recapture.
- Cancel on `cancelled` is a no-op success.

### 4.3 Upload / preview / stage transitions

```
start(size)
  → reservation + active cap
  → createBackupTransferStore upload
  → uploading { receivedBytes: 0, prefixCommitment }

append(offset, size, sha256, bytes)
  → existing store: identical retry → original receipt
  → changed bytes / gap / overlap / wrong id → fail, do not move offset
  → project receivedBytes + prefixCommitment

complete(total, wholeDigest)
  → store verifies length + digest
  → artifact { archiveBytes: total, archiveDigest }
  → uploaded, requiresPassphrase: true

preview(passphrase in RAM)
  → only from uploaded | interrupted(after complete)
  → checking (owned, not durable)
  → decodeBackupCatalog({ expectedArchiveDigest: artifact.archiveDigest })
  → complete graph
  → persist preview receipt (installation-key catalog in op dir)
  → zero passphrase
  → reviewed, requiresPassphrase: false

wrong passphrase
  → stay uploaded (or failed with incorrect-passphrase)
  → requiresPassphrase: true
  → do not keep a decrypt key to skip retry

stage(confirm, archiveDigest)
  → only reviewed
  → archiveDigest must equal artifact.archiveDigest === preview.digest
  → assertFresh + assertIdle + host restore barrier
  → preparePrivateBackupRestore (target key)
  → stagePrivateRestoreV2({ expectedPreparedDigest, receipt })
  → if existing stage matches directoryId/storeId/preparedDigest/receipt → { needsRestart } (idempotent)
  → if existing stage differs → hold, recovery-required, do not overwrite
  → public: staging then staged, canCancel: false
  → from this point coordinator cleanup MUST NOT delete prepared artifacts, stage file, or evidence
```

`applying` / `completed` come from bootstrap + existing validated status receipt. Coordinator list/get **reads** them; it does not drive apply.

### 4.4 Cancellation matrix

| Phase | Cancel | Scratch |
|---|---|---|
| capturing, sealing, uploading, uploaded, checking, reviewed, interrupted (unstaged), failed (unstaged) | yes | owned op scratch only |
| ready | yes | downloadable archive scratch (documented retention); not business data |
| staging, staged, applying | **no** (`canCancel: false`) | **retain** prepared store, stage file, evidence |
| completed, cancelled, expired | no | retention policy only; never age out staged restore |

Cancel must run even while a snapshot lease is held (export). It releases **that export’s** lease after writers close.

---

## 5. Invariants (test these; do not document around them)

### 5.1 Snapshot lease

1. Acquired **synchronously after admission**, before first capture read.
2. Blocks new HTTP **and** non-HTTP mutating work, including recovery/refresh reads that persist.
3. Drains in-flight writers; success means no further durable business write can land until release.
4. Clocks/bridges pause without using chat **stop** that drops queues; inbound queues and pending relays survive pause/resume.
5. Allowlist: operation get/list, cancel, recovery status. Polling is not business work.
6. **Release only after** `verifyPrivateWorkspaceCapture` succeeds (or after capture writers close on fail/cancel).
7. Graph validation, encode, download, upload, preview run **without** the snapshot lease.
8. Fail/cancel releases this lease; it never clears a restore hold.
9. Staged/applying restore → export admission refused (`restore-unavailable` / `workspace-busy`).
10. Capture tests may keep fixture leases; production coordinator must pass the real host lease into `assertLease`.

### 5.2 Keys and passphrase

- Persistable: installation/target key for journals, catalogs, prepared artifacts, stage file.
- RAM-only, owner-lifetime: passphrase, derived archive key. Clear on ready/reviewed/fail/cancel/close.
- Never: source installation key in v2 archive (already omitted), archive key in operation metadata, URL, ticket, logs.
- Interrupted seal or preview → `requiresPassphrase: true` and a **new** KDF/decrypt. No “resume with stored archive key”.
- After `reviewed` / `staged`, cold path uses target key only.

### 5.3 Identity binding

| Object | Identity |
|---|---|
| Operation | server UUID |
| Upload prefix | `prefixCommitment` (existing store) |
| Artifact | `archiveBytes` + SHA-256 of **complete** file |
| Preview | `PrivateBackupReceipt.digest` **===** artifact digest |
| Catalog | `catalogId` + `catalogDigest` from capture receipt |
| Prepared | `storeId` + prepared digest |
| Stage | `directoryId`, `storeId`, `workspaceId`, `preparedDigest`, `targetGuard`, receipt |

Stage request must send the reviewed archive digest. Mismatch → reject, no prepare. Browser never sends a directory or sqlite path.

Decode **always** passes `expectedArchiveDigest`. A completed upload that cannot match its declared digest is `invalid-backup`, not a preview.

### 5.4 Archive / preview trust

Trusted preview (and therefore `preview` on the projection) only after:

1. Authenticated footer/EOF,
2. Every entry,
3. Complete business graph,
4. Digest match to the completed artifact.

Partial catalogs from a killed `checking` are untrusted: leave them for diagnosis or discard only with the unstaged op; never publish `preview`, never stage.

### 5.5 Disk reservation (aggregate, not per-component max)

Per-module caps (1 GiB archive, prepared 1 GiB, capture 2 GiB source, 8 MiB file, catalog growth) are **not** a global budget. Admission:

```
reserved = sum over live ops of
  remaining upload bytes
  + catalog scratch
  + archive output (export: up to declared max, typically ≤ 1 GiB)
  + preview decode catalog
  + prepared destination bytes
  + one largest atomic replacement
  + safety margin
```

- Reject if `reserved + request > scratchQuota` or advisory `statfs` free space is insufficient → `insufficient-space`.
- Hold reservation until terminal unstaged cleanup, or until staged restore no longer needs it (apply completion).
- `statfs` is advisory. ENOSPC / fsync / rename failure: stop, original business bytes unchanged, op `failed` or `recovery-required`, no guessed success.
- Serialize reservation updates with journal admission (two tabs cannot oversubscribe).

Cap live operations at the existing transfer bound (`MAX_ACTIVE = 4`). List pages ≤ 20 items.

### 5.6 Active-owner crash recovery

Reuse the transfer-store rule: **confirmed process exit**, not a timeout, allows takeover.

On open:

1. If owner pid/nonce still alive → do not steal; project current phase (or `interrupted` if the owner is wedged and the journal says so).
2. If owner is dead:
   - `capturing`: mark `interrupted`, `requiresPassphrase: false`, **do not resume mid-capture** (catalog is provisional). User cancels (delete scratch) or starts a **new** export. Release any stale lease bookkeeping (the process is gone; do not leave the host permanently paused).
   - `sealing` with verified capture: `interrupted`, `requiresPassphrase: true`, keep sealed catalog, **delete/ignore partial archive file**, resume = passphrase + encode to a new artifact path.
   - `checking`: `interrupted`, `requiresPassphrase: true`, keep upload artifact, drop untrusted preview catalog.
   - `staging` with no matching stage file: `recovery-required`, `canCancel: false`, **keep** prepared dir. Human/recovery only.
   - Matching stage file: project `staged`; bootstrap owns apply.
   - `ready` / `uploaded` / `reviewed`: ownerless; durable.
3. Unexpected scratch vs journal (length/digest) → hold `recovery-required`, do not advance offset or publish artifact.
4. Malformed operation/stage → hold for diagnosis, do not silently replace.

### 5.7 Cold-stage reconciliation

Already in `stagePrivateRestoreV2`; coordinator must not weaken it:

- Fresh workspace + idle + epoch.
- No v1 stage; no conflicting v2 stage.
- Same stage tuple → idempotent `{ needsRestart: true }`.
- Prepared artifacts stay readable with the **unchanged destination key**.
- After stage, cancellation cannot delete restore evidence.
- Apply remains bootstrap + process-owned SQLite lock; coordinator is read-only for those phases.

### 5.8 HTTP / tickets

- Namespace: `PRIVATE_BACKUP_TRANSFER_API` (`/api/private-backup/v2`).
- Binary **before** `readBody()`; never stringify the archive.
- Every control and binary route: session + Host + Origin (loopback policy).
- Identifiers: operation UUID, ticket token, offsets, SHA-256. **No** `directory`, file path, or sqlite upload.
- Ticket URL must match `^/api/private-backup/v2/downloads/[A-Za-z0-9_-]{32,128}$`.
- Filename must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.realbud-backup$`.
- Ticket binds **one** completed artifact + current service generation; no session token, no passphrase; no-store; do not log the token.
- New ticket on failed download; **no implicit snapshot rebuild**.
- Distinguish internally: artifact generated vs ticket issued vs bytes written to the response. The public object has no “saved on disk” claim.

Dropped HTTP / timeout ≠ failure of the op. Client must GET status before retry (two-tab / lost-response rule).

---

## 6. Suggested HTTP surface (control vs binary)

All under `/api/private-backup/v2`. Bodies are the public types or `{ operation }`.

| Method | Path | Notes |
|---|---|---|
| GET | `/` or `/operations` | Bounded page, `parsePrivateBackupTransferPage` |
| POST | `/exports` | Passphrase RAM-only; starts capturing |
| POST | `/uploads` | `{ archiveBytes }` (and optional declared digest if you already require it at complete only — keep complete as source of truth) |
| PUT | `/operations/:id/chunks` | Binary; offset + digest headers; delegate to transfer store |
| POST | `/operations/:id/complete` | Upload only |
| POST | `/operations/:id/resume` | Interrupted + passphrase; export seal or upload preview |
| POST | `/operations/:id/preview` | Upload; passphrase; bind digest |
| POST | `/operations/:id/stage` | `{ archiveDigest }`; fresh/idle |
| POST | `/operations/:id/cancel` | Unstaged only |
| POST | `/operations/:id/download-ticket` | Export `ready` only; `parsePrivateBackupDownloadTicket` |
| GET | `/downloads/:token` | Artifact bytes; ticket auth only |

Do not accept a second complete/preview/stage with different digest. Identical complete with same length+digest is idempotent.

Export passphrase: accept on `POST /exports` and hold until seal, **and** on `resume` after crash. Do not put it on poll.

---

## 7. Implementation order (Codex)

Keep each step merging with a parser-roundtrip test. Stop before UI.

1. **Lease seam** with a fake host in unit tests: block mutating route + timer + recovery-write; allow GET op + cancel; pause bridge **without** queue clear; drain latch; restore hold untouched; lease still held through verify, released before a spy on `encodeBackupCatalog`.
2. **Coordinator journal** in the installation-owned transfer directory (sibling table/file, target-key encrypted). Records + ownership + reservation. Project every phase through `parsePrivateBackupTransferOperation`.
3. **Export path** wired to real capture/verify/archive. Assert lease release ordering with a test spy. No HTTP yet.
4. **Crash table**: kill after admit, after capture write, after verify, after partial encode, after artifact fsync-before-receipt. Expected phases as in §5.6.
5. **Wrap upload store**; do not reimplement chunks. Project `prefixCommitment` / `receivedBytes`.
6. **Preview + stage** with digest binding; refuse stage without `reviewed`; refuse cancel after stage; conflicting stage holds.
7. **HTTP adapter**: session/Host/Origin, binary order, tickets, two serialized tabs, lost-response “GET before retry”.
8. **Leave** `PrivateWorkspaceBackup.tsx` on v1. Do not register v2 panel in this slice.

Host integration in `server/index.ts` should be: construct store + coordinator, register routes, pass real `assertLease` / `assertFresh` / `assertIdle` / epoch. No new global bus.

---

## 8. Tests that define “done” for this coordinator

Source-level, no customer data, no packaging:

- Parser golden: one fixture per public phase × kind, including illegal combinations that must not be emitted.
- Lease: HTTP mutate blocked; mail/executor/timer blocked; status/cancel succeed; chat queues still present after resume; restore stage still present; encode not entered until verify completed and lease released.
- Export happy path: capture receipt → verify → lease off → graph/seal → `ready` with `preview.digest === artifact.archiveDigest`.
- Passphrase absent from sqlite bytes and status JSON (scan journal + projection).
- Resume seal after killed owner: passphrase required; partial archive not trusted; new artifact path.
- Mid-capture kill: no resume; cancel cleans catalog; business dir unchanged.
- Upload identical chunk / mutated chunk / two-tab append serialization (store + coordinator admission).
- Preview with wrong digest, truncated archive, wrong passphrase.
- Stage without preview; stage digest mismatch; second stage same tuple idempotent; different tuple holds.
- Cancel after `reviewed` deletes preview scratch; cancel after `staged` is 409 and files remain.
- Reservation: two large uploads refused at aggregate quota; ENOSPC during encode fails safe.
- Ticket: wrong origin/host rejected; path-looking ids rejected; ticket does not recapture.

Do not treat `cold-initial.log` history, in-memory pipeline archives, or catalog-growth measurements as this slice’s receipt.

---

## 9. Explicit non-goals (reject if they appear in the PR)

- Wiring the sliced browser helper or replacing v1 import UI.
- Keeping the snapshot lease during encode/download “so the archive matches later” — capture is already verified; later work is on immutable scratch.
- Reusing Telegram/Discord/Slack stop for pause.
- Persisting archive key to avoid passphrase re-entry.
- Browser `directory` / sqlite file as restore input.
- Deleting prepared artifacts because the user hit Cancel after stage.
- Publishing, remote copy, or claiming a backup was saved on another computer.
- Routing v2 bytes through the v1 JSON reader.
- Packaged macOS/Windows ACL/DPAPI/GUI proof (later gate; current Mac package predates this).

The usable product remains **v1** until a later slice wires the panel on this coordinator. This slice is complete when a loopback session can export to `ready` (lease released before seal), upload/resume/preview/stage with digest binding, recover a dead owner without losing staged evidence, and every status payload parses with the shared contract.