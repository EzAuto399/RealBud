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
