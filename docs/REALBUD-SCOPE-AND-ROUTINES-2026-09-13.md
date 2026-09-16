# RealBud: scope confirmation and recurring work

**Current commercial edition:** use [revision 32](../outputs/austin-monday-2026-09-14/README.md). It replaces the separate paid fit-check model with an A$1,500 project deposit, reduces CRM setup to A$1,500, makes the initial usage allowance reviewable and shows hosting budgets. Older figures and order wording below are historical; the current proposal, agreement and engagement JSON govern the offered scope.


**Connected-service positioning:** RealBud brings requests, priorities, prepared work, approvals and schedules together across the company's tools. The [Composio catalogue](https://composio.dev/toolkits), checked 13 September 2026, advertises 1,500+ app integrations. Google Workspace is an initial implementation example, not the product boundary. Catalogue breadth does not mean all integrations are included or live-tested. Keep the agreed first workflows, Kevin as initial operator, existing fees and delivery sequence; scope and test additional services before activation. Original business systems keep their records.


13 September 2026 · Working scope for review before implementation

Agent OS is now proposed at **A$4,500**. Keep the A$1,500 fit check credited toward that total, then propose A$1,000 at written scope/build start, A$1,000 at pilot/accepted go-live, and A$1,000 at the completed 30-day review/handover. Care remains A$299/month including A$75 eligible usage, with the first two care months included and paid invoices from month three after accepted go-live. Stage 2 remains separately approved A$2,000 setup and A$149/month. The [current engagement](AUSTIN-ENGAGEMENT-2026-09-10.json) and [concise proposal](AUSTIN-CUSTOMER-PROPOSAL-2026-09-10.md) retain the remaining commercial terms.

The price revision does not establish customer acceptance or silently change the delivered scope. This document defines the proposed work and open decisions. No new product implementation or routine activation was performed for this review.

## The work to confirm

RealBud is the office's supervised assistant across its existing files, websites and applications. Hermes supplies the agent engine. RealBud owns the authorised job, schedule, source access, saved work, review decisions and recovery. REI remains the financial record.

The first delivery contains two required workflows:

1. **Expected bills:** learn a provisional arrival pattern from approved history, have the office confirm it, check the agreed sources, and keep one continuing case as evidence changes. Expected arrival, receipt, processing, funding and verified payment remain separate facts. A failed source check produces an incomplete-coverage hold. Staff should not maintain a second spreadsheet or re-enter the same evidence daily.
2. **ANZ rent-reference preparation:** acquire the agreed export when the permitted session is available, preserve the original, propose supported reference changes, hold uncertain payers, and prepare a reviewed file for Kevin's REI preview. Verify unchanged dates, amounts, row count, order and totals. A manual upload remains a labelled fallback; it does not satisfy automatic acquisition acceptance.

The deployment remains one office, one agreed Windows 11 workstation, one primary operator and named reviewer, up to two agreed Gmail accounts, one ANZ/REI format and one supported phone route. The first technical example does not reduce those delivery obligations. Confirm the named native Windows app and browser during the fit check.

Revision 26 adds a initial Google resource scope within the broader connected-service product: up to two Gmail accounts, one Calendar, one Drive source folder tree and one output folder for Kevin. Morning priorities, calendar preparation and source-linked file/draft assistance join five templates, weekly summary and the guide. Eight assistance hours span teaching and observation. Source IDs, volumes, allowed actions and live acceptance are required; no sending or extra staff access is granted. See Schedule D of the current agreement.

**Resolved 13 September:** the user has excluded Airbnb allocation and Form 11 from this engagement for now. Any future consideration requires a separate scope and quote. Optional native macOS setup and CRM hosting/recovery are added as separately ordered options; the Windows baseline remains unless changed in writing.

Company CRM remains Stage 2. Private staff DMs, independent staff memory/account permissions, multiple execution computers and broad autonomous application work need their own scope; the three CRM seats do not automatically include them.

## Proposed operating rhythm

These are recommendations for confirmation, not active schedules. Exact times, weekends, timezone, quiet hours and source availability belong in the accepted routine.

| Work | Proposed trigger | Result and review |
|---|---|---|
| Refresh bill evidence and check expected arrivals | Each agreed working morning; weekly-only checking is too coarse for the proposed missing-bill routine | Update existing cases from the agreed inboxes/files. Show source coverage and new exceptions. Ask only for missing information or decisions. |
| Prepare ANZ references | Match Kevin's confirmed receipting cadence; the interview describes approximately every two days. Daily on selected working days is an alternative to agree, not an assumed equivalent | Preserve source, check overlap, prepare exact reference changes and a checked copy. Kevin confirms attribution and the REI preview. |
| Review the week's work | Once weekly, after that week's agreed runs | One summary of verified completed work, unresolved cases, missing source coverage and next owners. Use the same cases and receipts, not a second register. |
| Resume a held case | A validated login return, source arrival or reviewer decision | Resume the saved step promptly when permitted. Do not wait for the next daily trigger or blindly replay a completed action. |

The reviewed transcript describes the two-day receipting process at C1 06:03 and C3 10:07. These are source observations with provisional speaker/ASR labels, not approval of a precise future schedule. Sources: [clip 1](</Users/yoda/Downloads/Austin-Realty-Interview-2026-09-10/clip-01-transcript.md>) and [clip 3](</Users/yoda/Downloads/Austin-Realty-Interview-2026-09-10/clip-03-transcript.md>).

“Every two days” requires an anchor and an explicit rule for weekends. Monday/Wednesday/Friday has a three-day weekend gap. An invoice's monthly or quarterly expectation is a separate concept from running its evidence check each morning.

No-change runs should update the work record quietly. Notify the agreed person when a new decision, changed exception, completion requiring review or failure needs attention. Repeated scans should update one unresolved case rather than generate repeated phone alerts. Sending the internal summary to a phone also requires an agreed recipient and delivery policy; it is not customer correspondence authority.

## What a saved routine must contain

Each version needs an owner and reviewer, outcome, selected accounts/folders/app/session, permitted reads and effects, cadence and timezone, source coverage period, completion checks, time/cost limits, notification destination, and recovery policy. Kevin accepts that exact version before activation. Later plain-language changes create a reviewable revision.

The source flow is: trigger → claim one occurrence → check access/device/source freshness → prepare through the permitted tools → validate the result → request any required decision → save the verified work and its evidence. RealBud retains one scheduler and one authority for the run across desktop and phone.

The execution state must distinguish waiting for device, waiting for private sign-in, waiting for review, partial coverage, completed, failed, cancelled and interrupted work. A message that says “done” cannot establish a file write, payment or completed import.

The agreed recovery policy must cover these cases:

- Sleeping/offline PC: display missed or waiting work; run late only within the routine's approved freshness window. Do not promise that the app wakes a powered-off PC.
- Login/MFA: release control while Kevin signs in privately, then verify the intended account/window and current authority before continuing.
- Stop/takeover: cancel the worker, revoke its tools and reject late results. A timeout alone is not cancellation.
- Overlap/retry: one occurrence claim, a per-run device lease, bounded retries and checks for previous effects before retrying an uncertain outcome.
- Changed source or correction: preserve verified independent facts and human edits; retract only the affected inference. Reusing a corrected payer mapping in future runs requires an explicit reviewed rule with provenance.

## Current RealBud foundations and gaps

This table comes from a fresh read-only source review on 13 September. Existing tests and past QA reports provide context; this review did not rerun the app or establish new live acceptance.

| Layer | Existing foundation | Remaining work before the promised routine is dependable |
|---|---|---|
| Hermes engine and updates | Isolated Hermes adapter, candidate update checks, preserved profile and rollback: [adapter](../server/drivers/acp/hermes.ts:17), [updates](../server/hermes-update.ts:29) | Keep upstream unmodified. Prove update preserves the accepted routines, grants and saved work on the actual delivery build/device. |
| Actual computer execution | Bounded portal adapter and lease exist; Ask mounts the CUA connection separately: [Ask mounting](../server/index.ts:1477), [ACP forwarding](../server/drivers/acp/core.ts:223) | Put the real action path behind the same run/source/permission broker. Reject wrong tab/window/account, expired authority and competing ownership at execution. |
| Completion and saved results | Durable runs and transactional workflow storage: [run recovery](../server/job-runs.ts:277), [storage](../server/workflow-database.ts:83) | Generic Prepare can complete from parsed output strings: [executor](../server/job-executor.ts:207). Require typed proposals, domain checks and an actual saved artifact or state receipt. |
| Expected bills and corrections | An expected-bill register and board exist | Replace flat overwrite status and corrupt-as-empty reads with evidence fields, revision checks, reviewed Apply and safe migration. Pack output currently does not update the board: [bill store](../server/expected-bills.ts:51), [board](../src/components/desk/ExpectedBillsBoard.tsx:59). |
| Bank results and repeat learning | A checked-copy service already preserves immutable fields and requires reviewed rows: [validator](../server/bank-reference.ts:113) | Connect the pack/Ask request to that service. Add overlapping-export handling and separately reviewed future mapping rules; a row correction currently does not establish the next run's rule: [store](../server/bank-reference-store.ts:12). Validate the actual ANZ sample. |
| Prepare Stop | The worker can accept an abort signal; Ask has its own interrupt path | Production Prepare lacks owned per-run cancellation wiring, and Pause is disabled while running: [executor](../server/job-executor.ts:206), [workspace](../src/components/schedule/JobWorkspace.tsx:725). Cover Stop, restart and late-result races. |
| Recurrence and device availability | Daily/weekly clock, timezone, durable occurrence keys and missed-run recovery exist | Current schema supports clock time plus weekdays, not an anchored two-day interval or holiday calendar: [schedule contract](../shared/contracts.ts:65). Portal schedules queue attended work rather than acquire the export automatically: [dispatch](../server/index.ts:1771). Agree and implement the selected cadence/acquisition path. |
| Phone decisions and useful alerts | Paired Telegram draft decisions have identity/revision checks | Draft Allow/Deny is distinct from ACP permission, prepared-result approval and login-resume. Job-run events are local and held Prepare results are excluded from the generic pulse filter: [Telegram](../server/channels/telegram.ts:290), [job events](../server/index.ts:332), [pulse](../server/index.ts:1740). Wire one exact job/case decision across surfaces and test quiet/deduplicated delivery. |
| Windows delivery | Installer/resource targets exist: [packaging](../electron-builder.yml:88) | Prove the current build on the matching Windows 11 device: installation, model connection, actual sources/apps, correction, saved result, Stop/recovery and update. Older Windows Server/other-revision evidence does not close this gate. |

The current clock can run a recently missed occurrence up to 12 hours late and records older missed work. That is existing behavior to assess per routine, not an accepted business rule for ANZ work: [catch-up](../server/routines.ts:440). An awaiting-approval run counts as settled for run scheduling, so separate case-level deduplication is needed to avoid piling up the same unresolved work: [run statuses](../server/job-runs.ts:39).

Private staff operation is a later implementation track. Current pairing uses one canonical Bud conversation and the local API uses a per-boot token. General Composio identity is configuration-based, not authenticated staff identity: [pairing](../server/channels/telegram.ts:29), [local auth](../server/session-auth.ts:5), [Composio](../server/composio.ts:118). Follow the [staff-session design](REALBUD-STAFF-SESSIONS-2026-09-13.md) before offering independent staff accounts.

## Build and acceptance after scope confirmation

1. Record the exact sources, representative ANZ format/reference map, expected-bill history and coverage, device/apps, operator/reviewer and phone route. Confirm the cadence/recovery rules in writing; Airbnb/Form 11 remain excluded.
2. Complete one source-bound preparation with authoritative permission checks, Stop, verified output and durable review. Selected synthetic files can prove the domain logic before authorised source acquisition.
3. Complete both required domain paths: the bank checked copy and the bill case that survives a correction and reopening. Keep expected answers outside Bud's input.
4. Run those same jobs through the clock and chosen phone. Exercise changed evidence, unchanged evidence, incomplete coverage, duplicates, overdue approvals, sleep/restart, denied access and Stop over at least three representative sample days. Verify a genuine weekly occurrence separately; simulate longer intervals explicitly rather than pretending they elapsed.
5. Have Kevin, as operator and reviewer, repeat the accepted routines on the matching Windows PC without developer coaching. Measure active/review time, missed sources, incorrect matches, alert burden and recovery. Confirm activation only for the versions that pass.

Reuse the [26-scenario acceptance matrix](../outputs/realbud-next-week-readiness-2026-09-12/acceptance-matrix.csv) and [acceptance plan](REALBUD-NEXT-WEEK-ACCEPTANCE-2026-09-12.md). Their dated commercial passages are historical; revision 26 controls current scope and pricing. A complete test result needs actual output and persisted state, not merely a successful chat response or scheduled trigger.

Revision 26 targets 2-3 weeks build/test after fit check, signed scope and access readiness, then one week teaching/handover and 30 days observation after accepted go-live. The second included care month remains stabilisation. Dates depend on verified scope and capacity; elapsed time and demonstrations do not replace acceptance. CRM and hosting remain separate projects.
