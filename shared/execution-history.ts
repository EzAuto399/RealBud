/** Activity pages are views; these encrypted receipts retain retry identities. */
export interface ExecutionHistoryPage<T> { runs: T[]; nextCursor: string | null }
export interface ExecutionHistoryQuery { cursor?: string; limit?: number; subjectId?: string }
export interface ExecutionReceipt<T> { version: 1; stream: string; run: T; binding: string }
export interface ExecutionRequestReceipt { version: 1; stream: string; key: string; runId: string; binding: string }
export interface ExecutionCheckpoint<C = unknown> {
  version: 1; stream: string; currentHash: string; previousHash: string | null;
  recentIds: string[]; context: C;
}
export const EXECUTION_RECORD_KINDS = ['execution-job', 'execution-loop', 'execution-request', 'execution-state'] as const;
