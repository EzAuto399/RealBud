/** Portable work-batch persistence: shared validator and authority-reset restore.
 * Independent of config, app stores, Hermes, and the filesystem. */
import { BATCH_LIMIT, BATCH_TASKS, type WorkBatch } from "../shared/batches.ts";

const MAX_OUTPUT = 24_000;

export function validStoredWorkBatches(value: unknown): value is WorkBatch[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  const ids = new Set<string>();
  const keys = new Set<string>();
  return value.every((batch: any) => {
    if (!batch || typeof batch.id !== "string" || ids.has(batch.id)) return false;
    ids.add(batch.id);
    if (typeof batch.requestKey !== "string" || !/^[\w-]{8,100}$/.test(batch.requestKey) || keys.has(batch.requestKey)) return false;
    keys.add(batch.requestKey);
    if (!(Object.hasOwn(BATCH_TASKS, batch.task)) || !["running", "paused", "finished"].includes(batch.status)
      || !Number.isInteger(batch.revision) || batch.revision < 1 || !Number.isInteger(batch.sourceRevision)
      || !Number.isFinite(batch.createdAt) || !Number.isFinite(batch.updatedAt) || typeof batch.sample !== "boolean" || typeof batch.retryOnly !== "boolean"
      || ![batch.requestKey, batch.requestHash, batch.instruction, batch.detail].every((v: unknown) => typeof v === "string")
      || (batch.autoContinue !== undefined && typeof batch.autoContinue !== "boolean")
      || (batch.waitingForWorker !== undefined && typeof batch.waitingForWorker !== "boolean")
      || batch.instruction.length > 1000 || batch.detail.length > 2000 || !/^[a-f0-9]{64}$/.test(batch.requestHash)
      || !Array.isArray(batch.items) || !batch.items.length || batch.items.length > BATCH_LIMIT) return false;
    const properties = new Set<string>();
    return batch.items.every((item: any) => {
      if (!item || typeof item.propertyId !== "string" || properties.has(item.propertyId)) return false;
      properties.add(item.propertyId);
      return [item.address, item.source, item.output, item.detail].every((v: unknown) => typeof v === "string")
        && item.source.length <= 16_000 && item.output.length <= MAX_OUTPUT
        && ["queued", "running", "ready", "needs-review", "failed", "interrupted"].includes(item.status)
        && Number.isInteger(item.attempt) && item.attempt >= 0 && Array.isArray(item.gaps)
        && item.gaps.length <= 20 && item.gaps.every((v: unknown) => typeof v === "string" && v.length <= 500)
        && (item.reviewedAt === undefined || Number.isFinite(item.reviewedAt))
        && (item.retryAt === undefined || (Number.isFinite(item.retryAt) && item.retryAt >= 0));
    });
  });
}

const PAUSED_DETAIL = "Paused after restore. Completed results are kept. Resume remaining work or retry interrupted items.";
const INTERRUPTED_DETAIL = "Interrupted before a complete result was saved. Retry this item when ready.";

function nextSafeRevision(revision: number): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next) || next <= revision) {
    throw new Error("unsafe batch revision");
  }
  return next;
}

export function restoreWorkBatches(value: unknown, at: number): WorkBatch[] {
  if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) {
    throw new Error("unsafe restore timestamp");
  }
  if (!validStoredWorkBatches(value)) {
    throw new Error("invalid batch history");
  }
  const batches = structuredClone(value);
  for (const batch of batches) {
    let changed = false;
    if (batch.autoContinue !== false) {
      batch.autoContinue = false;
      changed = true;
    }
    if (batch.waitingForWorker !== false) {
      batch.waitingForWorker = false;
      changed = true;
    }
    const hasPendingItems = batch.items.some(item => item.status === "running" || item.status === "queued");
    if (batch.status === "running" || hasPendingItems) {
      if (batch.status !== "paused") {
        batch.status = "paused";
        changed = true;
      }
      if (batch.detail !== PAUSED_DETAIL) {
        batch.detail = PAUSED_DETAIL;
        changed = true;
      }
    }
    for (const item of batch.items) {
      if (item.status === "running") {
        item.status = "interrupted";
        item.detail = INTERRUPTED_DETAIL;
        changed = true;
      }
      if (item.retryAt !== undefined) {
        delete item.retryAt;
        changed = true;
      }
    }
    if (changed) {
      batch.revision = nextSafeRevision(batch.revision);
      // Old readers accepted finite timestamps, including fractions. Keep that
      // compatibility while ensuring the new persisted edit is a later safe
      // timestamp, even when restoring on a computer whose clock is behind.
      const updatedAt = Math.max(at, Math.floor(batch.updatedAt) + 1);
      if (!Number.isSafeInteger(updatedAt) || updatedAt > 8_640_000_000_000_000) {
        throw new Error("unsafe restore timestamp");
      }
      batch.updatedAt = updatedAt;
    }
  }
  if (!validStoredWorkBatches(batches)) {
    throw new Error("invalid batch history");
  }
  return batches;
}
