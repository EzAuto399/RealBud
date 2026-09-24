# Source bill lists and historical lookup — 21 September 2026

The private bill API now returns bounded pages and exact historical lookups. A bill or approved arrival pattern remains addressable after leaving the first page. The expected-bills summary applies its property, status group and text filters on the server, counts every matching row and returns only the requested page. No first-page absence is treated as proof that a source, bill or pattern does not exist.

## HTTP contract

These routes retain the desktop session and origin boundary. They do not connect to an email provider. Default page size is 20; the HTTP maximum is 100. Unknown, repeated, empty or malformed query parameters are rejected with 400. Cursor errors require refreshing the view, not retrying a mutation with a different identity.

| GET route | Query | Result |
|---|---|---|
| `/api/bill-register` | `from,to,propertyId,limit` | `SourceBillsWorkspace` version 2: counts, range and first occurrence, series and calendar pages |
| `/api/bill-occurrences` | `cursor,limit,propertyId` | `{items,nextCursor,snapshotCursor,total,revision}` |
| `/api/bill-series` | `cursor,limit,propertyId` | `{items,nextCursor,snapshotCursor,total,revision}` |
| `/api/bill-register/calendar` | `from,to,cursor,limit,propertyId` | `{items,nextCursor,revision}` |
| `/api/bill-occurrences/:id` | none | `{occurrence,originSeries}`; 404 when absent |
| `/api/bill-occurrences/by-source/:identity` | none | `{occurrence,originSeries}`; both null when absent |
| `/api/bill-series/:id` | none | `{series,occurrence}` with the exact origin bill |
| `/api/bill-series/matching` | `accountId,propertyId,kind,vendor,includeSeriesId?` | `{series}` containing at most the matching active pattern and explicitly retained historical link |
| `/api/bill-occurrences/:id/source` | none | `{itemId,accountId,receiptId,thread}` from the exact saved private mail identity |
| `/api/expected-bills` | `origin,propertyId,group,query,cursor,limit` | Version 2 summary described below |

Occurrence IDs retain the `source-bill:` prefix and 64-hex identity; pattern IDs retain `bill-series:` and UUID. The current-source route derives account and thread from the authoritative occurrence, derives the private mail item identity on the host, and verifies the returned account/thread. It cannot be redirected to a caller-chosen account. Missing current mail returns 404 or a recovery error independently of retained source text and correction history. Historical source alone does not authorize a new correction.

Workspace counts describe the register; each occurrence or series page supplies its own matching total. Dates default to UTC today through 366 days later, with the existing maximum 550-day span. Arrival predictions remain distinct from reviewed invoice due dates. A reviewed bill occupying an arrival period suppresses that prediction even when the bill is outside the displayed occurrence page.

Source cursors are opaque and bind insertion highwater marks to their kind, property and calendar range. Empty filtered physical pages may still have a continuation. Clients must continue using `nextCursor`; an empty `items` array alone does not establish absence. Existing corrections remain visible and may change a filtered view between reads. Exact lookup and revision checks govern edits.

## Expected-bills summary

The response is `{version:2,bills,groups,total,counts:{legacy,source},nextCursor,revision}`. `groups` contains only the returned page. `total` and `counts` describe all rows matching this view's filters within the captured source insertion snapshot. `origin` is `all` (default), `legacy` or `source`; groups are `needs-you`, `due-soon`, `in-process` or `settled`. Text search is bounded to 200 characters and searches bill kind, property ID, note, vendor and status. Omit an empty text query.

The summary scans source pages of 100 and immediately projects each row to slim bill fields. It retains at most the requested page plus one candidate, not a lifetime array of source bodies or correction histories. Ordering uses immutable creation time and an ID digest; continuation binds the normalized filters, a source snapshot cursor and a digest of the legacy records. The digest also avoids putting long legacy labels into page cursors. New source insertions stay outside an existing page sequence. Changed legacy content invalidates that sequence rather than silently shifting its offset. Current source corrections remain visible. The legacy-only view can remain readable when the source register needs recovery.

The host reuses a lazy register per `WorkflowDatabase` object. Its graph cache is invalidated by the storage layer's database change token. No workflow database is opened by declaring this cache, before staged-restore bootstrap runs.

Within one summary response, all source pages must have the same register revision. The combined workspace likewise requires calendar, counts, occurrences and series to agree. A commit by another process between those reads returns 409 with a refresh instruction instead of a mixed-time count or view. Corrections between separate client requests remain visible as described above.

## Authority, compatibility and limits

Existing POST/PUT review contracts are unchanged. The host still resolves source evidence and reviewer identity, rechecks private-book recovery and the current property directory after asynchronous source reads, and passes exact revisions/digests to the domain. Pattern approval and reactivation use direct historical getters. Pausing an existing pattern remains possible after its property is removed; reactivation requires a current property.

The GET workspace contract explicitly changes from full version-1 arrays to version-2 pages. Compatibility `snapshot()` and `expectedRows()` remain complete domain methods for bounded legacy consumers and tests; production HTTP lists and readiness counts no longer call them. The legacy expected-bill POST response is unchanged. Current source, corrections and pattern control do not depend on whichever rows a browser has already loaded.

This is the paged API slice of normalized bill retention, not a claim of unlimited storage or archival. Exact summary totals still require a source scan; the legacy register still uses its existing file reader. Initial or externally invalidated graph validation has its own full validation cost. Per-record correction bounds, private-mail retention limits, backup-size limits and archive/export policy are separate gates. No external payment, message, attachment download or live customer workflow was exercised here.

## Verification

The focused API/projection gate passed **60 tests** with the real encrypted workflow database. It includes 501 saved bills and 101 arrival patterns, exact lookup and correction beyond the first page, pattern pause beyond the first page, a summary search finding the 501st bill, complete filtered counts, stable pagination during inserts, current corrections, changed-filter and malformed-cursor refusal, legacy-change invalidation, compatibility for long legacy IDs and finite timestamps, continuation through an empty filtered physical page, calendar prediction suppression, and current-source binding/recovery. Two real database handles prove that commits between page reads fail with a refresh response and preserve the committed correction. Spies reject accidental use of the unbounded compatibility readers in the production API paths. Server TypeScript checking passed after these changes. The machine-readable gate is `outputs/source-bills-retention-2026-09-21/api/vitest.json`, with the source hashes and scope in `receipt.json` beside it.

Rendered UI, actual authenticated HTTP bootstrap, portable-backup roundtrip, packaged desktop and customer acceptance are reported separately by their respective integration gates. A passing local API test is not evidence for those layers.
