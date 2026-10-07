# Watch and learn (2026-10-07)

Owner ask: "Show Bud" a portal task once, then Bud repeats it. This is our answer to builder canvases like Gumloop: offices teach by doing, in their own signed-in session.

## Decision

1. **Record in the work browser, not a new browser.** RealBud already launches the person's Chrome or Edge with a private profile and a loopback CDP port (`server/work-browser-host.ts`). The recorder opens its own CDP connection to that endpoint. It attaches to one tab and adds a binding and a script that runs on each new page. It only accepts events while the tab's main-frame URL is on the pack's origin, and it removes the binding and script on Stop.
2. **Page events are untrusted.** The listener reports role, accessible name and landmark (navigation, main, dialog or other) for clicks, plus field labels for typing, select and radio. The host validates every field, caps each string to 120 characters and the whole recording to 400 events. Page changes come from CDP `Page.frameNavigated`, never from the page itself.
3. **No typed values are kept.** A password or one-time-code field is recorded only as "signed in here". Every other typed field becomes a `{key}` input that is filled in at run time.
4. **The output is the existing recipe grammar.** Navigation clicks become `nav` menu paths; main and dialog clicks become `click`; typing becomes `type {field, "{key}"}`. The runner already resolves targets by role and exact name inside main or a dialog, so the recorder records the same things. A reached consequential label goes to `stopBefore`, and recording stops there. Checkboxes, file pickers and clicks outside main are flagged.
5. **Drafts never publish themselves.** Drafts live in `DATA_DIR/learned-recipes.json` (private JSON, revisioned). Publishing requires:
   - no flags;
   - every click label either on the pack's read-safe list or confirmed by a reviewer;
   - no confirmed label on the consequential list;
   - the merged pack still passes `parsePortalRecipePack`.
6. **Replay is unchanged.** `loadPortalRecipePack` merges the published learned recipes into the shipped pack. Recipes are added under the `learned-` prefix, and confirmed labels are added to read-safe. Running one is a normal `POST /api/browser/tasks/recipe`, so the Start grant, broker, fence, per-instance approval, sign-in pause and Stop all apply. Learned recipes are `kind: "read"`.

## Borrowed ideas, no new packages
- Playwright codegen (Apache-2.0): accessible role and name instead of CSS selectors.
- browser-use workflow-use (MIT): record once, turn typed values into variables, replay deterministically.
- rrweb is not used, and no package was added.

## Not in v1
- Native desktop apps (cua-driver recording).
- Model-assisted generalisation and step repair.
- Hermios shared passwords and 2FA. The owner parked these on 2026-10-07.
