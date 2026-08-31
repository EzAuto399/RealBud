# The lived office

Date: 2026-08-30
Canonical constraints: `docs/GOAL-PROMPT.md` wins conflicts. Weekday map: `docs/PM-DAY.md`.
Design system: `DESIGN.md`. Routines: `docs/ROUTINES.md`. Records: `docs/PRODUCT-DESIGN-PLAN.md`.

This is the product at system altitude: the day RealBud is supposed to feel like, and the
wire underneath it. It is not a feature list and not a second IA. Everything here maps onto
Desk, Ask, Schedule and You. Nothing here opens a gate that `docs/NEXT-WAVE.md` closed.

Reviewed 2026-08-30 (CEO + eng, HOLD SCOPE, outside voice). Two things that appear in
earlier drafts of this design were cut by that review and are recorded in **Deferred** at
the bottom rather than described as if they exist.

---

## 1. Experience principles

**Opening RealBud is catching up, not starting.** The morning already happened. The screen
is the residue of the 7:30 run, not an empty tool waiting for input.

**Only what needs a person.** If Bud knew the next honest step, it took it and said so
quietly. The queue is an exception list. "Nothing needs you" is a designed state.

**Say the honest thing, loudest when it missed.** A miss is a first-class outcome with its
own copy. Never a silent success, never a fabricated card, never "checked" when nothing was.

**One tap is the whole ceremony.** Allow. Everything before it is reversible; nothing after
it leaves the building on its own.

**There is no Send.** Not greyed out, not behind a confirm — absent. Safety lives in the
shape of the action bar, not in warning copy.

**Every fact wears a stamp.** Where it came from, when it was observed, whether it is stale.
A number with no stamp does not get to produce wording.

**It learns this shop, not the industry.** Notes and property options, never statute. A day
count here is a house reminder, never a legal clock.

**The worker is furniture.** The PM never meets the engine. A visible tool call, skill file
or scheduler is a design failure.

**Nothing happens while nobody is looking.** Lid shut, background may gather facts. It may
never deliver.

---

## 2. The day, mapped

The IA is not object types. It is the shape of a Tuesday.

| Hour | The office is doing | Where | Queue state |
|---|---|---|---|
| 7:10 lid opens | Catching up on what ran | Desk | Now, Waiting beneath |
| 7:30 | Money check across the book | Desk (Schedule pressed it) | Now fills |
| 8:00–9:30 | Overnight mail, first fires | Their own Outlook; Desk holds an honest gap | Waiting: *Inbox not connected* |
| Mid-morning | Classify, draft, Copy into the PMS | Desk case canvas | Now → Done |
| Any time | "Put a courtesy on Harbour Rd" | Ask → becomes a Desk card | Now |
| Afternoon | Retune the clock, see what ran | Schedule | Next |
| Friday 16:00 | Owner catch-up pack | Desk (Schedule pressed it) | Now → Done |
| Any time | Their export, agency, worker | You | resolves Waiting |

**Desk** is the day. Primary pane is Now. Secondary is the object in focus with its evidence
rail. Book mode is a second *mode* of Desk for configuration, never a fifth place and never
mixed into the live queue.

**Ask** is the same worker through a different door, scoped to what you are looking at. The
moment something must leave the building it stops being a conversation and becomes a Desk
card. Ask never holds work.

**Schedule** is the week as the office runs it: named routines, when they next fire, what
each run produced, and a miss shown as a miss. It is the home of **Next**.

**You** is the state of the office itself. It is where **Waiting** gets resolved, and the
Desk queue relaxes as a consequence.

### The four states

These are states of the existing Desk queue. Not navigation, not modules. They live in
`src/lib/desk-queue.ts`, which already owned bucketing before this design existed.

**Now** — needs a person this sitting. A pending draft, an unmatched import row nobody else
can match, a licensee escalation. This is the Desk default and the only number in the
sidebar badge. Licensee rows sort to the top of Now and keep their own kind and tone; they
are not a separate bucket.

**Next** — the routine knows the step and nobody is needed yet. Seeded book kinds
(maintenance, lease, inspection, inbound) that are on the book but not this morning's work.
A portal session being prepared. Tomorrow's 7:30.

**Waiting** — blocked on something outside this sitting. A held case, a stale fact, a failed
handoff, an effect nobody could verify, an expired session, an uncovered property, an inbox
that is not connected. Waiting always names its own repair.

**Done** — a decision is recorded. The **count is today only**; the list keeps the history.
A running total of every decision ever made is a vanity number, not a day's work.

The mapping from a case's state to its part of the day is one exhaustive switch,
`bucketForWork`. A new `WorkState` cannot compile until someone says where in the day it
belongs, so a case can never fall through and render in no bucket at all. That is not
defensive style; a queue that can hide a card is a queue that lies by omission.

---

## 3. The core loop

```
event ─▶ facts (stamped) ─▶ evaluate (shop rules) ─▶ Bud's proposal
                                    │
                                    ▼
                         Desk card in Now
                                    │
                 Allow / Edit / Deny / Copy / Done in PMS
                                    │
                    ┌───────────────┴────────────────┐
                    ▼                                ▼
             Decision (audit)                Note (this owner,
        revision-exact, reversible            this building, taste)
```

**An event is typed or it is not an event.** Money landed or did not. A row arrived. A date
passed. The PM said something. There is no free-text trigger anywhere, because that is the
door a saved prompt — and then a send routine — walks in through.

**Facts and judgment are separate records.** Evidence is immutable and stamped with
authority and collector. A proposal is Bud's reading of it. The PM can disagree with the
reading without corrupting the fact.

**Evaluate is deaf to Notes.** `evaluateProperty` sees the property, the tenancy, the policy
and one money position. It never sees the vault. Notes may colour wording after the factual
call is made; they can never move `draft / escalate / clear / skip / hold`. This is the most
important line in the product and it is regression-tested.

**Allow is scoped to one revision.** Editing wording creates a revision; it does not
authorise anything. Allow references the exact revision it approved.

**A rule change recomputes the cards but does not claim a check.** Move a property's grace
days and the cards under it are recomputed from facts already on the book; `lastRunAt` does
not move, because nothing was re-read. On a book that has never been checked, nothing is
evaluated at all — evaluating there would invent cards from fixture facts.

---

## 4. Engine to lived surface

Everything in the left column is internal vocabulary. None of it appears on screen outside
Advanced diagnostics.

| Engine capability | How the PM experiences it | Store | Gate |
|---|---|---|---|
| SOUL + identity | Bud sounds like this office | `pack/property/SOUL.md` + Notes | No memory panel. Profile `memories/` ignored. |
| Pack skills | "Recheck" and the morning run fetching real facts | `pack/property/skills/` | PM cannot author, name or see a skill. |
| Learning loop | Drafts need fewer edits | Notes (wording) + `desk.json` options (behaviour) | Never-rules are code-derived and re-stamped on every write. |
| Scheduled work | Named routines, delivered as Desk cases | `loops.json` on RealBud's clock | `cron_mode: deny`. A `jobs.json` under the worker is a gate failure. |
| Delegation | One face. Case kinds, not specialists. | One profile, `property` | No second worker, no roster. |
| Model attach | You → Worker → Attach model | Worker profile config, written by the app | Zero terminal. Ask refuses a pasted key. |
| Chat | Ask, scoped to the case | Same profile, different door | Ask proposes; it cannot write the book or the clock. |
| PMS / portal | Recheck, draft, Copy | Recipe + binding as configuration | Bounded tools. Bud may prefill. Submit stays human. |
| Mail / SMS | *Planned.* Today: an honest "Inbox not connected" | — | Does not read mail. Auto-texting a tenant is send. |
| Pocket | *Planned.* The same Bud, that PM only | — | A room for the PM, never a channel for tenants. |

One rule: **the engine supplies facts and words. RealBud owns when, what the human sees, and
what may never happen.**

---

## 5. Scenes from a weekday

**7:12 Monday — the lid opens.** She catches up rather than starts. Desk is sorted: four
need you, two waiting. The strip says the book was checked at 7:31 Friday and that overnight
mail is not connected. The first thing she sees is four addresses, not a chat cursor.

**7:31 — the money check.** The clock presses Recheck. The worker returns ledger facts, shop
rules run, exceptions become cards. Oak St is three days past due, inside the courtesy
window, no hardship flag. She edits one word, taps **Allow**, then **Copy**, and pastes into
their PMS. There is no Send button on that card; there never was one to disable.

**7:44 — the miss.** Harbour Rd should be next. Instead the strip turns amber: *Recheck
missed. The worker did not return live facts.* Six addresses read Not checked. No drafts
were invented from stale numbers. Schedule's slot carries **Missed**; You shows the worker
source as Missed. Ask offers **Change model**, which opens You with the attach sheet already
open, because the fix lives there and never in the chat box.

**9:05 — the mail hour, and the refusal.** Forty overnight emails. She types *"just text all
the late ones."* Bud declines in one sentence and points at the courtesies already on Desk.
Nothing is queued. The clock does not change. No card is created to make the refusal feel
productive.

**10:20 — the leak.** Second hot-water fault at 8 Pine this month. Bud classifies it, reads
the after-hours plumber and the $500 cap off that property's options, and drafts the tenant
acknowledgement. It does not call the plumber and does not pay anyone. A Note records the
repeat. That Note will colour the next draft; it will not, by itself, change what the system
decides.

**11:40 — the export.** She drops the arrears CSV on Desk. Rows match by address or property
code. The preview is honest before anything commits: 41 matched, 3 unmatched, 1 ambiguous.
The four problem rows do not become four fake properties. They land in Now, because nobody
but her can match them.

**14:15 — from the car park.** *"Put a courtesy on Harbour Rd."* Bud drafts it from the book
and this morning's facts and stages it as a Desk card. Back at her desk it is in Now with
everything else and takes the same single Allow.

**Friday 16:00 — the owner pack.** One factual catch-up per property is already written,
with the Notes giving it voice. She skims six, edits one, Allows, Copies. By 16:20 the
Monday "any update?" emails do not arrive.

---

## 6. Trust, control and failure

**Nothing happens while nobody is looking.** Lid shut, the system may gather facts and write
a result file. It may not deliver. When the clock moves we deliberately do not backfill a
missed slot; Run now is the explicit human catch-up. A silently replayed 7:30 from four days
ago is a lie about what the office knew.

**There is no send path.** `POST /api/desk/drafts/:id/send` is 403 and the courtesy
disclaimer cannot be stripped. No Always-allow. No routine may send even if the PM typed
that instruction into Ask.

**Notes change what it sounds like; options change what it does.** A Note can say "this
tenant always pays Thursday, don't nag Wednesday" and soften the prose. It cannot suppress
the card. Suppressing the card is an option change, made on the card, visible and
reversible. That asymmetry is what lets a PM write freely in Notes without quietly disarming
the system.

**Every source says exactly what it is.** Worker live, CSV live, Missed, Not checked, Inbox
not connected, uncovered by worker. A partial ledger holds the properties it did not cover
rather than quietly clearing them. The demo book never poses as live and a training agency
name never counts as named. When a handoff finishes and we cannot read back proof, the state
is *effect unknown* and the PM records "Done in PMS". Unknown stays unknown.

Day counts on Desk are shop reminder rules, never state law. Law is a refusal, not a
feature. When the book itself fails to load, writes and schedules stop, the preserved data is
named, and the PM resumes explicitly.

---

## 7. Thirty and ninety days in one named office

Bud does not get smarter. **The office gets written down.**

**By day 30** it knows the shop's hand: which buildings are portal-only, which owner wants
Friday and which wants month-end, the chronic-but-harmless late payers whose courtesy should
read differently from real arrears. The measurable signal is not accuracy, it is **edit
rate** — how often she rewrites wording before Allow. Week one she rewrites most drafts. By
week four she approves them.

**By day 90** the defaults have moved: courtesy windows and channels settled per building
rather than per shop, owner cadence per property, groups carrying inherited defaults so a new
management picks up the building's conventions on arrival. The Decision history is long
enough to compute an honest load-off ledger — drafted, approved, escalated, minutes removed —
where *drafted never counts as sent*.

**The mechanism.** She says "this is how we handle X" once. It becomes a Note if it is taste.
If it is behaviour, it becomes a property option she edits in Book mode, and the cards
recompute under the new rule without claiming a fresh check.

**What it never becomes.** Not a skill marketplace, not a memory panel, not a prompt library,
not a second worker who specialises in maintenance, not a legal clock that learned the notice
periods. If the answer to "how did it get better" is "it grew a new capability", we shipped
the wrong product.

---

## Deferred

**Settings changes by approval (`PolicyProposal`).** Bud proposing an option change as a Desk
card, approved with one tap. Cut by the 2026-08-30 review for three reasons, all verified
against code:

1. A Decision-log-only record cannot satisfy `desk-v3-decode.ts:809` integrity without
   putting the proposal in `book.proposals`, whose `kind` is `DraftKind` and which
   `desk-v3-project.ts` maps into `drafts` — the exact `Draft` overload `docs/ROUTINES.md`
   forbids. `DECISION_KINDS` has no kind for applying a policy.
2. The dangerous direction is *loosening*. Widening `courtesyUntilDay` removes licensee
   escalation on a late property, and that property has no pending draft, so a
   hold-on-settings-change mitigation never fires there.
3. The product ingests untrusted text (pasted book, dropped CSV, attachments, Notes), so the
   approval card is a prompt-injection cash-out with one human tap as the only gate.

Build it when a named office asks, with their actual failure case choosing which fields are
proposable. Probably one field, not five. Until then, property options are edited by hand in
Book mode, which already works.

**Still gated on `docs/PILOT-CONTRACT.md`:** inbound-triage mail, live portal, Pocket, the
graduate installer, and Ask proposing a clock change (ROUTINES PR C).

## Open

`addProperty` and `removeProperty` still stamp `lastRunAt` through `evaluateBook`, so adding
a property reads as a fresh check. `patchProperty` no longer does. That inconsistency is
worth closing, and it is pre-existing rather than introduced here.
