# RealBud business OS and Austin workflow boundary

Status: product direction confirmed by the owner on 21 September 2026; architecture and implementation sequence recorded below. This is a target contract, not an end-to-end delivery receipt.

Scope update, 23 September: [core first and current workflow scope](2026-09-23-core-first-and-workflow-scope.md) supersedes the delivery sequence and current REI acceptance requirement below. Complete/verify the reusable core first; current packs are bank → CSV, email → bills → calendar, and email → morning priorities. The REI contract below is retained for future scope, not an active gate.

Implementation follow-up on the same day: [Reusable core implementation and evidence](../REAL-ESTATE-CORE-2026-09-21.md) supersedes the implementation-gap snapshots below. Those snapshots describe the decision-time baseline and remain here as history. The operating and acceptance contracts remain in force.

## Decision and prior art

RealBud is a standalone business work operating system. It should support a person working alone and a person joining a local office with departments, shared work and clear ownership. “Operating system” describes the business work layer; RealBud still runs on the customer's desktop operating system. Hermes supplies the worker capabilities behind the RealBud interface. Austin Realty is a first customer workflow pack, not the definition of the entire product.

This supersedes the property-management-only scope, permanently fixed navigation and local custody of vendor Composio keys in the earlier [goal prompt](../history/GOAL-PROMPT-2026-09-04.md) and [end state](../history/END-STATE-2026-09-17.md). Their dated observations remain historical evidence. The [Hermes and installation decision](2026-09-20-hermes-and-installations.md), identity isolation, approval checks and source-of-truth rules remain relevant. See the [business desktop receipt](../BUSINESS-DESKTOP-2026-09-21.md) for actual built and tested behavior.

The owner specified three Austin outcomes: daily bank CSV reference correction and REI Cloud recognition; Gmail-derived bill patterns in the RealBud calendar; and a morning Gmail work list around 08:00. The interview and operating-plan sources are listed at the end. Current-day daily processing supersedes the interview's less frequent bank-export example as the requested target; exact bank date/range semantics still need a real format contract.

## Product layers and authority

| Layer | Responsibility | Who can change it |
|---|---|---|
| RealBud core | Identity, private and shared scopes, work records, evidence, calendar, schedules, approvals, durable execution, recovery and audit | Reviewed RealBud releases; customers administer their allowed membership and operating settings through supported APIs |
| Managed services | Provider credentials, Composio provisioning and brokerage, model routing, billing, entitlements and core API enforcement | RealBud service operators; customers cannot supply a replacement service identity or bypass server authorization |
| Workspace and workflow packs | Tabs, views, saved filters, forms, property mappings, bill rules, ranking preferences, schedules and bounded job plans | Authorized workspace owners or members, according to scope; Hermes may propose changes |
| Customer connections | Which Gmail/bank/business accounts are connected, their granted scopes and when access is revoked | The authorized customer connects and consents; provider keys remain managed |

An installation is a running device/service, a member is a person, a private workspace belongs to that person, and a department is a shared authorization scope. A department tab does not grant access. Every API read and mutation must check the current member, company and scope at the authoritative service. Private history and credentials do not become company data merely because the person joins an office or changes departments.

Reuse current durable job, review, company-work and scheduler mechanisms. Introduce shared work/evidence identities only where needed to connect a complete workflow; do not create a second task system for each customer. Keep property and REI specifics in the Austin pack and adapters. Existing PM stores/profile names remain compatible during this transition; this decision is not a schema migration.

## Customization without changing the managed core

Desk, Ask, Schedule and You remain useful defaults. Customers should be able to choose which work views appear, save filters and arrange tabs. Department owners should be able to publish approved shared views and workflows. Basic changes need plain-language forms; code is an optional advanced authoring method.

Hermes-generated changes must target a versioned workspace definition or extension, with a visible preview, validation, required capabilities, owner approval where appropriate, and a previous working revision. A new view uses the same authorized records/API as the standard view. It must not receive provider keys, unrestricted Electron/Node access, core database handles or an implicit right to send, import or pay. Generated code is untrusted input. A real isolation boundary and capability broker are prerequisites before executing arbitrary extensions; a folder convention, prompt or same-user child process is not a sandbox.

Core updates must not overwrite customer layouts. A bad extension must be disableable without losing work records or preventing the default workspace from opening. Pack upgrades need compatibility checks, explicit data migrations, a recoverable prior configuration and retirement/export behavior. Start with validated declarative views and plans; a general plugin marketplace is not required to deliver Austin.

## Vendor credential custody

The current supported tool path uses a local broker with a per-session token and policy checks. This limits what Hermes receives through that path. However, project `ak_` credentials still live in local `config.json`; file mode 0600 protects against other OS users, not the customer or code executing as that same user. Hiding a Settings field cannot enforce vendor-only custody. The separate managed model gateway does not currently broker Composio calls.

The target is an independently protected managed connector service. It holds organization/project credentials and authenticates revocable customer grants scoped to tenant, member, installation, source account, workflow, capability and validity period. It must validate scope and approval at execution time, isolate tenants, support cancellation and reconciliation, and meter safely. Browser UI, local extensions and Hermes get only the minimum short-lived authority for the approved operation. Local administrator rights cannot authorize additional managed-service capabilities. Customers can modify a machine they own; they cannot thereby obtain vendor master credentials or bypass the managed service.

Customer connection consent and RealBud action approval are separate. Connecting Gmail does not authorize sending mail. Acquiring a bank export does not authorize payments. Revoking a connection must prevent queued work from silently using stale authority. Credentials and document contents must not enter ordinary telemetry, logs or error messages.

This changes the earlier absolute local-only connector claim: an authorized managed connector request may transmit selected source data through the broker. Define and disclose the actual data path, retention and deletion policy before rollout. Do not copy a customer's full mailbox or property book into the website account portal as part of this decision. The website remains a separate control surface; reporting an installation does not yet enable remote command execution. Any future website actions must use authenticated, scope-bound commands, approvals and durable execution receipts.

## Austin workflow 1: daily bank references and REI Cloud

1. Acquire the approved bank account's export for an explicit bank date/range, or accept a manual upload with identical validation. Login/MFA belongs to the customer. Preserve original bytes, encoding, filename, account binding, coverage and digest before parsing.
2. Validate the bank format and the agreed REI target format. Match references using the approved tenant/property reference directory. Change only the permitted reference field; preserve amounts, dates, row order and unrelated values. Explain every proposed change and expose duplicates, unmatched rows and uncertain mappings as holds.
3. Save all review decisions, including unchanged rows and hold reasons. Bind approval to the source, mapping version and exact corrected artifact. Permit a corrected mapping/review revision without losing history or silently invalidating an earlier artifact.
4. Upload the approved artifact through a verified REI adapter or an attended handoff. Distinguish file upload, REI validation/matching, import acceptance and final receipting/posting. Record the visible result and matched/rejected rows. Financial posting retains its own authority; upload success is not proof that REI recognized or posted the transactions.
5. Bind a logical operation to account, coverage and transaction identities so overlapping exports, double-clicks, restarts and lost responses cannot duplicate imports. When an external result is unknown, reconcile the target state before retrying. REI remains the financial source of truth.

**Current implementation:** local CSV selection, parsing, reference suggestions, human correction, encrypted original/result string storage and reviewed-file download. Automatic acquisition, owned download/upload transport, a real REI format/recognition contract and import receipts are absent. `File.text()` currently normalizes source bytes before persistence; keep decisions lack durable reasons/status, mapping revisions cannot be reopened, and exact-file dedup does not cover overlapping imports. Synthetic fixtures do not prove Austin's bank or REI acceptance.

**Acceptance:** a paired original/corrected customer-approved format fixture validates byte preservation and reference-only changes; ambiguous rows stay held; changed mappings remain reviewable; interrupted upload and overlapping-day replays do not duplicate effects; installed-device REI preview and acceptance evidence prove the exact artifact's recognition. Keep manual import available until the adapter meets that contract.

## Austin workflow 2: Gmail bills and native calendar

1. Read only the approved Gmail account and bounded historical interval through Composio. Capture message/thread identities, pagination, attachments, digests and a completion/checkpoint receipt. An incomplete scan must say what was not checked.
2. Propose property/vendor/bill-kind mappings with linked source evidence. The customer resolves ambiguous properties and confirms recurring patterns, responsibility and exceptions. Do not infer a payment obligation solely from an email classification.
3. Persist accepted bill facts and corrections idempotently against source identity/version. Separate a recurring series from an individual occurrence. Distinguish predicted arrival windows from verified invoice due dates, and payment arranged from payment confirmed.
4. Project accepted occurrences into RealBud's calendar and work list, with property, source, date basis and status visible. Calendar entries link back to their authoritative bill record; editing a projection cannot create a conflicting second record. Cancelled, corrected or replaced invoices update visibly without losing evidence.
5. Flag an expected bill that has not arrived, a received bill awaiting review, or an actual due obligation using the customer's confirmed rules. Receipt of mail, invoice acceptance, REI handoff and payment are separate recorded outcomes.

**Current implementation:** a bounded Gmail reader, supplied-input invoice/review recipes, a manually persisted expected-bills register and a job/run calendar. The Gmail adapter's seven-day/ten-thread scope cannot establish full historical recurrence or older follow-ups. There is no accepted-review transaction into the register, recurrence series, source-idempotent bill creation or bill calendar projection. The current board also hides rows after six per group and lacks full property/date/source review controls.

**Acceptance:** replaying the same messages creates no extra bill occurrences; missing pages/attachments show incomplete coverage; uncertain mappings require review; accepted correction preserves history; expected-arrival and actual-due dates are visually distinct; all records are reachable and property-scoped access is enforced.

## Austin workflow 3: morning priorities and follow-ups

Use the RealBud scheduler for a customer-selected local-office time, initially proposed as an 08:00 scan. The user has not confirmed the office timezone, weekdays/holidays or a ready-by deadline. “Starts at 08:00” and “ready by 08:00” are different commitments; show actual completion and freshness, and configure an earlier start if the customer chooses a ready-by deadline. The computer/service must be running and connected for a local scan; a powered-off, sleeping or disconnected computer must show a missed or late review rather than apparent success. Closing the RealBud window alone may leave its detached office service running.

Read new/relevant inbox material and unresolved/sent conversations since a saved checkpoint. Persist work-item identity, source links, owner, priority reason and next action. Rank urgent/time-sensitive work, actions to do, waiting/follow-ups and information-only updates in understandable groups. Use verified dates and customer rules; model urgency is a proposal, not a legal deadline.

Keep unresolved work between runs. Preserve manual priority, assignments, snooze and completion; new evidence may visibly reopen a task rather than quietly duplicating or overriding it. Waiting-for-reply logic needs sent/reply ordering, a confirmed follow-up interval and exclusions. Users can explain why an item was ranked and correct the rule. Nothing sends a follow-up merely because it is overdue.

**Current implementation:** source-linked prioritization over supplied files and durable schedule/occurrence/recovery foundations. The built-in inbound routine is unavailable. Morning preferences are non-executable examples. Account acquisition, durable email-task reconciliation, carry-forward, sent-mail timers and readiness monitoring are not wired end to end.

**Acceptance:** one approved scan yields one durable review per occurrence; restarts/retries do not duplicate tasks; missed scans remain visible; incomplete or expired Gmail access never appears as “nothing to do”; manual edits survive refresh; new replies resolve/reopen the correct existing item; ranking and calendar agree on verified dates in the office timezone.

## Delivery sequence and proof

1. **Core boundary and source identity.** Define the managed connector protocol and credential migration/revocation path; keep existing supported local setups recoverable until a verified migration is available. Fix byte-preserving bank intake and durable review decisions. Establish shared source/evidence identities, revision checks and scope enforcement before automatically persisting AI output.
2. **Connected Austin workflows.** Build approved Gmail acquisition and reviewed task/bill reconciliation; calendar projections and the morning schedule consume those same records. Complete bank acquisition, mapping amendments and the reviewed REI handoff. Each slice must work through UI, authoritative storage and recovery; supplied-file recipes alone are not completion.
3. **Workspace customization.** Deliver saved views, layouts and bounded pack settings over those working APIs. Introduce generated extensions only after their isolation, admission, update and rollback contract is implemented and tested.
4. **Office and release proof.** Exercise solo, shared-department and private-scope behavior, access revocation, disconnection/rejoin, backup/restore and retirement/export. Then deliver signed supported-platform builds and verify real Austin account workflows on the installed customer device. The current local Mac package does not prove Windows installation or customer acceptance.

At every stage separate configured, callable, locally tested, packaged, installed and customer-accepted evidence. Do not weaken approval, permissions or recovery to obtain a smooth demo. Failure, partial success and unknown external outcome are first-class states. A feature is not complete merely because a tool exists or a model produced plausible JSON.

## Alternatives and revisit conditions

Keeping RealBud permanently PM-only is simpler but conflicts with the owner's intended product. Allowing arbitrary edits to the privileged app is flexible but defeats the managed boundary. A general plugin framework before one complete customer workflow adds risk without proving value. The chosen path is a reusable governed core, complete Austin workflows, then bounded customization.

Revisit the execution topology before promising scans while every local machine is off, remote website commands, arbitrary extension execution, or a different data-residency commitment. Those require explicit architecture and verification, not more UI switches. Removing or migrating a connector requires a tested way to preserve evidence, revoke old authority and resume or cancel pending work.

## Source audit and verification for this decision

- Customer evidence: `/Users/yoda/Downloads/Austin-Realty-Interview-2026-09-10/workflows/austin-workflows.md`; `proposal-v3/AUSTIN-OPERATING-PLAN-2026-09-10.md` and `proposal-v3/AUSTIN-ROUTINES-AND-APPROVALS-2026-09-10.md` under that interview directory. These distinguish current practice, proposed behavior and unverified historical examples. No bank export or mailbox was accessed for this review.
- Bank implementation: `server/bank-reference.ts`, `server/bank-reference-store.ts`, `src/components/schedule/BankReferenceReview.tsx`, `server/accounts-review.ts`; synthetic walkthrough `scripts/qa-austin-workflow.mjs` and `scripts/qa-austin-accounts.mjs`.
- Mail/bills/scheduling: `server/composio-gmail.ts`, `server/expected-bills.ts`, `server/routines.ts`, `src/components/desk/ExpectedBillsBoard.tsx`, `src/components/schedule/MonthCalendar.tsx`, `pack/workflows/austin-accounts/` and `pack/workflows/austin-phase-1/`.
- Customization and boundary: `server/recipes.ts`, `server/company/workflow-template.ts`, `server/workflow-packs.ts`, `server/service-admin.ts`, `server/config.ts`, `server/connected-apps-broker.ts`, `server/drivers/acp/hermes.ts`, `src/components/Sidebar.tsx`.
- Narrow implemented hardening in this review: `server/service-child-env.ts` now removes operator Composio/gateway/payment namespaces and administration keys from tool child environments. Attached model configuration remains adapter-controlled. 61 targeted child-environment, real CLI spawn, Hermes environment and ACP tests passed; server typecheck passed. This closes accidental inheritance, not same-user file access. No deployment or rebuilt installer includes this fix yet.

Reproduce the narrow code checks from the repository with Node 24:

```sh
pnpm exec vitest run server/service-child-env.test.ts server/procs.test.ts server/drivers/acp/hermes-env.test.ts server/drivers/acp/acp.test.ts
pnpm exec tsc -p tsconfig.server.json
```

The updated direction documents received a separate read-only consistency review; relative document links and the focused code/instruction diff passed local checks. No account access, model call, live import or hosted rollout was part of this review.
