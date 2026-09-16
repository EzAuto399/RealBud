# Portfolio layout and persistent preparation — 7 September 2026

## Behaviour

RealBud now adapts its default property view and spacing at 50 properties. A PM can override automatic mode with cards/table, comfortable/compact spacing, 20/50/100 rows per page, 240–360px queue width and whether Bud remains open on wide windows. These presentation preferences and property sort are validated and saved locally. If storage is unavailable, choices continue in memory for the session.

Property search covers the complete book. The task queue adds a case-type filter and renders only the selected page, while keyboard Home/End and arrow navigation can cross pages. Changing filters resolves selection to a visible case. Property tables expand the existing notes/options editor and retain View tasks. Large tables scroll inside their own container on narrow windows.

Batch preparation now accepts up to 500 distinct properties through the existing authenticated boundary. Both the picker and result list are paged; selection spans pages and search, with a visible count. Result search and Needs attention filtering operate over the complete batch. Preparation still handles one property at a time, with a fixed source snapshot and bounded worker turn for each.

The optional **Continue after reconnect or restart** choice:

- Saves each property's result and attempt state atomically.
- Resumes opted-in work after reopening when Bud is ready; older batches retain manual recovery.
- Checks availability at most once per 30-second timer tick without overlapping recovery probes or active workers.
- Retries worker/transport failures up to three total attempts per property, with persisted 30/60-second backoff deadlines. Invalid output remains a reviewable failure. Explicit manual retry remains available.
- Keeps manual pauses paused, including when an availability check was already in flight. Pausing a retry wait wakes it without waiting for the deadline.
- Does not repeat completed properties. An interrupted preparation can repeat within the attempt bound because it never granted external-effect tools.
- Keeps locked-book recovery, stale controls, idempotent submissions, source isolation and review-only permissions.

History is bounded to 100 batches and 2,000 property results for new creation. Only fully reviewed, finished batches can make room. Unreviewed or unfinished results block new work at capacity rather than being discarded. Existing histories remain readable under their original validation limits.

Progress responses omit worker source documents. Clients send the revision they already have; unchanged progress returns `batch: null`, avoiding repeated result transfers. Source snapshots remain on the server for recovery and retries.

## Engineering and compatibility

No dependencies or external permissions were added. Workspace layout is presentation state, not a record mutation. New batch fields are optional in stored files. Omitted/false continuation retains the existing request hash, while opting in changes the hash and cannot be silently enabled through an idempotent replay. Atomic persistence errors stop preparation. Existing unrelated workspace changes were preserved.

The batch snapshot persistence format remains a bounded JSON history. Writes are synchronous and serialize progress before further dispatch. The tests demonstrate the chosen 500-property bound, not unlimited capacity or parallel worker execution. Bud runs while RealBud is running; this does not create an always-on service while the Mac is off.

## Verification

- Build passed, including TypeScript checks. Existing Vite large-chunk warnings remain.
- 47 batch/layout tests passed, including completion at 20, 50, 100, 150, 200 and 500 properties, restored results, opted-in restart continuation, manual recovery compatibility, availability races, capped retries, cancelled backoff waits, history capacity, source isolation and conditional responses.
- 61 HTTP/queue/book/context tests passed, including authenticated batch access, input validation and restricted response payloads.
- 46 browser checks passed on an isolated synthetic book. They cover every portfolio size above, full-book search, bounded rows, next-page navigation, remembered overrides, existing property editing, keyboard navigation across more than 1,000 task rows, selecting all 500 properties, selecting beyond the former first-100 cutoff, a saved unavailable-worker batch, a manual pause, omitted source documents and unchanged-response suppression.
- Browser overflow checks passed at 1200×800, 900×600 and 640×760. Wide screenshots use 1512×982. No browser runtime errors were observed.
- Scoped final diff checked for unintended changes and whitespace errors.

The first browser attempts exposed test-harness issues: an exact label selector, a fixture without sufficient actionable cases, and a test API lacking its configured UI port. Complete failure logs were preserved. The final test uses real CSV import to generate queue work and the supported `OMB_UI_PORT=5200` configuration; origin validation was not weakened.

Artifacts and commands are in `outputs/pm-portfolio-scale-2026-09-07/`:

```sh
fnm exec --using=24 pnpm build
fnm exec --using=24 pnpm test server/batches.test.ts src/lib/workspace-preferences.test.ts
fnm exec --using=24 pnpm test server/index.test.ts src/lib/desk-queue.test.ts src/lib/book-groups.test.ts src/lib/desk-ask-context.test.ts
fnm exec --using=24 node outputs/pm-portfolio-scale-2026-09-07/verify-ui.mjs
```

The browser harness is destructive only to its isolated synthetic book on port 18980. Its API uses a separate temporary data directory; it does not access the installed app's records on port 8799. The created synthetic batch was manually paused at the end with zero worker attempts.

## Remaining proof

The installed RealBud application has not been replaced. Native-package validation and a sustained run using a connected live model remain open. Simulated-worker completion is not measured provider throughput or proof of output quality for 500 real properties. Existing approval requirements remain in place for sends, payments, dispatch and property-record changes.
