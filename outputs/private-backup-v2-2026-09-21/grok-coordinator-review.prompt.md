You are the independent architecture reviewer for the next RealBud private-backup-v2 coordinator. READ-ONLY: use only this packet; no tools, edits, credentials, customer access or agents. Codex owns implementation and integration; other work is ongoing. Return a concrete minimal implementation plan with durable state transitions and invariants (especially idempotency, active owner crash recovery, cancellation, disk reservation, passphrase re-entry, archive identity, preview binding and cold-stage reconciliation). Identify which existing modules can be reused and which gaps require new code. Keep public projection compatible with the shared contract. No speculative new framework. The currently usable UI is v1; v2 domain modules exist but HTTP/UI are not wired. Internal paths must not become browser inputs. Server export must release its host pause after immutable capture/source verification before expensive archive work. No persistable source or archive key; target-key encryption is available. Restoration only into a fresh installation with reviewed exact digest; once staged, cancellation cannot delete restore evidence. Raw uploaded SQLite is forbidden. All external writes or publishing are out of scope. Requested model grok-4.6 xhigh.

### docs/PRIVATE-BACKUP-V2-IMPLEMENTATION-2026-09-21.md
# Private backup v2 implementation checkpoint

Status: source/domain and real source-bootstrap work in progress. The public UI still uses v1. This is not a v2 transfer UI, packaged desktop, native Windows or customer acceptance receipt.

## Implemented

- Authenticated framed archives and encrypted logical catalogs, full footer/EOF and business-graph checks. V2 omits the source installation key. V1 readers keep their existing format and limits.
- Durable sliced upload receipts, prefix resumption, artifact rehash, process ownership, interrupted-write fsync and cancelled-only retention. The sliced browser helper is not connected to HTTP/UI yet.
- Bounded source capture, exact ordinary bytes, fixed SQL schema/insertion ordering and second source/authority verification. The caller must hold a real host write lease; capture tests supply fixture leases.
- Logical restore resets Desk/handoff authority, source-account selection and setup reviews, pauses plans/clocks, interrupts mail/execution and rebuilds execution hash bindings. Drafts and permanent retry identities remain retained. Representative tests compare actual v1 restore results.
- Prepared artifacts keep final randomized destination ciphertext exactly, encrypted under the unchanged destination key. Authenticated before/intended hashes and ordered chunks support immutable sealing and restart replay.
- Compact cold restore validates all prepared data before mutation, accepts only before/intended target states during recovery, rejects changed settings/membership and unfinished database sidecars, and preserves evidence on failure. A process-owned SQLite lock prevents concurrent v2 stage/apply writers. Replacements authenticate and fsync before rename; temporary files stay outside the guarded company directory on the same filesystem.
- Actual `server/bootstrap.ts` handles v1/v2 before application stores load, rejecting conflicting stages. Legacy export/stage refuses pending v2 staging. Completed v2 restoration uses the existing validated status receipt.

## Evidence

Receipts are under `outputs/private-backup-v2-2026-09-21/`. Counts overlap and must not be added as unique tests.

| Check | Result | Receipt |
|---|---|---|
| Full current source suite | 3,945 passed, 143 environment-gated skipped, zero failed; 322 files, 250.57 seconds | `full-source.json`, `verification.json` |
| Codec/catalog/archive/upload/client and compatibility | 268 passed | `integrated-components.log` |
| Capture/transform/prepared/cold/pipeline/bootstrap and v1 domain/API | 129 passed in eight files | `complete-domain-gate.log` |
| Filesystem pipeline | 5,002 records; exact bank original/reviewed record and 5,001 drafts under a different key; production database reopens and recapture validates | `cold-followup.log`, `complete-domain-gate.log` |
| Prepared store | 12 checks including a generated 52 MiB + 17-byte file, corruption, case aliases, stale handles, cancellation, key and path admission | `prepared-tests.log` |
| Cold coordinator and real bootstrap | 18 checks including concurrent staging, interruption after every replacement/removal, streaming target changes, settings/membership, keys and conflicting stages | `cold-lock-tests.log` |
| Large catalog/capture | 5,101 records and 3,103 files; catalog growth observed at 101.8 MB | `catalog-growth-measurement.json`, `catalog-final-tests.log`, `capture-tests.log` |
| Server typecheck | Passed after cold/bootstrap integration | `typecheck-final.log` |

`cold-initial.log` retains seven initial failures. The pipeline fixture used the generic 100-record admission default; it now uses the same permanent-retention setting as the draft store. Cold replacement temporaries initially changed their own company-directory guard; they now use private staging with same-filesystem verification. Recovery checks remain strict.

The pipeline test collects its small generated archive in memory for fixture construction. Codec/catalog growth measurements are separate observations, not a 1 GiB end-to-end SLA. Mail/bill/execution graph and transform checks are separate from the bank/draft pipeline. The GUI and actual OS key store have not exercised v2.

## Required next steps

1. Implement the authoritative host snapshot lease: block new HTTP/non-HTTP work and drain writers before capture, then release only that lease after immutable capture and source verification. Current bridge/office-link stop methods do not prove in-flight async work has drained. Telegram/Discord/Slack stop functions also clear inbound queues and pending relays; do not reuse them for a temporary export pause that would lose queued work. Preserve those queues/receipts through pause/resume. Keep status/cancel/recovery available and preserve restore holds.
2. Implement durable export/preview coordination, bounded operation listing, owned artifact identities, cancellation/restart handling, passphrase re-entry and aggregate disk admission/quota. Per-component limits are not a global scratch budget.
3. Wire authenticated loopback binary routes and artifact tickets, checking session/Host/Origin, IDs and digests. Keep all filesystem paths internal and bind staging to the reviewed archive receipt.
4. Wire progress, cancellation, file-prefix checking after reload, preview/confirm/stage and native browser downloads into the panel. Preserve v1 import. Test desktop/390px, lost responses and two tabs with real HTTP.
5. Verify full source/browser/cold restart, then rebuild/test macOS artifacts and obtain separate current Windows ACL/DPAPI, installer/upgrade and GUI proof. Current source changes postdate the verified Mac package.

Further source gates: ENOSPC/fsync/rename fault injection, killed-process cold-lock recovery, independent prepared/cold review, and quantified aggregate scratch/working-set limits. Internal stage/apply seams do not authorize browser-provided paths or raw SQLite archives.


### docs/PRIVATE-BACKUP-V2-PLAN-2026-09-21.md
# Streaming private backup v2 — reviewed plan

Status: **implementation in progress; v2 is not available in the app yet**. The codec, encrypted logical catalog, resumable upload store, archive adapter and sliced browser helper have focused source tests. Source capture, bounded restore preparation, cold recovery and host/UI integration are being completed. The current v1 backup and its limits remain authoritative for the usable app. Existing packaged macOS receipts predate these modules; there is no v2 browser, package, native Windows or customer backup acceptance yet.

Current implementation and remaining integration gates: [implementation checkpoint](PRIVATE-BACKUP-V2-IMPLEMENTATION-2026-09-21.md). Capture, logical/prepared restoration and real source-bootstrap checks now exist. The host lease, operation coordinator and public transfer flow remain unfinished.

## Outcome and scope

Provide a complete streamed export, resumable upload, authenticated preview and fresh-workspace cold restore for supported private business records. Retain the exact v1 reader and restore path. Do not add cloud storage, remote deployment, arbitrary archive extraction, retention deletion or a generic plugin system.

A streaming HTTP response alone cannot meet this outcome. Current business graph validators accumulate complete decrypted record sets, and the v1 stage embeds all prepared files as base64 in a single encrypted journal. Both must gain bounded alternatives.

Current limits remain distinct:

| Layer | Current boundary |
| --- | --- |
| Backup v1 | 5,000 physical workflow records, 3,000 files, 48 MiB file/history collection limits, 64 MiB decoded snapshot and 96 MiB outer envelope |
| Workflow entity | 8,000,000-character encrypted JSON envelope per record; AES-GCM envelope output is ASCII |
| Source-linked bill/series | Permanent individual heads and aliases; 50 historical revisions and the workflow entity size guard remain |
| Mail | Normalized permanent task/receipt/source records remove aggregate task/receipt/journal caps; source bundles remain 1.4 MB, prepared inputs 950 KB, retained legacy private-vault reads 2 MB |
| Invoice proposals | Permanent individually encrypted request identities; no aggregate admission cap or automatic eviction; per-record size guard remains |

V2 removes the v1 aggregate transport/collection bottleneck within its own declared, tested capacity. It does not remove per-record/entity limits, release application capacity by exporting, or promise indefinite retention. A proposed initial acceptance target is a 1 GiB archive with explicit entry-count and scratch quotas; final supported figures must be established by implementation and measurements rather than silently inheriting v1 limits.

## Module boundaries and ownership for implementation

Implementation follows these exclusive work packages. Preserve other active changes and maintain concrete ownership when assigning follow-up work.

| Work package | Files and responsibility |
| --- | --- |
| Format and codec | New `shared/private-backup-v2.ts` and `server/private-backup-codec.ts`: versioned contracts, fixed supported crypto parameters, bounded binary framing, manifest/footer integrity and codec tests |
| Logical catalog and validation | New `server/private-backup-catalog.ts`; bounded adapter seams in `source-bill-graph.ts`, `execution-history-backup.ts`, `private-backup-mail-validation.ts`, and the current bank validator: logical export/import, catalog lookups and complete graph checks; retain existing v1 array adapters |
| Transfer service and HTTP | New `server/private-backup-v2.ts` and `server/private-backup-transfer-api.ts`: exclusive operations, private scratch journal, upload receipts, progress, expiry/cancel and completed artifact streaming; host owner integrates `server/index.ts` and `session-auth.ts` |
| Cold restore | New `server/private-backup-stage-v2.ts`; cold-bootstrap owner integrates `server/bootstrap.ts` and version dispatch in `private-workspace-backup.ts`; compact prepared-file catalog and resumable application |
| User interface | `src/components/PrivateWorkspaceBackup.tsx`, `src/lib/private-backup.ts`, and a focused v2 transfer helper: bounded file upload/download, progress, preview, explicit staging and recovery states |
| Native and release verification | Existing private-backup browser/native scripts plus dedicated v2 scenarios; Electron owner handles any necessary narrow native download integration and installer gates |

Common allowlist, validation and authority-reset helpers should be extracted from v1 only where needed to avoid divergent business rules. Keep the v1 envelope, reader and bounded full-read import behavior compatible. Do not route a large v2 archive through the v1 JSON reader as a fallback.

The first independently implementable package is the unused format/streaming codec and its tests, without HTTP, UI or bootstrap wiring. Its receipt establishes transport integrity only; trusted preview still requires the logical catalog and complete graph validation. Reuse the existing fixed scrypt profile and passphrase bounds, but use Node AEAD directly because the current whole-JSON encryption helper has no associated-data support. Exercise arbitrary transport chunks, consumer abort/backpressure and a generated archive above the v1 outer limit with measured bounded memory. This remains planned work, not a usable backup feature.

## Authenticated portable format

Use existing Node crypto, streams and SQLite; no new archive dependency is needed. The clear header contains only fixed magic/version, supported KDF parameters, random salt and an archive identifier. Reject unsupported or excessive KDF/framing values before expensive processing. Paths, workspace identity and business metadata belong in authenticated encrypted frames.

Use independently authenticated chunks no larger than 1 MiB, with unique sequence-derived nonces under a fresh per-archive key. Bind the exact header, sequence, lengths and frame role in authenticated data. Authenticate a complete bounded chunk before consuming its plaintext: a GCM transform can otherwise emit bytes before its final tag is checked.

A complete ordered manifest may itself span encrypted frames. The final authenticated footer binds its digest, ordered content digest, frame count, record/file counts and lengths. A preview becomes trusted only after the footer, every entry and the complete business graph validate. Reject missing/truncated footers, duplicate/reordered/spliced frames, malformed offsets and trailing bytes. Keep entry fragments contiguous in the first implementation to simplify validation.

Export portable logical values for encrypted Desk/mail/workflow records and exact bytes for allowed ordinary business files. V2 must not contain the source master key. Bank originals and reviewed artifacts retain their exact byte representations, including BOM, Unicode, line endings and quoting; export must not regenerate them from normalized CSV. Defer compression, arbitrary tar/zip input and external attachments.

## Bounded validation and key custody

Use a server-created private catalog with encrypted payloads, generated opaque entry identities and direct `get`, `iterate` and `count` operations. Reuse `WorkflowDatabase` primitives or a fixed internally created SQLite schema; never load or execute an uploaded database/schema. One entity remains subject to its existing size/history bound, even if it spans several archive frames.

During preview, preparation and staging, encrypt persisted catalog payloads with the **current installation's protected key**. The compact stage and prepared-file catalog must remain readable after restart using that same unchanged destination key. No passphrase, archive key or source master key may be persisted as operation metadata, plaintext scratch, URL parameters or logs. Do not introduce an independent persisted scratch key. Archive keys derived from the passphrase exist only for the active operation; clear owned buffers on exit. JavaScript strings cannot provide guaranteed memory erasure, and this design does not sandbox arbitrary code running as the same OS user.

Interrupted upload can resume from ciphertext and durable transport receipts. Interrupted archive decryption/export requires entering the passphrase again; do not retain an archive key merely to avoid that step. After a restore is staged, cold application uses only target-key prepared artifacts and needs no archive passphrase.

Complete graph checks must avoid retaining all source bodies:

- Bills: validate individual heads, permanent source aliases, origin links, active pattern reservations, occupied arrivals and marker counts through catalog lookups. Retain the current pure v1 adapter and business invariants.
- Execution: resolve each permanent request, receipt and checkpoint binding through indexed lookups, with bounded recent-file projections. Transform unfinished work and regenerate checkpoint/file hashes together.
- Mail: use `mail-records.ts`'s reader-based normalized graph validation with catalog lookups and incremental iteration. Resolve permanent task heads, receipts, sources, prepared inputs and logical migration origins in both directions. Validate retained legacy files one bundle at a time; never accumulate all decoded sources. Keep v1 compatibility adapters and exact origin-era prepared input. Mail's old aggregate journal caps have been removed separately; this does not remove its per-source/input limits.
- Bank/proposals/handoffs: reuse the authoritative current validators and retain source, revision, original bytes and retry evidence.
- Bill-review drafts: preserve every state, including accepted/discarded, exact unfinished strings, workspace binding, revisions, timestamps and immutable request tuples. Count these permanent records toward catalog capacity. Reuse `validateSavedBillReviewDraft` and `validateBillReviewDraftProposalLink`; a missing intent is legitimate before dispatch, but any present intent must match the actual source digest and input-document identity as well as its tuple/hash. Apply the existing plaintext and encrypted-envelope 64 KiB limits to closed and off-page drafts too. Drafts never become approvals.

For mail, explicitly supply the archived legacy view after inspecting its presence, even when that view is empty. Passing `undefined` to `validateMailGraph` intentionally skips origin-baseline comparison and must not conceal deleted legacy evidence. Preserve JSON property/array order inside logical evidence: current fingerprints use `JSON.stringify`. Restore must interrupt running normalized receipts, clear active ownership, preserve coverage gaps and revalidate the transformed graph, including origin-era prepared input. The v1 legacy wrapper and bill/execution validators currently materialize arrays/maps; they need bounded readers rather than merely a streaming HTTP wrapper.

`WorkflowDatabase.get`, `count`, `highWatermark`, `projectPage` and transactions provide useful catalog patterns, but there is no general iterator or revision-preserving import API. A fixed private catalog needs explicit bounded iteration, global identity uniqueness, retained revisions and insertion order; capped `list()` and revision-resetting `create()` are insufficient as direct export/import adapters.

Do not label an archive valid based only on individually valid rows. Missing, conflicting or orphaned relationships must fail the complete preview.

## Consistent export and the host barrier

Current v1 export uses idle checks, epochs and a second read. Its installation-wide write barrier currently belongs to restore. V2 needs an explicit reversible snapshot lease, distinct from preparing/staged restore state.

Acquire it synchronously after admission, block new HTTP and non-HTTP work, stop clocks/bridges that can write, and drain pending writes before capture. Reuse the existing `startTurn`, executor, mail, background bridge and request-accounting boundaries. Reads that perform recovery or refresh persisted data also respect the lease. Keep status, cancel and service recovery controls accessible; polling must not count as conflicting business work.

Capture consistent files and SQLite rows into immutable encrypted scratch content, preserving insertion ordering. Retain epoch/fingerprint verification against unexpected changes. Release the snapshot lease once capture is durably complete; subsequent catalog validation and download operate on that immutable capture and must not keep the business workspace paused. An export is downloadable only after complete graph validation, footer sealing, fsync and completed-operation receipt publication.

A failed or cancelled export releases its own lease after its writers close. It must never clear a restore hold or delete business evidence.

## Transfers, retry and cancellation

Expose small authenticated control requests and bounded binary data requests under the private-backup namespace. Handle binary streams before `readBody()`; do not stringify the archive through the generic API helper.

Proposed API actions:

1. Start export, receive operation ID, poll progress, then download a completed encrypted artifact.
2. Start upload, receive upload ID, append chunks by offset with a server-verified SHA-256 digest.
3. Complete upload, verifying declared total length and whole-file digest.
4. Preview with the passphrase, authenticating the entire archive and business graph.
5. Stage an explicitly confirmed restore bound to that reviewed archive digest, repeating current fresh/idle checks.
6. Cancel an owned, unstaged transfer or remove its completed downloadable scratch artifact.

An identical chunk retry returns its original durable receipt. Changed bytes, gaps, overlap and wrong-operation requests fail. Journal append intent before data write; after restart accept only the recorded before/after length and matching chunk digest. Unexpected scratch changes hold that transfer rather than guessing success. Serialize admission and journal changes so two tabs cannot append or stage competing operations.

Persist progress/receipts, not secrets. Use bounded per-request timeouts and background operation status rather than treating the existing 120-second UI request as the lifetime of a large export. Timeout or dropped response means an uncertain result: inspect operation status before retrying. Bound active operations, inactivity lifetime and work budgets explicitly.

Browser upload uses `File.slice()`. Download must avoid `arrayBuffer()`, full JSON and a whole-archive Blob. A native browser download can use a short-lived, artifact-only ticket issued by an authenticated request; it must never contain the general session token or passphrase. Bind it to one completed artifact/current service generation, enforce loopback Host/Origin policy, use no-store/referrer protections and do not log the ticket. A failed download can request another ticket; it must not rebuild the snapshot implicitly. Any native save bridge must be narrow and reviewed separately.

Distinguish generated, download-requested and actually saved receipts. Leaving a view or cancelling transport must not falsely imply that a backup was delivered.

## Compact staging and cold recovery

Preserve the fresh-workspace rule and all existing authority resets. Importing a backup must not reconnect Gmail, restore company membership, resume work or carry live approvals. Retain original private workspace/source identities so historical evidence still resolves.

Prepare target-key records and immutable files in the private operation directory. The v2 stage is a small target-key-encrypted manifest binding the reviewed archive, catalog, baseline and intended file digests. Large content lives in referenced server-created prepared artifacts; it is not embedded in one base64 stage object. Protect prepared business bytes with target-key chunk encryption where appropriate. Any temporary final-format plaintext file uses existing private filesystem permissions and exists only during atomic materialization.

Cold bootstrap dispatches on stage version before importing application stores. Reconstruct workflow storage using the fixed current schema, enforce the same 8,000,000-character encrypted entity bound after recovery transformations, and preserve row insertion order. Preserve current reset rules: schedules off, unfinished executions interrupted, agency source selection/reviews cleared, plans paused and approval attachments cleared, sign-in handoffs closed, unused Desk authority invalidated and approved work held.

For every replacement retain the current before/intended-hash rule, private temporary creation, fsync, atomic rename and final readback. Unexpected target changes hold startup. An interrupted apply resumes with the unchanged destination key and immutable prepared artifacts. Write the durable completion receipt only after every intended file and removal is verified.

Cancellation is safe before staging. After staging, do not delete the prepared artifacts needed for recovery or reopen business writes. Applying restore is not an ordinary cancellable upload; retain its hold and support continuation/recovery.

## Disk, filesystem and cleanup

Preflight space for the archive/upload, encrypted catalog, all prepared destination files, the largest atomic replacement and safety margin. Enforce a separate scratch-byte quota while writing. `statfs` is advisory: other processes can consume disk, so ENOSPC and interrupted fsync/rename must remain safe failure paths. Keep an explicit initial archive/entry/scratch policy and measure it before making capacity claims.

Use generated operation directories and basenames. Reject path traversal, absolute paths, unsupported names, duplicate/case-folded names, Windows reserved names, linked files, hardlinks and reparse ancestors. Do not accept a destination folder/path or raw SQLite from browser input. Apply the existing POSIX privacy and Windows ACL admission policy; never silently repair pre-existing paths.

Cleanup only an operation's authenticated owned scratch files. Unstaged incomplete transfers can be explicitly cancelled or cleaned under a documented retention policy. Never age out a staged/applying restore or original business evidence. An existing malformed operation/stage holds for diagnosis rather than being silently replaced. Completed downloads should expose their scratch-retention policy without claiming an off-computer copy exists.

## Acceptance gates

### Source/domain

- More than 5,000 records and more than 96 MiB; compare memory use as archive size grows. Record a bounded working-set target and actual measurement.
- Exact v1 read/import compatibility, including legacy full reads under unchanged v1 limits.
- Different-key roundtrip of bill aliases/history, execution retries/checkpoints, mail sources/manual decisions, and exact bank originals/reviewed bytes.
- Full graph corruption, unknown kinds, missing entities, duplicate identities and incompatible schema rejection before trusted preview/stage.
- Wrong passphrase; malformed header/KDF; truncated, duplicated, reordered, spliced and trailing frames; bad footer/manifest/counts/digests.
- Exact duplicate chunk retries, changed payload, concurrent append, stale offset, crash before/after append fsync and receipt commit.
- Disk-full, low-space admission, write/rename/fsync failure and cancellation at each phase; original bytes unchanged and owned scratch handling verified.
- Complete source/authority barrier tests covering HTTP, recovery reads, queued writes, direct worker dispatch and background timers.
- No passphrase/archive key/source master key in exported v2 logical metadata, persistent transfer metadata, status responses, logs or plaintext scratch.

### Actual HTTP/browser

- Session/Host/Origin checks for every transfer path and narrow download-ticket behavior; no arbitrary files/paths through identifiers.
- Bounded chunk handling, slow/aborted requests, reload/resume, double-tab retry and uncertain-result recovery.
- Verified progress/cancel/preview/stage UI, draft preservation, accessible controls, desktop and 390px layout.
- Download path does not construct a complete archive Blob; distinguish download requested from actual delivery.

### Cold bootstrap/native

- Actual source bootstrap and packaged different-key restore, production readers reopening, schedules still off and original retry identities retained.
- Interruption before/after every file replacement, target changes, lost/unreadable key, permission refusal/repair and repeat boot recovery.
- Scratch names with spaces/Unicode, real Windows ACL/reparse behavior, disk pressure and locked-file rename behavior.
- Owned service processes stopped and verified exited before scratch cleanup.
- Packaged macOS and actual Windows installation receipts separately. Existing Mac/POSIX checks and source simulations do not establish Windows success or customer acceptance.

Implementation may be split across the owned work packages, but the usable v2 slice is complete only when format, validation, transfer, UI and cold recovery pass together. Do not publish a partial streaming writer as a finished backup system.


### shared/private-backup-transfers.ts
import { parsePrivateBackupReceipt, type PrivateBackupReceipt } from './private-workspace-backup.ts';

/** Public transport projections only. Never include scratch paths, keys,
 * passphrases, raw exceptions, or uploaded business values here. */
export const PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES = 1024 * 1024;
export const PRIVATE_BACKUP_TRANSFER_MAX_BYTES = 1024 * 1024 * 1024;
export const PRIVATE_BACKUP_TRANSFER_MAX_ITEMS = 20;
export const PRIVATE_BACKUP_TRANSFER_API = '/api/private-backup/v2';
export const PRIVATE_BACKUP_TRANSFER_PHASES = [
  'capturing', 'sealing', 'ready', 'uploading', 'uploaded', 'checking', 'reviewed',
  'staging', 'staged', 'applying', 'completed', 'interrupted', 'failed', 'cancelled', 'expired',
] as const;
export type PrivateBackupTransferPhase = typeof PRIVATE_BACKUP_TRANSFER_PHASES[number];
export const PRIVATE_BACKUP_TRANSFER_ERRORS = {
  interrupted: 'This backup operation was interrupted. Check its saved progress before continuing.',
  'invalid-backup': 'This file could not be verified as a complete supported backup. Keep the original file.',
  'incorrect-passphrase': 'The backup could not be opened with that passphrase. Check it and try again.',
  'storage-unavailable': 'Backup storage is unavailable. Keep the original file and check this computer.',
  'insufficient-space': 'This computer needs more free space before the backup can continue.',
  'workspace-busy': 'Finish the current work before continuing this backup operation.',
  'restore-unavailable': 'This workspace is not ready to restore this backup.',
  'recovery-required': 'This backup operation needs recovery. Keep its files and contact support.',
  expired: 'This saved transfer has expired. Keep the original backup file.',
} as const;
export type PrivateBackupTransferErrorCode = keyof typeof PRIVATE_BACKUP_TRANSFER_ERRORS;
export interface PrivateBackupTransferArtifact { archiveBytes: number; archiveDigest: string }
export interface PrivateBackupTransferOperation {
  version: 2; id: string; workspaceId: string; kind: 'export' | 'upload';
  phase: PrivateBackupTransferPhase; createdAt: number; updatedAt: number; expiresAt: number | null;
  progress: { completedBytes: number; totalBytes: number | null };
  canCancel: boolean; requiresPassphrase: boolean;
  /** Required for upload operations, including interrupted/closed ones. */
  receivedBytes?: number; prefixCommitment?: string;
  artifact?: PrivateBackupTransferArtifact;
  /** Published only after complete authentication AND business graph validation. */
  preview?: PrivateBackupReceipt;
  error?: { code: PrivateBackupTransferErrorCode };
}
export interface PrivateBackupTransferPage {
  version: 2; workspaceId: string;
  limits: { archiveBytes: number; chunkBytes: typeof PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES };
  items: PrivateBackupTransferOperation[]; total: number; nextCursor: string | null;
}
export interface PrivateBackupDownloadTicket extends PrivateBackupTransferArtifact {
  url: string; filename: string; expiresAt: number;
}
/** SHA-256 of UTF-8 JSON.stringify(tuples), in this exact order, with lowercase
 * digests. At most 1024 tuples; this is NOT the whole-file archive digest. */
export type PrivateBackupChunkTuple = [offset: number, size: number, sha256: string];

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
export const privateBackupTransferId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const privateBackupTransferDigest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function artifact(v: unknown): PrivateBackupTransferArtifact | null {
  return object(v) && keys(v, ['archiveBytes', 'archiveDigest']) && integer(v.archiveBytes, 1) && v.archiveBytes <= PRIVATE_BACKUP_TRANSFER_MAX_BYTES && privateBackupTransferDigest(v.archiveDigest)
    ? { archiveBytes: v.archiveBytes, archiveDigest: v.archiveDigest } : null;
}
function receipt(v: unknown): PrivateBackupReceipt | null {
  if (!object(v) || !keys(v, ['digest', 'createdAt', 'workspaceId', 'fileCount', 'recordCount', 'plainBytes', 'included', 'excluded', 'restoreChanges'])) return null;
  const parsed = parsePrivateBackupReceipt(v);
  if (!parsed || parsed.createdAt.length > 40) return null;
  // Human-readable category labels, not filenames, evidence bodies, or errors.
  if ([parsed.included, parsed.excluded, parsed.restoreChanges].some(list => list.length > 20 || list.some(s => !s.trim() || new TextEncoder().encode(s).length > 300 || /[\u0000-\u001f\u007f]/.test(s)))) return null;
  return parsed;
}
export function parsePrivateBackupTransferOperation(v: unknown): PrivateBackupTransferOperation | null {
  if (!object(v) || !keys(v, ['version', 'id', 'workspaceId', 'kind', 'phase', 'createdAt', 'updatedAt', 'expiresAt', 'progress', 'canCancel', 'requiresPassphrase'], ['receivedBytes', 'prefixCommitment', 'artifact', 'preview', 'error']) ||
      v.version !== 2 || !privateBackupTransferId(v.id) || !privateBackupTransferId(v.workspaceId) || typeof v.kind !== 'string' || !['export', 'upload'].includes(v.kind) ||
      !PRIVATE_BACKUP_TRANSFER_PHASES.includes(v.phase as PrivateBackupTransferPhase) || !integer(v.createdAt, 1) || !integer(v.updatedAt, v.createdAt) ||
      !(v.expiresAt === null || integer(v.expiresAt, v.createdAt)) || typeof v.canCancel !== 'boolean' || typeof v.requiresPassphrase !== 'boolean' ||
      !object(v.progress) || !keys(v.progress, ['completedBytes', 'totalBytes']) || !integer(v.progress.completedBytes) ||
      !(v.progress.totalBytes === null || integer(v.progress.totalBytes, v.progress.completedBytes))) return null;
  const phase = v.phase as PrivateBackupTransferPhase;
  if (['staging', 'staged', 'applying', 'completed', 'cancelled', 'expired'].includes(phase) && v.canCancel) return null;
  if (v.requiresPassphrase && !['interrupted', 'failed', 'uploaded'].includes(phase)) return null;
  if (v.kind === 'upload') {
    const size = v.progress.totalBytes;
    if (!integer(size, 1) || size > PRIVATE_BACKUP_TRANSFER_MAX_BYTES || !integer(v.receivedBytes) || v.receivedBytes > size ||
        v.receivedBytes !== size && v.receivedBytes % PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES !== 0 || !privateBackupTransferDigest(v.prefixCommitment) ||
        ['capturing', 'ready'].includes(phase)) return null;
    if (['uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase) && v.receivedBytes !== size) return null;
    if (v.requiresPassphrase && v.receivedBytes !== size) return null;
  } else if (Object.hasOwn(v, 'receivedBytes') || Object.hasOwn(v, 'prefixCommitment') || ['uploading', 'uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying'].includes(phase)) return null;
  const parsedArtifact = v.artifact === undefined ? undefined : artifact(v.artifact);
  if (parsedArtifact === null || parsedArtifact && v.kind === 'upload' && parsedArtifact.archiveBytes !== v.progress.totalBytes) return null;
  if (parsedArtifact && ['capturing', 'uploading', 'cancelled', 'expired'].includes(phase)) return null;
  if (['ready', 'uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase) && !parsedArtifact) return null;
  const parsedPreview = v.preview === undefined ? undefined : receipt(v.preview);
  if (parsedPreview === null || parsedPreview && (!parsedArtifact || !['ready', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase))) return null;
  if (parsedPreview && parsedPreview.digest !== parsedArtifact?.archiveDigest) return null;
  if (['reviewed', 'staging', 'staged', 'applying'].includes(phase) && !parsedPreview) return null;
  if (v.error !== undefined && (!object(v.error) || !keys(v.error, ['code']) || typeof v.error.code !== 'string' || !Object.hasOwn(PRIVATE_BACKUP_TRANSFER_ERRORS, v.error.code))) return null;
  return {
    version: 2, id: v.id, workspaceId: v.workspaceId, kind: v.kind as 'export' | 'upload', phase,
    createdAt: v.createdAt, updatedAt: v.updatedAt, expiresAt: v.expiresAt as number | null,
    progress: { completedBytes: v.progress.completedBytes, totalBytes: v.progress.totalBytes as number | null },
    canCancel: v.canCancel, requiresPassphrase: v.requiresPassphrase,
    ...(v.kind === 'upload' ? { receivedBytes: v.receivedBytes as number, prefixCommitment: v.prefixCommitment as string } : {}),
    ...(parsedArtifact ? { artifact: parsedArtifact } : {}), ...(parsedPreview ? { preview: parsedPreview } : {}),
    ...(v.error ? { error: { code: (v.error as { code: PrivateBackupTransferErrorCode }).code } } : {}),
  };
}
export function parsePrivateBackupTransferResponse(v: unknown): PrivateBackupTransferOperation | null {
  return object(v) && keys(v, ['operation']) ? parsePrivateBackupTransferOperation(v.operation) : null;
}
export function parsePrivateBackupTransferPage(v: unknown): PrivateBackupTransferPage | null {
  if (!object(v) || !keys(v, ['version', 'workspaceId', 'limits', 'items', 'total', 'nextCursor']) || v.version !== 2 || !privateBackupTransferId(v.workspaceId) ||
      !object(v.limits) || !keys(v.limits, ['archiveBytes', 'chunkBytes']) || !integer(v.limits.archiveBytes, 1) || v.limits.archiveBytes > PRIVATE_BACKUP_TRANSFER_MAX_BYTES || v.limits.chunkBytes !== PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES ||
      !Array.isArray(v.items) || v.items.length > PRIVATE_BACKUP_TRANSFER_MAX_ITEMS || !integer(v.total, v.items.length) ||
      !(v.nextCursor === null || typeof v.nextCursor === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(v.nextCursor))) return null;
  const items = v.items.map(parsePrivateBackupTransferOperation);
  if (items.some(item => !item || item.workspaceId !== v.workspaceId) || new Set(items.map(item => item?.id)).size !== items.length) return null;
  return { version: 2, workspaceId: v.workspaceId, limits: { archiveBytes: v.limits.archiveBytes, chunkBytes: PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES }, items: items as PrivateBackupTransferOperation[], total: v.total, nextCursor: v.nextCursor as string | null };
}
export function parsePrivateBackupDownloadTicket(v: unknown): PrivateBackupDownloadTicket | null {
  if (!object(v) || !keys(v, ['url', 'filename', 'expiresAt', 'archiveBytes', 'archiveDigest']) || typeof v.url !== 'string' ||
      !/^\/api\/private-backup\/v2\/downloads\/[A-Za-z0-9_-]{32,128}$/.test(v.url) || typeof v.filename !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.realbud-backup$/.test(v.filename) || !integer(v.expiresAt, 1)) return null;
  const a = artifact({ archiveBytes: v.archiveBytes, archiveDigest: v.archiveDigest });
  return a ? { ...a, url: v.url, filename: v.filename, expiresAt: v.expiresAt } : null;
}


### Source API excerpts: server/private-backup-transfer.ts
9: 
10: export const BACKUP_TRANSFER_CHUNK_BYTES = 1024 * 1024;
11: export const BACKUP_TRANSFER_MAX_BYTES = 1024 * 1024 * 1024;
12: export const BACKUP_TRANSFER_JOURNAL_BYTES = 64 * 1024 * 1024;
13: export const BACKUP_TRANSFER_CANCEL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
14: const MAX_ACTIVE = 4;
15: const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
16: const HASH = /^[a-f0-9]{64}$/;
17: function fail(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
18: const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
19: const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
20: const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
21: interface Chunk { offset: number; size: number; digest: string }
22: export interface BackupUploadStatus {
23:   id: string; size: number; offset: number; state: 'uploading' | 'uploaded' | 'staged' | 'cancelled';
24:   createdAt: number; updatedAt: number; digest: string | null; manifestDigest: string | null;
25:   /** Commitment to the exact durably accepted prefix, for reselected files. */
26:   prefixDigest: string;
27: }
28: interface Upload extends Omit<BackupUploadStatus, 'prefixDigest'> { version: 1; workspaceId: string; pending: Chunk | null }
29: type FaultPoint = 'intent-saved' | 'data-written' | 'data-synced' | 'recovery-before-sync' | 'receipt-saved' | 'cancel-saved';
30: export interface BackupTransferOptions {
31:   /** An installation-owned directory, never a browser-provided path. */
32:   directory: string; key: Buffer; workspaceId: string;
33:   now?: () => number;
34:   /** Test-only interruption hook. No serialized value can configure it. */
35:   fault?: (point: FaultPoint, id: string) => void;
36: }
37: 
38: async function safeParents(path: string): Promise<void> {
39:   const absolute = resolve(path), root = parse(absolute).root; let current = root;
40:   for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
41:     current = join(current, part);
42:     try { const s = await lstat(current); if (!s.isDirectory() || s.isSymbolicLink()) fail('Backup transfer storage needs recovery.', 503); }
43:     catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
44:   }
45: }
46: async function privateFolder(path: string): Promise<void> {
86:  * confirmed process exit, not a timeout, permits restart recovery. */
87: export async function createBackupTransferStore(options: BackupTransferOptions) {
88:   if (options.key.length !== 32 || !UUID.test(options.workspaceId)) fail('Invalid backup transfer installation.', 400);
89:   const directory = resolve(options.directory), now = options.now ?? Date.now;
90:   const nonce = randomUUID(), pid = process.pid;
91:   await privateFolder(directory);
92:   const journal = join(directory, 'transfers.sqlite');
93:   const existing = await checkedFile(journal, true);
94:   if (existing && existing.size > BACKUP_TRANSFER_JOURNAL_BYTES) fail('Backup transfer journal needs size recovery. Existing copies were preserved.', 503);
95:   if (!existing) { const file = await open(journal, 'wx', 0o600); try { await windowsFilePrivacy(journal, 'file', true); await file.sync(); } finally { await file.close(); } fsyncDir(directory); }
96:   const key = Buffer.from(options.key);
97:   let db: DatabaseSync;
98:   try { db = new DatabaseSync(journal); } catch (error) { key.fill(0); throw error; }
99:   let closed = false, closing = false, queued = 0, tail: Promise<unknown> = Promise.resolve();
100:   const transact = <T>(fn: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
101:   const encode = (value: unknown) => JSON.stringify(encryptJson(key, value));
102:   const decode = (payload: unknown): unknown => { try { const v = JSON.parse(String(payload)); if (!isEncryptedEnvelope(v)) throw new Error(); return decryptJson(key, v); } catch { return fail('Backup transfer journal needs recovery.', 503); } };
103:   try {

### Source API excerpts: server/private-backup-archive.ts
7: interface ArchiveMetadata { version: 2; createdAt: string; workspaceId: string; databasePresent: boolean }
8: export interface BackupArchiveReceipt {
9:   metadata: ArchiveMetadata;
10:   transport: PrivateBackupCodecReceipt;
11:   receipt: PrivateBackupReceipt;
12: }
13: const META = 'realbud:metadata';
14: const MAX_LOGICAL_ENTRY = 8 * 1024 * 1024;
15: const decoder = new TextDecoder('utf-8', { fatal: true });
16: const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
17: function invalid(message = 'The backup archive contains unsupported business data. No restore was prepared.'): never { throw Object.assign(new Error(message), { status: 400 }); }
18: function parse(data: Buffer): unknown { try { return JSON.parse(decoder.decode(data)); } catch { return invalid('The backup contains an invalid JSON entry.'); } }
19: function metadata(value: unknown): ArchiveMetadata {
20:   if (!object(value) || Object.keys(value).sort().join(',') !== 'createdAt,databasePresent,version,workspaceId' || value.version !== 2 ||
21:       typeof value.workspaceId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.workspaceId) ||
22:       typeof value.databasePresent !== 'boolean' || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) invalid();
23:   return value as unknown as ArchiveMetadata;
24: }
39:  * No installation or source encryption key is serialized into the archive. */
40: export async function* encodeBackupCatalog(catalog: PrivateBackupCatalog, options: PrivateBackupCodecOptions & {
41:   createdAt: string; databasePresent: boolean;
42:   onComplete?: (receipt: BackupArchiveReceipt) => void | Promise<void>;
43: }): AsyncGenerator<Buffer> {
44:   const meta = metadata({ version: 2, createdAt: options.createdAt, workspaceId: catalog.workspaceId, databasePresent: options.databasePresent });
45:   const original = catalog.seal();
46:   if (!meta.databasePresent && original.records) invalid();
47:   async function* entries(): AsyncGenerator<PrivateBackupCodecEntry> {
48:     yield entry(META, Buffer.from(JSON.stringify(meta)));
49:     for (const file of catalog.iterateFiles()) yield entry(`file:${file.encoding}:${file.path}`, file.data);
50:     for (const record of catalog.iterateRecords()) yield entry(`record:${record.id}`, Buffer.from(JSON.stringify(record)));
51:     // Corruption or an unexpected writer must fail before the footer is emitted.
52:     const final = catalog.validate();
53:     if (final.digest !== original.digest || final.entries !== original.entries) invalid('The captured backup changed before sealing. No complete archive was produced.');
54:   }
55:   yield* encodePrivateBackupV2(entries(), { passphrase: options.passphrase, signal: options.signal, limits: options.limits,
56:     onComplete: async transport => { await options.onComplete?.({ metadata: meta, transport, receipt: receipt(meta, original, transport) }); } });
61:  * explicitly removes it. It is never a trusted preview or a staged restore. */
62: export async function decodeBackupCatalog(input: AsyncIterable<Uint8Array>, options: PrivateBackupCodecOptions & {
63:   directory: string; key: Buffer; expectedArchiveDigest: string;
64: }): Promise<BackupArchiveReceipt & { catalog: PrivateBackupCatalog }> {
65:   if (typeof options.expectedArchiveDigest !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedArchiveDigest)) invalid('The uploaded backup digest is missing.');
66:   let catalog: PrivateBackupCatalog | undefined, meta: ArchiveMetadata | undefined;
67:   let creating: Promise<PrivateBackupCatalog> | undefined;
68:   let current: { name: string; bytes: Buffer; offset: number } | undefined;
69:   try {
70:     const transport = await decodePrivateBackupV2(input, {
71:       passphrase: options.passphrase, signal: options.signal, limits: options.limits,
72:       visitor: {
73:         begin(value) {
74:           if (current || value.index === 0 && value.name !== META || value.index !== 0 && value.name === META) invalid();
75:           if (value.name === META ? value.size > 4096 : !value.name.startsWith('file:') && !value.name.startsWith('record:')) invalid();
76:           // The record envelope adds bounded identity fields to a logical body.
77:           if (value.size > MAX_LOGICAL_ENTRY + 1024) invalid('A backup entry exceeds its business record limit.');
78:           current = { name: value.name, bytes: Buffer.alloc(value.size), offset: 0 };

### Source API excerpts: server/private-backup-capture.ts
15: 
16: export interface PrivateCaptureLimits {
17:   maxDirectoryEntries?: number;
18:   maxRecords?: number;
19:   maxSourceBytes?: number;
20: }
21: export interface PrivateCaptureProgress {
22:   phase: 'files' | 'records' | 'guards';
23:   verifying: boolean;
24:   fileCount: number;
25:   recordCount: number;
26:   sourceBytes: number;
27: }
28: export interface PrivateCaptureOptions {
29:   directory: string;
30:   workspaceId: string;
31:   key: Buffer;
32:   catalog: PrivateBackupCatalog;
33:   /** Synchronous, authoritative lease and host epoch check. Called around every
34:    * asynchronous read/yield and before each catalog mutation. Never a UI flag. */
35:   assertLease(): void;
36:   signal?: AbortSignal;
37:   onProgress?(progress: PrivateCaptureProgress): void | Promise<void>;
38:   limits?: PrivateCaptureLimits;
39: }
40: export interface PrivateCaptureReceipt {
41:   version: 1;
42:   workspaceId: string;
43:   catalogId: string;
44:   catalogDigest: string;
45:   catalogEntries: number;
46:   databasePresent: boolean;
47:   sourceDigest: string;
48:   fileCount: number;
49:   recordCount: number;
50:   sourceBytes: number;
51:   directoryEntries: number;
52: }
53: export interface PrivateTargetReadOptions {
54:   assertLease?: () => void; signal?: AbortSignal; limits?: PrivateCaptureLimits;
55: }
56: interface FilesystemOptions extends PrivateTargetReadOptions { directory: string; onProgress?: PrivateCaptureOptions['onProgress'] }
57: interface Fingerprint {
58:   databasePresent: boolean; sourceDigest: string; fileCount: number;
59:   recordCount: number; sourceBytes: number; directoryEntries: number;
60: }
61: const DATABASE = 'workflow-state.sqlite';
62: const MAX_FILE = 8 * 1024 * 1024;
63: const MAX_DIRECTORY_ENTRIES = 100_000;
64: const MAX_RECORDS = 100_000;
65: const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
66: const PRIVATE_PREFIX = 'company-installation/private/';
67: const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
68: const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
69: const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) < Number.MAX_SAFE_INTEGER;
366: 
367: export async function capturePrivateWorkspace(options: PrivateCaptureOptions): Promise<PrivateCaptureReceipt> {
368:   const before = options.catalog.summary();
369:   if (before.sealed || before.entries !== 0 || before.workspaceId !== options.workspaceId) fail('Source capture requires a new provisional catalog for this workspace.', 409);
370:   const captured = await new CaptureReader(options, true).run(), after = options.catalog.summary();
371:   options.assertLease();
372:   if (after.sealed || after.entries !== captured.fileCount + captured.recordCount) changed();
373:   return Object.freeze({ version: 1, workspaceId: options.workspaceId, catalogId: after.catalogId,
374:     catalogDigest: after.digest, catalogEntries: after.entries, ...captured });
375: }
376: 
377: /** Mandatory second bounded source read while the same host lease remains held.
378:  * The caller releases its lease only after this resolves; graph validation/seal
379:  * may then run against the immutable captured entries without pausing work. */
380: export async function verifyPrivateWorkspaceCapture(options: PrivateCaptureOptions, receipt: PrivateCaptureReceipt): Promise<void> {
381:   if (!receipt || Object.keys(receipt).length !== 11 || receipt.version !== 1 || receipt.workspaceId !== options.workspaceId || !uuid(receipt.catalogId) ||
382:       !hex(receipt.catalogDigest) || !hex(receipt.sourceDigest) || typeof receipt.databasePresent !== 'boolean' ||
383:       ![receipt.catalogEntries, receipt.fileCount, receipt.recordCount, receipt.sourceBytes, receipt.directoryEntries].every(value => integer(value))) fail('The private source capture receipt is invalid.', 400);
384:   const assertCatalog = () => {
385:     const current = options.catalog.summary();
386:     if (current.catalogId !== receipt.catalogId || current.workspaceId !== receipt.workspaceId || current.digest !== receipt.catalogDigest || current.entries !== receipt.catalogEntries) changed();
387:   };
388:   assertCatalog();
389:   const current = await new CaptureReader(options, false).run();
390:   if (Object.entries(current).some(([key, value]) => receipt[key as keyof PrivateCaptureReceipt] !== value)) changed();
391:   options.assertLease(); assertCatalog();
392: }
393: 
394: /** Bounded names only; cold restore hashes/materializes content separately. */
395: export async function privateBackupTargetPaths(directory: string, options: PrivateTargetReadOptions = {}): Promise<string[]> {
396:   return new CaptureFilesystem({ directory, ...options }, false).targetPaths();
397: }
398: /** Authority guards stay separate from business files that a cold apply changes. */
399: export async function privateBackupTargetGuard(directory: string, options: PrivateTargetReadOptions = {}): Promise<string> {
400:   return new CaptureFilesystem({ directory, ...options }, false).targetGuard();
401: }

### Source API excerpts: server/private-backup-cold-restore.ts
16: 
17: export const PRIVATE_RESTORE_V2_STAGE_FILE = 'private-workspace-restore-v2.json';
18: const MAX_STAGE = 64 * 1024;
19: const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
20: const HASH = /^[a-f0-9]{64}$/;
21: interface Stage {
22:   version: 2; state: 'staged' | 'applying'; directoryId: string; storeId: string;
23:   workspaceId: string; preparedDigest: string; targetGuard: string; receipt: PrivateBackupReceipt;
24: }
25: type ManifestEntry = { path: string; beforeHash: string | null; intendedHash: string | null; bytes: number };
26: function hold(message = 'The prepared restore needs recovery. Startup is held and existing files are preserved.'): never {
27:   throw Object.assign(new Error(message), { status: 503 });
28: }
29: const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
30: async function parents(path: string): Promise<void> {
31:   const absolute = resolve(path), root = parse(absolute).root; let current = root;
32:   for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
33:     current = join(current, part);
70: }
71: export async function privateRestoreTargetHash(path: string): Promise<string | null> {
72:   const handle = await fileHandle(path); if (!handle) return null;
73:   try {
74:     const before = await handle.stat(), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
75:     if (before.size > 1024 ** 3) hold('The restore target exceeds its supported size. Existing files were preserved.');
76:     let offset = 0;
77:     while (offset < before.size) {
78:       const part = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
79:       if (!part.bytesRead) hold(); hash.update(buffer.subarray(0, part.bytesRead)); offset += part.bytesRead;
80:     }
81:     const after = await handle.stat(), named = await lstat(path);
82:     if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.ino !== after.ino || named.dev !== after.dev || named.nlink !== 1 || named.isSymbolicLink()) hold();
83:     return hash.digest('hex');
84:   } finally { await handle.close(); }
85: }
86: const fileHash = privateRestoreTargetHash;
87: async function readStage(directory: string, key: Buffer): Promise<Stage | null> {
144: async function noV1Stage(directory: string) { if (await fileHash(join(directory, PRIVATE_RESTORE_STAGE_FILE)) !== null) hold('Another restore is already staged. Recover it before preparing another restore.'); }
145: export interface StagePrivateRestoreV2Options {
146:   directory: string; key: Buffer; directoryId: string; storeId: string; workspaceId: string;
147:   expectedPreparedDigest: string; receipt: PrivateBackupReceipt;
148:   assertFresh: () => void; assertIdle: () => void; epoch: () => string;
149: }
150: /** Host must hold its installation write barrier throughout this call. */
151: async function stagePrivateRestoreV2Unlocked(options: StagePrivateRestoreV2Options): Promise<{ needsRestart: true; receipt: PrivateBackupReceipt }> {
152:   if (!Buffer.isBuffer(options.key) || options.key.length !== 32 || ![options.directoryId, options.storeId, options.workspaceId].every(v => typeof v === 'string' && UUID.test(v)) || !HASH.test(options.expectedPreparedDigest)) hold();
153:   const receipt = parsePrivateBackupReceipt(options.receipt); if (!receipt || receipt.workspaceId !== options.workspaceId) hold();
154:   const directory = resolve(options.directory), key = Buffer.from(options.key); let store: PrivateBackupPreparedStore | undefined;
155:   try {
156:     options.assertIdle(); options.assertFresh(); const epoch = options.epoch();
157:     await noV1Stage(directory);
158:     const existing = await readStage(directory, key);
159:     if (existing) {
160:       if (existing.directoryId !== options.directoryId || existing.storeId !== options.storeId || existing.preparedDigest !== options.expectedPreparedDigest || JSON.stringify(existing.receipt) !== JSON.stringify(receipt)) hold('A different restore is already staged.');
161:       return { needsRestart: true, receipt: existing.receipt };
204: }
205: export function stagePrivateRestoreV2(options: StagePrivateRestoreV2Options) { return withRestoreLock(options.directory, () => stagePrivateRestoreV2Unlocked(options)); }
206: export function applyStagedPrivateRestoreV2(options: Parameters<typeof applyStagedPrivateRestoreV2Unlocked>[0]) { return withRestoreLock(options.directory, () => applyStagedPrivateRestoreV2Unlocked(options)); }

### Source API excerpts: server/private-backup-prepared.ts
13: 
14: export const PRIVATE_BACKUP_PREPARED_CHUNK_BYTES = 1024 * 1024;
15: export const PRIVATE_BACKUP_PREPARED_LIMITS = Object.freeze({
16:   bytes: 1024 ** 3, fileBytes: 8 * 1024 ** 2, entries: 100_001, sqliteBytes: 3 * 1024 ** 3,
17: });
18: export interface PreparedLimits { bytes: number; fileBytes: number; entries: number; sqliteBytes: number }
19: export interface PreparedEntry {
20:   sequence: number; path: string; beforeHash: string | null; intendedHash: string | null; bytes: number;
21: }
22: export interface PreparedSummary {
23:   storeId: string; workspaceId: string; entries: number; bytes: number; digest: string; sealed: boolean;
24: }
25: interface Header extends PreparedSummary { version: 1; limits: PreparedLimits }
26: interface Metadata extends PreparedEntry { version: 1; entryId: string; chunks: number }
27: interface EntryRow { sequence: number; entry_id: string; lookup: string; payload: Uint8Array }
28: interface OperationOptions { signal?: AbortSignal }
29: const FILE = 'prepared.sqlite';
30: const DATABASE = 'workflow-state.sqlite';
31: const CHUNK = PRIVATE_BACKUP_PREPARED_CHUNK_BYTES;
32: const OVERHEAD = 29; // version + nonce + GCM tag
33: const META_BYTES = 4096;
34: const PAGE_BYTES = 4096;
35: const TABLES = {
36:   prepared_header: 'CREATE TABLE prepared_header (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL) STRICT',
37:   prepared_entries: 'CREATE TABLE prepared_entries (sequence INTEGER PRIMARY KEY, entry_id TEXT NOT NULL UNIQUE, lookup TEXT NOT NULL UNIQUE, payload BLOB NOT NULL) STRICT',
38:   prepared_chunks: 'CREATE TABLE prepared_chunks (entry_id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(entry_id,ordinal)) STRICT',
110: 
111: export class PrivateBackupPreparedStore {
112:   readonly directory: string;
113:   readonly storeId: string;
114:   readonly workspaceId: string;
115:   private readonly db: DatabaseSync;
116:   private readonly key: Buffer;
117:   private closed = false;
118:   private closing = false;
119:   private operation: { done: Promise<unknown>; controller: AbortController } | undefined;
120:   private closingPromise: Promise<void> | undefined;
121: 
122:   private constructor(directory: string, key: Buffer, db: DatabaseSync, storeId: string, workspaceId: string) {
123:     this.directory = directory; this.key = Buffer.from(key); this.db = db;
124:     this.storeId = storeId; this.workspaceId = workspaceId;
125:   }
126:   static async create(options: { directory: string; key: Buffer; workspaceId: string; limits?: Partial<PreparedLimits> }): Promise<PrivateBackupPreparedStore> {
127:     keyCheck(options.key);
216:   }
217:   summary(): PreparedSummary { this.idle(); return this.publicSummary(this.header()); }
218:   private row(sequence: number): EntryRow | undefined {
219:     const bounds = this.db.prepare('SELECT length(payload) AS size FROM prepared_entries WHERE sequence=?').get(sequence);
220:     if (!bounds) return undefined;
221:     if (!integer(bounds.size) || bounds.size > META_BYTES + OVERHEAD) fail();
222:     return this.db.prepare('SELECT * FROM prepared_entries WHERE sequence=?').get(sequence) as unknown as EntryRow;
223:   }
224:   private metadata(row: EntryRow, header: Header): Metadata {
225:     if (!integer(row.sequence, 1) || row.sequence > header.entries || !uuid(row.entry_id) || !hex(row.lookup)) fail();
226:     const value = this.decode(row.payload, this.aad('entry', row.entry_id, row.sequence));
227:     if (!exact(value, ['version', 'entryId', 'sequence', 'path', 'beforeHash', 'intendedHash', 'bytes', 'chunks']) ||
228:         value.version !== 1 || value.entryId !== row.entry_id || value.sequence !== row.sequence || !validPath(value.path) ||
229:         !nullableHash(value.beforeHash) || !nullableHash(value.intendedHash) || !integer(value.bytes) || !integer(value.chunks) ||
230:         row.lookup !== this.lookup(value.path) || value.bytes > (value.path === DATABASE ? header.limits.bytes : header.limits.fileBytes) ||
231:         value.chunks !== Math.ceil(value.bytes / CHUNK) || value.intendedHash === null && (value.bytes !== 0 || value.chunks !== 0)) fail();
232:     return value as unknown as Metadata;
233:   }
370:   }
371:   seal(options: OperationOptions = {}): Promise<PreparedSummary> {
372:     return this.run(signal => this.transaction(signal, async header => {
373:       await this.inspect(header, signal);
374:       if (!header.sealed) { header.sealed = true; this.saveHeader(header); }
375:       return this.publicSummary(header);
376:     }), options.signal);
377:   }
378:   /** Reauthenticates every sealed entry, chunk, before hash and ordered manifest. */
379:   validate(options: OperationOptions = {}): Promise<PreparedSummary> {
380:     return this.run(signal => this.transaction(signal, async header => {
381:       if (!header.sealed) fail('The prepared backup has not been sealed.', 409);
382:       return this.inspect(header, signal);
383:     }), options.signal);
384:   }
385:   /** Each chunk is authenticated before yield. Exhaust to verify full hash/EOF.
386:    * Already yielded bytes must remain provisional until this iterator completes. */
387:   async *readFile(path: string, options: OperationOptions = {}): AsyncIterable<Buffer> {
388:     this.idle(); aborted(options.signal); const header = this.sealed();
389:     if (!validPath(path)) fail('The prepared backup file identity is invalid.', 400);
390:     const found = this.db.prepare('SELECT sequence FROM prepared_entries WHERE lookup=?').get(this.lookup(path));
391:     if (!found || !integer(found.sequence, 1)) fail('The prepared backup file was not found.', 404);
392:     const row = this.row(found.sequence); if (!row) fail();
393:     const entry = this.metadata(row, header);
394:     if (entry.path !== path || entry.intendedHash === null) fail('The prepared backup file was not found.', 404);
395:     const digest = createHash('sha256');
403:   }
404:   close(): Promise<void> {
405:     if (this.closingPromise) return this.closingPromise;
406:     this.closing = true; this.operation?.controller.abort();
407:     this.closingPromise = (async () => {
408:       await this.operation?.done.catch(() => undefined);
409:       try { this.db.close(); } finally { this.key.fill(0); this.closed = true; }
410:     })(); return this.closingPromise;
411:   }
412: }

### Source API excerpts: server/private-backup-prepare.ts
29: async function* chunks(bytes: Buffer) { try { for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) yield bytes.subarray(offset, offset + 1024 * 1024); } finally { bytes.fill(0); } }
30: export async function preparePrivateBackupRestore(options: {
31:   directory: string; key: Buffer; source: PrivateBackupCatalog; prepared: PrivateBackupPreparedStore;
32:   databasePresent: boolean; assertLease: () => void; signal?: AbortSignal;
33:   onProgress?: (value: { files: number; bytes: number }) => void;
34: }) {
35:   if (!Buffer.isBuffer(options.key) || options.key.length !== 32) fail();
36:   const key = Buffer.from(options.key), directory = resolve(options.directory);
37:   const assert = () => { options.signal?.throwIfAborted(); options.assertLease(); };
38:   let scratch: string | undefined;
39:   try {
40:     assert(); const source = options.source.summary(), target = options.prepared.summary();
41:     if (!source.sealed || target.sealed || target.entries || target.workspaceId !== source.workspaceId || !options.databasePresent && source.records) fail();
42:     options.source.validate();
43:     const remaining = new Set(await privateBackupTargetPaths(directory)); assert();
44:     let files = 0, bytes = 0;
45:     const added = (size: number) => { files++; bytes += size; options.onProgress?.({ files, bytes }); };
46:     for (const file of options.source.iterateFiles()) {