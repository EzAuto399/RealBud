# W2: weekly bills review (what we learned before the first live run)

Notes for Bud. Facts from fictional QA runs on 2 October 2026 (fictional mailbox connector, fictional invoices, a deterministic stand-in for the model). No real mail, bill or payment was used. These notes grant nothing.

## What happens, step by step

| Step | What it needs | Who acts |
|---|---|---|
| 1. Setup | The office's Gmail account connected and selected, the property list with references and aliases, the bills plan reviewed and approved. | Office, once |
| 2. Collect | The reviewed Gmail scope for the week. RealBud keeps the original messages and records any gap in coverage. | RealBud |
| 3. Prepare | Up to 20 new bill candidates per run become saved drafts. One text-based PDF per message can be read; scans, images and several PDFs stay for the person. | RealBud |
| 4. Review | The person checks each draft against the original email and attachment, then accepts, corrects or leaves it. Nothing becomes a bill without this. | Kevin |
| 5. Calendar | Accepted bills show their due date. Approved recurring patterns show expected arrival windows and expected payment dates. | RealBud |
| 6. Follow-ups | An expected bill not found in fully checked mail becomes a follow-up, never a made-up bill. Gaps or unread attachments hold the finding instead. | RealBud, Kevin decides |

## Calendar meanings (keep them apart)

- **Due**: from an accepted invoice.
- **Expected arrival**: from an approved recurring pattern; a window, not a bill.
- **Expected payment**: a forecast from approved payment terms or an accepted due date; never a record that money moved.
- **Paid**: W2 never sets it; the bill correction API refuses payment-state changes.

## Things that go wrong, and what RealBud does

- Same request sent twice: the saved run is returned; no second draft or notification.
- Unchanged mail next week: the same draft and proposal are reused; the run is quiet.
- Lost reply after a proposal or acceptance: the saved request is read back; no duplicate bill.
- The same invoice under a new message: held as a possible duplicate until the person confirms it is separate.
- Setup changed after approval: W2 stops until the plan is reviewed again; saved results do not become bills.
- More than 20 new candidates: the rest stay as saved drafts for the next run.
- A week the computer was off: the gap is shown; no "missing bill" claim is made for unchecked time.

## Decisions Kevin must make

1. The Gmail account and which labels or folders are in scope.
2. Property mappings for vendors and accounts.
3. Which recurring patterns to approve (vendor, property, arrival window, payment terms).
4. What "expected payment" should mean for the office: due date, or usual payment day.
5. Weekly day, time and timezone (paused until approved).
6. How long before a missing bill becomes a follow-up, and who owns follow-ups.

## Preflight checklist for the first live run

1. Office's own data directory; Gmail account selected and checked in setup.
2. Bills plan reviewed and approved for the current setup (any setup change needs a fresh review).
3. Run W2 once by hand with the schedule paused. Open each draft beside its original email and attachment.
4. Accept one real bill only after checking its fields; confirm its due date appears once on the calendar.
5. Approve one recurring pattern; confirm its expected arrival and expected payment appear, labelled as forecasts.
6. Run again: nothing duplicated, no new notification.
7. No REI login is needed for W2. Any REI comparison is a separate, attended, read-only check.
8. Turn the weekly clock on only after the owner approves the time.
