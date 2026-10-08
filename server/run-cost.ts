/**
 * What one run's AI use cost. The model relays (`ask-model-relay.ts`,
 * `department-worker.ts`) record the Modelvia requests a run made as a
 * `RunUsage`; the price is read from each request's Modelvia receipt when a
 * person asks, never stored or computed from a local price table
 * (docs/decisions/2026-09-24-modelvia-sole-billing.md).
 *
 * Nothing here logs a request, a response body or the key.
 */
import type { RunDecisionUsage, RunUsage } from "../shared/contracts.ts";
import { modelviaRefusal, parseModelviaReceipt, type ModelviaReceipt } from "../shared/modelvia-receipt.ts";

/** A run keeps at most this many request ids; a full list may be incomplete. */
export const MAX_RUN_REQUEST_IDS = 200;
/** The receipt id shape (`ID` in shared/modelvia-receipt.ts). */
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const RECEIPT_TIMEOUT_MS = 10_000;
const RECEIPT_CONCURRENCY = 4;
const MAX_RECEIPT_BYTES = 64 * 1024;

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const count = (value: unknown): number | undefined => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;

/** `unidentified` counts calls whose answer carried no usable request id (a
 * repeated id is one receipt, not a gap). Any such call makes the run's price
 * incomplete. Absent means none.
 * ponytail: declared here, not on shared/contracts.ts RunUsage (outside this
 * change's files); move it there when that file is next edited. */
export type RecordedRunUsage = RunUsage & { unidentified?: number };

export function emptyRunUsage(): RecordedRunUsage { return { requestIds: [], calls: 0 }; }

const usableId = (id: unknown): id is string => typeof id === "string" && REQUEST_ID.test(id);
function addRequestId(usage: RunUsage, id: string): void {
  if (!usage.requestIds.includes(id) && usage.requestIds.length < MAX_RUN_REQUEST_IDS) usage.requestIds.push(id);
}

/** One request forwarded to Modelvia, with the `X-Request-Id` its answer carried. */
export function noteModelviaRequest(usage: RecordedRunUsage, requestId: string | null): void {
  usage.calls += 1;
  if (usableId(requestId)) addRequestId(usage, requestId);
  else usage.unidentified = (usage.unidentified ?? 0) + 1;
}

/** A non-streamed JSON answer: its token `usage`, and on a 409
 * `request_already_processed` the original request's id from its receipt,
 * which identifies a call whose answer carried no id of its own.
 * ponytail: with two calls of one lease in flight, that call may be a
 * different id-less one; pass the reply's own header id here if that matters. */
export function noteModelviaReply(usage: RecordedRunUsage, body: unknown): void {
  const refusal = modelviaRefusal(body);
  const original = refusal?.code === "request_already_processed" ? refusal.receipt?.requestId : undefined;
  if (usableId(original)) {
    addRequestId(usage, original);
    if (usage.unidentified) { usage.unidentified -= 1; if (!usage.unidentified) delete usage.unidentified; }
  }
  const tokens = record(body) && record(body.usage) ? body.usage : null;
  const input = count(tokens?.prompt_tokens), output = count(tokens?.completion_tokens);
  if (input !== undefined) usage.inputTokens = (usage.inputTokens ?? 0) + input;
  if (output !== undefined) usage.outputTokens = (usage.outputTokens ?? 0) + output;
}

/** What `recordJevUsage` reads from a jev-client `decide` result. */
export interface JevCall { ok: boolean; id?: string; model?: string; ms?: number; usage?: { input_tokens: number; output_tokens: number } }
const MODEL = /^[\w.:/-]{1,100}$/;
function decisionRow(value: unknown): RunDecisionUsage | null {
  if (!record(value) || !usableId(value.id)) return null;
  const input = count(value.inputTokens), output = count(value.outputTokens), ms = count(value.ms);
  return { id: value.id, ...(typeof value.model === "string" && MODEL.test(value.model) ? { model: value.model } : {}),
    ...(input !== undefined ? { inputTokens: input } : {}), ...(output !== undefined ? { outputTokens: output } : {}), ...(ms !== undefined ? { ms } : {}) };
}
function addDecision(usage: RunUsage, row: RunDecisionUsage | null): void {
  if (!row || (usage.decisions?.length ?? 0) >= MAX_RUN_REQUEST_IDS || usage.decisions?.some(saved => saved.id === row.id)) return;
  (usage.decisions ??= []).push(row);
}

/**
 * One Jev decision into the run that asked it: its Modelvia request id (so the
 * run's cost prices it from its receipt, like any relayed call) and a
 * `decisions` row with model, tokens and milliseconds. Never the state,
 * questions or answers. A result without an id was refused or never answered;
 * Modelvia charges no refusal.
 * ponytail: a timeout after dispatch may still be charged with no id to price
 * it, the same gap the relays have for a dropped answer; count it as
 * `unidentified` if Modelvia shows such charges.
 */
export function recordJevUsage(usage: RecordedRunUsage, result: JevCall): void {
  if (!usableId(result.id)) return;
  noteModelviaRequest(usage, result.id);
  addDecision(usage, decisionRow({ id: result.id, model: result.model, ms: result.ms,
    inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens }));
}

/** `decide`, recording each answer into `usage` (`recordJevUsage`). */
export function countJevUsage<A extends unknown[], R extends JevCall>(usage: RecordedRunUsage, decide: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => { const result = await decide(...args); recordJevUsage(usage, result); return result; };
}

/** `from` added into `into` (returned): calls, ids, tokens and decisions. */
export function addRunUsage(into: RecordedRunUsage, from: RecordedRunUsage | undefined): RecordedRunUsage {
  if (!from) return into;
  into.calls += from.calls;
  for (const id of from.requestIds) addRequestId(into, id);
  if (from.unidentified) into.unidentified = (into.unidentified ?? 0) + from.unidentified;
  if (from.inputTokens !== undefined) into.inputTokens = (into.inputTokens ?? 0) + from.inputTokens;
  if (from.outputTokens !== undefined) into.outputTokens = (into.outputTokens ?? 0) + from.outputTokens;
  for (const row of from.decisions ?? []) addDecision(into, row);
  return into;
}

/** A saved usage record, or undefined when absent or unreadable: a run saved
 * before usage was recorded loads without it. */
export function cleanRunUsage(value: unknown): RecordedRunUsage | undefined {
  if (!record(value) || !Array.isArray(value.requestIds)) return undefined;
  const calls = count(value.calls), unidentified = count(value.unidentified);
  // An unreadable count of id-less calls never reads as none.
  if (calls === undefined || value.unidentified !== undefined && unidentified === undefined) return undefined;
  const usage: RecordedRunUsage = { requestIds: [], calls };
  for (const id of value.requestIds) if (usableId(id)) addRequestId(usage, id);
  if (unidentified) usage.unidentified = unidentified;
  const input = count(value.inputTokens), output = count(value.outputTokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  // A malformed decisions row is dropped, like an unusable id.
  if (Array.isArray(value.decisions)) for (const row of value.decisions) addDecision(usage, decisionRow(row));
  return usage;
}

/** What the run view shows. Money is Modelvia's charged nanoAUD, summed. */
export type RunCost =
  | { state: "none" }
  /** `decisionsNanoAud`: the part of the total charged for Jev decisions
   * (`usage.decisions`), present only when above zero. The total includes it. */
  | { state: "priced"; requests: number; chargedNanoAud: string; decisionsNanoAud?: string }
  | { state: "pending"; requests: number }
  | { state: "not-priced"; requests: number }
  /** Some calls carried no receipt id: their charge cannot be read, so no sum is a total. */
  | { state: "incomplete"; requests: number }
  | { state: "unavailable"; requests: number };

/** The office's granted endpoint and key, read by the caller per request. */
export interface RunCostAccess { baseUrl: string; key: string }

/** Final receipt states; anything else may still change its charge. */
const FINAL = new Set(["settled", "released"]);

async function readReceipt(fetcher: typeof fetch, base: string, key: string, id: string, signal: AbortSignal): Promise<ModelviaReceipt> {
  const response = await fetcher(`${base}/requests/${encodeURIComponent(id)}`, {
    method: "GET", headers: { accept: "application/json", authorization: `Bearer ${key}` }, redirect: "error", signal,
  });
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body?.getReader();
  if (reader) for (let part = await reader.read(); !part.done; part = await reader.read()) {
    size += part.value.length;
    if (size > MAX_RECEIPT_BYTES) { await reader.cancel(); throw new Error("receipt too large"); }
    chunks.push(part.value);
  }
  if (!response.ok) throw new Error("receipt refused");
  const receipt = parseModelviaReceipt(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (receipt.requestId !== id) throw new Error("receipt for another request");
  return receipt;
}

/**
 * Sum one run's Modelvia receipts. Withheld is "not priced" (never A$0), an
 * unsettled receipt makes the run "pending", and any failure reads as
 * "unavailable" rather than a partial total. Wholesale and margin are never
 * read: a project key's receipt carries only the office's own charge.
 */
export async function runCost(usage: RecordedRunUsage | undefined, access: RunCostAccess | null, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<RunCost> {
  if (!usage || usage.calls === 0 && usage.requestIds.length === 0) return { state: "none" };
  const requests = Math.max(usage.calls, usage.requestIds.length);
  if (usage.unidentified) return { state: "incomplete", requests };
  // ponytail: a run past MAX_RUN_REQUEST_IDS shows "unavailable" rather than
  // an understated sum; keep every id (or a running total) if runs grow that long.
  if (!access || !usage.requestIds.length || usage.requestIds.length >= MAX_RUN_REQUEST_IDS) return { state: "unavailable", requests };
  let base: URL;
  try { base = new URL(access.baseUrl); } catch { return { state: "unavailable", requests }; }
  if (base.username || base.password || base.search || base.hash ||
      !(base.protocol === "https:" || base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) {
    return { state: "unavailable", requests };
  }
  const fetcher = options.fetch ?? fetch;
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(options.timeoutMs ?? RECEIPT_TIMEOUT_MS)]);
  const ids = usage.requestIds, receipts: ModelviaReceipt[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length && !signal.aborted) receipts.push(await readReceipt(fetcher, access.baseUrl.replace(/\/+$/, ""), access.key, ids[next++]!, signal));
  };
  try { await Promise.all(Array.from({ length: Math.min(RECEIPT_CONCURRENCY, ids.length) }, worker)); }
  catch { stop.abort(); return { state: "unavailable", requests }; }
  if (receipts.length !== ids.length) return { state: "unavailable", requests };
  if (receipts.some(receipt => receipt.priceBasis === "withheld")) return { state: "not-priced", requests };
  if (receipts.some(receipt => !FINAL.has(receipt.state))) return { state: "pending", requests };
  const decisionIds = new Set(usage.decisions?.map(row => row.id));
  let total = 0n, decisions = 0n;
  for (const receipt of receipts) {
    if (receipt.chargedNanoAud === null) return { state: "unavailable", requests };
    total += BigInt(receipt.chargedNanoAud);
    if (decisionIds.has(receipt.requestId)) decisions += BigInt(receipt.chargedNanoAud);
  }
  return { state: "priced", requests, chargedNanoAud: total.toString(), ...(decisions > 0n ? { decisionsNanoAud: decisions.toString() } : {}) };
}
