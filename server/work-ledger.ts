/** One process-wide ledger of the work an update restart would cut short
 * (docs/UPDATES-2026-10-10.md, "One ledger of work"). Work registers itself in
 * the module that owns it: "working" while it runs, "waiting" while it waits on
 * the person (a restart would drop that wait). Work that is saved and resumes
 * after a restart does not register, or ends its entry once it is resumable.
 * /api/health reads only the totals: never kinds, ids or content. */

export type WorkState = "working" | "waiting";
export interface WorkCounts { working: number; waiting: number }
export interface WorkLedgerSnapshot extends WorkCounts { byKind: Record<string, WorkCounts> }
export interface WorkEntry {
  /** Moves the entry between working and waiting; a no-op once ended. */
  set(state: WorkState): void;
  /** Idempotent. */
  end(): void;
}

const KIND = /^[a-z][a-z0-9-]{0,63}$/;
function checkedKind(kind: string): string {
  if (typeof kind !== "string" || !KIND.test(kind)) throw new Error("Invalid work kind.");
  return kind;
}
function checkedState(state: WorkState): WorkState {
  if (state !== "working" && state !== "waiting") throw new Error("Invalid work state.");
  return state;
}
function count(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid work count.");
  return value;
}

export function createWorkLedger() {
  const entries = new Set<{ kind: string; state: WorkState }>();
  const probes = new Set<{ kind: string; read: () => Partial<WorkCounts> }>();

  function begin(kind: string, state: WorkState = "working"): WorkEntry {
    const entry = { kind: checkedKind(kind), state: checkedState(state) };
    entries.add(entry);
    return {
      set(next) { const checked = checkedState(next); if (entries.has(entry)) entry.state = checked; },
      end() { entries.delete(entry); },
    };
  }

  /** Working from now until `work` settles, whichever way. */
  async function track<T>(kind: string, work: Promise<T>): Promise<T> {
    const entry = begin(kind);
    try { return await work; } finally { entry.end(); }
  }

  /** For a module that already keeps its own in-flight state. Read on every
   * snapshot; a read that throws or returns a bad count counts as 1 working
   * (fail closed). Returns the unregister function. */
  function probe(kind: string, read: () => Partial<WorkCounts>): () => void {
    const registered = { kind: checkedKind(kind), read };
    probes.add(registered);
    return () => { probes.delete(registered); };
  }

  function snapshot(): WorkLedgerSnapshot {
    const byKind = new Map<string, WorkCounts>();
    let working = 0, waiting = 0;
    const add = (kind: string, counts: WorkCounts) => {
      if (!counts.working && !counts.waiting) return;
      const row = byKind.get(kind) ?? { working: 0, waiting: 0 };
      row.working += counts.working; row.waiting += counts.waiting; byKind.set(kind, row);
      working += counts.working; waiting += counts.waiting;
    };
    for (const entry of entries) add(entry.kind, entry.state === "working" ? { working: 1, waiting: 0 } : { working: 0, waiting: 1 });
    for (const { kind, read } of probes) {
      let counts: WorkCounts;
      try { const value = read(); counts = { working: count(value?.working), waiting: count(value?.waiting) }; }
      catch { counts = { working: 1, waiting: 0 }; }
      add(kind, counts);
    }
    return { working, waiting, byKind: Object.fromEntries(byKind) };
  }

  return { begin, track, probe, snapshot };
}
export type WorkLedger = ReturnType<typeof createWorkLedger>;

/** The one ledger this service process reports from. */
export const workLedger = createWorkLedger();
