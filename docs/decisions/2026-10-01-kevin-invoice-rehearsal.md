# Kevin owns invoices; RealBud leads the rehearsal

Status: owner direction confirmed in conversation on 1 October 2026 (Australia/Brisbane). This decision does not establish completed mock execution, a Modelvia completion, live REI access/entry, payment authority or customer acceptance.

**Latest clarification: real REI reads, simulated writes.** The user requires an actual REI connection and reads to validate the supplied CSV against real records. Wait for the user to log in personally before those reads. All REI writes, edits, entries, imports, attachments, payments and sends remain simulated, with no change to live records. Reuse the same normal browser profile and its browser-managed cookies while REI permits it; do not export or copy session/token cookies. The earlier interpretation that all REI reads/evidence must be simulated is superseded.

**Browser direction:** The user rejects the BrowserSkill Chrome add-on requirement. Integrate Hermes' default browser capability inside RealBud and remove the add-on prerequisite from the normal connection flow. The implementation uses a persistent private work profile in Chrome or Edge, with the user signing in there; it does not reuse the user's personal browser profile. Session cookies stay browser-managed in that same work profile. RealBud still owns task scope, access, review, Stop and execution records; changing the browser transport does not authorize live writes. Current execution evidence is recorded in [the checkpoint](../KEVIN-INVOICE-MOCK-2026-10-01.md).

## Current job and ownership

Kevin is the sole owner/reviewer for W2 invoice intake and entry preparation, property matching, corrections, expected bills, calendar and exceptions. This supersedes the Sherry intake/missing-bill handoffs in the [30 September tool decision](2026-09-30-auston-workflow-tools.md) and [workflow plan](../AUSTON-KEVIN-SHERRY-WORKFLOW-PLAN-2026-09-30.md). Sherry's maintenance review and inspection planning remain separately planned, outside the first invoice rehearsal. Bank-reference and morning-priority work remain in the broader plan.

Kevin's supplied message asks to start by matching the current payment situation in REI and predicting when bills should arrive. Bud should connect each bill to evidenced REI status and propose expected arrival windows from sufficient historical occurrences. Expected arrival, due date, entry status, payment and advance recovery remain separate. Unknown coverage/status stays unknown.

The tool split remains: Composio for permitted mail and attachments; computer use for selected REI sessions; RealBud for job state, evidence, reviews and calendar. Zapier remains exclusive to Property Inspect. Kevin's invoice ownership does not grant payment release, notices, messages or live financial posting authority.

## RealBud-led acceptance: real reads and mock writes

Run the job in RealBud using its configured Modelvia worker and normal tool/review paths. Bud should identify the next step and carry it out; a developer manually assembling the result does not satisfy execution acceptance.

1. Record the selected app revision, worker, job identity and permitted inputs. Give Bud the Kevin-only W2 scope and ask it to begin.
2. Select the supplied `Property.csv` in RealBud. Bud inspects exact rows/headers and identity gaps without repeated approval for routine permitted reading. Treat the directory as an unaccepted snapshot until its normal import/review step; retain the original. Do not commit customer rows to fixtures or public logs.
3. After the user logs in, have Bud connect through the integrated Hermes browser path, confirm the selected agency/account and read the bounded property/invoice/payment records needed to validate the CSV. Retain source references, observation time and coverage; a read plan alone is not executed validation. Hold mismatches and insufficient evidence for Kevin.
4. Add labelled synthetic fixtures for a duplicate forward, conflicting revision, ambiguous match, mock paid bill and incomplete history. Keep them separate from actual REI evidence. Review proposed matches and recurrence through RealBud, and inspect its saved records/calendar. Simulate every proposed REI write without applying it; distinguish expected arrivals from evidenced due dates and synthetic paid status from verified reads.
5. Repeat the input and resume the job. Existing decisions must survive; duplicates must not create another bill or chase. Record failures honestly, fix the product, and rerun the affected step.
6. Retain job/turn references, tool outcomes, saved record/readback evidence and model request result. Label source tests, installed execution, simulated evidence, live integration and customer review separately. Public Modelvia health or a model's prose alone is not completion proof.

These are acceptance steps, not recorded test results. The property file alone cannot establish invoice matches, real payments or recurring bill history. Reading actual REI data is required for live CSV validation; synthetic fixtures alone cannot satisfy that step. Do not create, edit, attach, import, post, pay, send or otherwise change anything in live REI Cloud. Simulated write outcomes must never be reported as externally verified changes.

## REI sign-in qualification

Session qualification is deferred until the user has logged in personally. Then investigate reuse of that selected authorized session in the same persistent browser profile, including idle time, next-day reuse, browser/app restart and authentication expiry. Normal browser-managed cookies stay in that profile; no cookie/token export, copying or injection. Do not assume that Kevin must log in daily, or promise that he never will. Record observed behavior and any official vendor-supported session or API option before choosing an unattended operating arrangement.

After the user logs in and selects the correct session, a bounded read task can prove account identity, permitted record access and result provenance. Keep live REI unchanged. If sign-in/MFA is needed, Bud should hold that job with a clear human handoff, preserve progress and resume after the user reauthenticates. Credentials remain with the user/authorized person. Do not defeat MFA, weaken session controls or silently repeat an uncertain write.

Direct API access remains optional future work requiring verified entitlement and supported operations. Mock success does not qualify live REI entry; entry/attachment readback and any consequential-action authority remain separate acceptance stages.
