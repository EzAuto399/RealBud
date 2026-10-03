// The office's bank feed as an injected provider. Owner decision 2026-10-02:
// RealBud reaches Redbark through its MCP server with OAuth (Connect, approve
// scopes); the MCP connection (built in another packet) supplies
// `listBankAccounts()` and `listBankTransactions({account, from, to})`. Until
// it is wired, every bank route answers 409 bank_not_connected.
//
// W1 keeps redbark-source.ts's validation and CSV building: provider results
// are checked here and handed to pullRedbarkReview through a client-shaped
// adapter, so a pull from the provider becomes the same review batch.
import { createHash } from "node:crypto";
import type { RedbarkAccount, RedbarkClient, RedbarkTransaction } from "./redbark-source.ts";
import { isLocalDate, REDBARK_ACCOUNT_ID, REDBARK_CONNECTION_ID, REDBARK_TRANSACTION_ID } from "../shared/bank-source.ts";

export interface BankAccountSummary {
  id: string; name: string; institution: string;
  /** Last digits only, e.g. "····4321", or null. */
  numberMasked: string | null;
  /** Redbark's connection id for the account (coverage is bound to it). */
  connection: string;
  category?: "banking" | "brokerage";
  /** False for Redbark test-mode data; absent means live. */
  livemode?: boolean;
}
export interface BankTransaction {
  id: string;
  /** Local calendar date (YYYY-MM-DD), never a UTC instant. */
  postDate: string;
  description: string; reference: string | null;
  direction: "debit" | "credit";
  /** Signed integer cents: negative for debits. */
  amountCents: number;
  currency: "AUD";
}
export interface BankTransactions { account: Omit<BankAccountSummary, "connection" | "category" | "livemode">; from: string; to: string; transactions: BankTransaction[]; truncated: boolean }
export interface BankProvider {
  listBankAccounts(): Promise<BankAccountSummary[]>;
  /** Posted transactions only, newest first. */
  listBankTransactions(input: { account: string; from: string; to: string }): Promise<BankTransactions>;
}

let connected: BankProvider | null = null;
/** Set by the Redbark MCP connection once the office has connected (null when disconnected). */
export function setBankProvider(provider: BankProvider | null): void { connected = provider; }
export const connectedBankProvider = (): BankProvider | null => connected;

export const BANK_NOT_CONNECTED = "Connect Redbark in Workspace → Connected apps.";
export const bankNotConnected = () => Object.assign(new Error(BANK_NOT_CONNECTED), { status: 409, code: "bank_not_connected" });
const malformed = (): never => { throw Object.assign(new Error("The bank feed returned data RealBud could not verify. Nothing was saved."), { status: 502, code: "bank_malformed" }); };
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max && !CONTROL.test(v);

function account(value: BankAccountSummary): BankAccountSummary {
  if (!value || !REDBARK_ACCOUNT_ID.test(value.id) || !REDBARK_CONNECTION_ID.test(value.connection) || !text(value.name, 200) || !text(value.institution, 200) ||
      !(value.numberMasked === null || (typeof value.numberMasked === "string" && /^[·•x*\s]*\d{0,4}$/.test(value.numberMasked))) ||
      !(value.category === undefined || value.category === "banking" || value.category === "brokerage") || !(value.livemode === undefined || typeof value.livemode === "boolean")) return malformed();
  return value;
}
function transaction(value: BankTransaction): BankTransaction {
  if (!value || !REDBARK_TRANSACTION_ID.test(value.id) || !isLocalDate(value.postDate) || !text(value.description, 2000) || !(value.reference === null || text(value.reference, 500)) ||
      !Number.isSafeInteger(value.amountCents) || Math.abs(value.amountCents) >= 1e14 || value.currency !== "AUD" ||
      (value.direction !== "credit" && value.direction !== "debit") || (value.direction === "credit" && value.amountCents < 0) || (value.direction === "debit" && value.amountCents > 0)) return malformed();
  return value;
}

/** GET /api/bank-source/redbark/transactions: read-only. Posted transactions for
 * one account and at most 93 days, newest first, account number masked. No
 * review batch, no coverage change, no REI. */
export async function readBankTransactions(provider: BankProvider | null, query: URLSearchParams): Promise<{ status: number; body: unknown }> {
  const id = query.get("account") ?? "", from = query.get("from") ?? "", to = query.get("to") ?? "";
  if (!REDBARK_ACCOUNT_ID.test(id) || !isLocalDate(from) || !isLocalDate(to) || from > to) return { status: 400, body: { error: "Choose a bank account and a date range with the start on or before the end." } };
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 > 93) return { status: 400, body: { error: "Choose a date range of 93 days or less." } };
  if (!provider) return { status: 409, body: { error: BANK_NOT_CONNECTED, code: "bank_not_connected" } };
  const result = await provider.listBankTransactions({ account: id, from, to });
  if (!result || result.account?.id !== id || result.from !== from || result.to !== to || !Array.isArray(result.transactions) || typeof result.truncated !== "boolean") return malformed();
  const transactions = result.transactions.map(transaction)
    .map(row => ({ id: row.id, postDate: row.postDate, description: row.description, reference: row.reference, direction: row.direction, amountCents: row.amountCents, currency: row.currency }))
    .sort((a, b) => a.postDate < b.postDate ? 1 : a.postDate > b.postDate ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  return { status: 200, body: { account: { id, name: result.account.name, institution: result.account.institution, numberMasked: result.account.numberMasked }, from, to, transactions, truncated: result.truncated } };
}

/** The provider in the shape pullRedbarkReview takes, so W1 batches, coverage and
 * CSV building stay exactly as for the REST client. */
export function providerClient(provider: BankProvider): RedbarkClient {
  return {
    async listAccounts(): Promise<RedbarkAccount[]> {
      const list = await provider.listBankAccounts();
      if (!Array.isArray(list)) return malformed();
      return list.map(account).map(item => ({ id: item.id, connection: item.connection, provider: "redbark", category: item.category ?? "banking", name: item.name, type: "account",
        institution: { id: item.institution, name: item.institution }, accountLast4: item.numberMasked?.replace(/\D/g, "").slice(-4) || null, currency: "aud", status: "available",
        lastUpdatedAt: null, livemode: item.livemode !== false }));
    },
    async listTransactions(input) {
      const result = await provider.listBankTransactions(input);
      if (!result || result.account?.id !== input.account || !Array.isArray(result.transactions) || typeof result.truncated !== "boolean") return malformed();
      const transactions: RedbarkTransaction[] = result.transactions.map(transaction).map(row => ({ id: row.id, account: input.account, status: "posted", date: row.postDate, postDate: row.postDate,
        valueDate: null, description: row.description, reference: row.reference, extendedDescription: null, amountMinor: row.amountCents, currency: "aud", direction: row.direction, livemode: true }));
      // Redbark filters on the transaction date; a posting date can fall a day later, so dates are not range-checked here.
      if (new Set(transactions.map(row => row.id)).size !== transactions.length) return malformed();
      return { account: input.account, from: input.from, to: input.to, transactions, truncated: result.truncated, livemode: true,
        responseDigest: createHash("sha256").update(JSON.stringify(transactions)).digest("hex"), pages: 1 };
    },
  };
}

/** A provider over the Redbark REST client: the simulation's fake Redbark
 * speaks the live REST shapes, so its validation runs before the provider's. */
export function restBankProvider(client: RedbarkClient): BankProvider {
  return {
    async listBankAccounts() {
      return (await client.listAccounts()).map(item => ({ id: item.id, name: item.name, institution: item.institution.name, numberMasked: item.accountLast4 ? `····${item.accountLast4}` : null,
        connection: item.connection, category: item.category, livemode: item.livemode }));
    },
    async listBankTransactions(input) {
      const found = (await client.listAccounts()).find(item => item.id === input.account);
      if (!found) throw Object.assign(new Error("That bank account is not available."), { status: 404 });
      const pull = await client.listTransactions(input);
      return { account: { id: found.id, name: found.name, institution: found.institution.name, numberMasked: found.accountLast4 ? `····${found.accountLast4}` : null },
        from: input.from, to: input.to, truncated: pull.truncated,
        transactions: pull.transactions.filter(row => row.status === "posted").map(row => ({ id: row.id, postDate: row.postDate ?? row.date, description: row.description,
          reference: row.reference, direction: row.direction, amountCents: row.amountMinor, currency: "AUD" as const })) };
    },
  };
}
