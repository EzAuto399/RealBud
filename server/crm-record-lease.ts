// Per-record write leases for Hermios CRM. One write may be in flight per
// record at a time across every thread and broker in this installation; a
// second writer waits a bounded time and is then refused. Reads never take a
// lease. Hermios has no record revisions or idempotency keys yet, so this is
// RealBud's own guard against two Buds changing the same record at once.
//
// `CrmRecordLeases` is the seam: the in-process implementation below covers one
// desktop; a multi-device office can back the same interface with company
// Postgres (a lease row with fence, holder and expiry) without changing callers.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";

export interface CrmRecordKey { workspace: string; object: string; recordId: string }
export interface CrmRecordLease {
  /** Opaque, stable for the record; never the raw ids. */
  readonly key: string;
  /** Monotonic per key: a later holder always carries a larger fence. */
  readonly fence: number;
  readonly holder: string;
  /** Idempotent. */
  release(): Promise<void>;
}
export interface CrmRecordLeases {
  /** Resolves with the lease, or null when the record stayed busy for `waitMs`
   * or `signal` aborted first. Never throws for contention. */
  acquire(record: CrmRecordKey, options: { holder: string; waitMs: number; signal?: AbortSignal }): Promise<CrmRecordLease | null>;
}

export const CRM_RECORD_BUSY = "Another Bud is changing this record. Wait for it to finish, then review the change again.";

export function crmRecordKey(record: CrmRecordKey): string {
  for (const part of [record.workspace, record.object, record.recordId]) {
    if (typeof part !== "string" || !part || part.length > 300) throw new Error("This CRM record cannot be locked.");
  }
  return createHash("sha256").update(JSON.stringify(["crm-record-v1", record.workspace, record.object, record.recordId])).digest("hex");
}

/** One desktop's leases: FIFO waiters per record, a bounded wait each. */
export class InProcessCrmRecordLeases implements CrmRecordLeases {
  private readonly entries = new Map<string, { holder: string | null; fence: number; waiters: Array<() => void> }>();

  async acquire(record: CrmRecordKey, options: { holder: string; waitMs: number; signal?: AbortSignal }): Promise<CrmRecordLease | null> {
    const key = crmRecordKey(record);
    let entry = this.entries.get(key);
    if (!entry) { entry = { holder: null, fence: 0, waiters: [] }; this.entries.set(key, entry); }
    const state = entry;
    if (state.holder !== null || state.waiters.length) {
      const admitted = await new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return; settled = true;
          clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
          const at = state.waiters.indexOf(wake);
          if (at >= 0) state.waiters.splice(at, 1);
          resolve(value);
        };
        // Woken only when the lease is free and this waiter is first in line.
        const wake = () => finish(true);
        const abort = () => { finish(false); this.next(key); };
        const timer = setTimeout(abort, Math.max(0, options.waitMs));
        timer.unref?.();
        if (options.signal?.aborted) { abort(); return; }
        options.signal?.addEventListener("abort", abort, { once: true });
        state.waiters.push(wake);
      });
      if (!admitted) { this.forget(key); return null; }
    }
    state.holder = options.holder;
    const fence = ++state.fence;
    let released = false;
    return {
      key, fence, holder: options.holder,
      release: async () => {
        if (released) return; released = true;
        if (state.fence === fence) state.holder = null;
        this.next(key);
      },
    };
  }

  /** Hand a free lease to the first waiter, if any. */
  private next(key: string): void {
    const state = this.entries.get(key);
    if (!state || state.holder !== null) return;
    const first = state.waiters[0];
    // Reserved for that waiter until it resumes, so no newcomer can slip in.
    if (first) { state.holder = "\u0000reserved"; first(); return; }
    this.forget(key);
  }
  private forget(key: string): void {
    const state = this.entries.get(key);
    if (state && state.holder === null && !state.waiters.length) this.entries.delete(key);
  }
  /** For tests and diagnostics: records currently held or awaited. */
  get size(): number { return this.entries.size; }
}

/** Module-wide: every thread and broker on this desktop shares these leases. */
export const crmRecordLeases: CrmRecordLeases = new InProcessCrmRecordLeases();
export const newCorrelationId = (): string => `crm-${randomUUID()}`;

// ── Durable write receipts ───────────────────────────────────────────────────
// Hermios keeps a write's idempotency key for 24 hours. Each approved write's
// keys, step outcomes and returned ids are saved here before dispatch, so a
// restart within that window can resume a step (the same key and payload)
// instead of creating a second record. Never tokens, note bodies or titles.

export type CrmWriteStepKind = "update" | "create" | "link";
export type CrmWriteStepStatus = "pending" | "succeeded" | "conflict" | "failed" | "uncertain";
export interface CrmWriteStep { kind: CrmWriteStepKind; idempotencyKey: string; status: CrmWriteStepStatus; resultId?: string }
export interface CrmWriteEntry {
  correlationId: string; tool: string; workspace: string; generation: number;
  record: { view: string; recordId: string } | null; approvedAt: number; steps: CrmWriteStep[];
}
export interface CrmWriteJournal {
  begin(entry: CrmWriteEntry): Promise<void>;
  /** Insert or replace the step with this idempotency key. */
  step(correlationId: string, step: CrmWriteStep): Promise<void>;
  list(): Promise<CrmWriteEntry[]>;
}

const JOURNAL_RETENTION_MS = 48 * 3_600_000, JOURNAL_MAX = 500, JOURNAL_BYTES = 1_000_000;
const KEY = /^[A-Za-z0-9._:-]{1,200}$/;
function validEntry(value: unknown): value is CrmWriteEntry {
  const row = value as CrmWriteEntry;
  return !!row && typeof row === "object" && typeof row.correlationId === "string" && KEY.test(row.correlationId) && typeof row.tool === "string" &&
    typeof row.workspace === "string" && Number.isSafeInteger(row.generation) && Number.isSafeInteger(row.approvedAt) &&
    (row.record === null || (typeof row.record?.view === "string" && typeof row.record?.recordId === "string")) &&
    Array.isArray(row.steps) && row.steps.length <= 4 && row.steps.every(step => step && typeof step.idempotencyKey === "string" && KEY.test(step.idempotencyKey) &&
      ["update", "create", "link"].includes(step.kind) && ["pending", "succeeded", "conflict", "failed", "uncertain"].includes(step.status) &&
      (step.resultId === undefined || (typeof step.resultId === "string" && step.resultId.length <= 200)));
}

/** In-memory journal, for tests and hosts without private storage. */
export function memoryCrmWriteJournal(): CrmWriteJournal {
  const entries = new Map<string, CrmWriteEntry>();
  return {
    async begin(entry) { entries.set(entry.correlationId, structuredClone(entry)); },
    async step(correlationId, step) {
      const entry = entries.get(correlationId);
      if (!entry) throw new Error("This CRM write has no saved receipt.");
      entry.steps = [...entry.steps.filter(row => row.idempotencyKey !== step.idempotencyKey), { ...step }];
    },
    async list() { return structuredClone([...entries.values()]); },
  };
}

/** `<directory>/hermios-crm/write-receipts.json`, private and fsynced. A damaged
 * file holds every write (fail closed) and is never cleared. */
export function createCrmWriteJournal(directory: string, now: () => number = Date.now): CrmWriteJournal {
  let queue: Promise<unknown> = Promise.resolve();
  const file = join(directory, "hermios-crm", "write-receipts.json");
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => {}).then(work);
    queue = next.catch(() => {});
    return next;
  };
  const load = async (): Promise<CrmWriteEntry[]> => {
    const value = await readPrivateJson(file, JOURNAL_BYTES);
    if (value === undefined) return [];
    const rows = (value as { version?: unknown; entries?: unknown }).entries;
    if ((value as { version?: unknown }).version !== 1 || !Array.isArray(rows) || !rows.every(validEntry)) throw new Error("Saved CRM write receipts need recovery. No CRM change was made.");
    return rows;
  };
  const save = async (entries: CrmWriteEntry[]) => {
    const cutoff = now() - JOURNAL_RETENTION_MS;
    const kept = entries.filter(entry => entry.approvedAt >= cutoff).slice(-JOURNAL_MAX);
    await writePrivateJson(file, { version: 1, entries: kept }, { maxBytes: JOURNAL_BYTES, validate: () => {} });
  };
  return {
    begin: entry => serial(async () => {
      if (!validEntry(entry)) throw new Error("This CRM write receipt is invalid.");
      const entries = await load();
      await save([...entries.filter(row => row.correlationId !== entry.correlationId), structuredClone(entry)]);
    }),
    step: (correlationId, step) => serial(async () => {
      const entries = await load();
      const entry = entries.find(row => row.correlationId === correlationId);
      if (!entry) throw new Error("This CRM write has no saved receipt.");
      entry.steps = [...entry.steps.filter(row => row.idempotencyKey !== step.idempotencyKey), { ...step }];
      if (!validEntry(entry)) throw new Error("This CRM write receipt is invalid.");
      await save(entries);
    }),
    list: () => serial(load),
  };
}
