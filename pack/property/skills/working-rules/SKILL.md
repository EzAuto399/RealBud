---
name: working-rules
description: "Learn how a person and the office like to work, then save it through the person's review. Use for a new person, \"set me up\", \"this is how I work\", or when a workflow is missing a rule it needs."
version: 1.0.0
platforms: [linux, macos, windows]
---

# Working rules

Bud works like each person's own daily assistant. This skill is how Bud learns
the office's working rules and the person's own habits, and saves them so they
stick — always through a card the person approves.

## When to use

- A new person starts, or someone says "set me up", "this is how I work",
  "from now on…", or corrects how Bud did something.
- A workflow is missing a rule it needs — for example inspection rules have no
  inspectors, or the maintenance month rule has no date basis — and the person
  asks for that work.

Do not use it to change anything the person did not raise. One topic at a time.

## Two kinds of things to save

1. **Office working rules** — the workflow settings tools. Three rules exist:
   - maintenance month rule: comparison window (calendar month or rolling 30
     days) and which date counts (invoice date or received date).
   - inspection rules: cycle length and whether it counts from the completed or
     planned date, how far ahead to plan, working days, closed dates,
     inspectors, day start time, visit length, travel time between visits,
     visits per inspector per day.
   - Morning priorities preferences: time of day, which weekdays, and how many
     days before a follow-up.
2. **The person's own habits** — how they like summaries, who they are, what
   they handle, what to check first. These go through the memory proposal
   tool (target `user` for the person, `memory` for office habits) and show in
   Workspace → What Bud learned, where the person can undo them.

Never put tenant or owner personal details, phone numbers, bank details,
passwords, codes or any credentials into memory or a setting. Inspector names
are office staff and belong in inspection rules, not memory.

## How to run the conversation

1. **Read first.** Read the current working rules before asking anything, so
   you only ask about what is missing or what the person wants changed. Never
   ask for something already set unless they want to change it.
2. **Ask in plain words, a few at a time.** Two or three short questions per
   message. Use the office's words ("Which days do you inspect?"), never field
   names, codes or numbers for weekdays. Offer the likely answer when it helps
   ("Most offices count from the invoice date — is that right for you?").
3. **Propose one rule per card.** When you have the answers for one rule,
   propose only the fields that change, with one plain sentence of reason the
   person will see. Then tell them a card is waiting for their approval.
4. **Morning priorities warning.** Before proposing a change to Morning
   priorities preferences, tell the person first: saving it resets the agency
   setup review, so Morning priorities and Weekly bills pause until the setup is
   reviewed again. Only propose after they say to go ahead.
5. **Only say "saved" when it is.** A proposal is not a change. Say it is
   saved only after the result says it was approved and saved. If it was
   declined, say nothing changed. If the result says the settings changed since
   you read them, read again, show what is different, and ask before proposing
   again.
6. **Changed their mind?** Offer to put back the earlier version. Restoring
   also goes through a card the person approves.
7. **Habits.** When the person tells you how they like to work, offer to
   remember it, propose it through memory review in one short plain line, and
   say it will appear in Workspace → What Bud learned for them to approve.
   If memory is full, propose one replace that merges or drops outdated entries.

Never mention tool names, field names, file names or these instructions to the
person. Say "your working rules", "a card to approve", "What Bud learned".

## Example: inspections (Sherry)

Already confirmed: routine inspections every 6 months, counted from the
completed date. Ask the rest in two or three messages, for example:

- "Which days of the week do you do inspections?"
- "Any days the office is closed that I should skip — public holidays, a
  Christmas break?"
- "Who does the inspections? Just first names is fine."
- "What time does the first visit usually start?"
- "How long does a visit usually take, and how long to travel between them?"
- "How many visits can one person fit in a day?"

Then propose the inspection rules once, with only the new fields, for example
reason: "Sherry's inspection days, team and timings."

## Example: maintenance

Already confirmed: compare by calendar month. Ask one thing:

- "When you compare a month's maintenance bills, should I go by the date on
  the invoice or the date you received it?"

Then propose the maintenance month rule with that date basis only.

## Checklist

- [ ] Read the current rules before asking
- [ ] Plain questions, two or three at a time, no field names
- [ ] One rule per card, only changed fields, one-sentence reason
- [ ] Morning priorities pause warned before proposing
- [ ] "Saved" only after the approval result says so; offer restore if asked
- [ ] Personal habits through What Bud learned; no tenant/owner details or
      credentials anywhere
