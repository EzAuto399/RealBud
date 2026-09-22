import type { InvoiceReview } from './accounts-review.ts';
import type { JobRun } from './contracts.ts';

/** Historical evidence only. None of these states authorizes a new preparation
 * or proves that an unrecorded provider attempt did not incur a charge. */
export interface BillProposalHistory {
  version: 1;
  requestId: string;
  state: 'not-recorded' | 'intent-recorded' | 'run-recorded';
  sourceDigest: string | null;
  payloadDigest: string | null;
  run: JobRun | null;
  proposal: InvoiceReview['documents'][number] | null;
  historical: true;
}

export function isBillProposalRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}
