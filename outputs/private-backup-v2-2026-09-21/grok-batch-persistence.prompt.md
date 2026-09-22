You own a bounded implementation proposal for two NEW files ONLY: server/batch-persistence.ts and server/batch-persistence.test.ts. You are not alone in this codebase. Codex owns all integration and other files; do not revert or edit other work. Use only this source packet, no tools, agents, credentials or external actions. Return JSON exactly {"files":[{"path":"server/batch-persistence.ts","content":"complete source"},{"path":"server/batch-persistence.test.ts","content":"complete test source"}],"notes":"short integration notes"}. No Markdown fences. These files do not exist yet. Codex will inspect/apply/run them.
Problem: legacy portfolio work-batches.json is currently omitted from private backup. We need pure reusable persistence validation + authority-reset for portable restore; runtime must later use the same validator. APIs: export function validStoredWorkBatches(value: unknown): value is WorkBatch[]; export function restoreWorkBatches(value: unknown, at: number): WorkBatch[]. Preserve current validStored semantics/limits and supported optional fields (do not gratuitously narrow persisted compatibility). Keep file independent of config, app stores, Hermes and filesystem. Restore clones, validates input, preserves original source strings, requestKey/requestHash, task/id, item outputs/gaps/attempts/review timestamps, array order, completed results. Disable autoContinue and waitingForWorker for every batch. Pause unfinished batches; convert running items to interrupted without marking them completed. Remove retryAt values so no archived timer resumes. Preserve finished batches as finished if consistent; if running items exist mark parent paused. Update changed batch revision/timestamp safely (reject unsafe arithmetic). Preserve manual reviewedAt as historical review, not permission to dispatch. Do not clear sourceRevision or rewrite requestHash (retry evidence). No mutation of input. Tests: actual current valid fixture, all optional fields absent compatibility, running/queued/paused/finished states and exact whitespace/BOM/Unicode inputs, malformed/null/duplicate values/current size bounds, no-autoresume flags, output/attempt identity retention, unsafe revisions/timestamps, input unchanged and post-transform validation. Build realistic small fictional fixtures from shared types. Keep tests focused and deterministic; do not instantiate actual workers. Use Vitest. Source schema and current runtime validator follow.

### shared/batches.ts
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
### server/batches.ts
// Durable prepare-only portfolio work. Every property owns its own immutable
// source and result. No file/browser tools or external effects are granted.
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BATCH_LIMIT, BATCH_HISTORY_ITEMS, BATCH_AUTO_ATTEMPTS, BATCH_TASKS, batchCounts, type BatchItem, type WorkBatch, type BatchTask } from "../shared/batches.ts";
import type { DeskSnapshot } from "../shared/contracts.ts";
import { DATA_DIR } from "./config.ts";
import { writeFileAtomic } from "./atomic.ts";
import { deskContextMarkdown } from "./desk-context.ts";
import { askWorker } from "./recipe-draft.ts";
import { parsePrepareResult } from "./job-executor.ts";
import { productBudSystemPrompt } from "./ask-book.ts";

const MAX_OUTPUT = 24_000;
const excerpt = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 70)}\n[Excerpt only: additional source text was not included.]` : text;
const clone = <T>(value: T): T => structuredClone(value);
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
type Dependencies = {
  file?: string;
  snapshot: () => DeskSnapshot;
  notes: (id: string) => string;
  available: () => Promise<boolean>;
  /** Reversible host admission for timer/startup recovery; never stops or
   * clears saved work. Rechecked after asynchronous worker readiness. */
  canRecover?: () => boolean;
  ask?: typeof askWorker;
  retryDelayMs?: number;
};

function validStored(value: unknown): value is WorkBatch[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  const ids = new Set<string>();
  const keys = new Set<string>();
  return value.every(batch => {
    if (!batch || typeof batch.id !== "string" || ids.has(batch.id)) return false;
    ids.add(batch.id);
    if (typeof batch.requestKey !== "string" || !/^[\w-]{8,100}$/.test(batch.requestKey) || keys.has(batch.requestKey)) return false;
    keys.add(batch.requestKey);
    if (!(Object.hasOwn(BATCH_TASKS, batch.task)) || !["running", "paused", "finished"].includes(batch.status)
      || !Number.isInteger(batch.revision) || batch.revision < 1 || !Number.isInteger(batch.sourceRevision)
      || !Number.isFinite(batch.createdAt) || !Number.isFinite(batch.updatedAt) || typeof batch.sample !== "boolean" || typeof batch.retryOnly !== "boolean"
      || ![batch.requestKey, batch.requestHash, batch.instruction, batch.detail].every(v => typeof v === "string")
      || (batch.autoContinue !== undefined && typeof batch.autoContinue !== "boolean")
      || (batch.waitingForWorker !== undefined && typeof batch.waitingForWorker !== "boolean")
      || batch.instruction.length > 1000 || batch.detail.length > 2000 || !/^[a-f0-9]{64}$/.test(batch.requestHash)
      || !Array.isArray(batch.items) || !batch.items.length || batch.items.length > BATCH_LIMIT) return false;
    const properties = new Set<string>();
    return batch.items.every((item: BatchItem) => {
      if (!item || typeof item.propertyId !== "string" || properties.has(item.propertyId)) return false;
      properties.add(item.propertyId);
      return [item.address, item.source, item.output, item.detail].every(v => typeof v === "string")
        && item.source.length <= 16_000 && item.output.length <= MAX_OUTPUT
        && ["queued", "running", "ready", "needs-review", "failed", "interrupted"].includes(item.status)
        && Number.isInteger(item.attempt) && item.attempt >= 0 && Array.isArray(item.gaps)
        && item.gaps.length <= 20 && item.gaps.every(v => typeof v === "string" && v.length <= 500)
        && (item.reviewedAt === undefined || Number.isFinite(item.reviewedAt))
        && (item.retryAt === undefined || (Number.isFinite(item.retryAt) && item.retryAt >= 0));
    });
  });
}

export class BatchService {
  private batches: WorkBatch[] = [];
  private error = "";
  private stopped = false;
  private readonly cancellation = new AbortController();
  private runners = new Map<string, Promise<void>>();
  private readonly file: string;
  private readonly deps: Dependencies;
  private reconnectTimer: ReturnType<typeof setInterval>;
  private recovering = false;
  private wakeDelay?: () => void;
  constructor(deps: Dependencies) {
    this.deps = deps;
    this.reconnectTimer = setInterval(() => { void this.recoverReadyWork(); }, 30_000);
    this.reconnectTimer.unref();
    this.file = deps.file ?? join(DATA_DIR, "work-batches.json");
    if (!existsSync(this.file)) return;
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!validStored(data)) throw new Error("invalid batch history");
      this.batches = data;
      if (data.some(batch => batch.status === "running" || batch.items.some(item => item.status === "running"))) {
        this.commit(next => {
          for (const batch of next) {
            if (batch.status !== "running" && !batch.items.some(item => item.status === "running")) continue;
            const wasRunning = batch.status === "running";
            batch.status = "paused";
            batch.waitingForWorker = Boolean(wasRunning && batch.autoContinue);
            batch.detail = "Paused after restart. Completed results are kept. Resume remaining work or retry interrupted items.";
            for (const item of batch.items) if (item.status === "running") {
              item.status = batch.waitingForWorker && item.attempt < BATCH_AUTO_ATTEMPTS ? "queued" : "interrupted";
              item.detail = "Interrupted before a complete result was saved. Retry this item when ready.";
            }
            if (batch.waitingForWorker) batch.detail = "Saved work recovered. Bud will continue remaining properties when the connection is ready.";
            this.touch(batch);
          }
        });
      }
      queueMicrotask(() => { void this.recoverReadyWork(); });
    } catch {
      this.error = "Batch history could not be read safely. It has not been replaced. Restore its backup before preparing more batches.";
    }
  }