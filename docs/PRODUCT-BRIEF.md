# Product brief — vertical PM agent (not a PMS)

Date: 2026-08-15
Status: research complete, wedge not yet locked
Repo: `EzAuto399/RealBud` (OpenMausBot fork, product name RealBud)
Related: `/Users/yoda/projects/Property` (Challis Dickson listing portal)

## Verdict

Build a **supervised property-manager assistant** that sits **on top of** the agency’s existing PMS (PropertyMe / Property Tree / Reapit PM). Do **not** replace trust accounting. Do **not** rebrand this product as PropertyMe. Do **not** fork Hermes Agent as “our OS.”

The job is: take hours off a licensed-adjacent PM without ever pressing **Send** on a statutory notice or **Pay** on a trust withdrawal.

## Who this is for

**GTM (2026-08-17):** sell through a **licence-training provider** to people who have just passed their real-estate licence. First job may be sales, leasing, PM, or a bit of all three. The product must feel like professional software they can install, not a developer agent OS.

**Day-one user:** newly licensed AU agent (or their first agency desk).  
**Economic buyer later:** principal / rent-roll owner, or the training partner bundling seats.

Not: DIY landlords, US multifamily, a full PMS replacement, a trust-accounting company.

**Stack lock:** this repo is **RealBud** (OpenMausBot fork). RealBud owns the window. Hermes is a **pinned headless worker** (`hermes -p property` / ACP / cron). Do not launch Hermes.app. Do not fork or edit Hermes source. Do not use OpenManus (different project).

Legal metaphor that should drive the UX: the product is an **unregistered assistant**. It may prepare, remind, draft, file, and escalate. It may not sign, pay, or bind the agency.

## What a PM actually does (compressed)

Daily: bank/receipting, arrears widget, overnight jobs, unallocated money, interrupt-driven tenant/owner/tradie comms.

Weekly: inspection notices + field day, formal arrears notices, 60–90 day lease-expiry list, advertising if vacant.

Monthly: trust reconcile, disbursements, owner statements, compliance sweep.

Ad-hoc: vacates, bonds, tribunal, new managements, storms, hardship.

The work that *destroys* the week is the interrupt layer, not the happy-path automation the PMS already sells.

## What incumbents already ate

PropertyMe (6,400 agencies, 1.9M properties, EQT-backed) already ships AiMe: arrears automations, Reply with AiMe, Bills AI, lease-renewal automations, inspection reminders, task templates, owner/tenant portals. Property Tree has Alex AI. Tapi owns maintenance dispatch. Claire/Propic own generalist PM chat.

If the first demo is “we check rent and send a reminder,” a PropertyMe AE ends the meeting.

Public PropertyMe API (see [PyPropertyMe](https://pypropertyme.garyj.dev/)) is **mostly read-only** for typical scopes: contacts, properties, tenancies, balances, tasks, inspections, jobs. Sending payment notices and writing comments/docs usually still happens in the portal.

## Recommended wedge

**Owner-retention cadence + exception inbox.**

Every owner gets a truthful weekly or monthly update drafted from the PMS (rent status, open jobs, upcoming inspections/renewals, money in/out), sent on-brand after the PM taps Allow, logged to the file. Same loop drafts replies to inbound tenant/owner mail and creates the Job/task so nothing is unlogged.

Why this, not “full PM OS”:

- User already named weekly/monthly client catch-up as a goal.
- Portals are pull. Owners want push. Owner churn is a rent-roll valuation event.
- Trust risk is low if we only read + draft + log.
- Arrears *courtesy* SMS and repair *triage* can ride along. Statutory Form 11 / NSW termination / VIC NTV and tradie dispatch stay out of v1 send-path.
- Tapi already owns “handle the repair end-to-end.” We classify, draft the owner approval, and chase — we do not become a tradie marketplace.

### Explicit anti-goals (v1)

- No trust EFT, disbursement, or “fix the recon.”
- No auto-send of Form 11/12, NSW termination, VIC Notice to Vacate, rent-increase notices, entry notices.
- No TICA listings, lock changes, or legal advice.
- No inspection app, no payments licence, no PMS replacement.
- Do not ship under the name **PropertyMe** (incumbent trademark).

## Stack decision

```
Visible window: this repo — Desk, Copy/Approve, walkthrough
Headless worker: pinned Hermes profile `property` (CLI / ACP). Clock is RealBud; Hermes `cron_mode: deny`. Never Hermes.app.
System of record: the agency PMS (read API + human-gated portal actions)
Domain seed: /Users/yoda/projects/Property MCP (listings, applications, inspections)
```

### Hermes — use, do not “own”

- MIT (Copyright Nous Research 2025). We may copy, modify, and sell **code**. We may not take the Hermes name, logo, or Desktop as our product.
- Pinned worker: **v0.20.3** (`v2026.8.16.2`, commit `7339f5f160db5c96657a3bab60151227cc61f66c`) in `server/hermes-pin.ts`. We do not follow `main`. Bump the pin when we choose to.
- Velocity is the killer: ~1,400 PRs in a single minor. A rebranded fork dies in a month.
- Nous Portal is optional, not required. Force `approvals.mode: manual` for anything PM.
- Seam: `server/drivers/acp/hermes.ts`. Profile: `hermes -p property` so it does not share personal `~/.hermes` memory.
- Keep [EzAuto399/hermes-installer](https://github.com/EzAuto399/hermes-installer) as machine bootstrap only.

OpenMausBot routines are **real** (`server/routines.ts` + `src/components/RoutinesPage.tsx`). README’s “routines are a placeholder” is stale. Approvals, Composio (Claude only), and Chief of Staff are real. Custom MCP mount is **not** — Property MCP cannot be attached without new glue.

## First three surfaces (build order)

1. **Morning brief + owner Friday letter** — routine reads PMS balances/jobs/inspections (or CSV/export for a pilot) and drafts; PM approves send.
2. **Inbound triage** — classify repair vs rent vs access vs complaint; create Job/task; draft reply; never lose the timestamp.
3. **Portal assist (human in the loop)** — for payment notices and work-order updates the API cannot write, drive the logged-in PMS UI or fill Forms Live, then wait for Allow.

Dogfood path if we do not have an agency yet: the existing Dickson listing portal (`/Users/yoda/projects/Property`) already has enquiries, applications, and inspection bookings + MCP. Use that as the first system of record, then add PropertyMe OAuth read.

## Hard gates (never auto)

- Trust withdrawals (NSW: licensee-in-charge only, cannot delegate).
- Statutory notices (must be written, signed, correct clock — one early day voids insurance).
- Bond lodge/claim except through the state authority.
- Publishing interior photos of tenant belongings.
- Back-dating a maintenance request or a notice.

## Open questions (need a human)

1. First customer: a named agency PM, the Dickson owner book, or “we will sell later”?
2. First PMS: PropertyMe, Property Tree, or no PMS (CSV + Gmail only)?
3. Product name (cannot stay PropertyMe).
