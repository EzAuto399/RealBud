# Property intake, CUA interaction, UX and pricing research

Date: 2026-08-28  
Status: product reference only; not runtime customer, account, connection or release evidence

## Decision

RealBud asks **where the portfolio lives**, not which obscure file format the PM understands. The product presents the safest available route in this order:

1. current structured PMS export/report for the complete book and current money authority;
2. explicitly selected spreadsheet, PDF, document, screenshot or photo for staged property intake;
3. paste/manual entry for a small book or gaps;
4. one named read-only PMS API or restricted connector after pilot proof;
5. a RealBud-owned private browser recipe, then bounded CUA, only where the safer routes cannot cover the named task.

Cloud remains an optional accelerator. It does not unlock an outcome that local RealBud cannot represent safely.

## How Australian property data is commonly held

The authoritative rent roll normally lives inside a property-management system as linked property, ownership, tenancy, contact, financial and workflow records. It is then exported or shared through several surrounding channels rather than one universal file:

- PropertyMe documents bank-statement and reconciliation imports including OFX, QIF and CSV, and publishes an integration ecosystem for property/contact sync: [reconciliation](https://www.propertyme.com.au/features/reconciliation), [integrations](https://www.propertyme.com.au/integrations).
- MRI Property Tree describes property, ownership and tenancy profiles, maintenance, inspections, invoices, workflows and reporting, with migration/testing as an explicit onboarding phase: [Property Tree](https://www.mrisoftware.com/au/products/property-tree/), [migration readiness](https://www.mrisoftware.com/au/products/property-tree/get-me-ready/).
- Reapit/Console exposes portfolio dashboards and reports around arrears, inspections, renewals, maintenance and vacancies: [Console Cloud](https://www.console.com.au/cloud).
- Managed positions the rent roll alongside payment and partner integrations and supports migration from common Australian PMS products: [Managed for agencies](https://managedapp.com.au/agencies).
- InspectRealEstate documents XML listing feeds and database/API integration as well as exported property/key and lead/landlord data during onboarding: [listing providers](https://agent.inspectrealestate.com.au/contact-us/our-listing-providers/).

Implication: “connect the book” must not mean “upload one CSV forever.” CSV is the verified current RealBud money route today; other selected evidence can build the book now, while a named API, restricted connector or private browser recipe is a pilot adapter—not a generic marketplace promise.

## Computer-use reference

The referenced Modal computer-use project demonstrates useful implementation patterns: keep one owned desktop/session warm, reuse a pooled control connection, batch deterministic input actions and return the immediate screenshot with the action result. Its own documentation says the figures measure warm operations and are not a universal latency promise; model reasoning, cold allocation, authentication and recovery must be measured separately: [modal-computer-use](https://github.com/ashtonchew/modal-computer-use), [package documentation](https://pypi.org/project/modal-computer-use/).

RealBud therefore keeps its existing provider-neutral work receipts and adopts these design rules for future browser/CUA adapters:

- reuse an authenticated, case-scoped RealBud-owned session where policy permits;
- batch deterministic clicks/typing instead of asking the model to rediscover each step;
- bind the result and immediate screenshot/read-back to one receipt;
- benchmark cold start, warm action, model time, portal response, retry and recovery separately;
- never expose the daemon, clipboard, personal browser, arbitrary screen or raw computer tools to Bud.

This research does **not** add Modal, replace the pinned CUA runtime or prove a live vendor workflow. General-purpose screen control still struggles on specialised enterprise tasks; the referenced author likewise argues for human checkpoints in high-stakes work: [The Screen Is the API](https://ashtonchew.com/blog/the-screen-is-the-api/).

## UI reference

The referenced UI collection post is useful as a method: compose from proven interaction patterns, then simplify and adapt them to the product rather than inventing novelty. RealBud applies that by using ranked route cards, clear status labels, one real action per row, compact disclosures and restrained motion. Motion explains a state transition; it does not decorate every click. This matches the broader guidance that interfaces often need fewer animations, not more: [You Don't Need Animations](https://emilkowal.ski/ui/you-dont-need-animations).

The four-place navigation remains unchanged. Import methods live inside Ask, Desk Book and You → Connections; no marketplace or fifth surface is introduced.

## Pricing and billing direction

RealBud must not price or present value in model tokens. Tokens remain private diagnostics for BYOK provider usage. The future commercial model should be:

- a simple base subscription expressed in a PM-recognisable unit such as one PM and a portfolio band;
- included local capacity for normal Desk/book/routine use;
- optional metered cloud/browser acceleration quoted before the run in recognisable completed work, such as records checked or portal checks completed, with a visible cap;
- BYOK model spend kept separate and authoritative in the model provider account.

No price or checkout is added before named-pilot willingness-to-pay and real cost receipts exist. The current app truthfully says pricing is not configured and acceleration is not connected or charged.

This direction follows the value-layer argument in [a16z: You Are Not a Model—Don't Price Per Token](https://a16z.com/you-are-not-a-model-dont-price-per-token/) while retaining its counter-warning: a poorly defined “credit” is merely an opaque token. Stripe similarly recommends a metric that scales with customer value, is legible before signup and is reliably measurable, and suggests beginning with a simple or hybrid model: [usage-based SaaS pricing](https://stripe.com/resources/more/usage-based-pricing-strategy-for-saas), [AI pricing models](https://stripe.com/en-ca/resources/more/ai-pricing-models).

## Privacy and data-integrity constraints

Intake remains explicit-selection only. RealBud does not scan the PM's device, personal browser or personal worker profile. It keeps source accuracy/freshness visible, minimises retained data and treats provider/cloud access as a separate security boundary. These choices align with the Australian Privacy Principles on data quality and security, including accuracy, protection and destruction/de-identification when data is no longer needed: [OAIC APP quick reference](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-quick-reference), [OAIC APP 11](https://www.oaic.gov.au/privacy/australian-privacy-principles-guidelines/chapter-11-app-11-security-of-personal-information).

## What this changes now

- Ask presents all four intake choices and routes each working button to its real owner.
- Desk Book makes the authoritative PMS CSV refresh prominent and routes other formats back to Ask.
- You → Connections exposes selected evidence and paste/manual as active methods, with direct API and private PMS browser as pilot-gated methods.
- Usage & costs separates provider-billed BYOK use, unpriced local work and unconnected future acceleration without inventing spend or prices.

## Remaining proof

- the named office's actual PMS/export dialect and stable identity column;
- live paid-model spreadsheet/image extraction;
- a named read-only PMS/API account or private-browser recipe only if export pain warrants it;
- installed, authenticated, interrupted and recovery tests for that exact account;
- measured PM time/touch reduction and real unit economics before commercial pricing.
