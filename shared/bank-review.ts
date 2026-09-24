/** A review version is distinct from the database revision used for concurrent edits. */
export const BANK_REVIEW_ID = /^bank:([a-f0-9]{64})(?::r([2-9]|[1-9][0-9]{1,5}))?$/;
export function bankReviewVersion(id: string): number {
  const match = BANK_REVIEW_ID.exec(id);
  if (!match) throw new Error('Invalid bank review identity.');
  return Number(match[2] ?? 1);
}
export function bankReviewId(digest: string, version: number): string {
  const id = `bank:${digest}${version === 1 ? '' : `:r${version}`}`;
  if (!BANK_REVIEW_ID.test(id)) throw new Error('Invalid bank review identity.');
  return id;
}
export interface BankReviewAmendment { id: string; revision: number; reason: string }
export interface BankReviewSuccessor { id: string; previousRevision: number; requestDigest: string }
