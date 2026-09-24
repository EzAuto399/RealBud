# Batch-history backup integration review

One concrete wiring gap in the provided restore call sites. The rest of the batch backup path that is actually in the snippet is consistent with the stated restore contract.

## 1. v1/v2 restore does not map `restoreWorkBatches` / `JSON.parse` failures onto `fail` / `invalid`

**Trigger.** `work-batches.json` is present in a v1 snapshot or v2 catalog and is not valid stored history: truncated JSON, non-array document, duplicate ids/keys, or a clone that cannot take a safe revision/timestamp write.

v2 (`transformFile`):

```ts
if (file.path === 'work-batches.json') return jsonFile(file.path, restoreWorkBatches(JSON.parse(file.data.toString('utf8')), at), file.encoding);
```

v1 (`restoredFiles`):

```ts
else if (f.path === 'work-batches.json') value = restoreWorkBatches(value, at);
```

`restoreWorkBatches` throws a bare `Error` (`invalid batch history`, `unsafe restore timestamp`, `unsafe batch revision`). `JSON.parse` throws `SyntaxError`. Neither attaches `status`.

Every sibling branch in those same functions uses `fail(...)` / `invalid(...)` so the backup/restore contract carries an HTTP-class `status` (400/413/409). Admission already does the right thing:

```ts
if (path === 'work-batches.json' && !validStoredWorkBatches(value)) fail('Saved portfolio batch history needs recovery; no partial backup was created.', 400);
```

**Consequence.** Invalid batch history is fail-closed on **export** with a typed 400, and fail-closed on **v2 size overflow** via `jsonFile` (413), but schema/parse/unsafe-timestamp failures on **restore** leave the module’s statused error convention. Callers that branch on `error.status` will not treat this the same as a bad `loops.json` / `recipes.json` / desk book. The helper is intentionally host-agnostic; the integration still has to map it.

**Narrow fix.** Map at the two call sites only. Do not change validator semantics.

```ts
// v2 transformFile
if (file.path === 'work-batches.json') {
  let parsed: unknown;
  try { parsed = JSON.parse(file.data.toString('utf8')); }
  catch { invalid(); }
  try { return jsonFile(file.path, restoreWorkBatches(parsed, at), file.encoding); }
  catch { invalid('Saved portfolio batch history needs recovery; no partial restore was prepared.'); }
}

// v1 restoredFiles
else if (f.path === 'work-batches.json') {
  try { value = restoreWorkBatches(value, at); }
  catch { fail('Saved portfolio batch history needs recovery; no partial restore was prepared.', 400); }
}
```

Keep `jsonFile`’s 413 on the stringify/size path.

**Missing test.** For both `restoredFiles` and `transformPrivateBackupCatalog`: (a) `work-batches.json` bytes `{` or `[1]`; (b) a valid running batch whose `updatedAt` is finite but not restorable (`Number.MAX_VALUE`). Assert the thrown value has `status === 400` (or 413 if you only oversize after stringify), the same class as other business-file restore failures, and that the v2 destination catalog is not sealed.

---

## What was checked and is not a finding

- `STATIC` includes `work-batches.json`; v1 `validateBusinessFile` fail-closes invalid history on export; both restore transforms call `restoreWorkBatches` rather than copying raw bytes.
- Authority reset matches the spec: `autoContinue` / `waitingForWorker` forced off, `retryAt` deleted, `running` items → `interrupted` with output/source/attempts kept, queued stays queued, ready items are structurally unchanged. `recoverReadyWork` cannot auto-start that state (`paused && autoContinue && waitingForWorker`).
- Codex parent fix is in the helper (`running` **or** queued/running children → `paused`), so a finished parent with queued children is not copied through as finished. Both restore paths go through that helper; there is no “finished → verbatim file” bypass in the snippet.
- Codex monotonic write is in the helper (`max(at, floor(updatedAt)+1)` + `nextSafeRevision`) and is used by both transforms.
- v2 does not invent a missing `work-batches.json` (unlike `loops.json`), so empty history stays absent.
- Execution projections only rewrite `job-runs.json` / `loops.json`; they cannot clobber batch history.
- Inner source/output identity is preserved by `structuredClone` then JSON round-trip of strings; the fixture’s BOM / `\r\n` / `私人` ready-item `toEqual` is the right check. File-level pretty-print/key-order change is expected after authority rewrite.
- v1 `file()` has no 8MiB check after stringify; that is the pre-existing restoredFiles helper, not a batch-only miss. v2 `jsonFile` already 413s this file.

## Unverified production boundaries (not findings)

These were not in the pasted capture/apply/HTTP adapters. Local 99-check / capture-failure tests are not packaged or live evidence.

1. **Capture I/O.** `filesAt` / `bytes()` implementation: existing `work-batches.json` **> 8MiB** must `fail` the whole export, not drop the path. The snippet is truncated before that body.
2. **Streamed v2 catalog build.** That `privateBackupSourcePaths().staticPaths` and `validateBusinessFile` (not only the v1 snapshot) are what the catalog writer uses when adding files.
3. **Apply/removals.** Destination `work-batches.json` is removed when the backup omits the file (old archive, or source had no history). Otherwise a restore can keep leftover local batches.
4. **Backup root vs `DATA_DIR`.** `BatchService` writes `join(DATA_DIR, "work-batches.json")`; STATIC is `'work-batches.json'` relative to the snapshot directory. Same directory is assumed, not shown.
5. **HTTP/UI mapping** of restore errors after the defect above is fixed; worker/model continuation; packaged desktop apply; live source-account restore.

No other integration defect is supportable from the supplied source without guessing those callers.