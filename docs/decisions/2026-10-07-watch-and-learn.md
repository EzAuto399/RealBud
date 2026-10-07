# Watch and learn (2026-10-07)

Owner ask: "Show Bud" a portal task once, then Bud repeats it. This is our answer to builder canvases like Gumloop: offices teach by doing, in their own signed-in session.

## Decision

1. **Record in the work browser, not a new browser.** RealBud already launches the person's Chrome or Edge with a private profile and a loopback CDP port (`server/work-browser-host.ts`). The recorder opens its own CDP connection to that endpoint. It attaches to one tab and adds a binding and a script that runs on each new page. It only accepts events while the tab's main-frame URL is on the pack's origin, and it removes the binding and script on Stop.
2. **Page events are untrusted.** The listener reports role, accessible name and landmark (navigation, main, dialog or other) for clicks, plus field labels for typing and select (never the chosen option) and radio names. The host validates every field, caps each string to 120 characters and the whole recording to 400 events. Page changes come from CDP `Page.frameNavigated`, never from the page itself.
3. **No typed values or chosen options are kept.** A password or one-time-code field is recorded only as "signed in here". Every other typed field and every select becomes a `{key}` input that is filled in at run time; a reviewer may pin fixed text (such as "All"). A click whose label reads like row data (digits, `$`, `AUD`, or over 60 characters) adds no step and is flagged without its text.
4. **The output is the existing recipe grammar.** Navigation clicks become `nav` menu paths; main and dialog clicks become `click`; typing becomes `type {field, "{key}"}`. The runner already resolves targets by role and exact name inside main or a dialog, so the recorder records the same things. A reached consequential label goes to `stopBefore`, and recording stops there. Checkboxes, file pickers and clicks outside main are flagged.
5. **Drafts never publish themselves.** Drafts live in `DATA_DIR/learned-recipes.json` (private JSON, revisioned). Publishing requires:
   - no flags;
   - every click label either on the pack's read-safe list or confirmed by a reviewer;
   - no confirmed label on the consequential list;
   - the merged pack still passes `parsePortalRecipePack`.
6. **Replay is unchanged.** `loadPortalRecipePack` merges the published learned recipes into the shipped pack, for person-started Ask recipe tasks only: unattended loops (REI morning refresh, directory refresh) load `loadShippedPortalRecipePack`; W1 (uploads and prepare recipes) loads `loadPortalRecipePackWithPaths`, which keeps person-approved path overrides but never learned recipes or confirmed labels. A damaged learned file is named in the Ask run's reply. Recipes are added under the `learned-` prefix. Confirmed labels are never added to the pack's `readSafe` (since #130): they reach the runner only as `learnedReadSafe`, for tasks that run that learned recipe (`learnedReadSafe` in `server/portal-recipe-task.ts`), and the press guard (`learnedPressable`, #121) re-checks each one against Submit, affirmative and consequential labels (`consequentialKind`) before it can be pressed. Do not widen `readSafe` from a learned recipe. Running one is a normal `POST /api/browser/tasks/recipe`, so the Start grant, broker, fence, per-instance approval, sign-in pause and Stop all apply. Learned recipes are `kind: "read"`.

## Borrowed ideas, no new packages
- Playwright codegen (Apache-2.0): accessible role and name instead of CSS selectors.
- browser-use workflow-use (MIT): record once, turn typed values into variables, replay deterministically.
- rrweb is not used, and no package was added.

## Not in v1
- Native desktop apps (cua-driver recording).
- Model-assisted generalisation and step repair.
- Hermios shared passwords and 2FA. The owner parked these on 2026-10-07.
