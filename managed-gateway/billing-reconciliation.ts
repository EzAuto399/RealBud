import type { LedgerDatabase } from './database.ts';
import { requireThat } from './contracts.ts';

export interface RefundCreditAllocationIssue {
  code: 'refund_credit_allocation_required';
  sourceStatementId: string;
  paymentId: string;
  refundId: string;
  refundedCents: number;
  creditEventId: number;
  creditRequestId: string;
  creditNanoAud: string;
  creditStatementId: string | null;
  creditInvoiceId: string | null;
}

/** Derive unresolved allocation from immutable financial facts, regardless of arrival
 * order. No mutable "clear" flag can become stale, and existing databases need no
 * speculative backfill. A refund may concern care or one of several usage lines;
 * its allocation cannot be inferred from the aggregate refund amount alone. */
export function refundCreditAllocationIssues(db: LedgerDatabase, companyId: string): RefundCreditAllocationIssue[] {
  return db.all<RefundCreditAllocationIssue>(`
    SELECT DISTINCT 'refund_credit_allocation_required' AS code,
      original.id AS sourceStatementId, payment.id AS paymentId,
      refund.id AS refundId, json_extract(refund.body,'$.amount') AS refundedCents,
      credit.seq AS creditEventId, credit.request AS creditRequestId,
      json_extract(credit.body,'$.amountNanoAud') AS creditNanoAud,
      applied.statement AS creditStatementId, invoiced.invoice AS creditInvoiceId
    FROM square_refunds refund
    JOIN square_payments payment ON payment.id=refund.payment
    JOIN statements original ON original.id=payment.statement
    JOIN statement_events source ON source.statement=original.id
    JOIN events usage ON usage.seq=source.event AND usage.kind='usage_settled'
    JOIN events credit ON credit.request=usage.request AND credit.kind='credit' AND credit.tenant=original.tenant
    LEFT JOIN statement_events applied ON applied.event=credit.seq
    LEFT JOIN invoice_events invoiced ON invoiced.event=credit.seq
    WHERE original.tenant=?
    ORDER BY credit.seq,refund.id`, companyId);
}

/** Call inside the same transaction that closes or dispatches affected billing.
 * Reading verified incoming money remains permitted while allocation is unresolved. */
export function assertBillingAllocationClear(db: LedgerDatabase, companyId: string) {
  requireThat(refundCreditAllocationIssues(db, companyId).length === 0, 'refund_credit_allocation_required', 409);
}
