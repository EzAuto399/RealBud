> Document update 23: the customer proposal now includes workflow illustrations and the agreement contains user-supplied supplier details. Pricing and software readiness are unchanged. See the [current pack](../outputs/austin-monday-2026-09-14/README.md).

# RealBud — product gaps and a credible Austin offer

**Update 13 September:** The current revision 23 customer pack contains a [three-page proposal](../outputs/austin-monday-2026-09-14/customer/01-RealBud-Austin-Proposal.pdf), [one-page FAQ](../outputs/austin-monday-2026-09-14/customer/02-RealBud-Austin-FAQ.pdf) and [fillable draft agreement](../outputs/austin-monday-2026-09-14/customer/03-RealBud-Austin-Agreement-FILLABLE-DRAFT.pdf). It retains revision 21 pricing and the prior agreement terms: Airbnb allocation and Form 11 excluded, native macOS/CRM hosting separately ordered, and standard external CRM at A$6,000 to A$8,000 fully built and live with Austin setup unchanged. The review below is retained as earlier evidence; its unresolved Phase 1.5 wording is superseded. Product implementation gaps remain open.

13 September 2026 · Internal review and proposed build order · Historical engineering review at commercial revision 19; customer pack references updated to revision 23. No routine activation.

RealBud has demonstrated portable preparation packs. The next product milestone is a complete reviewed job: permitted input → stoppable preparation → validated proposal → human decision → saved result → safe recovery. That is the foundation for a dependable service and a credible proposal.

The engineering review below used the working tree at base commit `058aceab` with extensive existing changes, the recorded pack QA and engagement revision 19 at that time. No new application tests were run for this document update. The accompanying owner explanation and scorecard remain internal drafts; presentation v8 is archived historical evidence.

## What the customer evidence calls for

The reviewed interview describes recurring incorrect rent matches, expected bills that may never arrive, and duplicate work maintaining a second register. C2 08:24–10:14 distinguishes expected arrival, receipt and entering the payment process. C3's closing discussion supports REI/bills before company Excel/classification. These are reported needs, not acceptance of our implementation or pricing. See the [meeting evidence](AUSTIN-MONDAY-BRIEF-2026-09-14.md) and [reviewed interview analysis](</Users/yoda/Downloads/Austin-Realty-Interview-2026-09-10/detailed-analysis.md>).

For an owner unfamiliar with AI, lead with those tasks, show the original alongside the prepared result, explain who decides, and make support and exit terms easy to find. Ask about preferred explanation and training language through normal meeting conversation. Age is not evidence of technical ability or a reason to patronise the buyer.

## Current proof and the remaining gap

The [pack QA report](../outputs/austin-workflow-packs-2026-09-13/RESULTS.md) records 50 focused unit tests, 110 successful checks across seven real-model runs, and actual browser import/export/clean restore. Missing and partial inputs were exercised; the bank service produced a verified reference-only copy after simulated reviewer decisions. Hermes source was unchanged.

That establishes supplied-input preparation and portability. The harness bridges the bank proposal into the review API; the app does not yet provide that complete route. Bill proposals do not update the board. Source acquisition, recurring activation, restricted computer execution, phone decisions and matching Windows acceptance remain separate gaps. A successful chat answer cannot close them.

## Build order for the reusable app

These are delivery gates, not a promise to implement every item next week. Keep customer rules and samples in the pack; implement shared enforcement and recovery in RealBud.

| Order | Change and existing modules | Proof required before moving on |
|---|---|---|
| 1 — stop and enforce authority | Own each Prepare run's cancellation in `server/job-executor.ts`, expose Stop through the API and `JobWorkspace`, and reject late completion. Resolve the recorded Ask/ACP script-approval discrepancy before connecting office computer access; use the same authoritative run/source/account/device checks on the actual execution path. | Stop before work, during work and beside completion; restart; expired grant; wrong account/window; denied action; two jobs competing for one desktop. Cancellation releases access and cannot become success later. Verify the real allowed toolset, not a profile comment. |
| 2 — deliver a reviewed result | Introduce typed domain proposals using existing contracts. Connect bank proposals to `bank-reference-store.ts` and `BankReferenceReview`. Connect bill findings to reviewed persistence and `ExpectedBillsBoard`, replacing corrupt-as-empty reads and protecting concurrent corrections. | Malformed or unsupported output is held. Stale review fails without mutation. Human correction survives reread and restart. Bank immutable fields stay exact. Bill receipt/funding/payment remain independent. Completion requires a saved result receipt; awaiting review is distinct. |
| 3 — bind sources once | Extend current pack setup to select local inputs and authorised account bindings, validate formats and coverage, and preview the proposed run. Keep authentication outside the pack. Add the agreed Gmail and ANZ acquisition routes, with labelled manual fallback. | A fresh office imports the pack and configures its own inputs without editing JSON. Missing access is actionable. Wrong account, incomplete pagination, changed schema and stale export are held. Original source and provenance survive. |
| 4 — make daily work dependable | Reuse `routines.ts`, durable occurrence claims and the existing phone decision service. Add the accepted bank cadence if it requires an anchored interval; deduplicate ongoing cases, overlapping exports and notifications. | Three representative days plus a weekly occurrence; quiet no-change run; changed evidence; duplicated trigger; stale phone decision; login/MFA; sleep; network loss; restart. Resume saved work without replaying an uncertain financial effect. |
| 5 — make installation and care repeatable | Complete the matching Windows device path, first-run checks, support diagnostics, backup/restore and admitted Hermes update/rollback. Keep upstream Hermes unmodified and preserve office state separately. | Clean install through first useful result, reviewer handover, denied OS permissions, reconnect, restart, restore, failed update and rollback. Test the actual package and device, not only source APIs or an upstream driver. |

Source checks: [Prepare completion](../server/job-executor.ts:206) currently accepts parsed output strings; [Pause](../src/components/schedule/JobWorkspace.tsx:725) is disabled during a run; [bill loading](../server/expected-bills.ts:51) maps invalid/unreadable state to an empty register. The [capability review](REALBUD-HERMES-CAPABILITY-REVIEW-2026-09-13.md) records a source-level Ask approval discrepancy requiring focused verification, not a demonstrated live exploit. The [scope review](REALBUD-SCOPE-AND-ROUTINES-2026-09-13.md) gives the wider source map.

Engineering assumptions: input and model output are untrusted; approval is tied to the exact job, action, source and revision. Handle duplicate calls idempotently, reject stale writes and guard final state transitions against cancellation races. Migrate saved bill data safely rather than rebuilding it silently. Bound attempts, runtime and cost; log identifiers and reasons without source payloads or credentials. Preserve complete failure evidence in synthetic QA. Use focused regression tests and then the affected real-model/device path.

## Make the interface explain the work

Improve the existing workspace around three questions: **What is waiting for me? What has Bud checked? What will happen next?** Show the source coverage, exact proposed change and next action in the job. Use clear states such as Preparing, Needs your review, Waiting for sign-in, Incomplete check, Completed and Stopped. An unavailable source needs a visible reason and recovery step.

Pack setup should guide the user through import → choose sources → inspect permissions and schedule → test example → accept activation. Import itself must not connect accounts or activate a routine. Current v1 portability is useful; a guided binding and test flow remains to be built. A prompt file alone cannot make installation effortless.

RealBud's app owns jobs, permissions, review, schedules, evidence, recovery, cost controls and support. Packs own reusable procedures, input/output definitions, examples and suggested cadence. Austin's private settings own account bindings, confirmed bill expectations, reference rules, reviewer and hours. Preserve this separation without creating a second portfolio or a customer-specific Hermes fork. CRM and independent staff DMs remain later scope.

## Complete the offer with operational ownership

The current offer already includes strong service terms. The missing deliverables are concrete operating arrangements and evidence, rather than more benefits in the sales copy.

| Deliverable | What must be recorded or demonstrated |
|---|---|
| Accepted scope and scorecard | The two workflows, representative formats/volumes, sources, cadence, operator/reviewer, success measures and remediation process. Airbnb allocation and Form 11 are now excluded; later work requires a separate scope and quote. |
| Named support and escalation | The actual support contact/channel, owner during absence, how an urgent issue is reported and who can pause an affected routine. Fit this to the existing business-hour response targets; do not imply round-the-clock cover. |
| Data handling explanation | For files, screenshots, model prompts, connectors, histories and diagnostic logs: location, provider, purpose, minimum necessary content, access, retention/removal and any overseas processing. Verify actual settings and provider terms before client data is connected. |
| Continuity and restore guide | How Kevin continues in ANZ/REI during an outage; what stops; what queues; the agreed backup destination/frequency, recovery expectation and a demonstrated restore. A local container is not a backup or an availability guarantee. |
| Change and update record | Which pack/app/engine version was accepted, changes proposed, tests passed, profile/work retention and rollback. Customers should not need to edit Hermes code or run an untested upgrade during office work. |
| Handover and exit | Training attendance, operating guide, export contents and format, connection revocation and deletion steps. Define what is retained for agreed records versus removed; keep migration pricing within the existing terms. |
| Pilot measurement | Compare similar work before/after, including review and rework time, incorrect suggestions, missed coverage, notification burden and usage cost. Use measured results at the 30-day review. |

These specify existing delivery obligations or items to agree during the fit check. They do not silently add a staffed 24/7 service, unlimited work, new integrations or an unpriced disaster-recovery commitment.

## Assurances we can put in front of the owner

The internal [owner explanation](../outputs/austin-monday-2026-09-14/internal/OWNER-ASSURANCE-DRAFT.md) records the service terms retained in the revision 23 pack: a paid bounded fit check credited into A$4,500; acceptance before routine activation; eight hours of first-month training/help; two included care months; original-scope defect fixes; the final A$1,000 tied to review/handover; A$299 care from month three with A$75 eligible usage; and export/revocation on cancellation under the stated terms. Use the concise customer proposal and FAQ in the meeting; refer to the draft agreement for full terms.

Use an **acceptance and workmanship commitment**, with agreed examples and a written remedy for unresolved items. Do not describe the completed paid fit check as a refundable deposit. The current terms do not establish a blanket money-back warranty or compensation for business losses. Any such commercial commitment needs separately defined eligibility, remedy, limits and owner approval before inclusion.

Do not promise perfect accuracy, that no bill will ever be missed, universal account isolation, all data staying on the computer, quantified savings or completion next week. Claim only the behavior demonstrated at the relevant layer, and state proposed delivery separately. ACCC guidance requires substantiated claims and reasonable grounds for future promises; a qualification cannot cure a conflicting headline. [ACCC guidance](https://www.accc.gov.au/consumers/advertising-and-promotions/false-or-misleading-claims).

Privacy explanations must cover the AI services actually used, not merely where the app or database runs. OAIC's AI guidance supports due diligence, human oversight and consideration of personal information in both inputs and outputs. Its application to the particular office should be established as part of that assessment. [OAIC guidance](https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/guidance-on-privacy-and-the-use-of-commercially-available-ai-products).

## The next concrete milestone

After the scope decisions, deliver **one complete bank-reference job from the tested pack through the real app**: choose a synthetic input, prepare, show exact proposed changes, approve them in the actual review UI, save the byte-checked file and receipt, reopen them, and repeat with Stop and a stale approval. Reuse the existing deterministic bank service and keep ambiguous attribution with the reviewer. Resolve the execution boundary before any customer computer pilot.

Then complete the bill case through correction and persistence, acquire the agreed real sources, exercise scheduled/phone recovery, and pass matching Windows acceptance. A smaller bank example is an engineering milestone; it does not reduce the two-workflow Stage 1 scope.

For Monday 14 September, present the three-page proposal, answer common questions with the FAQ, and identify the details and review needed in the fillable draft agreement. Use the internal owner explanation and [pilot scorecard](../outputs/austin-monday-2026-09-14/internal/PILOT-SCORECARD-DRAFT.md) to prepare and record agreed examples. Demonstrate a supported local example and disclose its limits. The existing 4–8 week planning range to accepted go-live remains conditional. Next week's target should be the first verified end-to-end job, subject to delivery capacity and access, with a revised estimate after that evidence.
