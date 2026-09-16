export const BATCH_LIMIT = 500;
export const BATCH_HISTORY_ITEMS = 2000;
export const BATCH_AUTO_ATTEMPTS = 3;
export const BATCH_TASKS = {
  "owner-update": { label: "Owner updates", detail: "A concise update and missing facts for each owner." },
  "maintenance-brief": { label: "Maintenance briefs", detail: "Reported issue, urgency, access and next steps for each property." },
  "inspection-checklist": { label: "Inspection checklists", detail: "A practical checklist, missing documents and access questions." },
} as const;
export type BatchTask = keyof typeof BATCH_TASKS;
export type BatchItemState = "queued" | "running" | "ready" | "needs-review" | "failed" | "interrupted";
export interface BatchItem {
  propertyId: string;
  address: string;
  source: string;
  status: BatchItemState;
  attempt: number;
  output: string;
  detail: string;
  gaps: string[];
  reviewedAt?: number;
  retryAt?: number;
}
export interface WorkBatch {
  id: string;
  requestKey: string;
  requestHash: string;
  revision: number;
  task: BatchTask;
  instruction: string;
  status: "running" | "paused" | "finished";
  retryOnly: boolean;
  /** Absent in older files: continuation requires an explicit choice. */
  autoContinue?: boolean;
  waitingForWorker?: boolean;
  detail: string;
  sourceRevision: number;
  sample: boolean;
  createdAt: number;
  updatedAt: number;
  items: BatchItem[];
}
export function batchCounts(batch: WorkBatch) {
  return {
    total: batch.items.length,
    remaining: batch.items.filter(item => item.status === "queued").length,
    running: batch.items.filter(item => item.status === "running").length,
    ready: batch.items.filter(item => item.status === "ready" || item.status === "needs-review").length,
    failed: batch.items.filter(item => item.status === "failed" || item.status === "interrupted").length,
    reviewed: batch.items.filter(item => item.reviewedAt).length,
    attention: batch.items.filter(item => !item.reviewedAt && ["needs-review", "failed", "interrupted"].includes(item.status)).length,
  };
}
