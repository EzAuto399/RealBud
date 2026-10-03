# W2/W3 operating model clarified by the owner

1 October 2026 · Australia/Brisbane.

The owner clarified that the ongoing source for both workflows is the user's connected **Composio Gmail account**. The supplied CSV, which commonly arrives by email, is an example/reference for property matching, bill shape and timing. A new CSV is neither a recurring prerequisite nor the workflow trigger. “Training” here means reviewed examples and retained patterns; no model fine-tuning has been performed.

## W2 — weekly bills review

At the selected weekly time, RealBud collects the reviewed Gmail scope and Bud identifies new invoices, forwards, changed versions, unresolved bills and expected arrivals needing attention. RealBud saves the review results, maintains its internal bill calendar and follow-up schedule, and notifies the user of meaningful new or changed work. Kevin remains the accountable W2 reviewer.

Calendar meanings stay distinct:

- A reviewed received invoice can supply an actual due date.
- A reviewed recurring pattern supplies an expected-arrival window.
- An expected invoice not found in adequate checked coverage produces a missing-bill follow-up, not a fabricated payable invoice.
- Incomplete coverage, unread attachments or an unresolved candidate that could be the expected invoice produce a review/coverage hold.

Preserve existing review and duplicate controls. Automatically retained candidates and follow-ups do not silently become confirmed invoice facts or paid bills. An unchanged repeat should retain decisions and avoid duplicate calendar entries or repeated notifications. Later evidence can resolve or reopen a finding with history.

REI comparison is a separate attended verification step when needed. It requires the user's fresh client login and agency/account confirmation each run. Routine Gmail collection, bill preparation and the morning brief do not depend on that login. REI writes, imports, payments and external sends retain their existing simulation-only boundary.

## W3 — daily priorities before work

Using the same explicitly selected Gmail account, collect the reviewed inbox and sent context, then prepare the user's ordered morning work list: urgent decisions, unanswered requests, waiting/follow-ups and reference information. Preserve saved decisions and reopen items when substantive new evidence arrives. Present the brief and a notification through RealBud.

The selected time currently starts collection and preparation; it does not guarantee that the brief is finished at that minute. Set the start early enough for the desired before-work delivery, then measure the actual run. Workdays, time and timezone are owner choices, not assumptions made from the CSV.

## Current implementation boundary

The source now contains the clarified next workflow-pack instructions. Existing production capabilities include the Gmail collector, source-bound bill proposals, reviewed bill records, separate calendar dates/windows, and the full daily morning-review runner with guarded schedule controls.

The weekly W2 orchestrator is **not yet implemented**. Its remaining host work is:

1. Add a dedicated weekly bills loop/configuration using RealBud's existing durable clock. Generic scheduled recipes do not collect fresh Gmail and cannot stand in for this loop.
2. Coordinate W2 and W3 across collection and preparation so shared source receipts cannot switch beneath a run; account for delayed/offline weeks and source gaps.
3. Prepare and retain invoice candidates in bounded batches with current source identities, duplicates/version conflicts and recoverable review drafts.
4. Persist arrival findings tied to approved patterns and the complete relevant checked interval. Unreviewed candidates and gaps prevent a definite missing claim.
5. Save a durable changed-results summary and internal attention state linked to Bills/calendar. Existing Schedule attention badges can carry an initial review notification; desktop/paired-channel digests currently use older Desk counts and need their own result integration.
6. Run an installed weekly collection → preparation → saved review/calendar → repeat/recovery rehearsal, and verify W3 at its selected scheduled time.

These are the next W2/W3 acceptance gates. Native Hermios CRM and multiple departmental Buds remain separate workstreams; they do not block the Gmail-first milestone. W1 still waits for the original and corrected reference examples.

The owner has been asked for the weekly review day/time and daily brief workdays/time. No new clock has been enabled by this clarification. The workflow-pack instructions describe the intended host behavior and preparation boundary; they are not evidence that scheduled work or notifications have already occurred.

Source pack revision 5 and its reviewed-upgrade behavior passed 67 tests across six files, server typechecking, generated-pack verification and whitespace checks. These source instructions have not replaced the installed pack. See the [clarification validation receipt](../../outputs/w2-w3-readiness-2026-10-01/gmail-operating-model/clarification-validation-receipt.json).

Related evidence: [W2/W3 readiness](../W2-W3-READINESS-2026-10-01.md), [integration completion plan](../WORKFLOW-INTEGRATION-CLOSURE-2026-10-01.md).
