// Redbark open-banking source for Workflow 1 (bank → reviewed REI CSV).
// API shapes follow https://api.redbark.com/v2/openapi.json (release
// 2026-10-01.wattle): `GET /accounts` and `GET /transactions` return
// `{object:"list", data, next_page_url, previous_page_url}`; money is
// `{amount: <integer minor units>, currency}`; a capped walk carries
// `X-Redbark-Truncated: true`; 429 and 503 carry Retry-After.
// The key is the office's own credential (see bank-credentials.ts). It is sent
// only to the Redbark API origin and never appears in an error or a result.
import { createHash } from "node:crypto";
import type { BankReferenceRule } from "./bank-reference.ts";
import type { BankReferenceStore, RedbarkCoverage, RedbarkHeldRow } from "./bank-reference-store.ts";
import {
  isLocalDate, REDBARK_ACCOUNT_ID, REDBARK_CONNECTION_ID, REDBARK_TRANSACTION_ID,
  type BankSourceUpload, type RedbarkBatchProvenance,
} from "../shared/bank-source.ts";

export const REDBARK_API_BASE = "https://api.redbark.com/v2";
export const REDBARK_API_VERSION = "2026-10-01.wattle";
const MAX_PAGES = 100;
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;
const MAX_BODY_BYTES = 5_000_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface RedbarkAccount {
  id: string; connection: string; provider: string; category: "banking" | "brokerage";
  name: string; type: string; institution: { id: string; name: string };
  /** Last four digits only, or null. */
  accountLast4: string | null;
  currency: string; status: string; lastUpdatedAt: string | null; livemode: boolean;
}
export interface RedbarkTransaction {
  id: string; account: string; status: "posted" | "pending"; date: string;
  postDate: string | null; valueDate: string | null;
  description: string; reference: string | null; extendedDescription: string | null;
  amountMinor: number; currency: string; direction: "credit" | "debit"; livemode: boolean;
}
export interface RedbarkTransactionPull {
  account: string; from: string; to: string;
  transactions: RedbarkTransaction[];
  /** Any page carried X-Redbark-Truncated: true. */
  truncated: boolean;
  /** Every returned row was livemode. */
  livemode: boolean;
  responseDigest: string;
  pages: number;
}

export class RedbarkError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, code: string, status = 502) { super(message); this.name = "RedbarkError"; this.code = code; this.status = status; }
}

type Fetch = (input: string, init: { method: "GET"; headers: Record<string, string>; redirect: "error"; signal?: AbortSignal }) => Promise<Response>;
export interface RedbarkClientOptions {
  key: string;
  fetch: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  apiVersion?: string;
}

const malformed = (what: string): never => { throw new RedbarkError(`Redbark returned ${what} RealBud could not verify. Nothing was saved.`, "redbark_malformed"); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const text = (value: unknown, max: number, what: string): string => (typeof value === "string" && value.length <= max && !CONTROL.test(value)) ? value : malformed(what);
const nullableText = (value: unknown, max: number, what: string): string | null => value === null ? null : text(value, max, what);
const nullableDate = (value: unknown, what: string): string | null => value === null ? null : isLocalDate(value) ? value : malformed(what);
const timestamp = (value: unknown, what: string): string | null => value === null ? null : (typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value))) ? value : malformed(what);

function retryAfterMs(header: string | null, now: number): number {
  if (!header) return 2_000;
  if (/^\d{1,6}$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? 2_000 : Math.max(0, at - now);
}

function upstreamFailure(status: number, requestId: string | undefined): RedbarkError {
  const suffix = requestId ? ` (Redbark request ${requestId})` : "";
  if (status === 401) return new RedbarkError(`Redbark did not accept the saved key. Replace the office's Redbark key and try again${suffix}.`, "redbark_auth", 409);
  if (status === 403) return new RedbarkError(`The saved Redbark key does not have data:read access, or this computer is not on its allowlist${suffix}.`, "redbark_permission", 409);
  if (status === 404) return new RedbarkError(`Redbark has no such account for the saved key${suffix}.`, "redbark_not_found", 404);
  if (status === 424) return new RedbarkError(`The bank did not return data through Redbark. Try again later${suffix}.`, "redbark_upstream");
  if (status === 429 || status === 503) return new RedbarkError(`Redbark is busy or the bank is unavailable. Try again later${suffix}.`, "redbark_unavailable", 503);
  if (status === 400) return new RedbarkError(`Redbark rejected the request${suffix}.`, "redbark_request");
  return new RedbarkError(`Redbark returned an unexpected error${suffix}.`, "redbark_error");
}

/** Typed, fail-closed client. Every 200 body is validated before use. */
export function createRedbarkClient(options: RedbarkClientOptions) {
  const key = options.key;
  if (typeof key !== "string" || !/^rbk_live_[A-Za-z0-9_-]{16,200}$/.test(key)) throw new RedbarkError("The saved Redbark key needs replacing.", "redbark_key_invalid", 409);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const apiVersion = options.apiVersion ?? REDBARK_API_VERSION;
  const base = new URL(`${REDBARK_API_BASE}/`);

  async function get(url: string): Promise<{ body: unknown; truncated: boolean }> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await options.fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { authorization: `Bearer ${key}`, "redbark-version": apiVersion, accept: "application/json" } });
      } catch {
        // The transport error can carry request details; never pass it on.
        throw new RedbarkError("Redbark could not be reached. Check the connection and try again.", "redbark_unreachable", 503);
      }
      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        const wait = retryAfterMs(response.headers.get("retry-after"), now());
        if (wait <= MAX_RETRY_WAIT_MS) { await response.body?.cancel().catch(() => {}); await sleep(wait); continue; }
      }
      const raw = await response.text().catch(() => "");
      if (raw.length > MAX_BODY_BYTES) return malformed("an oversized response");
      let body: unknown;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
      if (response.status !== 200) {
        const requestId = record(body) && record(body.error) && typeof body.error.request_id === "string" && /^req_[A-Za-z0-9]{1,64}$/.test(body.error.request_id) ? body.error.request_id : undefined;
        throw upstreamFailure(response.status, requestId);
      }
      if (body === undefined) return malformed("a response");
      return { body, truncated: response.headers.get("x-redbark-truncated")?.trim().toLowerCase() === "true" };
    }
  }

  /** Paging takes ONLY the opaque `page` token from next_page_url and calls our
   * configured base for the same path with that token alone (filters are
   * locked to the first call of a walk). The host in the response is never
   * used, so the key cannot be sent anywhere Redbark's reply names. */
  async function walk(path: "accounts" | "transactions", first: URL): Promise<{ items: unknown[]; truncated: boolean; pages: number }> {
    const items: unknown[] = [], seenTokens = new Set<string>();
    let url: string | null = first.toString(), truncated = false, pages = 0;
    while (url) {
      if (++pages > MAX_PAGES) return malformed("more pages than");
      const page = await get(url);
      truncated ||= page.truncated;
      const list = page.body;
      if (!record(list) || list.object !== "list" || !Array.isArray(list.data) || !("next_page_url" in list) || !("previous_page_url" in list)) return malformed("a list");
      items.push(...list.data);
      const next = list.next_page_url;
      if (next === null) { url = null; continue; }
      if (typeof next !== "string" || next.length > 4096) return malformed("a page link");
      let token: string | null;
      try { token = new URL(next, base).searchParams.get("page"); } catch { return malformed("a page link"); }
      if (!token || token.length > 2048 || !/^[\x21-\x7e]+$/.test(token) || seenTokens.has(token)) return malformed("a page link");
      seenTokens.add(token);
      const following = new URL(path, base);
      following.searchParams.set("page", token);
      url = following.toString();
    }
    return { items, truncated, pages };
  }

  function account(value: unknown): RedbarkAccount {
    if (!record(value) || value.object !== "account_item") return malformed("an account");
    const id = text(value.id, 40, "an account"), connection = text(value.connection, 60, "an account");
    if (!REDBARK_ACCOUNT_ID.test(id) || !REDBARK_CONNECTION_ID.test(connection)) return malformed("an account");
    if (value.category !== "banking" && value.category !== "brokerage") return malformed("an account");
    if (!record(value.institution) || typeof value.livemode !== "boolean") return malformed("an account");
    const number = nullableText(value.account_number, 40, "an account");
    const digits = number?.replace(/\D/g, "") ?? "";
    return { id, connection, provider: text(value.provider, 40, "an account"), category: value.category,
      name: text(value.name, 200, "an account"), type: text(value.type, 60, "an account"),
      institution: { id: text(value.institution.id, 100, "an account"), name: text(value.institution.name, 200, "an account") },
      // Redbark documents this as masked; keep only the last four digits regardless.
      accountLast4: digits ? digits.slice(-4) : null,
      currency: text(value.currency, 3, "an account").toLowerCase(), status: text(value.status, 40, "an account"),
      lastUpdatedAt: timestamp(value.last_updated_at, "an account"), livemode: value.livemode };
  }

  function transaction(value: unknown, expectedAccount: string): RedbarkTransaction {
    if (!record(value) || value.object !== "transaction") return malformed("a transaction");
    const id = text(value.id, 204, "a transaction");
    if (!REDBARK_TRANSACTION_ID.test(id) || value.account !== expectedAccount) return malformed("a transaction");
    if (value.status !== "posted" && value.status !== "pending") return malformed("a transaction status");
    if (!isLocalDate(value.date)) return malformed("a transaction date");
    if (value.direction !== "credit" && value.direction !== "debit") return malformed("a transaction direction");
    const money = value.amount;
    if (!record(money) || !Number.isSafeInteger(money.amount) || Math.abs(Number(money.amount)) >= 1e14 ||
        typeof money.currency !== "string" || !/^[A-Za-z]{3}$/.test(money.currency)) return malformed("a transaction amount");
    const amountMinor = Number(money.amount);
    // Amounts are signed minor units. A sign that contradicts `direction` means
    // the convention is not what RealBud verified, so nothing is guessed.
    if ((value.direction === "credit" && amountMinor < 0) || (value.direction === "debit" && amountMinor > 0)) return malformed("a transaction amount");
    if (typeof value.livemode !== "boolean") return malformed("a transaction");
    return { id, account: expectedAccount, status: value.status, date: value.date,
      postDate: nullableDate(value.post_date, "a posting date"), valueDate: nullableDate(value.value_date, "a value date"),
      description: text(value.description, 2000, "a transaction description"),
      reference: nullableText(value.reference, 500, "a transaction reference"),
      extendedDescription: nullableText(value.extended_description, 2000, "a transaction description"),
      amountMinor, currency: money.currency.toLowerCase(), direction: value.direction, livemode: value.livemode };
  }

  return {
    async listAccounts(): Promise<RedbarkAccount[]> {
      const first = new URL("accounts", base); first.searchParams.set("limit", "100");
      const { items } = await walk("accounts", first);
      const accounts = items.map(account);
      if (new Set(accounts.map(a => a.id)).size !== accounts.length) return malformed("duplicate accounts");
      return accounts;
    },
    async listTransactions(input: { account: string; from: string; to: string }): Promise<RedbarkTransactionPull> {
      if (!REDBARK_ACCOUNT_ID.test(input.account) || !isLocalDate(input.from) || !isLocalDate(input.to) || input.from > input.to) {
        throw new RedbarkError("Choose a Redbark account and a valid date range.", "redbark_request", 400);
      }
      const first = new URL("transactions", base);
      first.searchParams.set("account", input.account);
      first.searchParams.set("from", input.from);
      first.searchParams.set("to", input.to);
      first.searchParams.set("limit", "100");
      first.searchParams.set("include_pending", "false");
      const { items, truncated, pages } = await walk("transactions", first);
      const byId = new Map<string, RedbarkTransaction>();
      for (const item of items) {
        const row = transaction(item, input.account);
        const seen = byId.get(row.id);
        // A repeated id across pages must be the same transaction.
        if (seen && JSON.stringify(seen) !== JSON.stringify(row)) return malformed("conflicting copies of a transaction");
        byId.set(row.id, row);
      }
      const transactions = [...byId.values()];
      const responseDigest = createHash("sha256").update(JSON.stringify(transactions)).digest("hex");
      return { account: input.account, from: input.from, to: input.to, transactions, truncated,
        livemode: transactions.every(row => row.livemode), responseDigest, pages };
    },
  };
}
export type RedbarkClient = ReturnType<typeof createRedbarkClient>;

const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;
const formatMinor = (minor: number) => {
  const sign = minor < 0 ? "-" : "", abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};
export const REDBARK_CSV_COLUMNS = { date: "Date", amount: "Amount", narrative: "Narrative", reference: "Reference" } as const;

/** Canonical REI CSV from validated rows: Date (bank posting date, else the
 * transaction date — never the run day), signed Amount, Narrative, Reference.
 * Pending rows and already-confirmed ids are left out and counted. Rows held
 * in an earlier review (`held`) are carried in with their saved data and id
 * unless this pull returned that id itself; `carried` counts them. */
export function redbarkBankUpload(input: {
  account: RedbarkAccount; pull: RedbarkTransactionPull; runDate: string; retrievedAt: string;
  confirmedIds?: ReadonlySet<string>; held?: Readonly<Record<string, RedbarkHeldRow>>; apiVersion?: string;
}): { source: BankSourceUpload | null; included: number; pending: number; alreadyConfirmed: number; carried: number } {
  const { account, pull } = input;
  if (account.id !== pull.account || !isLocalDate(input.runDate)) throw new RedbarkError("The Redbark pull does not match the selected account.", "redbark_request", 400);
  let pending = 0, alreadyConfirmed = 0;
  const rows = pull.transactions.filter(row => {
    if (row.status === "pending") { pending++; return false; }
    if (input.confirmedIds?.has(row.id)) { alreadyConfirmed++; return false; }
    return true;
  }).map(row => ({ id: row.id, date: row.postDate ?? row.date, currency: row.currency, amount: formatMinor(row.amountMinor),
    narrative: row.extendedDescription && row.extendedDescription !== row.description ? `${row.description} ${row.extendedDescription}` : row.description,
    reference: row.reference ?? "" }));
  const returned = new Set(pull.transactions.map(row => row.id));
  const carried = Object.entries(input.held ?? {}).filter(([id]) => !returned.has(id) && !input.confirmedIds?.has(id))
    .map(([id, row]) => ({ id, date: row.date, currency: "aud", amount: row.amount, narrative: row.narrative, reference: row.reference }));
  rows.push(...carried);
  rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (rows.some(row => row.currency !== "aud")) throw new RedbarkError("This Redbark account returned a non-AUD transaction. REI receipting needs AUD rows.", "redbark_currency", 409);
  if (!rows.length) return { source: null, included: 0, pending, alreadyConfirmed, carried: 0 };
  const csv = [[REDBARK_CSV_COLUMNS.date, REDBARK_CSV_COLUMNS.amount, REDBARK_CSV_COLUMNS.narrative, REDBARK_CSV_COLUMNS.reference].join(","),
    ...rows.map(row => [row.date, row.amount, row.narrative, row.reference].map(csvCell).join(","))].join("\r\n") + "\r\n";
  const provenance: RedbarkBatchProvenance = { kind: "redbark-api", version: 1, originalBankExport: false, apiVersion: input.apiVersion ?? REDBARK_API_VERSION,
    connection: account.connection, account: account.id, requestedFrom: pull.from, requestedTo: pull.to, runDate: input.runDate,
    retrievedAt: input.retrievedAt, responseDigest: pull.responseDigest, livemode: true, transactionIds: rows.map(row => row.id) };
  return { source: { filename: `redbark-${account.id}-${input.runDate}.csv`, bytesBase64: Buffer.from(csv, "utf8").toString("base64"), provenance },
    included: rows.length, pending, alreadyConfirmed, carried: carried.length };
}

/** Office-local calendar date; the system zone when the office has none. */
export function localDate(at: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface RedbarkPullSummary {
  batch: { id: string; revision: number; rows: number; originalDigest: string; originalBytesCaptured: false } | null;
  window: { from: string; to: string; firstRun: boolean };
  pending: number; alreadyConfirmed: number; returned: number;
  /** Rows held in an earlier review and carried into this one. */
  carried: number;
  coverage: { coveredThrough: string | null; revision: number };
}

/** One pull: window from the confirmed cursor, validated transactions, one
 * review batch. Nothing advances coverage here; only confirm-import does. */
export async function pullRedbarkReview(deps: {
  client: RedbarkClient; store: BankReferenceStore; coverage: RedbarkCoverage;
  account: unknown; today: string; rules: BankReferenceRule[]; now?: () => Date;
}): Promise<RedbarkPullSummary> {
  if (typeof deps.account !== "string" || !REDBARK_ACCOUNT_ID.test(deps.account)) throw new RedbarkError("Choose a Redbark bank account.", "redbark_request", 400);
  const accountId = deps.account;
  const account = (await deps.client.listAccounts()).find(item => item.id === accountId);
  if (!account) throw new RedbarkError("That Redbark account is not available to the saved key.", "redbark_not_found", 404);
  if (account.category !== "banking") throw new RedbarkError("Choose a Redbark bank account, not a brokerage account.", "redbark_request", 400);
  const state = await deps.coverage.state(accountId);
  if (state && state.connection !== account.connection) throw new RedbarkError("This Redbark account now belongs to a different bank connection. Review the account before pulling again.", "redbark_account_changed", 409);
  const window = deps.coverage.window(state, deps.today);
  const pull = await deps.client.listTransactions({ account: accountId, from: window.from, to: window.to });
  // An incomplete or test-mode walk cannot become a review batch: coverage
  // could later be confirmed for rows that were never seen.
  if (pull.truncated) throw new RedbarkError("Redbark capped this response at its row limit. No review batch was created. Ask your administrator to narrow the covered period.", "redbark_truncated", 409);
  if (!pull.livemode || !account.livemode) throw new RedbarkError("Redbark returned test-mode data. No review batch was created.", "redbark_test_mode", 409);
  const built = redbarkBankUpload({ account, pull, runDate: deps.today, retrievedAt: (deps.now?.() ?? new Date()).toISOString(),
    confirmedIds: new Set(Object.keys(state?.confirmed ?? {})), held: state?.held });
  const summary = { window: { from: window.from, to: window.to, firstRun: !state }, pending: built.pending, alreadyConfirmed: built.alreadyConfirmed, carried: built.carried,
    returned: pull.transactions.length, coverage: { coveredThrough: state?.coveredThrough ?? null, revision: state?.revision ?? 0 } };
  if (!built.source) return { batch: null, ...summary };
  const created = deps.store.createFromRedbark({ source: built.source, columns: { ...REDBARK_CSV_COLUMNS }, dateFormat: "YYYY-MM-DD", rules: deps.rules });
  // Jev payer hints are asked once here, before anyone has the batch's revision.
  const saved = await deps.store.addJevHints(created.id);
  return { batch: { id: saved.id, revision: saved.revision, rows: saved.value.batch.rows.length, originalDigest: saved.value.batch.originalDigest, originalBytesCaptured: false }, ...summary };
}
