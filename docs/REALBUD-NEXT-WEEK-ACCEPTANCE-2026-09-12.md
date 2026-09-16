# RealBud: next-week delivery and acceptance

12 September 2026 · Internal engineering and proposal readiness review

**Target 14–18 September: a working, supervised Austin pilot candidate, conditional on the gates below. Do not promise the whole product or completed Stage 1 handover by Friday.** The current proposed commercial plan estimates 80–120 delivery hours and 4–8 weeks to initial accepted go-live. Its later 30-day handover cannot be completed in one week. No reviewed source establishes customer acceptance of that proposal.

The useful demonstration is a continuous working session: **Kevin asks → Bud uses an approved source → prepares the work → Kevin corrects/reviews it → a verified result is saved → repeat → interrupt and recover → approve one precise recurring occurrence.** A plausible chat answer is one part of that path.

## Product and architecture

Keep RealBud as its own supervised office product around unmodified upstream Hermes. Hermes provides the agent, model, tools, memory and skills. RealBud owns source permissions, work plans, one clock, review decisions, verified artifacts, interruption and recovery. Updates pass RealBud compatibility checks before promotion; do not patch upstream code or blindly follow every new Hermes release.

REI/PMS remains the financial record. Store a thin source/property index and the operational memory actually needed for recurring work: expected bill occurrences, source coverage, evidence, review decisions and follow-up owners. Do not build another rent-roll CRM. Expected arrival, invoice receipt, arrangement, funding and payment confirmation must be independent facts, each with provenance and observation time.

The first delivery stays inside the proposed Stage 1: payment-reference preparation and expected bills, with inboxes as supporting evidence. CRM is separately approved Stage 2; Airbnb allocation and notice-evidence extras are later Phase 1.5. A payment-only pilot does not satisfy or reduce the wider paid Stage 1 commitment.

## What the evidence currently supports

| Layer | Current evidence | What remains unproven |
|---|---|---|
| Source and automated checks | Latest recorded suite: 1,997 passed, 8 skipped; pack import/recovery, approval, lifecycle and update tests | Correct customer outcomes across complete live workflows |
| Scripted Kevin day | 32 checks with simulated ACP/Cua/connected apps | A real working day, calendar changes, bank artifacts or actual denied computer calls |
| Installed Mac | Real model connection, native Ask, pack import/export/restore, preparation, Ask Stop, restart, Hermes update/rollback | Clean non-developer installation and matching Windows 11 behaviour |
| Real-model preparation | 26 recorded pack preparations; several evidence and correction cases improved | Not all passed business review; the positive mapped-bills pack case failed |
| Clock | One real arithmetic occurrence and saved receipt | Customer cadence, sleep/wake continuity, real source acquisition and phone delivery |
| Austin office | Interviews, proposed scope and workflow evidence | Actual authorised sources, Windows operation, phone decision delivery, independent operator acceptance |

Evidence: [pack QA](REALBUD-PACK-LIVE-QA-2026-09-12.md), [Hermes integration](REALBUD-HERMES-UPSTREAM-2026-09-12.md), [architecture](REALBUD-COMPUTER-WORK-ARCHITECTURE-2026-09-12.md). These reports describe different proof layers; their passing counts are not additive customer-acceptance scores.

## Five critical implementation gaps

| Gap | Required change | Release evidence |
|---|---|---|
| Actual computer authority | Mount the RealBud permission broker on the actual ACP computer path. Bind job/run/revision, source account, allowed tab or app window, expiry and active lease. Revoke on Stop, takeover or binding change. Inspect alternate terminal/file/network routes too. | Approved benign action succeeds; wrong tab/origin/window, stale permission and revoked lease execute zero prohibited calls. Re-run on matching Windows. A prompt refusal alone is insufficient. |
| Structured bill correctness | Accept typed proposals containing only real register/invoice IDs and explicit mappings. Validate coverage, arrival, due date, receipt, arrangement, funding and settlement independently. | The known positive case passes its exact oracle; incomplete coverage remains a hold; arranged does not become paid; workflow labels never become bill records. |
| Reviewed bill persistence | Apply validated proposals only after review, with revision checks and durable evidence. Preserve corrupt storage and fail closed. Migrate safely; deduplicate recurring obligations and repeated evidence. | Review → Apply → reopen retains correct state; duplicate has one effect; stale review is rejected; corrupt bytes survive and writes are blocked; positive receipt facts survive unrelated coverage corrections. |
| Prepare cancellation | Give each preparation an owned cancellation signal, authoritative Stop endpoint and in-app control. Terminate work and revoke tools; persist cancellation so late success cannot replace it. | Stop both manual and clock preparation; worker/tools cease within a documented measured bound; double Stop is harmless; restart keeps cancelled state; a new retry runs once. Existing Ask Stop is separate proof. |
| Bank pack to checked artifact | Connect source batches and typed row proposals to the existing review/export service. Require reviewed rows and return the verified artifact ID/digest, not a model-written “checked copy” claim. Add cross-export coverage/overlap handling. | Original bytes unchanged; only approved reference fields differ; dates, amounts, order, row count and totals preserved; uncertain rows held; exact repeat and overlapping exports cannot cause silent duplicate execution. |

Relevant implementation boundaries: `server/index.ts`, `server/drivers/acp/core.ts`, `server/cua-bounded.ts`, `server/job-executor.ts`, `server/job-runs.ts`, `server/recipe-draft.ts`, `server/expected-bills.ts`, `server/workflow-database.ts`, `server/bank-reference.ts`, `server/bank-reference-store.ts`, `src/components/schedule/JobWorkspace.tsx`, `src/components/desk/ExpectedBillsBoard.tsx`. Reuse existing adapters, transactions and validators. These changes belong in RealBud; they do not require a Hermes fork.

Also fix open-workspace refresh after approval/pause so desktop and phone cannot display contradictory state. Server revision checks must remain authoritative while notification retries and UI refresh catch up.

## Test the work, not just the response

The [26-scenario acceptance matrix](../outputs/realbud-next-week-readiness-2026-09-12/acceptance-matrix.csv) covers installation, packs, daily PM tasks, evidence correction, approvals, interruptions, privacy boundaries, scheduling and office handover. Each row identifies required proof and existing partial evidence. It is an acceptance backlog, not a report that all 26 scenarios passed.

For each run record the app build, Hermes version, model, source digest/coverage, job and run IDs, requested and executed actions, verified output or precise hold, reviewer corrections, active/review/wait time, cost where available, and failure/recovery receipt. Preserve bad outputs as regression cases. Keep expected answers outside the agent's input so tests cannot pass by repeating the answer key.

Run three complementary levels:

1. **Deterministic contracts:** invalid IDs, calculation and CSV invariants, missing evidence, denied access, duplicate/retry, stale revision, corrupt storage, cancellation races and partial success. Write failing cases for the known defects, then prove the fixes. Tighten existing simulations that accept any response or nearly any terminal status.
2. **Installed app with the real model:** use realistic attachments and natural multi-turn conversation; inspect actual receipts, artifacts and resulting UI. Test a source correction, conflicting information, a follow-up the next day, changed preferences, missing data, injection, Stop and recovery. A safe hold can be the correct result; a generic reply cannot.
3. **Kevin on the target Windows PC:** private customer sign-in, exact selected accounts/apps, approved representative files, one named reviewer and the chosen phone route. Kevin repeats the task without developer coaching and explains what needs approval. Measure his review burden and the verified result against the current manual workflow.

The completed live conversation rehearsal uses [synthetic morning evidence](../outputs/realbud-next-week-readiness-2026-09-12/fixtures/kevin-morning.md) and a separate [three-turn oracle](../outputs/realbud-next-week-readiness-2026-09-12/conversation-cases.json): complete evidence, withdrawn Inbox B coverage, then ambiguous cadence. The [actual result review](../outputs/realbud-next-week-readiness-2026-09-12/conversation-review.md) records a correct first review and draft-only scheduling clarification, but a failed correction oracle: Bud unnecessarily questioned unchanged receipt facts and blurred “not found” with “not issued.” This strengthens the need for structured validation. A conversation pass cannot close the original pack defect, Bills Apply, checked export, cancellation or computer containment.

Run the main paths across three consecutive sample days: changed evidence, unchanged evidence, then sleep/restart/interruption. Require visible missing coverage, preserved human edits, one execution per occurrence and no repeated notification for unchanged holds. This is a short operational rehearsal, not a statistical reliability claim or completed month of care.

## 14–18 September execution plan

Dates are proposed internal targets. They depend on capacity, a successful device fit check and the actual defects; they are not a customer delivery commitment.

| Day | Work and owner roles | Exit evidence |
|---|---|---|
| Mon 14 | Delivery lead + Kevin: 45-minute fit check, device/app architecture, baseline task, selected sources, primary/backup reviewer, sample bank/bill evidence. Engineering: reproduce five gaps and agree exact contracts. | Written scope, source manifest, target-device result and small failing regression cases. If the PC/session is unavailable, label the week synthetic-only until arranged. |
| Tue 15 | Runtime engineer: actual computer broker and Prepare Stop. Workflow engineer: bank adapter, bill validation and reviewed persistence. QA: negative paths and outcome oracles. These are parallel responsibilities if capacity exists. | Selected paths pass contracts and failure recovery; no broken invariants or falsely successful receipts. Unfinished work remains explicit. |
| Wed 16 | QA + delivery lead: installed real-model conversations and complete preparation/review/artifact path; begin matching-Windows rehearsal. | Midweek go/no-go. If computer restrictions, Stop or the main result cannot be proved, Friday becomes a supervised demo/fit-check report, not an operational pilot. |
| Thu 17 | Kevin + reviewer: one authorised attended office cycle, correction, ambiguity, duplicate attempt, restart and chosen phone decision. QA records actions and actual artifacts. | Correct source and result, independent approval, one effect, understandable hold/recovery; no external consequential action inferred from a test request. |
| Fri 18 | Kevin + backup reviewer repeat without coaching; delivery lead provides runbook, known issues and support route. Approve precise cadence only after the selected routine passes. | Dated pilot decision and evidence pack. A second bill workflow is included only when its full correctness/persistence/Stop gates pass. Wider Stage 1 go-live and later handover remain separate milestones. |

A primary Friday demonstration can be the payment-reference path: selected export → preserved original → validated reference-only proposal → Kevin reviews → checked file → authorised REI preview/readback → saved result → Stop/recovery. If acquisition is manual, label it manual; it does not satisfy the proposed automatic-acquisition obligation. Bills are the second required Stage 1 path, not an optional item to quietly omit.

Do not plan all five fixes as guaranteed one-day work. Monday's reproduction and actual Windows fit check determine the achievable sequence; add delivery capacity or extend the milestone if needed rather than skipping acceptance.

## Pilot and go-live decisions

For every capability activated in a pilot, require all of its critical cases to pass, with zero prohibited actions, false payment confirmations, lost source data or falsely completed work. Repeat critical paths with changed datasets, not just the same prompt. Record Stop latency, response time, review effort and cost; agree operational targets with Kevin from measured baseline rather than inventing an SLA.

A supervised payment-only pilot may hold unfinished bills inactive with a clear scope note. **Full Stage 1 acceptance requires both main routines**, inbox support, the agreed Windows/browser/native-app path, actual chosen phone route, source acquisition and coverage, durable operational state, duplicate/recovery behaviour, and operator training. Require the reviewer to demonstrate Stop, takeover, correction and recovery. Do not infer acceptance from silence or the calendar.

No runtime release is authorised by this document. Current testing is installed Mac + real model + synthetic files. Customer site/account access, phone recipients and activation require the specific agreed office scope. A question about Windows availability is pending; no customer session has been confirmed.

## Proposal handoff

Use only the [corrected customer proposal](AUSTIN-CUSTOMER-PROPOSAL-2026-09-10.md) aligned to [engagement revision 18](AUSTIN-ENGAGEMENT-2026-09-10.json). The prior Markdown's Stage 1 installments totalled A$6,500 despite its A$5,500 headline; they now total A$5,500: A$1,500 + A$1,500 + A$1,500 + A$1,000. Stage 2 remains separately approved A$2,000, against the scoped A$4,000 list price. No new pricing or accepted contract was created in this review.

The matching commercial brief's Stage 1 percentage is corrected to 50%, and its comparable Stage 2 referral price to A$4,000+, consistent with the canonical engagement. The proposal preserves training/support, two included care months, month-three billing, acceptance and the later 30-day handover. The existing old `proposal-v3` and `phase-plan-v2` HTMLs have stale commercial terms and must not be handed off. A [new local review copy](../outputs/realbud-next-week-readiness-2026-09-12/proposal/index.html) was generated from the corrected source, with exact-text, amount and local-link verification. It includes internal source context and is not a send-ready public package. Browser URL policy blocked opening the local HTML for visual inspection; desktop/mobile/print appearance remains unverified. Review presentation and remove internal source context from any eventual customer export before sending.

Before customer handoff, confirm:

- Named operator and backup reviewer; actual Windows architecture, browser and native application versions; available session and lock/sleep constraints.
- Approved bank sample/format/reference map and REI preview expectations; bill register/history, agreed mailboxes and complete coverage rules.
- Exact first run, cadence, timezone, weekends, operating/quiet hours, source availability and phone route. “Every two days” is not automatically Monday/Wednesday/Friday.
- What the fit check delivers, what remains implementation work, which pilot capabilities can be used, and how later acceptance is recorded.
- A measured baseline, review responsibilities, support contact, costs and a readable recovery guide. Sign-in stays customer-controlled.

No proposal, customer communication or calendar invitation was sent during this review.
