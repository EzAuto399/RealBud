# Permanent invoice preparation requests

Status: implemented and verified at source/API/browser and unsigned macOS package level. This follows the bank checkpoint in `BANK-HISTORY-2026-09-21.md`.

## Behavior and integrity

Invoice proposal intents already use individually encrypted workflow records. The 1,000-request lifetime admission cap is removed without migrating or deleting historical requests. The normal per-record encrypted size guard and available disk remain limits. A retry of an old ID still reconciles to its permanent job receipt; an intent without a worker receipt remains held for explicit recovery, never converted into new paid work automatically.

The previous service checked for an existing request before asynchronous source/authority reads, then ignored the database create result. Two service instances could observe absence and later use different inputs for one request ID. The final claim now reads/creates and validates the winning receipt inside a SQLite transaction. A different source, request payload, recipe or authority loses before executor admission or input replacement. An identical loser replays the winning receipt, preserving its original preparation time and exact input. Job projection also verifies the exact idempotency key.

`bill-proposal-validation.ts` provides the canonical input builder and pure stored-receipt validator used by live replay and private backup. The persisted shape is unchanged. Validation enforces the one-document metadata-only contract, exact relationships, empty file-access scope, field limits and original source-reference bindings. Live replay additionally reconstructs the entire input from trusted current source and agency authority. Backup preview/staging reject malformed inputs before touching destination business records.

Historical inputs with attachments omit MIME types and sizes. Pure backup validation can check their schema and relationships but cannot reconstruct the complete original source digest from omitted fields. Live admission still compares their retained input with trusted source and authority. Attachment-free receipts allow exact source-digest reconstruction. This is not independent authentication of a customer's original email.

## Evidence

- `outputs/proposal-retention-2026-09-21/retention-red.log`: seven regressions reproduced before the fix, including the 1,001st refusal and conflicting/identical competing claims.
- `backup-red.log`: three malformed proposal inputs were accepted by the earlier backup preview: file scope, conflicting source reference and extra document.
- `focused.log`: **36/36** tests pass, including two actual independent encrypted SQLite handles, different preparation timestamps, an already queued winner, conflicting payload/source/authority, interrupted intent recovery, wrong job key and altered attachment-bearing input. Worker execution is deterministic and isolated; no paid provider call is made.
- `backup-integration.log`: **40/40** across proposal, bank, normalized bills and existing private backup. All 1,001 retained proposal identities survive different-key restore; an old unfinished intent stays held without entering the executor or writing new worker input. Re-encrypted malformed imports are rejected before preview/staging, leaving target bytes unchanged.
- `browser/receipt.json`: **12/12** actual source HTTP/built-React checks with a fictional connector and deterministic invoice worker. Proposal display, source/attachment acknowledgement, bill acceptance/correction, repeated scans, calendar and retained-page/draft behavior pass. Desktop/mobile frames were visually inspected; no renderer errors.
- Server typecheck, package preparation and independent source review pass. The earlier full source checkpoint passed **3,412 tests with 143 environment-gated skips** before this follow-up; it is not presented as a rerun of the changed code. Focused counts overlap and are not summed.

Private backup v1 still has 5,000 physical workflow records and aggregate size/file bounds. Removing live request admission does not remove backup capacity limits. Mail normalization and streaming backup v2 remain unfinished; their plans are `MAIL-RETENTION-PLAN-2026-09-21.md` and `PRIVATE-BACKUP-V2-PLAN-2026-09-21.md`. Windows, live Gmail/REI, OS Keychain/DPAPI and signed distribution remain separate proof gates.


## Packaged checkpoint

Fresh unsigned macOS arm64 app: `outputs/proposal-retention-2026-09-21/package/mac-arm64/RealBud.app`. The installed `/Applications/RealBud.app` remains unchanged. Build preparation/typechecks and packaging passed. `build-provenance.json` includes 977 selected source/build/test/harness inputs, all 2,376 packaged regular files and 14 symlink targets. Source digest (including the native harness follow-up): `061d50ad956b33319dfe67ea8521b3590a278f49f8935c427a9ec2a7258b6807`; artifact-manifest digest: `047e7a43a6b7bcbbaab74e97a901525557ae97c2fe8243233bbd4d5d95b4f9d6`. The unchanged ASAR does not identify server/UI changes stored outside it. The pre-build source input manifest is retained; only the QA script changed after packaging.

`native-private-restore/receipt.json` records **six passing checks** through actual packaged main/preload/IPC/service/cold bootstrap. Native different-key restore retains exact bank bytes, normalized bill/paused-pattern/old-alias history and the invoice proposal intent. A separate packaged compiled-domain probe validates the exact restored proposal record and rejects its unfinished retry without worker admission or mutation. That probe uses explicit fictional source/authority callbacks, not live HTTP/Gmail authorization. In-memory `safeStorage` AES fixtures do not establish OS Keychain or DPAPI custody. All captured service PIDs exited before temporary data was removed. Native harness changes received an independent read-only review.

`mac-smoke.log` passes renderer, native capabilities, embedded service and clean shutdown on this exact package. The final native completion view was visually inspected. Final tracked-diff and direct changed-file whitespace/conflict checks passed, including untracked source files.
