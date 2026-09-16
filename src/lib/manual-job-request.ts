import { MANUAL_JOB_REQUEST_ID, manualJobRequestKey, type ManualJobMode } from "../../shared/manual-job-request";

const STORAGE_KEY = "realbud.manual-job-requests.v1";
const MAX_PENDING = 500;
type StorageLike = Pick<Storage, "getItem" | "setItem">;
type Pending = { revision: number; requestId: string };
type PendingRequests = Record<string, Pending>;
export type ManualJobScope = { id: string; revision: number; mode: ManualJobMode };

function read(storage: StorageLike): PendingRequests {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return {};
  const rows: unknown = JSON.parse(raw);
  if (!rows || typeof rows !== "object" || Array.isArray(rows) || Object.keys(rows).length > MAX_PENDING) {
    throw new Error("Run recovery data could not be read. Check saved results before starting more work.");
  }
  for (const row of Object.values(rows)) {
    if (!row || typeof row !== "object" || !Number.isInteger(row.revision) || row.revision < 1 ||
      typeof row.requestId !== "string" || !MANUAL_JOB_REQUEST_ID.test(row.requestId)) {
      throw new Error("Run recovery data could not be read. Check saved results before starting more work.");
    }
  }
  return rows as PendingRequests;
}

const scopeKey = (scope: ManualJobScope) => JSON.stringify([scope.id, scope.mode]);

export function pendingManualJobRequest(scope: ManualJobScope, storage: StorageLike = localStorage): string | null {
  const pending = read(storage)[scopeKey(scope)];
  return pending?.revision === scope.revision ? pending.requestId : null;
}

/** Checking an existing run must never allocate another operation. A second
 * window can have confirmed or replaced the request since this one rendered. */
export function resumeManualJobRequest(
  scope: ManualJobScope,
  requestId: string,
  storage: StorageLike = localStorage,
): { ready: true; requestId: string } | { ready: false; pendingRequestId: string | null } {
  if (!MANUAL_JOB_REQUEST_ID.test(requestId)) throw new Error("The pending run could not be identified. Check saved results before starting more work.");
  const pendingRequestId = pendingManualJobRequest(scope, storage);
  return pendingRequestId === requestId
    ? { ready: true, requestId }
    : { ready: false, pendingRequestId };
}

/** Save before sending. A lost response, remount or reload reuses this ID.
 * Only IDs and plan versions are stored here, never the job's contents. */
export function beginManualJobRequest(
  scope: ManualJobScope,
  storage: StorageLike = localStorage,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const rows = read(storage);
  const key = scopeKey(scope);
  if (rows[key]?.revision === scope.revision) return rows[key].requestId;
  if (!Object.hasOwn(rows, key) && Object.keys(rows).length >= MAX_PENDING) {
    throw new Error("Check the results of earlier runs before starting more jobs.");
  }
  const requestId = createId();
  if (!MANUAL_JOB_REQUEST_ID.test(requestId)) throw new Error("Could not create a safe run request. Try again.");
  rows[key] = { revision: scope.revision, requestId };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    throw new Error("Run recovery could not be saved on this device. No work was started. Check browser storage and try again.");
  }
  return requestId;
}

/** A terminal receipt confirms the outcome, including failure. An explicit
 * later click may then start new work; a running receipt keeps its identity. */
export function confirmManualJobReceipt(
  scope: ManualJobScope,
  requestId: string,
  receipt: { jobId: string; jobRevision: number; mode: string; status: string; idempotencyKey: string },
  storage: StorageLike = localStorage,
): boolean {
  if (receipt.jobId !== scope.id || receipt.jobRevision !== scope.revision || receipt.mode !== scope.mode ||
    receipt.idempotencyKey !== manualJobRequestKey(scope.id, scope.revision, scope.mode, requestId)) {
    throw new Error("The response did not match this run. Check saved results before trying again.");
  }
  if (receipt.status === "queued" || receipt.status === "running") return false;
  if (!["completed", "partial", "awaiting-approval", "failed", "interrupted", "cancelled", "missed"].includes(receipt.status)) {
    throw new Error("The run returned an unknown state. Check saved results before trying again.");
  }
  const rows = read(storage);
  const key = scopeKey(scope);
  if (rows[key]?.requestId === requestId && rows[key]?.revision === scope.revision) {
    delete rows[key];
    storage.setItem(STORAGE_KEY, JSON.stringify(rows));
  }
  return true;
}
