# Ask desk continuity — 9 September 2026

Implemented in the local source checkout. Ask now keeps the draft mounted while the PM connects office apps, fixes model setup, reviews a schedule, or turns an office source off. No package, installed application, or production deployment was changed.

## Journey and ownership

| Journey | Result | Owner |
| --- | --- | --- |
| Ask → Add | Files, source readiness, source controls and connection management stay in Ask. Add is available even when the model is unavailable. The floating panel escapes the composer's scroll clipping, supports Escape and keyboard focus, and fits a 390px screen. | `ComposerOfficeToolkit`, `AskWorkspaceSheet` |
| Save key / switch mode / return from sign-in | Access refreshes automatically. One client subscription and one server observation cache supply Add, source chips, account settings and status replies. In-flight checks are deduplicated; invalidated results cannot restore old access. | `office-source-store`, `connected-apps-refresh`, `ConnectedAppAccessCache` |
| “What are we connected to?” | Product code answers from refreshed account and tool observations, including apps beyond mail. Ready, pending, stale, account choice, failed checks and off-in-Ask are distinct. Generic discovery tools are not presented as available to Ask when every source is unavailable or off. | `shared/office-sources`, `shared/ask-controls`, `connected-status-intent` |
| Chase a reply / prepare an owner update | Interactive Ask can receive the currently ready office apps without an email keyword gate. The turn instruction tells Bud when recent correspondence is relevant, supplies the selected account IDs, and retains exact-operation review and bounded mail guidance. | `office-source-turn`, `server/index.ts` |
| Turn off a source | A persisted source choice revokes existing app sessions and excludes that source from the next turn. Direct and mixed-batch app calls are restricted to enabled sources. Repeated identical choices do not revoke unrelated work again. Queued work is held when access changes. | source PATCH boundary, connected-app broker, ACP session identity |
| Ask → Schedule work → setup → Ask | The existing schedule editor and model setup open within Ask. A schedule request fills the existing plan description without replacing an unfinished plan. Timing, approvals, stale-plan protection and saved drafts retain their existing owners. Focus is restored when the panel content changes. | `ChatView`, `RoutinesPage`, `JobWorkspace`, `BudSetupCard` |
| Engineering language | Deterministic setup, schedule, inventory and generic failure replies use short PM wording. A regression check rejects settings arrows and internal terms in these replies. Advanced account configuration remains behind disclosures. | `ask-control-intent.test.ts` and reply formatters |

Source selection is a local capability choice, not provider disconnection and not permission to send, pay, or change records. Account and tool discovery is not proof of a successful mailbox read. Book recovery remains an explicit administrative recovery path; it is not replaced by model setup.

## Failure and concurrency handling

- A failed or malformed refresh clears usable access; saved credentials remain intact and Refresh is available as recovery.
- A late refresh cannot revive a source after invalidation. Mode and key changes retain the existing server serialization and Gmail consent recovery rules.
- Account choices must match a currently observed active account at the authenticated server boundary. Ambiguous accounts are not automatically mounted.
- Status tasks use the same operation identity and queue handling as connection checks, so a stopped or superseded reply cannot settle a newer task.
- Sign-in polling belongs to the app, survives switching views, is bounded to five minutes, and retries only status observations. It never retries OAuth creation or mailbox operations.
- The worker receives current source choices; internal/system-driven jobs do not receive these interactive app mounts. Previous conversation claims do not override the current turn's source state.

## Verification

- Focused regression suite: **365 tests passed** across 18 files. Subsequent checks covered the added inventory queue race, source idempotency, account selection, source-ID boundaries, schedule handoff and final copy. See the logs in `outputs/desk-continuity-2026-09-09/`; test runs overlap and their counts should not be added.
- Production build and TypeScript checks passed. Existing large-bundle warnings remain.
- Built UI plus real local HTTP API passed the scripted desktop/mobile walkthrough in `scripts/qa-desk-continuity.mjs`: draft → Add → save key → fictional sign-in → automatic refresh → live inventory → source off → inventory reflects removal → schedule → model setup → return to preserved draft → failed refresh and recovery.
- The walkthrough used a loopback provider and fictional accounts, made one fictional sign-in request, performed **zero mailbox operations**, and reported no browser errors or horizontal overflow at 390px.
- Review checked the task's changed source files for whitespace errors and preserved the pre-existing workspace changes. The wider checkout has an unrelated pre-existing whitespace warning in `src/lib/telegram-channel.test.ts`.

Evidence:

- [Desktop Add panel](../outputs/desk-continuity-2026-09-09/browser/ask-connected-desktop.png)
- [Schedule inside Ask](../outputs/desk-continuity-2026-09-09/browser/schedule-within-ask.png)
- [Mobile sources](../outputs/desk-continuity-2026-09-09/browser/ask-sources-mobile.png)
- [Latest browser result](../outputs/desk-continuity-2026-09-09/browser/result.json)
- [Main focused tests](../outputs/desk-continuity-2026-09-09/focused-tests-4.log)
- [Queue and handoff checks](../outputs/desk-continuity-2026-09-09/final-tests.log)
- [Source-only diff against this task's starting files](../outputs/desk-continuity-2026-09-09/task-changes.diff)

Re-run the browser check after building, using an installed Playwright runtime:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
CHROME_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
fnm exec --using=24 node scripts/qa-desk-continuity.mjs
```

## Remaining live proof

Real provider OAuth/account revocation, successful mailbox reads, real-model interpretation of contextual follow-up requests, and native microphone behavior were not exercised. The contextual-mail wiring and exclusions have local regression proof; a named-office job with the real model/provider remains the next validation step. Scheduled email execution is still outside the supported interactive mail path. No external messages, payments, record changes, package install, or deployment were performed.
