# Retained daily bank import history

The daily bank workflow previously stopped creating reviews after 500 distinct source files. Each review was already an individually encrypted workflow record, so removing that lifetime admission limit does not require rewriting or deleting historical data. This follow-up passed source, browser and unsigned macOS package gates; the checkpoint is recorded below and in `REAL-ESTATE-CORE-2026-09-21.md`.

## Contract

The original file digest remains the permanent batch identity. Repeated identical files return the same saved review. A changed mapping cannot replace a winning review, including concurrent imports from independent SQLite handles. Reviewed copies remain immutable; revision checks reject stale decisions.

`GET /api/bank-reference` returns a version-2 page with `batches`, `total` and `nextCursor`. Default page size is 20, maximum 100. A cursor retains its insertion highwater; later imports do not shift existing pages or alter their total. Refresh starts a new view. Details and original/reviewed downloads resolve the exact saved ID. Session and query admission remain authoritative at the HTTP boundary. Internal `list()` is a complete compatibility reader; the UI uses bounded pages.

History and the open transaction review are independent UI state. Refresh/load-more keeps decisions and reasons. Switching, reloading or importing another batch cannot silently replace meaningful unsaved decisions; discard is explicit. Failed history reads retain the loaded page and open draft.

## Source integrity and compatibility

The shared `validateSavedBankBatch` validates live reads/mutations and backup import/export. It regenerates row facts and candidates from the original CSV and saved mapping. It reconstructs reviewed output from admitted reference changes and requires exact output bytes and digests. A recomputed output hash cannot authorize changed amounts, dates, narrative, order or unrelated formatting.

Legacy text-only reviews retain their weaker source provenance. The original v1 writer removed quotes from changed reference cells when the replacement did not require quoting. Validation admits that exact historical algorithm as well as the newer quote-preserving algorithm for v1, while preserving the original saved output. It does not accept arbitrary parsed-cell equivalence or rewrite valid old results.

Private backup v1 still has its 5,000 physical-record and aggregate size limits. Bank history paging does not make that format unlimited or release capacity by deleting evidence. The single-file 750 KB CSV limit and normal encrypted record-size guard remain. See `PRIVATE-BACKUP-V2-PLAN-2026-09-21.md` for the separate larger-workspace format.

## Verification

- `outputs/bank-history-2026-09-21/backup-baseline.log`: reproduced the original 501st-import refusal.
- `backup-integrity-red.log`: reproduced acceptance of forged source-row facts and self-consistent prepared amounts before the shared validator was integrated.
- `legacy-quote-red.log`: reproduced the stricter reader rejecting the actual v1 quoting behavior, before exact legacy compatibility was added.
- `backup-integration.log`: **36 passing tests** across bank retention, private backup and normalized bill backup. Different-key restoration preserves all 501 bank identities, oldest original/prepared bytes, review revision and duplicate/mapping behavior. Forged facts/results are rejected before staging with unchanged target bytes. Legacy quoted-reference output survives restoration unchanged.

- `backend/receipt.json`: **60 passing tests** covering actual encrypted history and isolated bootstrap HTTP, 501 records, independent-handle races, strict queries and legacy compatibility.
- `projected-page.log`: **19 passing tests**. SQLite projects one decoded entity at a time; a real child with a 96 MiB old-space limit processes 32 near-limit encrypted records whose total exceeds its heap. This is a memory guard, not maximum-bank-page latency evidence.
- `browser/result.json`: **13 passing checks**, built React UI and actual local HTTP. Exact binary downloads, captured page totals, off-page selected review, drafts through failures/refresh, explicit discard and delayed-settings protection are exercised. Desktop/mobile frames were visually inspected. CSV data is fictional; failed history/detail responses and delayed settings are explicit browser injections.
- `parser-tests.log`: **34 passing parser tests**. Precomputing normalized payer aliases preserves identical full-batch digests for the fictional 1,000-row/300-property case. The single-Mac median changed from 144.76 ms to 12.01 ms (`alias-performance-before.json` and `alias-performance-after.json`); this is not a customer or Windows SLA.
- `full-source.result.json`: **3,412 passed, 143 environment-gated skips, zero failures**, 295 test files, 171.89 seconds. Counts overlap focused suites and must not be summed.

The fresh unsigned app is `outputs/bank-history-2026-09-21/package/mac-arm64/RealBud.app`. `package:prepare`, Electron syntax checks and packaging passed. `build-provenance.json` fingerprints 973 selected source/build/test/harness inputs, all 2,375 packaged regular files and 14 symlink targets, including actual `Resources/pack`, native helper and PostgreSQL contents. Source digest: `35d6276da1ff7f2401bc64abd582fdd0281b559d05082a1b67413a2e54e987ac`; artifact-manifest digest: `1af0155652e7493d8d0d0073e7c8de2b30094c92ce73692060bb1c8281021eed`. ASAR is unchanged from the preceding checkpoint because bank server/UI resources live outside it; ASAR alone cannot identify these changes.

`native-private-restore/receipt.json` records **five passing checks** through the actual app/main/preload/IPC/detached service/cold bootstrap. Different-key restore preserves exact bank bytes, normalized bill history, paused patterns and old aliases; current custody wins over a stale quarantine while alternative recovery material is preserved. The completion panel was visually inspected. All four captured service PIDs exited before scratch removal. `mac-smoke.log` passes renderer, capabilities, embedded service and shutdown.

Native custody uses labelled in-memory AES `safeStorage` fixtures, not OS Keychain or DPAPI. No live bank/REI/Gmail account, signed distribution, installed Windows or customer-office acceptance is established. The installed `/Applications/RealBud.app` remains unchanged. Invoice-proposal and mail follow-ups after this checkpoint require separate verification.
