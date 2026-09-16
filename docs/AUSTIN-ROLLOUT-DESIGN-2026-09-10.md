# Austin rollout — proposal and RealBud design

Revision 5 workflow extension: [guided routines, daily bank/inbox work and shared approvals](AUSTIN-ROUTINES-AND-APPROVALS-2026-09-10.md). Daily inbox organisation is now Phase 1; mailbox changes and sending remain separately scoped. This controls conflicting earlier scope statements.

10 September 2026 · Internal design · Proposed work, not a delivered integration.

Execution register: [Austin setup, workflow coverage and delivery tasks](AUSTIN-DELIVERY-PLAN-2026-09-10.md) consolidates the work below into stable task IDs, dependencies and acceptance gates. Edit its JSON source when the delivery scope changes.

Platform prerequisite: [RealBud as a modular harness over Hermes](REALBUD-HERMES-HARNESS-2026-09-10.md) defines lifecycle preservation, agency isolation and reusable add-ons. Complete those foundation checks before treating the Austin CRM as independently installable. The customer pricing remains a proposal; no amount changes in that review.

Consolidated Windows delivery and commercial plan: [Austin operating plan](AUSTIN-OPERATING-PLAN-2026-09-10.md). Its revision 4 decisions supersede earlier Mac-only scope and pricing.

## Decision and commercial scope

The revised proposal is **A$1,750 guided onboarding + A$299/month + actual usage at cost**, with an initial proposed A$75 usage budget. All eligible Phase 1 excess in the first billing month is absorbed with no later recovery. Customer-direct provider usage is not invoiced again; the same excess benefit is settled through a verified credit/reimbursement. These are proposed terms, not a signed commitment.

Scope: one Austin office, one agreed Windows 11 workstation, one primary operator and reviewer, up to two Gmail accounts, one bank/REI format and one supported phone channel. Confirm the exact native apps, CPU architecture, volumes and operating hours. Start with one demonstrated website/native-app workflow through Hermes + Cua. An ARM VM is supplementary when Austin uses x64. Hardware is optional; a Mac mini may host Phase 2 CRM but cannot replace the Windows apps.

Proposed onboarding payments are A$875 after scope/technical feasibility agreement and A$875 after accepted handover. Include agreed configuration, sample verification, two one-hour trainings and a guide. The A$299 fee starts at accepted go-live and includes standard updates, upkeep and one hour of product help; defects remain our responsibility. Reusable Windows/product engineering is our investment. CRM, hardware, hosting and additional apps/formats are separately scoped.

Use the operating plan for the source findings, exact-revision GitHub Actions build procedure, Windows 11 acceptance matrix, usage settlement and cost sensitivity. Do not treat an installer build, upstream Windows support or the existing Mac concept as proof of Austin readiness. Defer an additional Codex engine until better successful-task reliability/cost or a concrete customer need is demonstrated.

## Design direction: extend the existing workspace

Keep the existing **Desk, Ask, Schedule and You** structure. Configure Austin's priorities inside those surfaces rather than building an Austin-only app or adding a second calendar. One office configuration and one set of case records should support future agencies too.

- **Desk:** a concise morning status, “Prepare rent file”, “Check expected bills”, open exceptions and source freshness. Selecting a row opens a case alongside the list. Keep financial meaning in words as well as colour.
- **Ask:** the current property/case and sources travel with the question. Ask should explain or prepare the next step without requiring Kevin to re-enter context. A task launcher stages work; it does not grant access or execute immediately.
- **Schedule:** expected arrival windows, invoice due dates, arranged-payment follow-ups and actual run outcomes together. Calendar entries open the same cases as Desk. A routine completion is not evidence a bill is paid.
- **You:** office preferences and a resumable onboarding checklist. Technical project setup is for our technician; Kevin sees which account is connected, allowed access, coverage, next check and one recovery action.

## Current source findings and exact owners

Inspected current working tree, package 0.1.18, source commit recorded separately in the artifact evidence. Existing local edits mean the commit alone does not identify source state.

| Area | Current evidence | Adjustment |
|---|---|---|
| Setup continuity | `src/components/WorkspaceSetup.tsx:9` defines Bud / Apps / Phone / Office sections; lines 14–24 keep visited panels mounted while open. `src/lib/workspace-setup.ts:6` opens setup without leaving unfinished work. | Reuse this sheet. Add an outcome checklist that resumes into the current task. Persist non-secret checklist results on the server, not just panel visits. |
| Gmail setup | `src/components/GmailReadOnlySetup.tsx:149` exposes a technician form with project API key, auth configuration, verification and mode selection. `src/components/ConnectedAppsCard.tsx` owns access state and operation receipts. | A provisioned Austin path should show “Connect the office Gmail” and Google consent. Retain technician controls under an administrator setup view. Hiding fields requires a real provisioning/credential design first. |
| Gmail capability | `server/composio-gmail.ts:244` describes a single-task listing of at most 10 threads from seven days, no pagination or attachment bodies. The transport is per Ask turn. | Add explicit recurring read authority, bounded backfill, incremental checkpoints and attachment coverage. Reuse account binding, strict scopes and operation receipts; do not silently broaden the current approval. |
| Suggested work | `src/components/PmTaskStarters.tsx:6` features prepare-day and owner-update. `src/lib/pm-task-starters.ts` contains rent evidence and inbox examples; its starter guard protects unsent text. | Add reusable office-selected priorities for bank preparation and expected bills. Do not hardcode Austin or replace a draft. Gate each action on actual capability and permitted sources. |
| Bank preparation | `server/import-inspect.ts:1` names ledger columns; line 22 covers identity/daysSinceDue/rentLanded/levyPaid. `shared/rent-workflow.ts:18` stores checking preferences, not payment records or a bank export adapter. | Build a dedicated versioned bank-review path. Named REI reference-export and expected-bill occurrence contracts were not found in targeted searches of server/shared/src. An absent symbol is a search result, not proof every related primitive is absent. |
| Bill calendar | `src/components/schedule/WeekCalendar.tsx:50` renders Loop schedules via `src/lib/schedule-week.ts`. `server/routines.ts:132` marks inbound-triage unavailable. | Add bill obligations/occurrences as domain data and project them into the existing calendar. A scheduler and a week view do not establish invoice monitoring. |
| Phone and recovery | `src/lib/phone-connections.ts` handles Telegram/Discord/Slack refresh; channel adapters and remote-decision owners exist. | Add general bill alert routing and a durable outbox through these owners. Confirm the agreed channel reaches the recipient and that the case can be opened from a phone. A desktop localhost URL is insufficient. |

### Current targeted checks

Ran `fnm exec --using=24 pnpm exec vitest run src/components/GmailReadOnlySetup.test.ts src/components/WorkspaceExperience.test.ts server/import-inspect.test.ts server/routines-recovery.test.ts` on this working tree: **44 passed, 1 failed, 4 files**. Full output is `proposal-v3/source-checks.log` in the Austin interview folder.

The failure remains `server/routines-recovery.test.ts:196`: the assertion expects “another clock or revision” while the implementation rejects with “another schedule or version”. The test is not green, and assertions after that failure did not run. Review the intended error contract and update the relevant assertion in the implementation work. These source checks do not prove installed onboarding, Austin Gmail access, REI imports or phone delivery.

## The onboarding journey

Use five outcome steps in the existing setup sheet. Every step displays **Not started / Working / Ready / Needs attention**, the last verification time and one next action. Ready means server-confirmed evidence, never a clicked checkbox.

| Step | Kevin's experience | Evidence required before Ready |
|---|---|---|
| 1. Office and people | Confirm Austin, Kevin, Danny's review route and timezone. | Saved office identity, operator permissions and agreed notification ownership; verify actual timezone. |
| 2. Connect sources | Choose the office Gmail, review read-only consent; see the selected mailbox and coverage. | Verified account identity/scopes, test read and declared history/attachment coverage. Unknown OAuth results require status lookup before a new connection. |
| 3. Check rent file | Supply sample and reference map; review changed references and held rows. | Accepted schema, original hash, complete row accounting, unchanged amounts/dates and verified REI sample result. |
| 4. Set bill cycles | Review suggested cycles in a batch. Confirm expected windows, owner and due-date rules. | Versioned bill obligations, source provenance and a confirmed initial register; no invented due dates. |
| 5. Reminders and handover | Select run cadence, phone recipient and budget; complete a sample together. | Run/source recovery test, channel result, spend rule, training and signed-off sample checklist. Schedule remains paused until appropriate office approval. |

Persist checklist progress independently of the UI with an office/workflow version and revision. A changed account, bank schema, reference map or permission invalidates only affected checks. Cancellation preserves work; retries recheck state. Credentials stay in the owning server store and never enter the chat, exported setup guide or reusable office template. A provisioning service must not ship our shared project secret inside a customer app.

## Data, actions and recovery

### Bank review

Introduce a bank batch owner adjacent to the existing import/Desk owners. Proposed contract: officeId, batchId, schemaVersion, sourceHash, account identity, date range, integer minor-unit totals, immutable original rows, proposed reference edits, held reasons, mapping revision and acceptance revision. This is proposed schema, not an existing implementation.

Use deterministic parsing for amounts/dates and exact identifiers. Preserve leading zeros, all rows, dates, amounts and debit/credit direction. Include duplicate/overlapping uploads, reversals, split payments, tenancy changes and two candidate properties. Staff approve ambiguous mappings. The server checks current batch and mapping revisions before creating a copy. A changed source invalidates approval. Exports use the verified REI schema and a separate filename; partial or uncertain REI imports require destination reconciliation before retry.

### Expected bills

Proposed records: **BillObligation** for recurring expectation; **BillOccurrence** for property/issuer/billing period; immutable **BillEvidence** for email/attachment/invoice; **PaymentEvidence** for arranged versus verified; **AlertDelivery** for recipient/version/outcome. Unique office + obligation + billing-period keys prevent duplicate cases. The same occurrence backs Desk, Schedule and phone.

Operational states are expected → missing or received → arranged → verified paid, with dispute/cancel/duplicate handling. Source coverage is a separate state: an outage changes the confidence/coverage display, not financial facts. Show “Check incomplete; last successful check…” and stop new claims that no bill arrived. A due date needs invoice evidence; an expected window is not a payment deadline. New invoice versions cannot silently overwrite an approval. Arranged payment never auto-closes on a calendar date.

### Calendar and alerts

Reuse routine persistence for execution and add an incremental inbox cursor per office/account. Reserve an occurrence claim before running; commit case transitions and outbox events atomically. Keep checkpoint progress only for successfully processed pages, deduplicate messages and preserve partial coverage. Bounded retries, freshness timestamps and visible missed-run recovery are required.

Alerts carry case identity, current revision, reason, recipient, attempt and provider result. Coalesce repeats and revalidate recipient/current case before dispatch. Acknowledged is not resolved; accepted by a provider is not read. One calm morning digest can cover normal upcoming items; missing bills, due/arranged exceptions and delivery failures follow agreed escalation rules. Keep phone lock-screen text minimal and detailed evidence in the case.

### Spending and permissions

Authority belongs at server boundaries: office/account access, recurring consent, financial review, case edits, recipient changes and spend limits. UI simplification must not bypass these boundaries. Reserve anticipated cost before chargeable work and settle against a deduplicated usage ledger. Attribute late supplier costs to the original usage period. First-month excess is ours; do not reset the waiver on reconnection or charge it later. Stop extra chargeable work at the ongoing limit and show coverage impact.

Use configured model/provider access first; do not invent a hosted billing product in the setup UI. A customer paying a provider directly is not billed by us again for the same calls. Shared plan allocations must be attributable and agreed. [Composio pricing](https://composio.dev/pricing) has free limits, managed-app sublimits and add-ons; actual account costs still need measurement.

## Delivery order and acceptance gates

First complete the Windows vertical slice and exact-installer acceptance defined by W01–W07 in the task register. The workflow packages below follow that proof; they do not replace it.

| Priority | Work package / primary owners | Dependencies | Completion evidence |
|---|---|---|---|
| P0 | Sample contract and setup checklist: WorkspaceSetup, workspace-setup, office configuration, source access | One authorised bank file/map; bill examples; account/cadence/recipient choices | A resumable checklist, preserved draft, explicit stale/unknown states; accepted scope and feasibility. |
| P0 | Bank preparation: shared bank contract + server batch owner + Desk review component (proposed additions) | Confirm REI schema, reference fields and mapping | Money invariants, held rows, stale review rejection, duplicate upload, balanced export and a real REI sample. |
| P0 | Bills + recurring intake: new shared bill contract/store linked to composio-gmail, broker, routines and persistence | Explicit recurring read scope and history/attachment design | Missing versus incomplete source, arranged versus paid, deduplicated occurrences, outage/catch-up and invoice revision tests. |
| P1 | Calendar + alerts: WeekCalendar, schedule-week, existing channels/remote decisions + outbox | Bill records, recipient authority and run results | One case across screens, quiet hours/timezone rules, no duplicate alerts, visible delivery failure, actual phone opening route. |
| P1 | Customer setup and task wording: WorkspaceSetup, ConnectedAppsCard, GmailReadOnlySetup, PmTaskStarters | Provisioned configuration and verified capability states | Kevin can set up and recover without project IDs; retained technical/admin path; no broadening of permissions. |
| P1 | Usage and handover: usage ledger/budget owner (proposed), installed release checks | Supported provider billing route and measured costs | Budget boundary, duplicate/late usage events, first-period waiver, restart and installed Windows 11 office acceptance. |
| P2 | Twenty CRM + shared Bud tasks | Phase 1 accepted, sample workbook, roles, edition and migration estimate | Import totals, identity/role boundaries, replay-safe sync, record ownership and approved outreach. Separate scope and price. |

These are work packages and dependencies, not calendar promises. Sequence implementation from accepted data contracts into the case store and actions, then calendar/phone projections. The first release should complete a narrow end-to-end path; it should not ship five disconnected mock screens as a workflow.

Test invalid files, unknown references, duplicate uploads, stale edits, concurrent approvals, mid-run cancellation, source expiry, partial pages, missing attachments, DST/timezone changes, computer sleep/restart, corrupt persistence, notification uncertainty and cost reservation overshoot. Keep ordinary recovery local to the affected task. Record sanitized run IDs, counts, coverage and result codes; omit mailbox bodies, bank rows, account secrets and unnecessary tenant information from diagnostics.

## Product concept and proposal files

`proposal-v3/customer.html` is the customer proposal; `workspace.html` is an internal interactive concept with fictional data and no live connections. The concept keeps state across Desk/Ask/Schedule/You, shows a source outage, blocks an unresolved bank batch and invalidates a review when the sample file changes. It demonstrates interaction intent only. `internal.html` presents this design and the source evidence. Customer and internal packs are separated.

Pricing, source audits and prototypes prove different things. Neither a rendered proposal nor passing fixture checks is a verified office outcome. Existing videos, interview notes, earlier proposals and product source are preserved. No accounts were connected, messages sent, financial records changed, product source implemented or release published by this design pass.
