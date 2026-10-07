# Watch and learn: checkpoint 2026-10-07

**Not yet established:** a recording made in RealBud's own work-browser host, a packaged or installed build, any run against live REI Cloud, and customer acceptance. All evidence below is source, local tests or a local real-Chrome run against synthetic pages.

Decision: `docs/decisions/2026-10-07-watch-and-learn.md`.

## What exists
- **Recorder** (`server/learn-recorder.ts`). It opens its own CDP connection to the work browser and attaches to one tab. It installs a binding and a listener script, and accepts events only from the main frame's default context while that frame is on the pack's origin. Page events come from the host. Typed values are never read. Password and one-time-code fields are recorded only as `secret`. Stop claims the session synchronously, and if saving fails the events are kept for a retry.
- **Compiler** (`server/learn-compile.ts`). It turns events into v1 recipe steps using the runner's role and name targets:
  - navigation clicks become `nav`;
  - a click on a pager control (Next, Previous or a page number) becomes a paged table read ending `{paginate:true}`;
  - a label exactly on the pack's consequential list goes to `stopBefore`;
  - any other risky label flags the step and stops compiling there.
- **Risk rule** (`learnLabelRisky`, `server/learned-recipes.ts`). A label is risky if it matches the pack's consequential list in any case or as part of a longer label, or the broker's consequential, submit, affirmative, credential or sign-in patterns. A risky label can never be confirmed, published or merged.
- **Store and merge** (`server/learned-recipes.ts`). Drafts are kept in `DATA_DIR/learned-recipes.json` with revisions; a stale revision gets a 409. Blockers are checked against the shipped labels. Merge validates each recipe on its own and skips only a bad one. `loadPortalRecipePack` merges published recipes, and a damaged file still leaves the shipped recipes working.
- **Task lock** (`NativeBrowserRuntime.setLearning`). No browser task can start while a recording is running.
- **API**: `GET /api/learn`; `POST /api/learn/start|stop|cancel`; `POST /api/learn/recipes/:id`, plus `/publish`, `/unpublish` and `/delete` on the same path.
- **UI**: Schedule has a "Show Bud a task" header button that opens a drawer (`#schedule-learn`, `src/components/schedule/LearnedRecipesCard.tsx`). Run uses the existing `POST /api/browser/tasks/recipe` Start card.

## Evidence (2026-10-07, lead rerun)
- `pnpm typecheck`: clean.
- vitest, 10 files (learn-*, learned-recipes, native-browser-runtime, portal-recipe-task, portal-recipe-runner, browser-authority, browser-broker, LearnedRecipesCard): 282 passed, 0 failed, 0 skipped.
- `server/learn-replay.test.ts`: recorded, published and replayed through the real broker on the fictional REI mock. It read 2 pages and 6 rows, stopped before "Notice" without pressing it, and asked the person for no approvals.
- Full `pnpm test`: 8872 passed, 0 failed, 336 environment-gated skipped (583 files passed, 32 skipped).
- `scripts/qa-learn-record.mjs` (real headless Chrome, trusted input, synthetic HTTPS portal): 22/22. Receipt: `outputs/learn-record-2026-10-07/`.
- `scripts/qa-learn-ui.mjs` (built renderer in scratch, isolated service): passes. Receipts: `outputs/learn-ui-2026-10-07/lead-final/`.

## Known limits / next
1. Confirmed labels are added to the portal-wide read-safe list (benign labels only, after the risk rule). Keeping them per recipe needs a runner change.
2. There is no model-assisted repair when a recorded step stops matching the page.
3. Native desktop apps (cua-driver recording) are not covered.
4. Hermios shared passwords and 2FA are parked by the owner.
5. Next proof: record a read-only task in live REI with the owner present, through the packaged app.
