# Hermios plans and checkout in the RealBud console — 1 October 2026

Status: spec. Evidence tier for current-state facts: source and document reads (RealBud `website/`, `managed-gateway/`, `hermios-realbud-modules`, salesfren proposal, Codex session conclusions). No live Square, Hermios or Modelvia action has been taken.

## Owner decisions (1 Oct 2026)

- **Payments:** Square subscriptions (reuse the existing Square integration and account).
- **Price basis:** A$, GST inclusive (matches RB invoices and `composeBillingPlanConfig`: AUD, GST 10%).
- **Shape:** one Hermios plan for an office of 3 plus extra seats; also a higher-priced RealBud + Hermios bundle.
- **Trial:** 14 days, card upfront.
- **Audience:** existing RealBud customers buy inside their own console account and connect Hermios in their own RealBud installation. RealBud sign-up stays invite-only.

## Prices (owner decision 2 Oct 2026, supersedes the A$20 and A$49 proposals)

| Plan | Price (A$ incl GST) | Includes |
|---|---|---|
| Per person (list, anchor) | A$49 / person / month | Hermios CRM connected to RealBud and Bud |
| **Office pack — Best value** | **A$129 / month** for 3 people (save A$18/month vs per-person) | Hermios workspace, 3 people |
| Extra person (on the Office pack) | A$39 / month each | — |
| Pay yearly | **A$1,290 / year** for the Office pack (2 months free) | Same as Office pack |
| **RealBud + Hermios bundle** | RealBud care fee + **A$99** for 3 people (save A$360 a year vs the Office pack) | Everything above on one RB invoice; extra people A$39 |

Conversion structure: the per-person list price anchors; the Office pack is the default and marked Best value; yearly shows "2 months free"; the bundle shows its annual saving. Ex GST the Office pack is A$117.27/month against ~A$34/month of shared Hermios infrastructure today (Square card fees not yet included). AI usage is **not** in these plans: Modelvia stays the sole source of AI rates and usage (resale line on the RB invoice, unchanged).

## Hermios workspace limit — licence finding (2 Oct 2026, not legal advice)

The cap (`MAX_WORKSPACES_WITHOUT_ENTERPRISE_KEY = 5`) is enforced in `auth/services/sign-in-up.service.ts` and its constants file, both AGPLv3. The key check it consults, `enterprise/services/enterprise-plan.service.ts`, is `/* @license Enterprise */` (Twenty Commercial License: no production use without a Twenty Enterprise subscription; modifications remain Twenty's). Licence-respecting route: remove or make configurable the cap in the AGPL files only; do not forge a key or modify/rely on Enterprise-licensed files in production; publish the modified source to network users (AGPLv3 §13); keep Twenty's Enterprise-only features (billing, SSO, etc.) off unless licensed. Hermios coordinator owns the change.

## Conversion design (console)

- **Placement:** the offer appears where the need is felt — Desk → Hermios tab and the featured Connected apps tile in the app ("Get Hermios for your office" → console), and `/account` in the console. A public `/pricing` section can follow; sign-up stays invite-only.
- **Anchoring and default:** show the bundle beside standalone with the saving stated; mark one option "Most popular"; seat stepper defaults to 3 with the per-person equivalent shown.
- **Risk reversal:** "14 days free. Cancel any time before day 14 and you won't be charged." Reminder email 3 days before the first charge. Only claim data export once the export-after-cancel policy is decided.
- **Momentum:** after payment, a 3-step checklist with progress (Create your Hermios workspace → Connect Bud in RealBud → Invite your team), each step one primary action; deep link back to the RealBud app.
- **Proof and clarity:** concrete outcomes for a property office (records beside your work, Bud prepares follow-ups, you approve changes); plain AUD incl GST; no dark patterns (no pre-ticked add-ons, no hidden renewal, cancel is as easy as start).

## Architecture

**managed-gateway (billing authority)**
- Versioned plan catalog (operator-defined): product id, capability keys (`hermios.crm`), included seats, price cents incl GST, extra-seat cents, trial days, terms reference. Prices never come from the browser.
- Square subscription adapter (Subscriptions + Catalog + Customers + Cards on file) under the existing collection modes (`local` / `sandbox` / `live`, live gated by `REALBUD_AUTHORIZE_COLLECTION` and the seller-basis digest). Card captured at trial start via Square's hosted flow; card data never touches RealBud.
- Verified Square webhooks (signature, idempotent event store) → subscription state (`trialing`, `active`, `past_due`, `canceled`) → office capability `hermios.crm` with seats. Non-payment flags only; the operator decides on pausing (existing policy). Never delete or uninstall CRM data from a webhook.
- New terms reference for the Hermios subscription; owner acceptance recorded like office terms (re-accept on price/terms change).

**website (console)**
- `/account/hermios`: plan cards, seat stepper, terms acceptance, Square checkout, success → setup checklist; subscription status, change seats, cancel.
- Billing-owner only for purchase; any office member can see status.

**RealBud app**
- Not connected + no subscription → "Get Hermios for your office" opens the console page. Subscription present → "Connect Bud to your Hermios" (built).
- After OAuth, the app reports the verified Hermios membership to the gateway so the office's subscription is linked to that workspace (one billing owner; no double charge — Hermios billing stays off).

**Hermios (coordinator session)**
- Stage 1 (now): buyer creates the workspace through Hermios sign-up (they become its admin); RealBud links via OAuth.
- Stage 2 (automated provisioning): partner endpoint to create/activate a workspace and assign the buyer as admin without their session; partner grant source + `billingOwner: realbud`; RealBud service principal (separate from `WorkspaceModuleAdminGuard`); idempotency by RealBud company + purchase id; `get_hermios_profile` returns a stable workspace id.
- **Workspace cap:** owner chose the fork change (2 Oct). See the licence finding above. Twenty's own Stripe billing (`@license Enterprise`) stays off.

## Build order

1. Gateway catalog + Square subscription adapter + webhooks in **sandbox** (RealBud).
2. Console `/account/hermios` with design pass (Astra) and checklist (RealBud).
3. App upsell + subscription-aware connect state (RealBud).
4. Hermios partner provisioning and cap decision (Hermios coordinator).
5. Live: owner creates Square subscription plans/keys, sets live collection, accepts terms; first paid office.

## Partnership and websites (owner request 2 Oct 2026)

- **realbud.app:** a "RealBud × Hermios" section on the home page and a partnership page: what the office gets together (CRM records beside daily work, Bud prepares follow-ups, approvals stay with the person, one invoice), pricing, and a clear path for existing customers (sign in → Account → Hermios). Sign-up stays invite-only; new offices use the pilot enquiry.
- **hermios.app (Hermios coordinator):** a reciprocal "Works with RealBud" page linking to realbud.app.
- **In the RealBud app:** "Get Hermios for your office" in the Hermios tab and Connected apps tile.

## Square setup for Hermios

A dedicated Square catalog for Hermios (owner creates it, or the gateway creates it through the Catalog API in sandbox and then live once the owner sets keys on the gateway): subscription plan "Hermios CRM" with variations: Office pack monthly (A$129 incl GST for 3 people) plus extra-person quantity (A$39 each), Office pack yearly (A$1,290), per-person list (A$49) for display/anchoring, a 14-day free trial phase, and the bundle add-on (A$99 for 3) billed with the RB invoice. Webhook subscription for subscription and invoice events to the gateway. Keys never pass through Claude or Bud.
