// W1 (bank → reviewed REI file → person posts → readback) run records.
// One private 0600 JSON file beside the workflow data; the server is the only
// writer and every write to a path goes through one in-process queue for that
// path (serializeFile), whichever store instance makes it. A damaged or unknown file holds every
// run ("needs recovery") and is never cleared.
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";

export const W1_STEPS = ["fetch", "review", "sign_in", "upload", "handoff", "readback", "check_outcome", "confirm", "done"] as const;
export type W1Step = typeof W1_STEPS[number];
export const W1_ATTENTION = ["sign_in", "account_mismatch", "duplicate_ids", "already_imported", "review_changed", "preview_mismatch",
  "handoff_failed", "readback_failed", "readback_mismatch", "pending_rows", "rejected_rows", "nothing_found", "outcome_unknown",
  "coverage_conflict", "confirm_failed", "fetch_failed", "nothing_to_import", "pending_unknown"] as const;
export type W1AttentionReason = typeof W1_ATTENTION[number];
export type W1Outcome = "imported" | "nothing_new" | "abandoned";

export interface W1PreviewRow { transactionId: string; included: boolean }
export interface W1Preview { previewId: string; destination: string; artifactDigest: string; rows: W1PreviewRow[]; warnings: string[] }
export type W1RowStatus = "accepted" | "rejected" | "pending";
export interface W1ReadbackRow { transactionId: string; status: W1RowStatus }
export interface W1ReadbackFound { kind: "found"; importRef: string; destination: string; artifactDigest: string; rows: W1ReadbackRow[] }

export interface W1Run {
  version: 1; kind: "w1-run"; id: string; revision: number;
  account: string; destination: string; createdAt: string; updatedAt: string;
  step: W1Step;
  /** Why the run stopped at its current step. The step is kept, so the next
   * advance retries that step (never a later one). */
  attention: { reason: W1AttentionReason; message: string } | null;
  fetch: { today: string; from: string; to: string; coverageRevision: number; batchId: string; transactionIds: string[] } | null;
  /** importIds are the REI import file's rows (preview, readback and confirm
   * match these); held and excluded rows stay out of REI and are listed here. */
  review: { batchId: string; outputDigest: string; importIds: string[]; heldIds: string[]; excludedIds: string[] } | null;
  /** Written before the upload call. An attempt without a preview after a
   * restart or a lost reply is an unknown outcome, never a reason to re-send. */
  upload: { attemptId: string; startedAt: string; batchId: string; artifactDigest: string; preview: W1Preview | null } | null;
  handoff: { at: string } | null;
  posting: { reportedAt: string; outcome: "posted" | "unsure" } | null;
  uncertain: { kind: "upload" | "posting"; since: string; inspection: "nothing" | "unknown" | null } | null;
  readback: { importRef: string; rows: W1ReadbackRow[] } | null;
  confirm: { startedAt: string; coveredThrough: string | null; coverageRevision: number | null } | null;
  outcome: W1Outcome | null;
  log: { at: string; step: W1Step; event: string }[];
}

interface W1File { version: 1; kind: "w1-runs"; runs: W1Run[] }

export const W1_ACCOUNT = /^[A-Za-z0-9_.:-]{1,100}$/;
export const W1_DESTINATION = /^[A-Za-z0-9_.:-]{1,100}$/;
export const W1_TRANSACTION = /^[A-Za-z0-9_.:-]{1,200}$/;
const RUN_ID = /^w1run_[a-f0-9-]{36}$/;
const ATTEMPT_ID = /^w1up_[a-f0-9-]{36}$/;
const REF = /^[A-Za-z0-9_.:\/-]{1,200}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BYTES = 8_000_000;
const MAX_LOG = 40;
const KEEP_FINISHED = 200;

export const newRunId = () => `w1run_${randomUUID()}`;
export const newAttemptId = () => `w1up_${randomUUID()}`;
export const isActive = (run: W1Run) => run.step !== "done";

const hold = (): never => { throw Object.assign(new Error("The saved bank import runs need recovery. Nothing was changed."), { status: 503 }); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: unknown, expected: string): v is Record<string, unknown> => object(v) && Object.keys(v).sort().join(",") === expected;
const str = (v: unknown, pattern?: RegExp): v is string => typeof v === "string" && (!pattern || pattern.test(v));
const time = (v: unknown) => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const nat = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const list = (v: unknown, each: (item: unknown) => boolean, max = 100_000) => Array.isArray(v) && v.length <= max && v.every(each);
const nullOr = (v: unknown, check: (value: unknown) => boolean) => v === null || check(v);

function validPreview(v: unknown) {
  return keys(v, "artifactDigest,destination,previewId,rows,warnings") && str(v.previewId, REF) && str(v.destination, W1_DESTINATION) && str(v.artifactDigest, DIGEST) &&
    list(v.rows, row => keys(row, "included,transactionId") && str(row.transactionId, W1_TRANSACTION) && typeof row.included === "boolean") &&
    list(v.warnings, w => typeof w === "string" && w.length <= 1000, 500);
}
const validReadbackRows = (v: unknown) => list(v, row => keys(row, "status,transactionId") && str(row.transactionId, W1_TRANSACTION) &&
  (row.status === "accepted" || row.status === "rejected" || row.status === "pending"));

function validRun(r: unknown): boolean {
  if (!keys(r, "account,attention,confirm,createdAt,destination,fetch,handoff,id,kind,log,outcome,posting,readback,review,revision,step,uncertain,updatedAt,upload,version")) return false;
  return r.version === 1 && r.kind === "w1-run" && str(r.id, RUN_ID) && Number.isSafeInteger(r.revision) && Number(r.revision) >= 1 &&
    str(r.account, W1_ACCOUNT) && str(r.destination, W1_DESTINATION) && time(r.createdAt) && time(r.updatedAt) &&
    (W1_STEPS as readonly unknown[]).includes(r.step) &&
    nullOr(r.attention, a => keys(a, "message,reason") && (W1_ATTENTION as readonly unknown[]).includes(a.reason) && typeof a.message === "string" && a.message.length <= 1000) &&
    nullOr(r.fetch, f => keys(f, "batchId,coverageRevision,from,to,today,transactionIds") && str(f.today, DATE) && str(f.from, DATE) && str(f.to, DATE) &&
      nat(f.coverageRevision) && str(f.batchId, REF) && list(f.transactionIds, id => str(id, W1_TRANSACTION))) &&
    nullOr(r.review, v => keys(v, "batchId,excludedIds,heldIds,importIds,outputDigest") && str(v.batchId, REF) && str(v.outputDigest, DIGEST) &&
      [v.importIds, v.heldIds, v.excludedIds].every(ids => list(ids, id => str(id, W1_TRANSACTION)))) &&
    nullOr(r.upload, u => keys(u, "artifactDigest,attemptId,batchId,preview,startedAt") && str(u.attemptId, ATTEMPT_ID) && time(u.startedAt) &&
      str(u.batchId, REF) && str(u.artifactDigest, DIGEST) && nullOr(u.preview, validPreview)) &&
    nullOr(r.handoff, h => keys(h, "at") && time(h.at)) &&
    nullOr(r.posting, p => keys(p, "outcome,reportedAt") && time(p.reportedAt) && (p.outcome === "posted" || p.outcome === "unsure")) &&
    nullOr(r.uncertain, u => keys(u, "inspection,kind,since") && (u.kind === "upload" || u.kind === "posting") && time(u.since) &&
      (u.inspection === null || u.inspection === "nothing" || u.inspection === "unknown")) &&
    nullOr(r.readback, b => keys(b, "importRef,rows") && str(b.importRef, REF) && validReadbackRows(b.rows)) &&
    nullOr(r.confirm, c => keys(c, "coverageRevision,coveredThrough,startedAt") && time(c.startedAt) && nullOr(c.coveredThrough, d => str(d, DATE)) && nullOr(c.coverageRevision, nat)) &&
    (r.outcome === null || r.outcome === "imported" || r.outcome === "nothing_new" || r.outcome === "abandoned") &&
    (r.step === "done") === (r.outcome !== null) &&
    list(r.log, e => keys(e, "at,event,step") && time(e.at) && (W1_STEPS as readonly unknown[]).includes(e.step) && typeof e.event === "string" && e.event.length <= 300, MAX_LOG);
}

export function validateW1File(value: unknown): W1File {
  if (!keys(value, "kind,runs,version") || value.version !== 1 || value.kind !== "w1-runs" || !Array.isArray(value.runs) || !value.runs.every(validRun)) return hold();
  const ids = new Set((value.runs as W1Run[]).map(run => run.id));
  if (ids.size !== value.runs.length) return hold();
  return value as unknown as W1File;
}

/** Counts each stable transaction id. Two legitimate payments with the same
 * date, amount and narrative are two ids; nothing here compares amounts. */
export function compareTransactionIds(expected: readonly string[], observed: readonly string[]) {
  const counts = new Map<string, number>();
  for (const id of expected) counts.set(id, (counts.get(id) ?? 0) + 1);
  const unexpected: string[] = [];
  for (const id of observed) {
    const left = counts.get(id) ?? 0;
    if (left > 0) counts.set(id, left - 1); else unexpected.push(id);
  }
  const missing = [...counts].flatMap(([id, n]) => Array<string>(n).fill(id));
  return { missing, unexpected, same: missing.length === 0 && unexpected.length === 0 };
}

export const duplicateIds = (ids: readonly string[]) => [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];

export function blankRun(input: { account: string; destination: string; at: string; id?: string }): W1Run {
  return { version: 1, kind: "w1-run", id: input.id ?? newRunId(), revision: 1, account: input.account, destination: input.destination,
    createdAt: input.at, updatedAt: input.at, step: "fetch", attention: null, fetch: null, review: null, upload: null, handoff: null,
    posting: null, uncertain: null, readback: null, confirm: null, outcome: null, log: [{ at: input.at, step: "fetch", event: "Run started." }] };
}

export function logged(run: W1Run, at: string, event: string): W1Run["log"] {
  return [...run.log, { at, step: run.step, event: event.slice(0, 300) }].slice(-MAX_LOG);
}

/** One queue per file path for this process: every store instance (and the
 * host's evidence file) writes through it, so a read-modify-write never
 * interleaves with another on the same file. Writes themselves are
 * writePrivateJson's temp → fsync → rename. */
const queues = new Map<string, Promise<unknown>>();
export function serializeFile<T>(path: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(path) ?? Promise.resolve()).then(work, work);
  const tail = next.catch(() => {});
  queues.set(path, tail);
  void tail.then(() => { if (queues.get(path) === tail) queues.delete(path); });
  return next;
}

export class W1StateStore {
  private path: string;
  constructor(directory: string) { this.path = join(directory, "w1", "runs.json"); }
  private async load(): Promise<W1File> {
    const saved = await readPrivateJson(this.path, MAX_BYTES);
    return saved === undefined ? { version: 1, kind: "w1-runs", runs: [] } : validateW1File(saved);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> { return serializeFile(this.path, work); }
  private async save(file: W1File) {
    const finished = file.runs.filter(run => !isActive(run));
    const drop = new Set(finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED)).map(run => run.id));
    const next: W1File = { ...file, runs: file.runs.filter(run => !drop.has(run.id)) };
    validateW1File(next);
    await writePrivateJson(this.path, next, { maxBytes: MAX_BYTES, validate: validateW1File });
  }
  /** Reads queue behind pending writes too, so a read never sees an older file than a write it follows. */
  async list(): Promise<W1Run[]> { return (await this.serial(() => this.load())).runs; }
  async get(id: string): Promise<W1Run> {
    const run = (await this.serial(() => this.load())).runs.find(item => item.id === id);
    if (!run) throw Object.assign(new Error("That bank import run is no longer available."), { status: 404 });
    return run;
  }
  /** Creates a run unless another active run already uses its bank account or
   * REI destination: overlapping pulls could otherwise import a payment twice. */
  create(run: W1Run): Promise<W1Run> {
    return this.serial(async () => {
      const file = await this.load();
      if (file.runs.some(other => isActive(other) && (other.account === run.account || other.destination === run.destination)))
        throw Object.assign(new Error("A bank import for this account or REI destination is still open. Finish or check it first."), { status: 409 });
      await this.save({ ...file, runs: [...file.runs, run] });
      return run;
    });
  }
  /** Compare-and-set inside the serialized section. */
  update(id: string, expectedRevision: number, change: (run: W1Run) => W1Run, at: string): Promise<W1Run> {
    return this.serial(async () => {
      const file = await this.load();
      const index = file.runs.findIndex(run => run.id === id);
      if (index < 0) throw Object.assign(new Error("That bank import run is no longer available."), { status: 404 });
      if (file.runs[index].revision !== expectedRevision) throw Object.assign(new Error("This bank import changed. Reload it and try again."), { status: 409 });
      const changed = change(file.runs[index]);
      const next: W1Run = { ...changed, id, account: file.runs[index].account, destination: file.runs[index].destination, revision: expectedRevision + 1, updatedAt: at };
      if (!validRun(next)) throw Object.assign(new Error("The bank import step could not be saved. Nothing was changed."), { status: 500 });
      const runs = [...file.runs]; runs[index] = next;
      await this.save({ ...file, runs });
      return next;
    });
  }
}
