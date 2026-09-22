export interface BankBatchSummary {
  id: string;
  revision: number;
  createdAt: number;
  reviewedAt?: number;
  rows: number;
  originalDigest: string;
  outputDigest?: string;
  supersededBy?: string;
}
export interface BankHistoryQuery { cursor?: string; limit?: number }
/** Total covers the captured insertion snapshot. Existing reviews remain live. */
export interface BankHistoryPage {
  version: 2;
  batches: BankBatchSummary[];
  total: number;
  nextCursor: string | null;
}
