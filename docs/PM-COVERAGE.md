# What an Australian PM actually does — and what RealBud covers

Date: 2026-09-04  
Canonical: `docs/GOAL-PROMPT.md` wins. Weekday sim: `docs/PM-DAY.md`. Pickup: `docs/NEXT-WAVE.md`.

This is a **coverage map**, not a licence to start inbound, send, trust, or a second Bud. The customer is a residential **property manager**. Sales/leasing agents, tenants, and DIY landlords are out.

## The constraint (why “do everything” fails)

A typical Australian PM is running ~170 properties. At eight hours that is about **2.8 minutes per property per day** — arrears, maintenance, inspections, renewals, and owner comms in the same bucket.[1]

Inspections (schedule + notice + travel + report + follow-up) eat about **one-third of the week**.[2] Maintenance is the other time sink agencies try to cut. The PMS (PropertyMe / Tree / Reapit) already owns the **record, the send, and the trust**. PropertyMe’s own automation already fires arrears messages, vacate/renewal tasks, and owner statements.[7][8]

RealBud does not replace that. RealBud owns the **weekday the PMS does not run**: exception judgment, draft wording the PM copies, overnight mail triage (when named), attended portal where the API cannot write, and Allow from the phone between inspections.

**Wall line the PM must be able to say:** *I see what it used. It cannot send. It did not invent a clock.*

How Bud runs that weekday (clock / Hands / Ask / portal — not a prompt box): `docs/AGENTIC-DAY.md`.

## Full range of the job (lifecycle)

What agencies advertise and what a tenancy manager actually does, end to end.[4][5]

| Stage | Repeated work | Their tool | RealBud |
|---|---|---|---|
| **Let / lease** | Advertise, opens, applications, references | Listing portals + PMS | **Out.** Different buyer (leasing officer). Do not become a CRM. |
| **Start** | Lease, bond lodge, entry condition report, keys | PMS + bond authority | **Never** bond/trust. Later: checklist reminder only. |
| **Every morning** | Who paid, who is late, courtesy before a notice | PMS arrears + MePay / bank / CSV | **Built.** Morning money. Recheck. Copy. Send 403. |
| **Overnight** | Mail: leak, no hot water, “I paid”, access | Outlook / Gmail / portal inbox | **Planned.** Demo holds an inbound card. Do not open mail until a named inbox. |
| **Day** | Maintenance classify, quote, tradie, owner cap | PMS jobs | **Classify only.** No dispatch. No Always-allow tradie. |
| **Day** | Inspections: Form 9 / entry notice, itinerary, report | Forms Live / PMS inspect app | **Not the walk.** Later same-clock kind: *due this week* + draft notice **wording**. Never invent the statutory clock. |
| **Rolling** | Lease expiry 90 days, rent review, renewal offer | PMS automations already | **Later kind** on the same clock. Draft offer. PM sends in PMS. |
| **Friday** | Owner catch-up | Owner portal / email | **Built.** Friday letter. Copy only. |
| **Event** | Vacate, exit report, bond claim | Trust + RTBA/RBO | **Never** move trust or lodge/claim. |
| **Anytime** | Portal screens the API cannot write | Their Chrome login | **Built.** Attach + Run beside me. Human Submit. Pay/sign/notice stay with them. |
| **Anytime** | Between inspections, not at a desk | Phone | **Built.** One digest + Allow/Deny on courtesy. Licensee cards stay Desk-only. |
| **Compliance** | Smoke alarm, pool, gas, water-efficiency dates | Spreadsheet / PMS | **Flag missing.** No law crawler. No Form 11 / NTV. |
| **Money** | Trust recon, owner disbursement, invoices | PMS trust | **Never.** |

## What we already cover (do not rebuild)

Shipped in this repo:

- Morning money evaluate → Desk cards → Allow / Deny / Edit / **Copy**
- Friday owner letter from Desk facts + Notes
- CSV match by address or property code; holds for partial / reversed / unmatched
- Ask → Desk (courtesy + paste a book)
- Phone Allow on courtesy; quiet-hour digest + durable receipts
- Attended portal (plan + Attach + Run beside me)
- You → This office (eight fields). Demo name does not count as live
- Worker pin, pack, Test hands. User chrome never says Hermes

**Ease already designed for a non-technical PM**

- Four places only: Desk · Ask · Schedule · You
- Named loops, not “create an automation”
- One Allow. Send is always 403
- Teach a job in English → plan approval → clock. No cron UI
- Copy into the PMS they already know

## What we should cover next (same job, same window)

Order is **minutes returned**, not architecture. Each row is a **kind on the existing clock**, not a new product.

1. **Named office + their CSV** — the only thing that makes morning money real. Human.
2. **Inbound triage (declared inbox)** — leak vs rent vs access vs noise. Draft reply. Create nothing in the PMS except a card. Needs the eight fields + a named inbox.
3. **Inspection-week admin** — “these addresses are due; here is the entry-notice wording to Copy.” PM still walks the house in their inspect app. Do not mint Form 9 as a legal act.
4. **Renewal / rent-review queue** — 90-day list from the export or a later PMS read. Draft the owner/tenant wording. PM sends.
5. **Maintenance classify → owner cap** — urgency + “over $X, ask the owner.” Still no tradie dispatch until a named office’s portal recipe exists.
6. **Compliance flags** — certificate dates on the book. Held chip. No crawler.

Stop after (1) until a real shop is on You → This office. (2)–(6) wait on that shop asking.

## What we will never cover (even if a PM asks)

- Send SMS/email/notice from RealBud
- Trust EFT, bond lodge/claim, owner disbursement
- Statutory notice as a legal instrument (Form 11, NTV, breach)
- Invented legal clocks
- Tenant-facing bot / WhatsApp to tenants
- Unattended browser, Always-allow, money/sign/notice Submit
- Sales listing CRM, home opens, application scoring as a product
- A second Bud, a law shelf, Hermes.app

Those are how you lose the licence-training story and the insurance.

## Non-technical use (the actual product)

A graduate PM should not need Terminal, a model name, or “CSV schema.”

| They should | We must not ask them to |
|---|---|
| Open RealBud. Desk is the morning. | Open Hermes, pick a model, paste a key in chat |
| Drop last night’s export (or Recheck). | Learn PropertyMe API / OAuth |
| Tap Allow on the phone between inspections | Sit at Desk for every courtesy |
| Copy the wording into the PMS and send there | Trust RealBud to send |
| Say “log in to the levy portal every Friday” once, Attach, Run beside me | Write a prompt or a cron |
| Type the agency name on You | Invent a shop so we can demo live |

**The remaining ease hole is not more chrome.** It is: a named book, a funded model key on You (never Ask), and quitting the old packaged binary so they run this tree. Worker install/pin mismatch still reads as engineering — keep that behind You → Worker, plain sentences only (`Missed`, `Install the pinned worker`).

## How this uses current infrastructure

| Infra already in the repo | PM job it serves |
|---|---|
| Desk evaluate + Copy | Morning arrears exception queue |
| Owner letter routine | Friday owner narrative |
| `parsePmsExport` | Sit on any PMS without an API |
| Notes isolated from evaluate | Learning loop without poisoning facts |
| Remote decisions + digest receipts | Allow from the car |
| Recipes + portal fence + Run beside me | Screens the API cannot write |
| Named loops + teach-a-job | Same clock for new kinds (inbound, inspection-week, renewals) |
| Send 403 + never-rules | Licence / insurance boundary |

Do not add a fifth nav place, a connector marketplace, or a PMS clone. Extend **kinds** when a named office’s export proves the morning.

## Sources

See the HTML board `Perso/realbud-pm-coverage-2026-09-04.html` for the cited industry figures. Product state is this repo, not those pages.
