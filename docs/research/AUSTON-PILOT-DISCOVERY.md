# Auston Realty pilot discovery

Date checked: 2026-08-28  
Status: public discovery only; no agency account, system, consent or workflow is connected

This file is external research material. It must not be imported by the app,
projected as a configured agency or used to satisfy any pilot field. Runtime
state comes only from the code-owned pilot contract and fresh account receipts.

## Decision

Treat Auston Realty as RealBud's first named design-partner candidate, not as a hard-coded product template. RealBud should standardise the repeated property-management jobs and admit an exact adapter for the office's named system. It should not promise that an arbitrary Australian website is supported merely because Bud can open a browser.

The implementation therefore uses seven portable system families and a strict route order:

```text
structured export/API
→ restricted named connector
→ code-owned browser recipe
→ bounded CUA handoff
```

The earlier route wins when it can complete the named job. Public research never creates login authority, execution readiness or a legal deadline.

## What the public evidence supports

| Observation | Evidence | Confidence | Product implication |
|---|---|---:|---|
| Auston offers leasing and property-management services alongside sales and investment work | [Auston Realty](https://austonrealty.com.au/) | High | The three proposed shadow workflows are relevant discovery candidates. |
| The public team page includes a property-management role | [About Auston Realty](https://austonrealty.com.au/about/) | High | A named working PM and principal still need direct confirmation. Do not copy a public staff name into the pilot contract. |
| The public office and property signals are Queensland-focused | [Auston properties](https://austonrealty.com.au/properties/) | Medium | Start the jurisdiction interview with Queensland; do not infer the managed book is QLD-only. |
| The operating software and accounts are not disclosed publicly | Public pages reviewed above | High | PMS, exporter, bank, mailbox/calendar, office OS and vendor test account remain unknown. |

## Eight fields to confirm with the office

The visit must fill the code-owned contract in `server/pilot-contract.ts`; this document is not a substitute.

1. Agency, principal and the one PM who will use RealBud day to day.
2. PMS brand and exact product/edition.
3. Person authorised and able to produce the read-only export.
4. Export cadence and the office's useful freshness limit.
5. Stable property identity in the export.
6. Installed office operating system and version.
7. States or territories represented in the managed book.
8. One approved non-production vendor/portal account for login, MFA, expiry, revocation and human-Submit proof.

Also name the read-only bank-evidence account, inbox/calendar provider and approved Pocket channel separately. Passwords, MFA material, account numbers, cookies and raw message content do not belong in this document, Desk, Ask, logs or support reports.

## First three shadow workflows

| Workflow | Baseline to observe | RealBud target | Boundary |
|---|---|---|---|
| Morning money | Time, records, exports, bank views, discrepancies and rework | Batch the current PMS export, corroborate only approved credits, then show exceptions and courtesy drafts | PMS stays money authority; bank absence never proves non-payment; no transfer, allocation, pay or send |
| Inbox and maintenance | Inbox volume, emergency path, property matching, owner/tradie handoff and follow-up | Classify, link evidence, prepare a reply and own the next check | Read scope first; attachments quarantined; reply/dispatch waits for review and human action |
| Tenancy dates | Trusted lease/inspection fields, shop cadence and missed follow-ups | Surface confirmed upcoming work and prepare a checklist/draft | No invented statutory clock, notice or legal advice; licensed person owns formal action |

For each workflow capture elapsed time, systems opened, records checked, interruptions, follow-ups and error/rework points. Success is fewer system visits and manual checks, recovered follow-ups, accepted exception precision and PM time returned—not model or tool-call volume.

## Australian system-family coverage

This is a recognition and routing catalog, not a claim that each connector is live.

| Family | Recognised examples | What the named adapter must prove |
|---|---|---|
| PMS and rent roll | [PropertyMe](https://www.propertyme.com.au/features), [MRI Property Tree](https://www.mrisoftware.com/au/products/property-tree/), [Reapit PM](https://www.console.com.au/), [Managed](https://managedapp.com.au/) and other named PMS products | Export/API scope, stable identity, freshness, account, revocation, retry and partial-result handling |
| Read-only bank evidence | Agency-named bank | Approved test account, manual login/MFA, exact recent-credit view, expiry/rate limits/revocation and structurally absent transfer/payee routes |
| Inbox and calendar | Microsoft 365, Google Workspace or another named provider | One account, minimum read scopes, attachment quarantine, disconnect/recovery and draft-only handoff |
| Leasing and inspections | PMS-native workflow, InspectRealEstate, Inspection Express or another named portal | Trusted dates, SSO/MFA, layout/read-back, cancellation and licensed-person boundary |
| Maintenance and compliance | PMS-native maintenance, Tapi, ServiceM8 or another approved vendor | Urgency rules, owner limits, vendor identity, attachments and human dispatch/Submit |
| Listings, enquiries and BDM | [REA Partner Platform](https://partner.realestate.com.au/integrations/overview/), agency CRM or authorised lead provider | Agency delegation, exact scopes, stable listing/contact identity, revocation and no unauthorised scraping |
| PM Pocket | Official WhatsApp Business Cloud and Telegram adapters | Exact named PM, agency privacy approval, dedicated channel, restart, stale decision, ambiguity and disable/re-enable proof |

Vendor ecosystems support this adapter-first approach: PropertyMe publishes an integrations ecosystem; MRI and Reapit publish partner/API platforms; REA requires agency authorisation and scopes. Those facts are counter-evidence to a universal login or scraper. An integration must be installed for the exact customer and remain revocable; a recognised logo is not a connection receipt.

## Jurisdiction and legal-source rule

Australian residential tenancy work is not one national clock. Configure the actual book jurisdictions and verify risk-sensitive facts against current official sources such as the [Queensland Residential Tenancies Authority legislation index](https://www.rta.qld.gov.au/about-us/legislation) or [NSW Fair Trading property-management guidance](https://www.fairtrading.nsw.gov.au/housing-and-property/property-professionals/managing-a-property). Store source, title, jurisdiction, checked time and the fact verified. Official-source checking may flag a licensed-person review; it never enables statutory drafting or lets Bud invent a deadline.

## Pilot visit exit

The visit is complete only when all eight contract fields and the three workflow baselines have named evidence. After that, choose the smallest adapter needed for the first shadow workflow, exercise it against an approved account, and record auth, expiry, revocation, retries, stale/partial data and recovery. Only a fresh installed shadow run can move an individual capability from pilot-gated to proven for that office.
