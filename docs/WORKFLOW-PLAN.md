# Workflow and build plan

Date: 2026-08-17
Status: Hermes does the work; computer use is the exception; the product is per-property options

## The split

**Hermes** (pinned in `server/hermes-pin.ts`, not latest) is the default **headless** hands (`hermes -p property`). Desk Recheck may ask it for ledger JSON; any miss stays on the training book. Never launch Hermes.app. Bank, PMS exports, water/levy portals that can be scripted, email, calendars: turn the site into an API/CLI or a skill and call it.

**Computer use** is only for the few screens that will not script cleanly — usually the unique building/PMS “send reminder / assign tradie” button. Train that path once, save a skill, put it on a routine. That is a thin adapter, not the product.

**The product** is the options on each property: what to check, what comes out of rent, who to tell, what must never send. Those differ by building, lease, and state. That is what we should be specifying.

```
Routine (morning)
  → Hermes skills: bank? rent landed? levy/water/strata taken from rent?
  → Policy on that property: what is late, what to draft
  → If notify needs the dumb portal: computer-use skill (trained)
  → Allow card
```

## Per-property options (this is the work)

Each managed property (or tenancy) gets a card. Defaults from the shop, then overrides.

| Option | Why it exists | Example |
|---|---|---|
| Rent source | How we know money landed | MePay / bank feed / PMS export / Hermes bank skill |
| Due rule | Weekly vs calendar month, grace days | Due Fri, courtesy after 3 days |
| Taken from rent | Levies, water, strata, insurance the PM pays from the receipt | “Levy $420 quarterly — flag if rent in but levy not paid out” |
| Late path | Courtesy SMS vs letter vs portal notice | Courtesy only until day 7 |
| Notify channel | Portal click (CUA) vs SMS API vs email | This building = portal only |
| Tradie / emergency | Who they call, spend cap | After-hours plumber, $500 |
| Owner update | Weekly / monthly / silent | Investor wants Friday note |
| Never | Statutory send, trust pay, lock change | Always escalate |

v0 ships the card + arrears checks (rent landed, optional levy-from-rent) + draft. Portal CUA only if that property’s notify channel is “portal.”

## Loops (same engine, different option sets)

| Loop | Hermes | CUA only if |
|---|---|---|
| Rent / arrears | Bank + ledger + “levy taken from rent” | Their reminder button has no API |
| Owner catch-up | Read jobs/arrears/inspections, write letter | — |
| Jobs / tradie | Email/SMS/API | Building job portal is click-only |
| Inspection / renewal | Calendar + templates | Forms Live merge is click-only |

## Who owns what (the split, pinned)

RealBud is not a remote for the Hermes terminal. It is the PM's desk. Hermes is the worker behind it.

| Thing | RealBud window | Hermes property (headless) |
|---|---|---|
| When (7:30, Friday 4pm) | Yes | No |
| What the human sees (Desk cards, Allow/Deny/Copy) | Yes | No |
| How (bank, ledger, skill) | No | Yes — CLI / ACP / skill |
| Send / pay / notice | Never | Never (approvals.mode manual, cron_mode deny) |

```
Schedule (RealBud clock)
  → "morning arrears" loop
  → hermes -p property   ← skill + model + SOUL
  → JSON / draft text only
  → Desk evaluate (shop rules, not law)
  → Allow card → PM copies into the PMS
```

**A routine is Desk, but the clock pressed Recheck.** Named loops, not free-text prompts. The OpenMausBot routine runner (pick a MAUS + prompt) is deleted; Hermes cron stays denied. If the app is closed: on open, the next scheduled tick (or a manual Recheck) catches up. Later, if they need 7:30 with the lid shut: a launchd job that only writes a result file, RealBud reads it on open. Still fail closed. Still no send.

Chat = ACP into the same `property` profile (one memory, one SOUL). Skills = files in `pack/property/skills/`. Approvals = Desk Allow. Terminal / pets / plugins / group chats are never shown to the PM.

## What we build now

1. Property options model (the table above) + fixture properties. ✅ Desk
2. Hermes-shaped skills: `check-rent`, `check-levy-from-rent` (bank or export first, website→CLI when we wrap one). Skill `morning-arrears` in pack; live skill work continues.
3. Routine that runs those skills per property and opens a draft card. ✅ Schedule → named loops (`server/routines.ts`).
4. CUA skill slot reserved for `portal-notify` — empty until one portal is trained.
5. Allow / Deny / Edit. No send on statutory. No Always allow. ✅ Desk

## What we do not do

- Hardcode PropertyMe vs Property Tree as the product.
- Computer-use the bank if Hermes can read it.
- Two-day silent sit before the options model exists.

Walk-through (short) = fill options for their book + train the one portal notify skill if they have no API.
