# An Australian PM weekday, mapped onto RealBud

Date: 2026-08-29  
Canonical constraints: `docs/GOAL-PROMPT.md` wins. Routines stay named kinds. PMs retune them. They do not author jobs.

This is the office day we simulate. It is not a new product surface and not a licence to start inbound mail or a live PMS.

## What the office actually does

A residential PM in Australia lives in a PMS first: PropertyMe, Property Tree (MRI), or Reapit PM (Console Cloud). Rent often lands through MePay, Console Pay / Ezidebit, or a bank feed. Inspections go out through Forms Live, Inspection Manager, or the PMS inspect app. Jobs and owner notes stay in the PMS. Overnight mail is Microsoft 365 or Gmail, plus tenant/owner portal messages. Statutory notices and trust movement stay with a licensed person in that PMS. RealBud never becomes those systems.

Typical weekday:

| When | Office work | Their tool | RealBud |
|---|---|---|---|
| 7:30 | Arrears board, courtesy follow-up | PMS arrears + MePay / bank | Morning money routine. Recheck. Copy. Send stays 403. |
| Morning | Overnight mail, leak / no-hot-water | Outlook / Gmail, PMS jobs | Inbound triage is Planned. Demo Desk holds an inbound card. Do not open mail. |
| Day | Maintenance classify, lease dates, inspection prep | PMS jobs, Forms Live, inspect app | Demo Book holds those case kinds. No tradie dispatch. No statutory draft. |
| Ask | “Put a courtesy on Oak”, paste a new book | Phone / email dump | Ask → Desk card. Allow fills the book. |
| Friday 4pm | Owner catch-up | PMS owner portal / email | Friday owner letter. Copy only. |
| Anytime | Their export, agency name, worker | CSV, You | Book import. Go-live. Worker, never Hermes.app. |

## How the worker is used

RealBud owns WHEN and the cards. The pinned worker (`property`) fetches ledger JSON on Recheck and on the morning routine. Same door. A miss or an uncovered property holds. `cron_mode: deny` stays. The PM never sees a Hermes window, a cron UI, or `hermes -p property`.

## What we will not add from this map

Inbox sync, PropertyMe/Property Tree APIs, Forms Live, a routine author, or a second clock. Those wait on `docs/PILOT-CONTRACT.md`.
