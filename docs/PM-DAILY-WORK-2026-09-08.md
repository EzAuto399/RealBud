# Daily PM work: execution, review and reuse

8 September 2026. This pass fixes the path from a saved job or property batch to a useful result, review, and another day's work. It uses fictional inputs. It does not establish that a customer office's PMS or inbox is connected.

## Important gaps addressed

| Gap | Implemented behavior |
| --- | --- |
| Losing a job response could make a retry run Hermes again | Schedule saves a request UUID before sending. Checking an uncertain request retrieves the same retained receipt, including after reload. Running work returns HTTP 202. An explicit new run gets a new UUID after the outcome is confirmed. |
| Another window could clear that UUID while a stale screen still offered “Check previous run” | Checking retains the exact UUID. If it was cleared or replaced elsewhere, the screen refreshes results without creating another operation. |
| Job status changed in memory before its disk write succeeded | State and events update after persistence. Corrupt history, failed restart settlement and uncertain flushes hold job operations with sanitized recovery messages. The original history is preserved and Desk can still open. |
| A queued attended job could mix an older plan with newer permissions | A queue for an outdated revision is cancelled before starting. The PM reviews the current plan before another run. |
| A summary with no usable output could appear completed | A preparation with neither output nor an explicit request for missing information fails visibly. Held-input results can continue into Ask with the original request and questions attached. |
| Results in Schedule sent PMs to Desk even when no Desk task existed | Manual and scheduled work share an expandable result feed. Actual drafts, sources and held steps appear in Schedule. Desk links appear only for runs that produced Desk tasks. Header controls jump to plans, the week and results. |
| Repeating a previous property batch required reconstructing its selection | **Repeat this work** previews its exact surviving property membership and instruction. The new draft captures current saved Desk facts and notes when started. Removed properties are listed; new units are not silently added. |
| Reviewing large batches mixed pending and completed review | All, To review, Needs attention and Reviewed filters combine with address search and existing pagination. A new batch resets result filters. |
| Opening another plan could discard an unfinished description | Bare descriptions now receive the same navigation protection as edited plans. Settings' old run buttons open the exact plan in Schedule. |
| The real Hermes check stopped after a 12-second quiet provider stream | RealBud supplies a supported 60-second child-process SSE idle default. Explicit settings and the existing overall job deadlines are preserved. No Hermes profile, model, credential or upstream source was changed. |

All work remains under the existing review and permission boundaries. Reusing a result or supplying missing information does not approve a held action. Batch preparation still uses supplied snapshots, without live inbox refresh, sending, booking, payments or PMS mutations.

## Verification

- Final broad test run: **1,263 passed, 8 skipped, 145 test files**. The final Settings navigation simplification was followed by another production build and a browser check.
- Production frontend/server TypeScript and Vite build passed. The existing large-chunk warning remains; no bundle performance improvement is claimed.
- Portal HTTP regression suite passed with zero skips.
- Nineteen browser checks passed with a 200-property fictional book at 390, 600, 900 and 1440 pixels. They cover result expansion, protected drafts, batch review/reuse, keyboard focus on section jumps, lost-response reload, the cross-window check race and missing-input handoff. No browser runtime errors or page overflow. A twentieth check verifies Settings opens the exact Schedule plan without an execution request.
- Controlled tests cover duplicate requests, deliberate new attempts, stale revisions, bounded output, partial progress, storage failure, malformed history and restart. A corrupt-history server smoke confirmed healthy startup, history read/mutation 503, Desk 200, unchanged original bytes and no unhandled errors.
- The first real Hermes preparation failed at the provider's 12-second SSE idle threshold. After the supported default change, the fictional quote comparison completed in **44.2 seconds**, preserved the source reference and AUD 35 difference, and exposed unresolved tax/access/spending questions. The complete result survived reopening. Checking the same request after reopening made no second worker call. The response was read; its summary is more confident than the detailed comparison and the draft remains verbose, so human review still matters.
- Early browser harness failures used an obsolete button accessible name. They are preserved separately from the final passing checks. An early new test incorrectly supplied an array to parameterized test arguments; that harness error was corrected. The first package attempt was stopped to include the final Settings change.

- The rebuilt macOS app passed strict deep code-signature verification, DMG checksum verification, and the native renderer/capabilities/embedded-server/shutdown smoke. Bundled files matched the tested production UI and server. A native walkthrough opened the new package with its own 200-property fictional workspace, displayed the saved manual result in Schedule, and completed a real Bud readiness check in **9.8 seconds**. No new notarization was performed.

Evidence, screenshots, before copies and the scoped diff are in `outputs/pm-daily-work-2026-09-08/`. Use its **Open review app.command** launcher for the new package and isolated review workspace.

## Remaining proof needed

The most important next proof is one named PM completing one repeated daily workflow using their authorized current sources. Verify account identity, read scopes, pagination, property matching, freshness, approval, confirmed external completion and reconciliation after an uncertain outcome. Measure the PM's total time, including review and correction, over repeated runs. A fictional 200-property UI check is not a real 200-property Hermes throughput test.

Job idempotency is bounded by the existing 1,000 retained receipts. Older API callers without request IDs retain independent-attempt behavior. Scheduled routine triggers and attended portal actions have their own existing controls; this change does not claim every possible operation has indefinite duplicate protection.

Cross-device behavior still uses the existing paired chat channels and responsive interface. Actual phone pairing, live customer accounts, remote access while the Mac is asleep, native mobile capture/push and independent PM usability remain separate verification work. A local signed package does not establish fresh notarization or a generally available release.

No credentials, office records, installed app, unrelated build, or prior review history were deleted or replaced in this pass.
