# PM Desk layout and navigation review — 7 September 2026

The screenshot showed a Desk dominated by repeated status information above a compressed case canvas. This change brings the task queue, draft review and Bud into the main working area, and makes property management easier to reach and scan.

## Implemented

- Explicit Tasks, Properties and Batch work destinations with a visible current selection.
- Morning overview collapsed by default; address details, setup and keyboard help remain available on expansion. Recovery, failed checks and operation errors remain visible.
- Contextual Bud panel beside the case on wide windows, with an Evidence switch and a closable panel on smaller windows. The worker status is separate from source freshness.
- Case-level Ask and Evidence actions. Ask stages the selected case, case type, recorded observation, hold and wording in the existing composer. Unsaved wording is separately labelled. Opening Ask does not submit a turn or grant approval.
- Draft editing beside the wording. Failed saves retain the editor. Saves submit the revision captured when editing began; a conflicting revision remains rejected by the existing server boundary.
- Unfinished case edits live in Shell memory across case and page navigation, and disappear when the app session ends. They are not written to browser storage or disk.
- Properties starts sorted by address, retains alternate sort/group controls, folds notes on demand and offers View tasks for the chosen address. Existing option editing, notes-on-blur, import review and removal confirmation remain wired.
- Sidebar labels explain what each destination contains. Compact workspace status retains important worker issue summaries and expands supporting details on demand.

## Engineering scope and assumptions

This is an improvement to the current local source, not a replacement of the existing PMS or approval workflow. Existing uncommitted work was preserved. No dependencies, server routes, database schema, credentials or external permissions were changed. The assistant handoff is source material in the existing composer and preserves an existing request through the existing merge mechanism. Sensitive wording remains in app memory or the explicitly staged conversation context.

The implementation uses the existing queue, evidence, decision, property and Ask components. Queue and assistant widths adapt at 980px and 1320px. The header is bounded so expanded overview/activity cannot consume the entire task canvas. Existing queue pagination and bounded property rendering remain unchanged.

## Verification

- Production build passed, including UI/server TypeScript checks. Existing Vite large-chunk warnings remain.
- 73 focused tests passed across five files: desk Ask context, queue, work continuation, book grouping and server Desk.
- 31 browser assertions passed against an isolated sample server: draft save failure/retry, revision submission, actual stale-revision rejection, unfinished edits across cases and Ask navigation, source-preserving handoff without a model send, property notes/options disclosure, property-to-task navigation, keyboard Home/End, empty-search recovery, and assistant panel open/close.
- Browser layout checked at 1512×982, 1200×800, 900×600 and 640×760, including horizontal overflow and visible decision controls. No browser runtime errors.
- The scoped final diff passed whitespace checks. A separate pre-existing trailing blank line in `src/lib/telegram-channel.test.ts` was left unchanged.

Commands:

```sh
fnm exec --using=24 pnpm build
fnm exec --using=24 pnpm test src/lib/desk-ask-context.test.ts src/lib/desk-queue.test.ts src/lib/work-continuation.test.ts src/lib/book-groups.test.ts server/desk.test.ts
fnm exec --using=24 node outputs/pm-desk-layout-2026-09-07/verify-ui.mjs
```

Screenshots, logs, browser harness and copies of the files before this turn are in `outputs/pm-desk-layout-2026-09-07/`. The browser harness uses an isolated local sample API on port 18979; the preview runs on port 5199. It does not exercise the installed app's data or live provider execution.

## Remaining proof

The installed RealBud application was not replaced or restarted. Native package verification, live-office integrations and PM usability interviews are outside this local validation. Unsubmitted edits are retained only for the current app session; they are not crash/restart recovery. Property notes retain their existing save-on-blur behavior.
