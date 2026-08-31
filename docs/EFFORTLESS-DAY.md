# The effortless day — remote decisions, pulses, user jobs on the clock

Date: 2026-08-31
Status: plan of record. Canonical constraints: `docs/GOAL-PROMPT.md` wins.
Builds on `docs/CHANNELS.md`, `docs/PORTAL-WORK.md`, `docs/PM-DAY.md`.
Nothing here opens inbound mail, a live PMS, or live CUA — the eight-field
visit in `docs/PILOT-CONTRACT.md` still gates those.

The loop this closes: **work flows to the phone, decisions flow back.**
Today a channel carries messages to Bud and answers back. What it does not
yet carry is the thing a PM actually needs at 9:40 between inspections:
"12 Oak St — courtesy wording ready. Tap to allow." One tap, recorded on
the book, done.

## What is missing, honestly mapped

Grounded in `docs/PM-DAY.md` (the Australian PM weekday) and what is built:

1. **Remote decisions.** Desk cards wait for a person at a desk. The person
   is rarely at the desk. Channels already know who the paired human is —
   decisions should travel.
2. **Proactive pulses.** Nobody opens an app to discover work. After the
   morning loop settles, the brief should arrive — phone channel first,
   desktop notification when the app runs.
3. **User jobs on the clock.** Teach-a-job ships recipes; they run manually.
   "Every Friday 4pm" in the description should land the job on the same
   RealBud clock as the named loops — never a second clock, never a cron UI.
4. **The brief at scale.** 20+ addresses is a wall. Counts up front,
   needs-you expanded, the rest a line.
5. **"Partial" run status.** A worker answering 1 of 6 reads as "failed"
   today. Accurate and needlessly alarming. `partial` tells the true story.
6. **Desktop notifications.** The Electron shell can notify when a loop
   produces needs-you cards — no phone required.

## Stage R1 — remote decisions (builds first)

- A Desk card that enters needs-you pushes to every paired channel: the
  address, the kind, what Allow means, and buttons. Telegram inline keyboard
  (`callback_query`); Discord message components. Text fallback parses
  yes / no / allow / deny, numbered when several wait ("2 allow").
- A tap records the decision exactly like a Desk Allow: same route, same
  `expectedRevision`, same decision log — stamped `via Telegram · Yoda ·
  9:41 am`. A remote decision is never quieter than a desk one.
- Only the paired chat can decide. Anyone else gets the one polite refusal.
- Statutory / licensee cards push as *information* ("needs the licensee —
  open Desk when you're at a screen") and are never remotely decidable.
- One pending decision per chat at a time (the grokbot lesson). Batch
  approvals list exactly what they cover ("Allow all 3: Oak, Harbour, Pine").
- Deny with a reason travels too: "no — too soon" lands on the card's notes.

## Stage R2 — pulses (builds second)

- After a loop settles with needs-you cards: one push per channel — the
  brief line + a review button. One digest, never a drip per card.
- Quiet hours in the agency timezone: nothing pushes 6pm–7am local; the
  morning digest waits for 7am. The clock already knows the zone.
- Desktop notification via the Electron shell when it's running, same digest.
- A miss pushes honestly too ("Recheck missed — 0 checked") but never at
  night.

## Stage R3 — user jobs on the clock (built 2026-08-31)

- The teach bar parses cadence words ("every Friday 4pm", "weekday mornings")
  into the recipe's schedule; the draft card shows the clock it will keep
  ("Runs Fridays at 4:00 pm · Australia/Brisbane") before saving.
- `server/routines.ts` admits user recipes onto the same clock: a recipe with
  a schedule is a loop with its recipe id; the week calendar shows it in its
  slot; Run now works; pause/resume is the recipe's status.
- **The plan-approval gate**: nothing executes on the clock until a person
  approves the plan. A scheduled-but-unapproved job is skipped on tick (no
  run spam; the due slot still catches up after approval). Shadow runs —
  manual, nothing clicked — never require approval. Approve once on You →
  Bud's jobs or from the Schedule card's "Plan needs approval" chip;
  un-approving is delete-and-re-teach, never a silent flip.
- Execution stays the staged path: shadow → approved → active,
  tighten-steps learning, evidence per run.
- PM-DAY's "PMs do not author jobs" line is superseded by the bounded recipe
  model: PMs author *described, origin-locked, evidence-carrying* jobs; the
  clock and the cards stay RealBud's.

## Site learning — different portals, layouts, banks

Every portal, bank feed, and layout is its own shape; the system does not
pretend otherwise. Each recipe carries `siteNotes`: what runs taught Bud
about *that* site — page names, button labels, quirks. Distill ("Tighten
steps") rewrites the steps AND refreshes the notes from the last run's
evidence; every later run reads them before it starts. A second portal is a
second recipe with its own notes — learning never bleeds across sites.
Origins and the evidence contract are never touched by a rewrite.

## Scale — measured, not hoped

`node --experimental-strip-types scripts/simulate-scale.mjs` boots the real
server on a temp home and times the operations a PM feels. 2026-08-31, this
machine, per fresh boot (6 training fixtures + N seeded through the real
intake path):

| Properties | Seed (intake + allow-all) | Desk snapshot | Snapshot size | Morning evaluate | CSV preview | CSV import | Loops |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 376 ms | 3 ms | 30 KB | 27 ms | 5 ms | 26 ms | 1 ms |
| 50 | 893 ms | 2 ms | 58 KB | 28 ms | 8 ms | 32 ms | 1 ms |
| 80 | 1480 ms | 3 ms | 86 KB | 28 ms | 14 ms | 42 ms | 1 ms |
| 100 | 1906 ms | 3 ms | 104 KB | 30 ms | 20 ms | 46 ms | 1 ms |

Flat where the PM feels it (snapshot, evaluate, import), linear where the
work is one-time (seeding). The book cap is 200; the cap error says so.

## Stage R4 — the scale + honesty polish (with or after R1)

- Morning brief collapse: "6 checked · 2 need you · 1 licensee" with only
  needs-you rows expanded.
- `partial` run status across routines, the Runs list, and the week calendar.
- Desktop notifications land with the Electron shell's next packaged run.

## Hard rules (never relax)

- A remote decision carries the same weight and the same audit as a Desk one.
- Quiet hours are the agency's, not the machine's.
- No channel becomes a second agent, a second clock, or a new nav place.
- Statutory moments keep a licensed human in them; a phone tap is fine for
  courtesy wording, never for a notice.
- Nothing here opens mail, a live PMS, or live CUA. The visit gates those.
