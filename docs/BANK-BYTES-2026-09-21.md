# Bank file preservation — 21 September 2026

New uploads from **Prepare bank references** now capture the file's binary bytes through `File.arrayBuffer()`. The server admits strict UTF-8 and UTF-8 with a byte-order mark only; it rejects invalid byte sequences, other encodings, malformed CSV and ambiguous simultaneous text/binary payloads. Rejection does not replace saved reviews or change the local source file. Rejected files are not retained as new workflow records.

The existing encrypted workflow store retains the admitted source's filename, encoding, byte count, base64 bytes and SHA-256 digest in batch version 2. The parser's offsets are converted to byte positions against that captured source. Reviewed exports copy unchanged byte ranges and replace only approved reference cells, retaining existing reference quoting and all surrounding bytes. Original downloads retain the source filename. Both download paths verify the bytes against the saved digest in the browser before constructing a binary Blob.

Existing version 1 records and internal text-only callers remain compatible. They are explicitly identified as saved text whose original upload bytes and encoding were not captured. Their downloads are UTF-8 reconstructions; they are not silently relabelled as byte-preserved originals. Opening an identical file reuses its existing review, including this limitation for a legacy record. A different mapping for the same source is rejected after atomic database deduplication, and a reviewed batch cannot be approved again. Mapping amendments, account/date-range binding, overlapping-file reconciliation and durable reasons for kept rows remain separate work.

## API contract

The existing authenticated JSON routes remain in use. New creation accepts:

```json
{
  "source": { "filename": "Fictional bank.csv", "bytesBase64": "..." },
  "columns": { "date": "Date", "amount": "Amount", "narrative": "Description", "reference": "Reference" },
  "dateFormat": "YYYY-MM-DD",
  "rules": []
}
```

`source` replaces `csv` on the new upload path; the server derives metadata and never trusts a client digest or encoding declaration. The original source limit remains 750,000 bytes, and the request limit is 2 MB for base64 plus mapping. Export responses add `bytesBase64`, `byteLength`, `filename`, `encoding` and `originalBytesCaptured` alongside compatible `csv` and `digest` fields. `shared/bank-source.ts` defines these transport shapes.

## Verification

Focused checks cover BOM, non-ASCII and supplementary characters, mixed line endings, quoted multiline cells, multiple replacements, all-keep byte identity, invalid codecs/base64, source corruption, encrypted reopen, repeated filenames, legacy records, changed mappings and stale/repeated review. The UI helper tests exercise raw file transport and rejection of a mismatched binary download.

```sh
pnpm exec vitest run server/bank-reference.test.ts src/lib/bank-file.test.ts
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/qa-bank-bytes.mjs
```

The browser rehearsal starts a disposable real local server against the built UI, uses a fictional bank file, exercises original/reviewed binary downloads and reload, and captures desktop/mobile screenshots. It does not use a live bank, model, mailbox, payment service or REI account. Its receipt is `outputs/bank-bytes-2026-09-21/result.json`; a scripted test is not an installed Windows or customer REI acceptance result.

Observed: **37 focused tests passed**, and the real UI/HTTP rehearsal passed all six checks, including original/reviewed browser downloads, reload persistence, rejected encoding, legacy disclosure and no browser exceptions. Desktop and 390px mobile screenshots were inspected. The mobile page had no horizontal overflow. Source-service and UI checks used the current local build; no live financial action or Windows execution occurred.
