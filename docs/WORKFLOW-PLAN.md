# Workflow and build plan

Date: 2026-08-17
Status: Hermes does the work; computer use is the exception; the product is per-property options

## The split

**Hermes** is the default hands. Bank, PMS exports, water/levy portals that can be scripted, email, calendars: turn the site into an API/CLI or a skill and call it. Better control than clicking every morning.

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

## What we build now

1. Property options model (the table above) + fixture properties.
2. Hermes-shaped skills: `check-rent`, `check-levy-from-rent` (bank or export first, website→CLI when we wrap one).
3. Routine that runs those skills per property and opens a draft card.
4. CUA skill slot reserved for `portal-notify` — empty until one portal is trained.
5. Allow / Deny / Edit. No send on statutory. No Always allow.

## What we do not do

- Hardcode PropertyMe vs Property Tree as the product.
- Computer-use the bank if Hermes can read it.
- Two-day silent sit before the options model exists.

Walk-through (short) = fill options for their book + train the one portal notify skill if they have no API.
