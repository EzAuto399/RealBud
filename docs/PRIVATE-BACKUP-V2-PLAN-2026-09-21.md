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
