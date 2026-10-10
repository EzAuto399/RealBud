import { REDBARK_AUTH_ORIGIN, REDBARK_CONNECTOR_ID, REDBARK_LABEL, REDBARK_MCP_URL, REDBARK_SCOPES } from '../shared/redbark-connection.ts';
import { isLocalDate, REDBARK_ACCOUNT_ID, REDBARK_TRANSACTION_ID } from '../shared/bank-source.ts';
import {
  ConnectorError, createMcpConnector, McpToolError, nextPageToken,
  type ConnectorCall, type McpConnectorConfig, type McpConnectorOptions,
} from './mcp-connector-core.ts';
import { oplog } from './oplog.ts';

/**
 * Redbark preset on the generic connector core: the office's bank feed, read
 * only. Server URL, read-only scopes and the read allowlist are fixed here;
 * `listBankAccounts` / `listBankTransactions` map Redbark rows for Ask's bank
 * broker and W1. Amounts are signed minor units; dates are the local
 * `post_date` (docs/REDBARK-LIVE-CHECK-2026-10-02.md).
 */

export interface BankAccount { id: string; name: string; institution: string; numberMasked: string | null }
export interface BankTransaction {
  id: string; postDate: string; description: string; reference: string | null;
  direction: 'debit' | 'credit'; amountCents: number; currency: 'AUD';
}
export interface BankTransactions { account: BankAccount; from: string; to: string; transactions: BankTransaction[]; truncated: boolean }
export type BankFeedErrorCode = 'bank_not_connected' | 'needs_reconnect' | 'invalid_range' | 'unavailable';
export class BankFeedError extends Error {
  readonly code: BankFeedErrorCode;
  constructor(code: BankFeedErrorCode, message: string) { super(message); this.name = 'BankFeedError'; this.code = code; }
}
export const BANK_RANGE_DAYS = 93;
export const BANK_ROW_CAP = 2000;
const MAX_PAGES = 60;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const clean = (v: unknown, max: number): string | null => typeof v === 'string' && v.length <= max && !CONTROL.test(v) ? v : null;
const RANGE_MESSAGE = `Choose a connected bank account and a date range of up to ${BANK_RANGE_DAYS} days.`;

/** Inclusive calendar-day span between two YYYY-MM-DD dates. */
const spanDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

function listData(value: Record<string, unknown>): unknown[] {
  if (!Array.isArray(value.data)) throw new McpToolError('invalid');
  return value.data;
}

function bankAccount(value: unknown): BankAccount & { banking: boolean } {
  if (!object(value) || typeof value.id !== 'string' || !REDBARK_ACCOUNT_ID.test(value.id)) throw new McpToolError('invalid');
  const name = clean(value.name, 200), institution = object(value.institution) ? clean(value.institution.name, 200) : null;
  const number = value.account_number ?? null;
  if (name === null || institution === null || (number !== null && clean(number, 40) === null)) throw new McpToolError('invalid');
  // Redbark documents the number as masked; keep only the last four digits regardless.
  const digits = typeof number === 'string' ? number.replace(/\D/g, '') : '';
  return { id: value.id, name: name.trim() || 'Bank account', institution: institution.trim() || 'Bank',
    numberMasked: digits.length >= 4 ? `••••${digits.slice(-4)}` : null, banking: value.category === undefined || value.category === 'banking' };
}

function bankTransaction(value: unknown, account: string): BankTransaction | null {
  if (!object(value) || typeof value.id !== 'string' || !REDBARK_TRANSACTION_ID.test(value.id) || value.account !== account) throw new McpToolError('invalid');
  if (value.status === 'pending') return null;
  if (value.status !== 'posted' || (value.direction !== 'debit' && value.direction !== 'credit')) throw new McpToolError('invalid');
  const money = value.amount;
  if (!object(money) || !Number.isSafeInteger(money.amount) || Math.abs(money.amount) >= 1e14 || typeof money.currency !== 'string') throw new McpToolError('invalid');
  // Signed minor units; a sign that contradicts `direction` is not the verified convention.
  if ((value.direction === 'credit' && money.amount < 0) || (value.direction === 'debit' && money.amount > 0)) throw new McpToolError('invalid');
  if (money.currency.toUpperCase() !== 'AUD') throw new BankFeedError('unavailable', 'This bank feed returned a currency other than AUD.');
  // Bare local calendar dates; `*_datetime` are UTC instants and are never used.
  const postDate = value.post_date ?? value.date;
  if (!isLocalDate(postDate)) throw new McpToolError('invalid');
  const description = clean(value.description, 2000);
  const reference = value.reference === null || value.reference === undefined ? null : clean(value.reference, 500);
  if (description === null || (reference === null && value.reference !== null && value.reference !== undefined)) throw new McpToolError('invalid');
  return { id: value.id, postDate, description, reference, direction: value.direction, amountCents: money.amount, currency: 'AUD' };
}

async function readAccounts(call: ConnectorCall): Promise<BankAccount[]> {
  const accounts = new Map<string, BankAccount>(), seen = new Set<string>();
  let page: string | null = null, pages = 0;
  do {
    if (++pages > MAX_PAGES) throw new McpToolError('invalid');
    const list = await call('list_accounts', page ? { page } : { limit: 100 });
    for (const item of listData(list)) {
      const { banking, ...account } = bankAccount(item);
      if (banking) accounts.set(account.id, account);
    }
    page = nextPageToken(list, seen);
  } while (page);
  return [...accounts.values()];
}

export const REDBARK_CONNECTOR: McpConnectorConfig = {
  id: REDBARK_CONNECTOR_ID,
  label: REDBARK_LABEL,
  serverUrl: REDBARK_MCP_URL,
  authorizationServer: REDBARK_AUTH_ORIGIN,
  scopes: REDBARK_SCOPES,
  allowlist: { list_accounts: 'read', list_transactions: 'read', get_account_balance: 'read' },
  defaultArgs: { context: 'RealBud reads office bank accounts and transactions for reconciliation.' },
  async verify(call) {
    const accounts = await readAccounts(call);
    const banks = [...new Set(accounts.map(account => account.institution))].slice(0, 5).join(', ') || 'No bank accounts';
    return `${banks} · ${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}`;
  },
};

function feedError(error: unknown): BankFeedError {
  if (error instanceof BankFeedError) return error;
  if (error instanceof ConnectorError && error.code === 'needs_reconnect') return new BankFeedError('needs_reconnect', 'The office bank feed needs the owner to sign in to Redbark again.');
  if (error instanceof ConnectorError && error.code === 'not_connected') return new BankFeedError('bank_not_connected', 'The office bank feed is not connected.');
  return new BankFeedError('unavailable', 'The bank feed could not be read right now. Try again shortly.');
}

export function createRedbarkConnection(options: McpConnectorOptions) {
  const connector = createMcpConnector(REDBARK_CONNECTOR, options);

  async function listBankAccounts(): Promise<BankAccount[]> {
    try { return await connector.read(readAccounts); }
    catch (error) { throw feedError(error); }
  }

  async function listBankTransactions(input: { account: string; from: string; to: string }): Promise<BankTransactions> {
    if (!object(input) || typeof input.account !== 'string' || !REDBARK_ACCOUNT_ID.test(input.account) || !isLocalDate(input.from) || !isLocalDate(input.to) ||
        input.from > input.to || spanDays(input.from, input.to) > BANK_RANGE_DAYS) throw new BankFeedError('invalid_range', RANGE_MESSAGE);
    // Which step failed, for the one log line below: every failure reads the
    // same to Bud, and without this a timeout, a refused argument and a row
    // RealBud could not verify looked alike on a customer PC (10 Oct).
    let stage: 'accounts' | 'transactions' | 'rows' = 'accounts';
    const started = Date.now();
    try {
      return await connector.read(async call => {
        stage = 'accounts';
        const account = (await readAccounts(call)).find(row => row.id === input.account);
        if (!account) throw new BankFeedError('invalid_range', RANGE_MESSAGE);
        const rows = new Map<string, BankTransaction>(), seen = new Set<string>();
        let page: string | null = null, pages = 0, truncated = false;
        do {
          stage = 'transactions';
          if (++pages > MAX_PAGES) throw new McpToolError('invalid');
          // Only the documented MCP arguments (redbark.com/docs/mcp/tools).
          // `include_pending` belongs to the REST API; pending rows are dropped
          // below either way.
          const list = await call('list_transactions', page ? { page } : { account: input.account, from: input.from, to: input.to, limit: 100 });
          stage = 'rows';
          for (const item of listData(list)) {
            const row = bankTransaction(item, input.account);
            if (!row) continue;
            const prior = rows.get(row.id);
            if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new McpToolError('invalid');
            if (!prior && rows.size >= BANK_ROW_CAP) { truncated = true; break; }
            rows.set(row.id, row);
          }
          if (list.truncated === true) truncated = true;
          page = truncated ? null : nextPageToken(list, seen);
        } while (page);
        const transactions = [...rows.values()].sort((a, b) => b.postDate.localeCompare(a.postDate));
        return { account, from: input.from, to: input.to, transactions, truncated };
      });
    } catch (error) {
      const failed = feedError(error);
      const code = (error as { code?: unknown } | null)?.code;
      // Step, error code and time only: never arguments, rows or Redbark's text.
      oplog('connector', 'The bank feed read failed.', { connector: 'redbark', stage,
        code: typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : 'unknown', ms: Date.now() - started });
      throw failed;
    }
  }

  return { connector, listBankAccounts, listBankTransactions };
}
