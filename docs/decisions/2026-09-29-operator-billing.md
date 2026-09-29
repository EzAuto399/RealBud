# Operator billing: collect, record and follow up client invoices (owner decision, 2026-09-29)

Supersedes the "no manual payment-reconciliation API" line in `website/docs/AI-PLATFORM-BILLING.md` for **RealBud service invoices** (`RB-…`). It does not change how Modelvia's own `CI-…` invoices are read or collected.

## Owner decisions

- RealBud is the operator. Modelvia bills RealBud wholesale for each office's AI usage. The client's bill is the **RealBud invoice** (`RB-…`): care line plus the AI usage lines from Modelvia's finalized month, with RealBud's margin. Clients never see wholesale cost, basis points or margin.
- Clients pay by **bank transfer**, **PayID** (`0455123764`) or **card via Square** (already built; settles only by verified webhook).
- Invoices are **due 7 days** after issue, then **overdue**.
- The operator records transfer/PayID payments on the admin desk and can undo a mistaken record. Non-payment is **flagged only**; the operator decides whether to lower the cap or turn AI off. Nothing is paused automatically.

## Monthly procedure

1. Month ends (Brisbane). Modelvia finalizes each office's customer invoice.
2. Operator opens **Admin → Billing → Close month**, reviews each office (terms accepted, Modelvia invoice ready) and closes it. This issues `RB-…` (due in 7 days) and queues the invoice email. A month whose Modelvia invoice is late can be closed care-only with AI deferred to the next invoice.
3. Client sees the invoice in Account → AI usage & billing with the amount, due date and how to pay (PayID, bank transfer with the invoice number as reference, or card).
4. Card: marked paid automatically when Square confirms. Transfer/PayID: operator checks the bank, then **Record payment** (method, amount, date received, bank reference).
5. After the due date the invoice shows **Overdue (n days)** on the desk; operator sends a reminder (email draft) and decides on AI access.

## Edge cases

| Case | Behaviour |
| --- | --- |
| Part payment | Recorded amount ≤ outstanding; status **Part paid** with the balance. Card checkout is refused while a transfer payment is recorded (Square charges the full amount); the balance is paid by transfer. |
| Amount larger than outstanding | Refused (`payment_exceeds_outstanding`). |
| Recorded by mistake / payment bounced | **Undo** with a reason. Appends a reversal; nothing is deleted. |
| Paid by card and by transfer | Both are kept; status **Overpaid**. Operator refunds or credits the difference (existing care credit/refund flow). |
| Card payment already settled | Recording a transfer is refused (`invoice_already_paid`). Square payments cannot be undone here; use the refund flow. |
| Credit / zero invoice | Adjustment Note or nothing due; no payment actions. |
| Future date received | Refused. |
| Same record sent twice | Idempotent on the payment id. |
| Month closed twice | Returns the existing invoice. |
| Office has not accepted terms for the month | Close refused with the reason shown. |
| Office AI off or disabled | Still invoiced for what was used. |

## Contract: gateway operator API (operator bearer, as `/v1/operator/offices/*`)

- `GET /v1/operator/billing/invoices` → `{ now, invoices: OperatorInvoice[] }` (newest first, at most 500).
- `POST /v1/operator/billing/invoices/{id}/payments` body `{ paymentId (uuid), method: 'bank_transfer'|'payid'|'other', amountCents, receivedOn: 'YYYY-MM-DD', reference?, note? }` → `OperatorInvoice`.
- `POST /v1/operator/billing/invoices/{id}/payments/{paymentId}/reverse` body `{ reason }` → `OperatorInvoice`.
- `GET /v1/operator/billing/close?period=YYYY-MM` → `{ period, offices: [{ companyId, officeName, invoiceId|null, termsVersion|null, state: 'closed'|'ready'|'blocked', blocker|null }] }`.
- `POST /v1/operator/billing/close` body `{ companyId, period, deferAi? }` → `{ invoice: OperatorInvoice, ai, alreadyClosed }`.

`OperatorInvoice = { id, companyId, officeName, billingEmail|null, period, kind, issuedAt, dueAt, totalCents, gstCents, paidCents, outstandingCents, status: 'unpaid'|'part_paid'|'paid'|'overpaid'|'credit'|'nothing_due', overdue, daysOverdue, payments: [{ id, method: 'square'|'bank_transfer'|'payid'|'other', amountCents, receivedOn, reference|null, note|null, recordedBy|null, recordedAt, reversed: { reason, by, at }|null }] }` — all cents are decimal strings, times epoch ms.

Portal `GET /v1/portal/invoices` adds per invoice `dueAt, status, overdue, paidCents, outstandingCents`, and top-level `paymentInstructions: { payId: { id, name }|null, bank: { accountName, bsb, accountNumber }|null }` from gateway env `REALBUD_PAYID`, `REALBUD_PAYID_NAME`, `REALBUD_BANK_ACCOUNT_NAME`, `REALBUD_BANK_BSB`, `REALBUD_BANK_ACCOUNT_NUMBER`. `REALBUD_INVOICE_TERMS_DAYS` (default 7) sets the due date.

## Billing plans: accept once, roll forward (owner decision, 2026-09-29, second part)

Monthly commercial terms are per office per month on the gateway (`commercial-terms.ts`), and until now were published only with `commercial-cli.ts publish` and accepted by the billing owner every month. Owner decisions:

- **Accept once, roll forward.** The operator sets a **billing plan** per office; the billing owner accepts it once; the gateway then publishes each month's terms from the plan and records them as covered by that acceptance (a *standing* acceptance). A new plan version (price or terms change) needs the owner's acceptance again (agreement clause 7: changes require written agreement).
- **Go-live = the month the owner accepts the invite.** Month 1 of any included period is that month.
- **Seller:** Yo-Da Lai, sole trader, ABN 84 992 526 369, **GST registered** (Tax Invoices with GST stay).
- **Austin Realty's plan** (service agreement 15 Sep 2026): months 1–2 included (no care fee, AI usage included), from month 3 A$125/month GST-inclusive plus AI usage billed after each month; due in 7 days; 12-month terms.
- One-off (project milestone) invoices: **not now**.

### Plan

`{ companyId, version, startPeriod, includedMonths (0–24), careCents (after the included months), aiBilling: 'resale'|'included' (after the included months), markupBasisPoints? (resale only; default from REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS), billingEmail?, tradingName? }` — append-only versions. Seller, tax and reference ids come from deployment configuration, never from the browser.

### Rules

- Setting a plan publishes terms for every month from `startPeriod` through next month that is not already closed; a later month is published lazily (close list, close, portal terms read) and by a daily timer.
- Included months: care 0 and no `aiUsage`. The month still closes, as an A$0 Tax Invoice with the line "Included service — no charge". Modelvia customer invoices for included months are recorded as **absorbed** (RealBud's cost) so they are never consolidated onto a later invoice, and never block a close (`ai_usage_unconsolidated`).
- Owner acceptance: the portal's existing commercial-terms read/accept shows the **plan** (included months, monthly fee from which month, AI billed after each month) and accepting it accepts the plan version. Every later month of that version gets a standing acceptance with subject `standing:<plan acceptance digest>`; nothing else creates acceptances.
- Close list blockers: `no_billing_plan`, `plan_awaiting_owner` (plan version not accepted yet).
- Clients never see markup basis points or wholesale cost.

### Contract additions (operator bearer)

- `GET /v1/operator/offices/billing-plan?companyId=` → `{ plan|null, acceptance: { state: 'none'|'awaiting_owner'|'accepted', acceptedAt|null }, months: [{ period, version, careCents, aiBilled: boolean, included: boolean, state: 'published'|'accepted'|'standing'|'closed' }] }`
- `PUT /v1/operator/offices/billing-plan` body = plan without `version` → same shape as GET.
