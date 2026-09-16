# PM journey review — 7 September 2026

This pass followed everyday work through Desk, Properties, Ask, CSV review and Schedule. The priority was avoiding lost work and dead ends, preserving existing approval boundaries and reducing unnecessary setup prompts. The earlier office-form and portfolio-grouping work remains in place.

## Fixed journeys

| Journey | Problem found | Result |
| --- | --- | --- |
| Add a property | Dialog closed before the save succeeded | Entered details remain after failure; the server's error is shown inside the dialog; successful saves close it. Pending submissions are guarded. |
| Edit notes | Leaving the field silently saved; snapshots could erase drafts | Explicit Save/Discard, inline success/error, retry and session draft retention across pages and app views. |
| Edit options | Background snapshots reset inputs; all options were resubmitted | Only edited options are sent. Drafts resume after navigation; invalid day relationships are shown before submission. |
| Return from Bud | Desk returned to its default view | View, task filters, search, selection, property group, page and expanded property remain in this app session. |
| Follow a task link | Remembering a view could interfere with task-directed navigation | Schedule, workday actions and notification links explicitly open the task queue. Ordinary return navigation restores position. |
| Review CSV by keyboard | Focus could escape the modal; effect reruns could reset focus | Tab/Shift-Tab stay in the review, Escape respects pending work, and focus returns to the prior control. The add dialog uses the same behavior. |
| Work with a live book | Sample replay appeared in property management | Replay is offered only in demo mode and is disabled while property drafts exist. |
| Understand missing data | Optional notes and property codes contributed to an eight-field completion prompt | The card names useful missing facts without nagging about optional fields. |
| Reject invalid options | Earlier fields could mutate before a later validation failure | Options are validated on a copy before replacing the current options. |

Ask's contextual handoff and Schedule's existing draft retention were exercised successfully. This review did not change their worker execution semantics. A property with no recorded check no longer displays ledger badges as though a check result exists.

## State, safety and limitations

Property draft text remains in memory, using the existing case-editor approach rather than writing unencrypted note content to browser storage. It survives navigation while the app stays open; it is not crash/restart recovery. A before-unload guard covers unfinished property and case edits. Platform handling of native-window closing still needs installed-app verification.

Per-property pending state and duplicate-submit guards outlive individual cards. Failed operations retain drafts and sanitized local recovery messages. Discard reads the latest accepted property values. Removing a property with unfinished edits is disabled until those edits are saved or discarded. The server still validates input, recovery state, property existence and duplicate addresses/codes. An interrupted add can have an uncertain outcome; the dialog advises checking the book before retrying, and existing server duplicate checks remain in force.

Saving options sends only changed keys, so unrelated options are preserved. Concurrent edits to the same field still use the existing last-save behavior; this pass does not add collaborative locking. It does not grant sending, payment, portal or PMS mutation authority. No database migration, new dependency or live model call was introduced.

## Verification

- 147 tests passed: property draft isolation/retry/duplicate handling, authoritative Desk validation, queue/grouping, authenticated HTTP, Ask context, job-plan behavior, office validation and completeness copy.
- 27 browser checks passed using synthetic data on isolated API port 18983 and UI port 5203. Coverage includes add failure/retry, snapshot updates during edits, navigating to Ask and returning, restoring search and expanded editing, failed note/option saves, partial option payloads, discard, CSV keyboard containment/import, live-book replay visibility, case handoff without sending, Schedule draft retention, narrow layouts and task-notification routing.
- No browser runtime errors. Production build and TypeScript checks passed; existing Vite chunk-size warnings remain.
- Scoped diff and whitespace review passed. Before copies, screenshots, test logs, the browser harness and scoped diff are under `outputs/pm-journey-review-2026-09-07/`.
- One repeated browser attempt reused fixture values already equal to the intended edits. The fixture initialization was corrected and the final run passed; the failed attempt log remains available.

The installed native application was not replaced. Real-PM usability sessions, native release verification and sustained live-Bud output-quality/throughput checks remain open. These tests establish local behavior, not a claim that every workflow is now optimal.
