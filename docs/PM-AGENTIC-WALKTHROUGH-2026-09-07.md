# Bud workflow and capability walkthrough — 7 September 2026

This review followed selected Desk work into the canonical Bud conversation, inspected real PM deliverables, and exercised the existing persistence and permission boundaries. It used fictional cases and isolated local state. No customer records, live-office accounts, sends, payments or installed application files were changed.

## Changes made

- Desk offers **Prepare next step**, **Summarise this case**, **Improve wording** when a draft exists, and **Investigate missing facts** for eligible cases. Human-only and unmatched-case recovery routes remain in place.
- A selected-case attachment now includes the matching property, recorded ledger facts, case recipient, contact safeguards and tenancy status, source labels and dates, and saved notes. Unsaved notes and wording are explicitly separate. References are data, not instructions or authority.
- Draft/work records must match both the selected ID and property. Other properties and private source keys are excluded. Unknown dates and missing sources remain explicit; a case observation is not presented as proof of a fresh ledger.
- Attachments identify the case type as well as its address. Returning to the same case refreshes its one attachment, including note changes that do not bump the Desk revision. Existing requests and other attachments remain intact, with a visible notice when the request was preserved.
- Recovery investigations now stage the request and evidence in Ask instead of sending a bare prompt directly. Connection checks, approval ownership and existing composer operations retain control. The editable request uses plain language; technical case metadata lives in the reference.
- Individual note and wording excerpts, contact/source counts and the complete reference are bounded. Omitted content is labelled and requires inspection before relying on it. The complete Ask envelope is still validated before sending.
- The real output review found unsupported claims such as “we’ve logged this” and “the office is triaging”. Bud's drafting guidance now explicitly distinguishes both completed and ongoing action from a proposed next step. A focused live regression checks these claims. This improves the prompt; it does not make model output infallible.

No storage schema, worker authority, integration credentials or dependencies changed. Notes and edits remain in the existing app-session memory until the user saves/sends them; this work does not add crash recovery for unsent property drafts.

## Capability evidence

| Capability | Evidence from this pass | Practical limit |
| --- | --- | --- |
| Read supplied evidence and prepare useful PM work | Real worker produced morning plans, quote comparisons, maintenance briefs, inspection checklists and held-arrears checklists from unpredictable fictional source references | Synthetic source runtime, not a live-office acceptance test |
| Connected tools | Real MCP initialization, discovery, authenticated loopback read, source citation and quote arithmetic passed | A fixture connector; customer OAuth and actual PMS reads remain unverified |
| Permission enforcement | Real write-capable probe requested approval and was denied before reaching its inert endpoint; broker tests cover exact requests, duplicates, cancellation and uncertain outcomes | No real external write was attempted |
| Correct and continue work | Real worker updated a quote/day correction and retained those corrected facts after process restart with supplied conversation history | Does not prove unlimited context or autonomous memory of omitted facts |
| Persistent batches | Tests cover restart, partial success, completed-item preservation, opt-in continuation, bounded retries, manual pause and failed persistence | The 500-property boundary is tested with controlled workers; real 200-property throughput is not established |
| Saved jobs and follow-ups | Tests cover full result persistence, held consequential steps, idempotency, queued-message replacement and restart | Does not establish operation while the Mac is asleep or the local service is stopped |
| Document instruction handling | Real fictional supplier quote contained a malicious instruction; Bud retained business facts and missing access without following it | One adversarial scenario, not a complete prompt-injection security assessment |
| Portal computer use, other attachment formats and parallel research | Existing capabilities remain available under their established controls | Not independently exercised in this pass; no claim that every available tool has been validated |

## Verification and output review

- 134 focused tests passed across context/queue behavior, Ask policy, connected-app broker, batches, job execution and conversation persistence. After the final reference-bound and label edits, 36 affected tests passed again.
- Production build and TypeScript checks passed. Existing Vite large-chunk warnings remain.
- 15 browser checks passed on isolated API 18984 / UI 5204: specific task requests, saved and unsaved notes, latest-context replacement, preservation notice, refinement, recovery staging, distinct same-address case labels, missing-worker gating, no silent writes and narrow-screen overflow. No browser runtime errors.
- The visible app completed a real connection check and sent an attached maintenance case to Bud. The returned brief cited the unpredictable reference from that property note, retained missing access/spending authority and stayed with maintenance. Returning to Desk retained the selected case. A fresh browser session then recovered and reviewed that persisted response without rerunning the worker. The live harness initially flagged the normal local unread-badge PATCH; source inspection confirmed it marks the conversation read, and the harness now allows only that exact payload. No office/PMS write endpoint was requested.
- Eight distinct real-worker PM scenarios have passing checks across the broad run and focused maintenance reruns. The broad retry recorded seven passes and a maintenance assertion failure because the first matcher also caught “No tradesperson has been booked”. That matcher was corrected to detect affirmative claims; the later in-progress claim was identified by reading the output and addressed separately. The final focused maintenance response passed the expanded check and was read.
- The initial broad run was interrupted by disk exhaustion while saving a response. Only the unused, rebuildable Vite dependency cache was removed. Original logs and partial results were retained. This interruption is not recorded as a successful run.
- Browser harness failures from incorrect selectors and checks made before React effects completed were retained; final checks wait for the relevant rendered state. The live-UI harness also initially matched a negated “nothing has been logged” statement; that assertion was corrected to inspect affirmative claims.

The results contain useful deliverables, preserve quote-tax and scope uncertainties, keep ambiguous payment/contact work held, and retain corrections after restart. Some responses remain more verbose and cautious than a PM may want. Observed response time varies substantially, including roughly 106 seconds for one quote comparison. Large-portfolio throughput and independent PM usability still need measurement.

Repeated sample resets in the isolated book also exposed accumulated historical cases in the attention count. That sample-replay/history behavior was not changed in this focused handoff pass. The subsequent Wednesday demo-readiness pass repaired it with atomic sample replacement, rollback and live-book protection; see `WEDNESDAY-DEMO-READINESS-2026-09-09.md`.

The isolated UI and API services were stopped after verification. The installed native app was not rebuilt or replaced.

Evidence, before copies, scoped diff, screenshots and scripts: `outputs/pm-agentic-walkthrough-2026-09-07/`.
