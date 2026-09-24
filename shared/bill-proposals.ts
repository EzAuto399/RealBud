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
  attachmentReads?: BillAttachmentRead[];
}

export function isBillProposalRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

export interface BillAttachmentRead { attachmentId: string; fileName: string; pages: number; text: string; sha256: string }
/** Optional for receipts created before attachment reading was supported. */
export function billAttachmentReads(value: unknown): BillAttachmentRead[] {
  if (value === undefined) return [];
  const fail = (): never => { throw new Error('The saved PDF reading result needs review.'); };
  if (!Array.isArray(value) || value.length > 1) return fail();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'attachmentId,fileName,pages,sha256,text' ||
        typeof row.attachmentId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(row.attachmentId) ||
        typeof row.fileName !== 'string' || row.fileName.length > 255 || /[\\/\x00-\x1f\x7f]/.test(row.fileName) ||
        !Number.isSafeInteger(row.pages) || row.pages < 1 || row.pages > 20 || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 64_040 ||
        typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) return fail();
    return { attachmentId: row.attachmentId, fileName: row.fileName, pages: row.pages, text: row.text, sha256: row.sha256 };
  });
}
