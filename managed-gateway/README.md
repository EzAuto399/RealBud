# RealBud managed gateway

Off-device service with four jobs:

1. **Installation provisioning and revocation.** Each installation gets one Modelvia project and key, and one Composio connector device.
2. **Connectors** (`/v1/connectors/*`), for the desktop's managed Gmail read.
3. **Service entitlement.** Whether an office's RealBud service is active, which licence it holds, and its go-live and expiry dates.
4. **The monthly care fee.** One invoice per office and month from the commercial terms the office's billing owner accepted, collected automatically through Square.

**Modelvia is the only source of AI rates, caps, usage and AI invoices** (owner decision, [24 September 2026](../docs/decisions/2026-09-24-modelvia-sole-billing.md)). This service has no AI rate, usage, limit or model-forwarding route. A customer office's monthly invoice carries its finalized Modelvia customer invoices as "AI usage" lines at their exact totals (owner decision, [26 September 2026](../docs/decisions/2026-09-26-modelvia-commercial-terms.md)); the gateway prices no AI itself. It never loads into the desktop and never changes Hermes.

## Routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | liveness |
| `GET /ready` | none | 200 only when provisioning is composed; always reports `modelviaOperator` and `operatorAccess` (`configured\|missing`). The first is a legacy field name for local RealBud-scoped credential presence. Makes no network call |
| `POST /v1/portal/installations/provision` | portal bearer, `billing_owner` | needs an active entitlement and a ready Modelvia customer |
| `POST /v1/portal/installations/revoke` | portal bearer, `billing_owner` | no entitlement needed, so a lapsed office can still be shut off |
| `/v1/connectors/*` | connector credential | needs an active entitlement |
| `POST /v1/operator/offices/ai-access` | operator bearer, `realbud_operator` | sets one office's AI access at Modelvia: default A$200 monthly cap, a custom cap, or disabled ([DEPLOY.md](DEPLOY.md#office-ai-access)) |
| `GET /v1/portal/commercial-terms?period=YYYY-MM` | portal bearer | the month's published terms for the principal's office (`terms`, `digest`, `acceptance`), without markup basis points, plus `plan` (the office's billing plan in words, or null); publishes the office's plan months lazily first |
| `POST /v1/portal/commercial-terms/accept` | portal bearer, `billing_owner` | accepts exactly `{period, version, digest}`; for a month of a billing plan this accepts the plan version (every other month gets a standing acceptance) |
| `GET\|PUT /v1/operator/offices/billing-plan` | operator bearer | GET `?companyId=`: `{plan, acceptance: {state, acceptedAt}, months: [{period, version, careCents, aiBilled, included, state, invoiceId}], rollForward: {published, blocker}}`. PUT the plan without `version`: same content returns the current version, different content is a new version the owner must accept ([DEPLOY.md](DEPLOY.md#billing-plans-accept-once-roll-forward)) |
| `GET /v1/operator/billing/invoices` | operator bearer | every invoice, newest first (at most 500), with due date, paid and outstanding cents, `status` (`unpaid`, `part_paid`, `paid`, `overpaid`, `credit`, `nothing_due`), `overdue`/`daysOverdue` and every payment (Square and recorded) |
| `POST /v1/operator/billing/invoices/{id}/payments` | operator bearer | records a checked bank transfer, PayID or other payment `{paymentId (uuid), method, amountCents, receivedOn, reference?, note?}`; idempotent on `paymentId`; refused over the outstanding balance, for a future date, on a card-paid invoice, or on a credit/zero invoice |
| `POST /v1/operator/billing/invoices/{id}/payments/{paymentId}/reverse` | operator bearer | undoes a recorded payment with `{reason}` (appends a reversal, deletes nothing); Square payments are refunded through Square instead |
| `GET\|POST /v1/operator/billing/close` | operator bearer | GET `?period=YYYY-MM`: offices with terms or a billing plan, `closed`, `ready` or `blocked` with the reason (`terms_not_accepted`, `terms_version_ambiguous`, `plan_awaiting_owner`, `no_billing_plan`, or the code of a refused publication); publishes plan months lazily first. POST `{companyId, period, deferAi?}`: closes the month as `commercial-cli.ts close` does, resolving the accepted terms version itself; an included plan month closes as an A$0 Tax Invoice (`ai: included`); a closed month returns its invoice |
| `GET /v1/portal/invoices` | portal bearer | the office's invoices in `invoices`, each with a `paid` flag (Square settlement), `dueAt`, `status`, `overdue`, `paidCents` and `outstandingCents`, plus top-level `collectionMode` (`off`, `sandbox`, or `live`; mode alone does not make checkout available) and `paymentInstructions` (`payId`, `bank`, each null unless configured) |
| `GET /v1/portal/invoices/{id}` · `/document` · `/receipt` | portal bearer | one invoice as JSON, as printable HTML, or its settlement receipt (409 `payment_not_settled` until paid) |
| `POST /v1/portal/invoices/{id}/checkout` | portal bearer, `billing_owner` | one idempotent Square-hosted checkout for a collectible invoice (503 `payment_provider_unselected` in `local` mode) |
| `POST /v1/webhooks/square` | Square signature | payment and refund notifications; a trigger only, settlement is re-read from Square |
| `GET /v1/portal/hermios/plans` · `GET /v1/portal/hermios/terms?optionKey=&people=` | portal bearer | the operator's Hermios catalog (`hermios-catalog.json`) and, for one option and number of people, the exact terms and `digest` to accept |
| `GET /v1/portal/hermios/subscription` | portal bearer | `{optionKey, state, people, cadence, trialEndsAt, currentPeriodEnd, capability, hermiosLinked}`; `state` is `pending_payment`, `trialing`, `active`, `past_due` or `canceled` |
| `POST /v1/portal/hermios/subscription/start` · `/change` · `/cancel` | portal bearer, `billing_owner` | start `{optionKey, people, termsDigest, cardSourceId, verificationToken?}` (Square-hosted card token; 14-day trial with the card on file; idempotent per office); change `{optionKey, people, termsDigest}` (people now, cadence at period end); cancel `{}` (period end; no charge in the trial). 503 `hermios_subscriptions_unconfigured:REALBUD_HERMIOS_SUBSCRIPTIONS` until enabled |
| `GET /v1/operator/offices/hermios-subscription?companyId=` | operator bearer | every Hermios subscription record of the office with Square ids and accepted terms digests |
| `POST /v1/webhooks/square/subscriptions` | Square signature (`HERMIOS_SQUARE_*`) | subscription and invoice notifications; stored once by event id, state re-read from Square; past due is a flag only |

Every other path returns 404: `/v1/portal/usage`, `/v1/portal/rates`, `/v1/portal/rates/accept`, `/v1/portal/limits`, `/v1/model/stream` and the local payment webhooks are gone. The error codes that tell an operator what to fix:

- `tenant_unavailable` (403): the company has no entitlement. Create one with the entitlement command.
- `service_unavailable` (402): the entitlement is inactive, expired, or not yet live.
- `modelvia_customer_not_ready` (409): the office's Modelvia customer is missing, inactive, under another client, or has a zero monthly cap. Set it with the office AI access route.
- `modelvia_customer_foreign` (409): the Modelvia customer id belongs to another platform client. Nothing was written.
- `modelvia_billing_binding_operator_required` (409): a new customer-paid office needs a one-time billing-company binding by a Modelvia global operator. Verify the exact office binding, then retry this RealBud operation; see [DEPLOY.md](DEPLOY.md#global-secret-cutover).
- `modelvia_billing_account_bound` (409): the existing Modelvia customer belongs to a different billing company. Review its immutable binding before any retry.
- `operator_unauthenticated` (401) / `operator_unconfigured` (503): no valid operator bearer, or the operator secret or Modelvia operator variables are not set.
- `commercial_terms_unavailable` (503): `REALBUD_INTERNAL_COMPANY_ID` is not set, so no office can be told apart from RealBud's own account.
- `commercial_terms_missing` (404) / `commercial_terms_not_accepted` (409): publish the month's terms, then the billing owner accepts them.
- `square_mapping_required` (409): record the office's Square customer mapping with the commercial command.
- `internal_usage_not_billable` (403): the company is RealBud's own account and is never invoiced.
- `payment_exceeds_outstanding`, `invoice_already_paid`, `nothing_to_pay`, `payment_conflict`, `reversal_conflict`, `square_payment_not_reversible` (409), `invalid_received_on` (400): a payment record or undo the desk refused; nothing was written.
- `balance_payable_by_transfer` (409): a transfer is recorded against the invoice, so card checkout is off; the balance is paid by transfer.
- `terms_not_accepted` / `terms_version_ambiguous` (409): the office has not accepted the month's current terms; publish or have the billing owner accept, then close.

The installation project copies the Modelvia customer's caps at provisioning. Its monthly cap and concurrency are the customer's; its request cap is `REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD` (default A$1), never above the monthly cap. After the customer's caps change, `caps-cli.ts apply --company <id>` (`pnpm run caps`) re-applies them to every ready installation. Cap fields stored in the ledger are legacy and drive nothing.

## Service entitlement (operator)

Run on the service machine only. The command opens the same database as the server (`$REALBUD_GATEWAY_DATA/ledger.sqlite`, default `./data`). The database must already exist: start the server once first.

```sh
cd managed-gateway
node --experimental-strip-types entitlement-cli.ts set --company <companyId> --evidence <ticket> \
  --license <licenseId> --name "<legal name>" --address "<address>" \
  --go-live 2026-09-01 --go-live-evidence <signed-order-ref> --expires 2027-09-01
node --experimental-strip-types entitlement-cli.ts set --company <companyId> --evidence <ticket> --active false
node --experimental-strip-types entitlement-cli.ts get --company <companyId>
```

On an existing company, `set` changes only the fields you pass. The licence cannot change after creation. Output is one JSON line with no secrets. `pnpm entitlement …` runs the same command.

## Monthly office invoice (operator)

The same machine and database, with `REALBUD_INTERNAL_COMPANY_ID` set to RealBud's own company id (never invoiced). Full sequence and the Square variables: [DEPLOY.md](DEPLOY.md#care-fee-collection-square).

```sh
node --experimental-strip-types commercial-cli.ts publish reviewed-terms.json      # month, seller, customer, care cents, optional billingEmail and AI resale; sends nothing
node --experimental-strip-types commercial-cli.ts map reviewed-square-mapping.json # office's Square customer; calls nothing
node --experimental-strip-types commercial-cli.ts close <companyId> <YYYY-MM> <termsVersion>  # one office invoice after the month; optional email after close
node --experimental-strip-types commercial-cli.ts email-list <companyId>           # bounded delivery-state readback, no recipient printed
node --experimental-strip-types commercial-cli.ts email-deliver <companyId> <invoiceId>  # explicitly retry one invoice
node --experimental-strip-types commercial-cli.ts email-repair-auth <companyId> <invoiceId> <reviewReference>  # audited first 401/403 repair; sends nothing
node --experimental-strip-types commercial-cli.ts credit <companyId> <invoiceId> <creditId> <cents> <reason>  # carried to the next invoice
```

A billing plan (`PUT /v1/operator/offices/billing-plan`) replaces the monthly `publish` for an office: the gateway publishes each month's terms from the plan and the billing owner accepts once ([DEPLOY.md](DEPLOY.md#billing-plans-accept-once-roll-forward)); the seller basis comes from `REALBUD_SELLER_*`, `REALBUD_TAX_TREATMENT_REF`, `REALBUD_CUSTOMER_TERMS_REF` and `REALBUD_CARE_AGREEMENT_REF`. The admin desk closes a month through `POST /v1/operator/billing/close` with the same checks and records transfer/PayID payments (owner decision [2026-09-29](../docs/decisions/2026-09-29-operator-billing.md)). Invoices are due `REALBUD_INVOICE_TERMS_DAYS` days after issue (default 7; 0 to 365); an older invoice that recorded no due date, or the issue time, is read as issue plus that many days. Non-payment is flagged as overdue only; nothing pauses an office. How offices pay by transfer is printed on the invoice and returned with the portal invoice list from `REALBUD_PAYID` and `REALBUD_PAYID_NAME` (both needed), and `REALBUD_BANK_ACCOUNT_NAME`, `REALBUD_BANK_BSB` (6 digits) and `REALBUD_BANK_ACCOUNT_NUMBER` (4 to 10 digits, all three needed); a part left unset or malformed is shown as none.

The terms' `rateCards` list is normally empty: Modelvia sets AI prices. One closed RealBud invoice per office contains the accepted care fee and credits plus the exact lines of finalized Modelvia customer invoices when that office accepted AI resale. Modelvia's finalization can hold up close; the gateway's older AI usage tables cannot. Optional `customer.billingEmail` is bound to the accepted terms. Email mode is off by default; a configured close attempts delivery, and the server retries recent queued or uncertain attempts. See [DEPLOY.md](DEPLOY.md#care-fee-collection-square) for recipient review, exit codes, retry limits, old queued invoices and auth repair.

## Run and test locally

Node 24+ with `node:sqlite`.

```sh
pnpm exec tsc -p managed-gateway/tsconfig.json
cd managed-gateway && node --experimental-strip-types --test ./*.test.ts
node --experimental-strip-types sandbox-smoke.ts   # offline provisioning smoke against fakes
```

The root `pnpm test` does not include this service. Every fixture here is synthetic. A passing fake is never evidence that a real Composio, Modelvia or Square account was used.

## Modules

| Module | Responsibility |
| --- | --- |
| `http.ts`, `server.ts`, `composition.ts` | Route set above; production composition from env, including care collection. Connectors read office project keys from the same secret store provisioning writes |
| `provisioning.ts`, `provision-connector.mjs` | Installation provisioning and revocation; connector registry CLI |
| `modelvia-keys.ts` | Modelvia operator client: customer read and write (own client only), project, key, rotate, revoke |
| `office-ai-access.ts`, `operator-token.ts` | Operator office AI access route and its own operator bearer |
| `composio-org.ts`, `connectors.ts` | Composio org client; connector broker |
| `entitlement-cli.ts`, `local-env.ts` | Operator entitlement command; shared `.env.local` and database path |
| `commercial-terms.ts`, `billing.ts`, `office-ai-billing.ts`, `invoice-html.ts` | Accepted monthly office terms; one office invoice with care and finalized Modelvia AI lines; credits, receipts, due date and payment standing, and printable document |
| `operator-billing.ts` | Operator billing desk: invoice list with standing, recorded transfer/PayID payments and their reversals (append-only), month close from the desk |
| `billing-plans.ts` | Billing plans (accept once, roll forward): append-only plan versions, terms published from the plan with standing acceptances, absorbed included months, the portal presentation without basis points |
| `invoice-email.ts`, `commercial-cli.ts` | Digest-bound invoice email outbox, bounded delivery and recovery; operator close, email-list, email-deliver and email-repair-auth commands |
| `square-payment.ts`, `square-mapping.ts` | Square-hosted checkout, signed webhook verification and refunds; the per-office Square customer mapping |
| `hermios-plans.ts`, `hermios-catalog.json`, `hermios-square-catalog.ts`, `office-subscriptions.ts`, `square-subscriptions.ts` | Hermios plan catalog (data), the operator command that creates it in Square's Catalog, the office subscription record and its Square adapter (local fake in `local` mode) |
| `database.ts`, `ledger.ts` | SQLite ledger: entitlements, terms, invoices, payments, audit chain. Older AI-usage tables stay in the schema, readable and unused |
| `gateway.ts`, `auth.ts`, `direct-provider.ts`, `messages.ts`, `attempts.ts` | Earlier model-forwarding core. Not composed by `server.ts`; kept with its tests ([PHASE2.md](PHASE2.md)) |

Deployment is described in [DEPLOY.md](DEPLOY.md). It is a separate authority and never runs from a coding session.
