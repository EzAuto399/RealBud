# One workspace experience

RealBud's four screens now share more of the same interaction contract: carry the work forward, recover where the problem occurs, preserve unfinished input, and describe the consequence of an action before offering it.

## Delivered

| Area | Result |
| --- | --- |
| Setup | One panel for Bud, office apps, phone connections and office details. Desk, Batch work, Schedule and Ask can open it without leaving their work. It names the originating screen and returns there. |
| Setup continuity | Visited panel sections keep their entered fields for the lifetime of the open panel. Credentials are not persisted by this navigation feature. The background is inert; dialog focus and shortcuts stay inside the active interaction. |
| Work continuity | A shared work-reference card appears in Desk's Bud panel, Ask attachments, job plans and job results. Removing an Ask reference preserves the user's wording. Saved-result context remains reference material, not fresh evidence or permission. |
| Navigation | Conversation reading position and follow-latest behavior, Desk queue position/results, Schedule selection/timing sections/results/scroll, and You scroll survive switching screens in the open app. Existing draft persistence remains in its existing owners. |
| Connection truth | Desk and phone setup share a phone connection roster. Concurrent reads coalesce, late refreshes cannot restore a disconnected account, invalid/failed reads clear usable state, and pairing changes refresh automatically with bounded fast polling. Office sources retain their existing shared readiness state. |
| Feedback | Unconfirmed global action failures stay visible until dismissed, including inside an active setup dialog. Copy controls share loading, success, failure and retry behavior across Ask, settings commands, pairing codes and prepared results. |
| Partial success | A saved job whose schedule refresh fails is identified as saved. Its recovery action retries only the read, never the save. |
| Reviews | Plan approval and action approval use explicit scope explanations. An approval receipt does not claim the action completed. Server approval, revision, idempotency and execution boundaries are unchanged. |
| Empty states | Desk offers the next action directly, including starting the sample/recheck, clearing a search, or showing all tasks. Supporting explanations stay under a disclosure. |
| Visual consistency | Shared surface colors, control sizes, focus outlines, mobile touch targets, setup navigation, notices and reference cards. Telegram's mark also appears in phone setup. On mobile the plan's action bar no longer covers its fields; duplicate plan status was removed. |
| Language | Primary schedule and recovery copy describes jobs and results rather than clocks or runtime sessions. A focused copy-lint test guards these surfaces. |

## Validation and evidence

- Production build with both TypeScript projects.
- 445 tests passed across 62 files: frontend libraries/components, the existing branch API, and scheduled-job behavior. New checks cover connection races, malformed responses, failure recovery, navigation drafts, notice behavior, review scope and copy language, including server-provided routine descriptions.
- `scripts/qa-workspace-unification.mjs` runs the built application against an isolated local service with a fictional conversation. It covers all four screens, panel return/focus, entered-field preservation, conversation position, job saving with failed-refresh recovery, draft retention, work-reference removal, persistent errors and desktop/mobile layout.
- The existing desk-continuity walkthrough verifies automatic fictional OAuth return refresh, source removal and deterministic inventory. The Telegram walkthrough verifies the message rendering, clipboard failure/retry and request versions.
- Logs, JSON results, screen captures, before snapshots and the task-only diff are under `outputs/workspace-unification-2026-09-09/`.

## Boundaries

These are local source and built-browser results. No live Telegram messages, mailbox work, customer records, payments, deployment or packaged-app installation were performed. The installed desktop app still requires a new package/update. Book recovery and deep account administration remain explicit admin operations. Navigation memory added here is scoped to the open app; it is not a new disk-persistence contract. This pass is not a certification that every possible accessibility or provider failure has been covered.
