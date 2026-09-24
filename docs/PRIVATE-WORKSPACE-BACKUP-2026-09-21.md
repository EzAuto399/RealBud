# Private business backup and fresh-workspace recovery

RealBud can export a passphrase-encrypted snapshot of supported private business records and restore it into a fresh installation. This is separate from the office-host PostgreSQL backup. It does not export company membership or account credentials, and it does not claim to copy the entire computer or Hermes home.

## Included records

The allowlist in `server/private-workspace-backup.ts` includes:

- The encrypted Desk book and immutable `company-installation/workspace.json` identity.
- Agency setup, saved views, Schedule plans, job receipts, loop history, legacy expected bills and installed customer-pack journals, including reviewed instruction versions.
- Individually encrypted mail decisions, permanent task heads, every saved receipt/source, actual prepared-input bindings and migration origins, plus retained compatible legacy files. Backup and the live reader share the complete graph validator, including private workspace identity, exact source account, receipt digests, referenced messages and reverse source-to-task links. See `MAIL-RETENTION-2026-09-21.md` for the source follow-up and its proof layers.
- Recognized workflow database records: bank originals and reviewed copies, source-linked bills and recurrence history, invoice preparation requests and sign-in handoff receipts.
- Supported Markdown property/owner/decision notes, the standard vault documents, bounded workflow input files and instruction support text/licenses.

The export excludes provider configuration and keys, connected-account credentials, company enrollment/member tokens, the shared office database, the worker installation and authentication, conversations/memory, and arbitrary external attachments or files outside the supported folders. An unsupported database record kind or schema fails the complete export instead of disappearing silently.

## Portable encryption and consistency

The versioned `realbud-private-business` bundle uses scrypt with a random salt and AES-256-GCM. The 32-byte source data key is included only inside the passphrase-encrypted payload. It is never returned in a preview or written as a plaintext staging key. The passphrase is 16–256 characters. The file limit is 96 MB, with bounded file count, decoded payload size and individual business files; oversized workspaces require assisted backup, and no partial export is issued.

Export requires idle business work. The host mutation generation and captured business files/database records are rechecked before returning the bundle. Workflow records are read in a SQLite transaction and exported as validated data, not as executable uploaded database bytes. A restore creates its own fixed SQLite schema and re-encrypts each recognized record.

Every file has a portable allowlisted name, length and SHA-256 digest. Preview rejects wrong passphrases, tampered ciphertext, duplicate names, traversal/absolute paths, Windows reserved names, linked files, unknown records and incompatible or corrupt business schemas. Previews run through the same exclusive operation guard as exports and restore staging.

## Fresh restore and restart

The host requires an untouched sample workspace: no existing private business work, notes, edited office instructions, company enrollment or active work. A preview alone does not change records. An explicit restore binds the preview digest, repeats fresh/idle checks, and writes one stage encrypted with the target installation's current key. The host then holds business mutations and stops its runtime clock without changing the captured files.

`server/bootstrap.ts` applies the stage before importing application stores or starting work. It retains the target OS-backed key and re-encrypts the Desk, private mail envelopes and reconstructed workflow records. The source private workspace identity is preserved, so retained mail item identities still match their saved evidence. Company membership is not restored.

The boot journal distinguishes staged and applying work. Target fingerprints are checked before replacement, including office installation changes. Files are replaced atomically, then read back against their planned digests. An interruption resumes using that same target key; unexpected changes hold startup. Temporary database construction is cleaned up on both success and failure. The durable completion receipt records that rekeying and setup review are required.

Restore deliberately resets current authority:

- Gmail selection and agency setup reviews are cleared.
- Schedule plans are paused, their approvals/attachments cleared and revisions advanced; all existing code-owned loops are off.
- Queued/running job and loop receipts become interrupted. Historical completed evidence remains.
- Sign-in handoffs are closed. Unused Desk capabilities/handoffs are invalidated and expired, portal recipes become unpublished, and approved/preparing/handoff-ready Desk work is held. Used historical handoff receipts and draft/evidence history remain.
- Installed pack journals are retained, but native instructions must be repaired in the target worker profile and plans reviewed before execution.

## Verified evidence

The final focused domain gate passed **44 tests** across `server/private-workspace-backup.test.ts` and `server/private-backup-mail-validation.test.ts`. These cover encrypted portable export, excluded credentials, original bank-byte integrity, different-key restore, actual DeskStore reopening, actual collected-mail reader reopening with human corrections preserved, schema/source/workspace mismatches, stale targets, linked/malicious paths, interrupted multi-file application, replay and cleanup. Whole-project typecheck and `git diff --check` passed after these changes. The final main delivery report records 3,152 passing application tests plus 203 passing real PostgreSQL tests and the exact unsigned macOS package.

The actual UI/HTTP rehearsal uses two fictional local workspaces and the built GUI. Its six checks cover encrypted download, preview, changed file/passphrase invalidation, populated-workspace rejection, explicit fresh staging, and an owned child stop/start through the real source bootstrap. The restart restores an actual property and exact BOM/Unicode bank bytes under a different local key; all schedules remain off. Desktop and 390-pixel screenshots were visually inspected without page errors or horizontal overflow.

Artifacts: `outputs/private-backup-2026-09-21/receipt.json`, `boundaries.json`, `private-backup-preview-desktop.png`, `private-backup-preview-mobile.png`, and `private-backup-staged-desktop.png`. The separate boundary checks cover fresh-target notes/edited instructions/company state, stale preview, in-flight requests and the staged write barrier.

This evidence is local source-bootstrap and built-UI proof on macOS. It is not a live customer backup, a physical Windows restore, an installed native restart-IPC test, or managed-service delivery proof. No customer accounts or paid provider calls were used.

## Remaining lifecycle limits

Backup preserves history; it does not archive or delete it to release application capacity. Normalized mail removes the old 2,000-task/1,000-receipt aggregate limits while preserving source/input bounds. The earlier 1,000-request invoice preparation cap is removed; permanent proposal receipts now use shared live/backup validation and preserve transaction winners (see `PROPOSAL-RETENTION-2026-09-21.md`). Source-linked bill occurrences/patterns now have normalized encrypted retention without the old 500/100 aggregate caps; per-entity history/size limits remain. Backup v1 still refuses more than 5,000 physical workflow records, including mail records and derived bill indexes, and the settings UI explains that capacity. A supported larger-workspace backup remains separate work. Existing data is preserved rather than automatically deleted.

A downloaded-file confirmation does not prove that an off-computer copy exists. The bundle and its passphrase must be retained separately, and a successful restore should be checked against the intended business records before retiring the original computer. Connected accounts, office membership and workflow approvals must be established again on the restored installation.

## Packaged follow-up

The final unsigned macOS application passed seven packaged UI checks and seven packaged HTTP/bootstrap boundary checks using its own Electron 43.4.0 / Node 24.18.1. The latter includes a real public-key-file permission refusal followed by successful repair and restart without consuming the staged backup. See `outputs/real-estate-core-2026-09-21/packaged-backup/receipt.json` and `packaged-backup-boundaries.json`. The Windows installer now runs the same packaged API check, but no Windows result is claimed here. Native service restart IPC and customer keychain/Windows Credential Manager acceptance remain distinct from these owned child-process restarts.

The newer `outputs/source-bill-retention-2026-09-21/` checkpoint adds normalized bill graph validation and **34 passing backup/cache tests**, including 501 bills/101 patterns, exact different-key restoration, orphan-graph refusal and encrypted head-size enforcement. Incoming records and transformed restore writes share the live store's 8,000,000-character encrypted-envelope ceiling; a forged valid graph cannot bypass it via the larger plaintext limit. Actual packaged native restore now passes **5 checks** through unchanged preload/main/service code and displays the dated completion receipt. Every captured service PID exits before scratch deletion. This native test uses a labelled in-memory safeStorage fixture; OS Keychain/DPAPI proof is still separate. See `NATIVE-KEY-CUSTODY-2026-09-21.md` for the measured boundary and exact package hashes.
