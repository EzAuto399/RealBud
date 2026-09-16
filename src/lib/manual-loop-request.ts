import type { LoopRun } from "@shared/contracts";
import { MANUAL_JOB_REQUEST_ID } from "../../shared/manual-job-request";

const KEY = "realbud.manual-loop-requests.v1";
type StorageLike = Pick<Storage, "getItem" | "setItem">;
export type PendingLoopRequest = { requestId: string; expectedRevision: number };
type Requests = Record<string, PendingLoopRequest>;
const invalid = () => new Error("Run recovery could not be read on this device. Check saved results before starting more work.");

function read(storage: StorageLike): Requests {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return {};
    const rows = JSON.parse(raw);
    if (!rows || typeof rows !== "object" || Array.isArray(rows) || Object.keys(rows).length > 500) throw invalid();
    for (const row of Object.values(rows) as PendingLoopRequest[]) {
      if (!row || typeof row.requestId !== "string" || !MANUAL_JOB_REQUEST_ID.test(row.requestId) ||
          !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1) throw invalid();
    }
    return rows;
  } catch { throw invalid(); }
}

function write(rows: Requests, storage: StorageLike) {
  try { storage.setItem(KEY, JSON.stringify(rows)); }
  catch { throw new Error("Run recovery could not be saved on this device. Check browser storage before starting more work."); }
}

const keyFor = (loopId: string) => JSON.stringify([loopId]);
export function pendingLoopRequest(loopId: string, storage: StorageLike = localStorage): PendingLoopRequest | null {
  return read(storage)[keyFor(loopId)] ?? null;
}

/** Keep the original revision across clock edits; checking is about the old run. */
export function beginLoopRequest(loopId: string, revision: number, storage: StorageLike = localStorage,
  createId: () => string = () => crypto.randomUUID()): PendingLoopRequest {
  const rows = read(storage);
  const key = keyFor(loopId);
  if (rows[key]) return rows[key];
  if (!Number.isSafeInteger(revision) || revision < 1 || Object.keys(rows).length >= 500) throw invalid();
  const requestId = createId().toLowerCase();
  if (!MANUAL_JOB_REQUEST_ID.test(requestId)) throw invalid();
  const request = { requestId, expectedRevision: revision };
  rows[key] = request;
  write(rows, storage);
  return request;
}

/** Another window may have already confirmed this exact request. Never start
 * new work from a stale 'Check previous run' button. */
export function resumeLoopRequest(loopId: string, captured: PendingLoopRequest, storage: StorageLike = localStorage): PendingLoopRequest | null {
  const pending = pendingLoopRequest(loopId, storage);
  return pending?.requestId === captured.requestId && pending.expectedRevision === captured.expectedRevision ? pending : null;
}

export function confirmLoopReceipt(loopId: string, request: PendingLoopRequest, run: LoopRun, storage: StorageLike = localStorage): boolean {
  if (run.loopId !== loopId || run.requestId !== request.requestId || run.loopRevision !== request.expectedRevision || !run.manual) {
    throw new Error("The result did not match this request. Check saved results before trying again.");
  }
  if (run.status === "queued" || run.status === "running") return false;
  if (!["completed", "partial", "awaiting-approval", "failed", "missed", "interrupted"].includes(run.status)) throw invalid();
  const rows = read(storage);
  const key = keyFor(loopId);
  if (rows[key]?.requestId === request.requestId && rows[key]?.expectedRevision === request.expectedRevision) {
    delete rows[key];
    write(rows, storage);
  }
  return true;
}

/** Only an authoritative rejection permits discarding an unaccepted request.
 * Connection loss, timeout and storage/server failure keep the identity. */
export function rejectLoopRequest(loopId: string, request: PendingLoopRequest, status: number | undefined, storage: StorageLike = localStorage): boolean {
  if (status !== 400 && status !== 404 && status !== 409) return false;
  const rows = read(storage);
  const key = keyFor(loopId);
  if (rows[key]?.requestId === request.requestId && rows[key]?.expectedRevision === request.expectedRevision) {
    delete rows[key];
    write(rows, storage);
  }
  return true;
}
