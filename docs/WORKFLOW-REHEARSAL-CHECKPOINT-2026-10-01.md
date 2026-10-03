# W1 sign-in hold and W2/W3 improvement checkpoint

1 October 2026 · Australia/Brisbane.

## Installed W1 preparation

At 20:51, the installed RealBud Ask conversation received a supervised W1 preparation request. Bud acknowledged that it is waiting for the user to sign into **both the bank and REI Cloud in RealBud's dedicated work browser**, then explicitly confirm both sign-ins and the intended bank account and REI agency/trust account. No browser task, export, upload, receipt posting or recurring schedule was started by this request.

This is an instruction-level checkpoint in Ask, not a new saved W1 job or a completed workflow test. A ready browser connection does not prove either website is signed in. Before any account work, the user must confirm the bank product/login origin, account nickname, REI agency/trust account and initial covered period. Passwords, MFA codes and full account numbers are not requested in chat. Expired authentication returns to the same human sign-in hold. Final receipt posting remains the user's action.

The installed native runtime still rejects downloads and uploads. A complete automated W1 export-to-REI test therefore remains unavailable. Original/corrected bank CSV examples, overlap handling, a two-day runner and REI outcome verification remain acceptance requirements in the [W1 operating model](decisions/2026-10-01-w1-bank-to-rei-workflow.md).

The work browser was reported ready by the installed app. Its separate Chrome process is not exposed through the personal Chrome extension. A usability gap remains: the ready state has no **Show work browser** action, and connection readiness does not check that a window is visible. Do not restart or close it while the user is signing in.

## W2 and W3 readiness

| Workflow | Ready now | Still needed |
|---|---|---|
| W2 weekly Gmail bill review | Controlled manual collection, source-bound proposals, recoverable drafts, reviewed bills and arrival calendar | Weekly runner, persisted coverage-aware arrival findings, internal follow-up handoff, changed-result notifications, installed repeat/recovery acceptance |
| W3 daily Gmail priorities | Daily runner, bounded batches, retained review decisions and missed-run history | User-selected timing, result-specific notifications and installed scheduled acceptance for the intended account |

The installed Schedule screen showed Morning priorities **paused**, with a prior partial result of 10 collected conversations and zero prepared. Its displayed weekday 08:00 setting is existing configuration, not confirmation of the user's desired delivery time. Weekly W2 timing and daily W3 workdays/delivery time were requested; no new schedule was enabled.

## Improvements made in source

- **W3 source identity:** before another model batch, compare the prepared source receipt, Gmail account and account-binding revision with this run's collection. If they differ, hold the run and preserve saved batches. This avoids paying for a new batch under a replacement source. It is a defensive guard, not full collection/preparation locking; concurrent collection and empty-input races still need coordination.
- **W2 collection feedback:** expose the actual complete, partial, failed, interrupted or running receipt, its requested source interval in the office timezone, counts and the next review action. Retain/read back failed collection receipts and distinguish saved messages from reviewed bill or attachment facts.

These changes are in the development checkout. They have not replaced the installed app, and they do not implement the weekly runner or qualify either workflow for unattended operation.

Validation on Node 24.21.0 passed: **101 tests across seven files**, full UI/server typechecking and scoped whitespace checks. The suites were `morning-mail-workflow`, `morning-mail-scheduler`, `morning-w3-readiness`, `mail-ingestion`, `SourceBillsPanel`, `bill-review-drafts` and `source-bill-pages`. Independent diff review found no blocking defect within this scope. The new receipt presentation has component-render tests; it has not been visually accepted in an installed build.

## Next implementation order

1. **Finish reliable routine execution.** Give W2 a dedicated weekly runner using the existing durable clock. Bind W2 and W3 preparation to an immutable collection, retain completed candidate/batch IDs, recover missed coverage and resume without repeating accepted work.
2. **Make results easy to act on.** Show one result card per routine: checked account and period, new/changed/held items, last confirmed completion, next run and a direct review action. Keep sign-in holds, coverage gaps and partial outcomes visible. Send notifications only for meaningful changes, failures or required action.
3. **Reduce repeated work.** Reuse unchanged evidence and verified attachment extraction, keep batches bounded, and measure collection time, preparation time, model calls, retry counts and work left incomplete. Add lookup indexes only when measured retained-history scans justify them.
4. **Prove recovery before activation.** Rehearse unchanged repeats, concurrent collection, service restart, lost responses, expired authentication, late runs and conflicting evidence. Verify the installed app's saved results and notifications, not just model output or source tests.

The existing [Gmail operating model](decisions/2026-10-01-gmail-w2-w3-operating-model.md) remains the acceptance contract. Native CRM and additional departments are separate milestones.
