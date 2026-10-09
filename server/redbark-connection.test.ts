import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { REDBARK_AUTH_ORIGIN, REDBARK_SCOPES } from '../shared/redbark-connection.ts';
import { BankFeedError, createRedbarkConnection, REDBARK_CONNECTOR } from './redbark-connection.ts';
import { createPrivateVault } from './private-vault.ts';
import { setOpLogPath } from './oplog.ts';
import { fictionalConnectorService } from './testing/fictional-mcp-connector.ts';

// Redbark's real scope list (public protected-resource metadata, 2026-10-02).
const ALL_SCOPES = ['mcp:read', 'brokerage:read', 'account:read', 'connections:read', 'connections:write', 'data:read', 'categories:read', 'categories:write',
  'destinations:read', 'destinations:write', 'syncs:read', 'syncs:write', 'rules:read', 'rules:write', 'events:read', 'events:write'];
const ACCOUNT = { object: 'account_item', id: 'acct_fict1', connection: 'conn_fict', provider: 'fiskil', category: 'banking', name: 'Fictional Trust', type: 'savings',
  institution: { id: 'inst_fict', name: 'Fictional Bank' }, account_number: 'xxxx xxxx 4321', currency: 'aud', status: 'active', livemode: true };
const BROKER = { ...ACCOUNT, id: 'acct_fict2', category: 'brokerage', name: 'Fictional Shares' };
function txn(i: number, patch: Record<string, unknown> = {}) {
  const debit = i % 2 === 0;
  return { object: 'transaction', id: `txn_fict${i}`, account: 'acct_fict1', status: 'posted', date: '2026-09-10', post_date: `2026-09-${String(10 + (i % 15)).padStart(2, '0')}`,
    post_datetime: '2026-09-10T17:18:00Z', direction: debit ? 'debit' : 'credit', amount: { amount: debit ? -1250 - i : 9900 + i, currency: 'aud' },
    description: `Fictional row ${i}`, reference: `REF${i}`, livemode: true, ...patch };
}

let fake: ReturnType<typeof fictionalConnectorService>, rows: Array<Record<string, unknown>> = [], pageSize = 100;
const page = (all: unknown[], args: Record<string, any>, path: string) => {
  const offset = typeof args.page === 'string' ? Number(args.page.slice(4)) : 0;
  const next = offset + pageSize < all.length ? `https://api.redbark.internal/v2/${path}?page=tok-${offset + pageSize}` : null;
  return { object: 'list', data: all.slice(offset, offset + pageSize), next_page_url: next, previous_page_url: null };
};

async function connected() {
  const feed = createRedbarkConnection({ vault: createPrivateVault(mkdtempSync(join(tmpdir(), 'redbark-')), randomBytes(32)), workspaceId: () => 'fictional-workspace',
    authorize: async () => ({ authority: 'manage' as const, principal: 'single-seat', stillManages: async () => true }), redirectBase: () => 'http://127.0.0.1:8799', transport: fake.fetch, resolve: fake.resolve, now: () => 1_700_000_000_000 });
  const started = await feed.connector.handle('start', 'POST', {} as IncomingMessage, {});
  const authorizeUrl = (started.body as { authorizeUrl: string }).authorizeUrl;
  expect((await feed.connector.callback(fake.approve(authorizeUrl))).status).toBe(200);
  return { feed, authorizeUrl };
}

beforeEach(() => {
  rows = [txn(1), txn(2, { reference: null }), txn(3, { status: 'pending' }), txn(4)]; pageSize = 100;
  fake = fictionalConnectorService({ mcpOrigin: 'https://mcp.redbark.com', authOrigin: REDBARK_AUTH_ORIGIN, scopes: ALL_SCOPES, tools: {
    list_accounts: args => page([ACCOUNT, BROKER], args, 'accounts'),
    list_transactions: args => page(rows, args, 'transactions'),
  } });
  fake.s.grantScope = 'mcp:read data:read';
});

describe('Redbark preset', () => {
  it('asks for read-only scopes and allowlists only read tools', async () => {
    expect(REDBARK_SCOPES).toEqual(['mcp:read', 'data:read']);
    expect(Object.entries(REDBARK_CONNECTOR.allowlist)).toEqual([['list_accounts', 'read'], ['list_transactions', 'read'], ['get_account_balance', 'read']]);
    const { authorizeUrl } = await connected();
    expect(new URL(authorizeUrl).searchParams.get('scope')).toBe('mcp:read data:read');
    expect(new URL(authorizeUrl).searchParams.get('scope')).not.toMatch(/write|connections|syncs|rules|categories/);
  });

  it('maps banking accounts with the last four digits only', async () => {
    const { feed } = await connected();
    expect(await feed.listBankAccounts()).toEqual([{ id: 'acct_fict1', name: 'Fictional Trust', institution: 'Fictional Bank', numberMasked: '••••4321' }]);
  });

  it('maps signed minor units and local post dates, excludes pending, newest first', async () => {
    const { feed } = await connected();
    const result = await feed.listBankTransactions({ account: 'acct_fict1', from: '2026-09-01', to: '2026-09-30' });
    expect(result).toEqual({ account: { id: 'acct_fict1', name: 'Fictional Trust', institution: 'Fictional Bank', numberMasked: '••••4321' }, from: '2026-09-01', to: '2026-09-30', truncated: false,
      transactions: [
        { id: 'txn_fict4', postDate: '2026-09-14', description: 'Fictional row 4', reference: 'REF4', direction: 'debit', amountCents: -1254, currency: 'AUD' },
        { id: 'txn_fict2', postDate: '2026-09-12', description: 'Fictional row 2', reference: null, direction: 'debit', amountCents: -1252, currency: 'AUD' },
        { id: 'txn_fict1', postDate: '2026-09-11', description: 'Fictional row 1', reference: 'REF1', direction: 'credit', amountCents: 9901, currency: 'AUD' },
      ] });
    // Only Redbark's documented MCP arguments: an unknown one is refused as
    // invalid_arguments, which read as "could not be read right now" (10 Oct).
    expect(fake.s.calls.find(call => call.name === 'list_transactions')?.args).toEqual({ context: expect.any(String), account: 'acct_fict1', from: '2026-09-01', to: '2026-09-30', limit: 100 });
  });

  it('refuses a sign that contradicts direction', async () => {
    const { feed } = await connected();
    rows = [txn(2, { amount: { amount: 500, currency: 'aud' } })];
    await expect(feed.listBankTransactions({ account: 'acct_fict1', from: '2026-09-01', to: '2026-09-30' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('logs the failed step, code and time, never the account, range or rows', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'rb-oplog-')), 'realbud.log');
    setOpLogPath(log);
    const { feed } = await connected();
    rows = [txn(2, { amount: { amount: 500, currency: 'aud' } })];
    await expect(feed.listBankTransactions({ account: 'acct_fict1', from: '2026-09-01', to: '2026-09-30' })).rejects.toMatchObject({ code: 'unavailable' });
    const text = readFileSync(log, 'utf8');
    expect(JSON.parse(text.trim().split('\n').at(-1)!)).toMatchObject({ event: 'connector', connector: 'redbark', stage: 'rows', code: 'invalid', ms: expect.any(Number) });
    expect(text).not.toMatch(/acct_fict1|2026-09-01|Fictional/);
  });

  it.each([
    ['from after to', { account: 'acct_fict1', from: '2026-09-30', to: '2026-09-01' }],
    ['94 days', { account: 'acct_fict1', from: '2026-07-01', to: '2026-10-02' }],
    ['a bad date', { account: 'acct_fict1', from: '2026-02-30', to: '2026-03-01' }],
    ['a bad account id', { account: 'conn_fict', from: '2026-09-01', to: '2026-09-02' }],
  ])('rejects %s before any request', async (_label, input) => {
    const { feed } = await connected();
    const before = fake.s.requests.length;
    await expect(feed.listBankTransactions(input)).rejects.toMatchObject({ code: 'invalid_range' });
    expect(fake.s.requests).toHaveLength(before);
  });

  it('accepts exactly 93 inclusive days', async () => {
    const { feed } = await connected();
    await expect(feed.listBankTransactions({ account: 'acct_fict1', from: '2026-07-01', to: '2026-10-01' })).resolves.toMatchObject({ truncated: false });
  });

  it('pages only by token through MCP, never fetching the foreign next_page_url, and caps at 2,000 rows', async () => {
    const { feed } = await connected();
    rows = Array.from({ length: 2150 }, (_, i) => txn(i + 10));
    const result = await feed.listBankTransactions({ account: 'acct_fict1', from: '2026-09-01', to: '2026-09-30' });
    expect(result.transactions).toHaveLength(2000);
    expect(result.truncated).toBe(true);
    expect(fake.s.requests.some(url => !url.startsWith('https://mcp.redbark.com/') && !url.startsWith(`${REDBARK_AUTH_ORIGIN}/`))).toBe(false);
    expect(fake.s.calls.filter(call => call.name === 'list_transactions')[1]!.args).toEqual({ context: expect.any(String), page: 'tok-100' });
  });

  it('reports typed errors when not connected', async () => {
    const feed = createRedbarkConnection({ vault: createPrivateVault(mkdtempSync(join(tmpdir(), 'redbark-')), randomBytes(32)), workspaceId: () => 'fictional-workspace',
      authorize: async () => ({ authority: 'manage' as const, principal: 'single-seat', stillManages: async () => true }), redirectBase: () => 'http://127.0.0.1:8799', transport: fake.fetch, resolve: fake.resolve });
    await expect(feed.listBankAccounts()).rejects.toBeInstanceOf(BankFeedError);
    await expect(feed.listBankTransactions({ account: 'acct_fict1', from: '2026-09-01', to: '2026-09-02' })).rejects.toMatchObject({ code: 'bank_not_connected' });
  });
});
