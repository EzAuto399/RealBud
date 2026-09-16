# PM daily experience walkthrough

Reviewed and improved on 5 September 2026. This is source and browser evidence for the current working tree, with a separate real Hermes canary using fictional inputs. It is not an installed-package or live-agency acceptance report.

The later [work completion and reuse review](PM-AGENTIC-WORK-REVIEW.md) records the second pass, including real file comparison, complete output preservation, result handoff and reusable jobs with editable inputs.

The practical goal is to let a PM describe an outcome, provide the relevant sources, see what is happening, review useful work and continue later with less repeated explanation. The repository already contained substantial job-journey and Hermes compatibility work. This pass preserves that work and completes the interaction gaps found during the walkthrough.

## What changed

| Observed friction | Resulting interaction | Main implementation |
| --- | --- | --- |
| Ask said the workroom was ready with no worker installed and offered the wrong model-setup action. | Ask and Schedule derive availability from the same dependency-ordered facts: connection, recovery, worker, safeguards, model and readiness receipt. A failed probe offers a recheck, not an invented installation failure. | `src/lib/bud-setup.ts`, `ChatView.tsx`, `schedule/JobWorkspace.tsx` |
| Setup and service outages prevented the PM from writing a request. | Ask keeps the draft editable, explains the missing dependency once and blocks starting work until ready. Existing draft storage preserves text across navigation and a service restart. | `Composer.tsx` |
| A blank conversation gave little practical help using the worker. | Four editable examples cover owner updates, document comparison, daily priorities and public research. They ask for sources and the desired output. Choosing an example never starts work or overwrites an existing draft or attachment. Any other task can still be described. | `PmTaskStarters.tsx`, `src/lib/pm-task-starters.ts` |
| “Build my plan” was available when the worker could only fail. | Model-dependent actions explain setup first. The PM can still write and save a plan manually while the worker is unavailable. | `schedule/JobWorkspace.tsx` |
| Plan decisions and results required searching through a long form. | Each open plan explains its next step and has direct, keyboard-focusable links to plan actions and results, including empty or failed result loads. | `schedule/JobWorkspace.tsx` |
| Steering and queuing were small icon controls. | Ask labels them “Steer now” and “Do next”; the start button is labelled and uses the product's larger decision target. Existing execution and queue semantics remain authoritative. | `Composer.tsx` |
| Prepared output was mixed into the receipt trail. | Completed, partial and held preparation results expose readable, selectable prepared text and a copy control. Sources and held actions stay visible. Rehearsal narration is excluded from reusable prepared output. Clipboard failure explains how to copy manually beside the result. | `desk/JobRunFeed.tsx`, `src/lib/job-run.ts` |
| An empty history could say “Loading activity…” indefinitely. | Jobs and routines have independent loading, ready and error states. Retry keeps prior results; requests have a 15-second fetch budget and a request generation guard, so an older refresh cannot replace a newer refresh. | `src/state/store.tsx`, `desk/JobRunFeed.tsx` |
| Capability descriptions were generic and disconnected from doing work. | You explains six practical uses and opens Ask or Schedule directly. Tool progress uses plain labels for planning, finding prior work, inspecting images and delegated checking. | `BudSetupCard.tsx`, `src/lib/tool-label.ts` |

## Hermes capability evidence

RealBud owns the PM interface, context, approvals, schedules and status. Hermes remains a separate worker. The property profile already configures `web`, `terminal`, `file`, `vision`, `todo`, `session_search` and `delegation`; this pass adds no permissions or toolsets.

| Capability | Product use and strongest evidence from this pass | Remaining limit |
| --- | --- | --- |
| Plan and prepare work | Real provider drafted an editable plan, rehearsed it and prepared the correct total from fictional inputs 17 and 26. Approval was bound to the edited revision. Duplicate execution returned the same run, and its receipt survived reopening the store. | A synthetic computation does not establish first-pass quality for a real owner update or other office work. |
| Conversation continuity | Real ACP handshake, warm follow-up and a fresh worker process with restored transcript all retained a fictional reference label. | This proves the tested continuity path, not retrieval quality across an agency's historical work. |
| File, image, research and calculation tools | Existing profile configuration and boundary code inspected. Editable examples and capability guidance make these paths discoverable. | No live document-comparison or public-research accuracy benchmark was run in this pass. Required files and connections must actually be available. |
| Task planning, session search and delegation | Existing toolsets inspected; progress labels now explain these operations. Delegation remains bounded to two children and 24 iterations by the profile. | The real canary did not invoke delegation or session search. Enabled configuration is not proof of those tools completing a customer task. |
| Steer, stop and queued follow-up | Existing branching, ACP and watchdog tests passed. Ask now shows the relevant actions in plain language. | A live provider turn was not interrupted or steered during this pass. |
| Repeating and on-demand jobs | Schedule's reviewed plan lifecycle remains in place. The PM HTTP regression battery and real prepare/rehearsal contract passed. | Native Hermes cron is not a second scheduler. RealBud remains responsible for scheduling, revision approval and receipts. |
| Named portals and connected apps | Existing attachment/connection boundaries preserved. Portal-job HTTP scenarios passed. | This is not proof of authentication or a successful job in a customer's live portal. |

The official [Hermes v0.21 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31) was checked for upstream context. Upstream feature availability does not itself establish that a feature is exposed, permitted or verified inside RealBud. In particular, this work does not introduce native Hermes bot management, a second cron service or unrestricted MCP access. `execute_code` remains omitted from the property toolsets until its approval path is supported.

## Verification

- Frontend TypeScript project build, server TypeScript check and Vite production build passed with Node 24. Vite still reports large bundle chunks; no bundle-performance improvement is claimed.
- 103 tests across 10 focused files passed: readiness/setup, task starters, job plans, output selection, tool labels, activity deduplication, branching, ACP and watchdog behavior.
- The five-suite PM HTTP battery passed: Desk, PM day, PM exceptions, portal jobs and walkthrough. These use controlled test fixtures and do not substitute for a live office visit.
- `scripts/qa-hermes-contract.mjs` passed with a real configured provider and fictional inputs. It exercised readiness, plan drafting, rehearsal, revision approval, correct preparation, duplicate prevention, durable results and fresh-process transcript recovery.
- Browser walkthrough at 900 × 600 verified editable examples, preservation of an existing draft, the correct setup destination, disabled model-dependent actions and manual plan creation/save.
- An isolated local service was stopped and restarted. Ask showed reconnection, retained the draft across reload, and recovered when the service returned.
- A synthetic HTTP failure exposed “Reload activity.” Retrying with an empty successful response produced the true empty state without a loading message.
- Prepared text copied exactly, including paragraph breaks, without diagnostic notes or held-step text. A clipboard-denied attempt exposed the manual-copy fallback. Expanding a rehearsal did not create an additional prepared-text copy control.
- No model keys, customer records, external messages or live portal operations were used in the browser fixtures. No independent Hermes installation or profile was changed by this pass.

Screenshots contain fictional walkthrough data. The Ask image intentionally shows a missing-worker case so the retained draft and correct setup route are visible.

![Ask at the minimum desktop size](../outputs/ux-walkthrough-2026-09-05/ask-900x600.png)

![Prepared work and its review context](../outputs/ux-walkthrough-2026-09-05/prepared-result-900x600.png)

## Next customer proof

Use one named PM and one recurring workflow from discovery. Compare the current process with three representative repetitions in RealBud. Record PM input time, review and correction time, repeated explanations, missing information, first-pass acceptance and follow-ups completed. Measure net PM time returned after review and correction, rather than model response speed alone.

The installed desktop package has not been rebuilt or replaced with these changes. No claim is made that every Hermes capability is fully exercised or that a live agency has achieved measurable time savings yet.
