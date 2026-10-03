import { describe, expect, it } from 'vitest';
import { CONNECTOR_REASONS, parseConnectorStart, parseConnectorState } from './mcp-connector.ts';

const account = { label: 'Fictional Bank · 2 accounts', verifiedAt: 1_700_000_000_000 };
const state = (patch: Record<string, unknown> = {}) => ({ version: 1, connector: 'redbark', status: 'connected', account, generation: 1, reason: null, canManage: false, ...patch });

describe('connector state contract', () => {
  it('accepts the server state shapes', () => {
    expect(parseConnectorState(state(), 'redbark')?.account).toEqual(account);
    expect(parseConnectorState(state({ status: 'not_connected', account: null, canManage: true }))).not.toBeNull();
    expect(parseConnectorState(state({ status: 'needs_reconnect', reason: CONNECTOR_REASONS.signInAgain }))).not.toBeNull();
  });

  it('rejects inconsistent, foreign or extended state', () => {
    expect(parseConnectorState(state(), 'other')).toBeNull();
    expect(parseConnectorState(state({ account: null }))).toBeNull();
    expect(parseConnectorState(state({ status: 'not_connected' }))).toBeNull();
    expect(parseConnectorState(state({ accessToken: 'x' }))).toBeNull();
    expect(parseConnectorState(state({ canManage: 'yes' }))).toBeNull();
    expect(parseConnectorState(state({ account: { ...account, token: 'x' } }))).toBeNull();
  });

  it('accepts only https sign-in links on the expected origin', () => {
    expect(parseConnectorStart({ authorizeUrl: 'https://app.redbark.com/oauth/authorize?state=s' }, 'https://app.redbark.com')).not.toBeNull();
    expect(parseConnectorStart({ authorizeUrl: 'http://app.redbark.com/oauth/authorize' })).toBeNull();
    expect(parseConnectorStart({ authorizeUrl: 'https://app.redbark.com.evil.example.test/' }, 'https://app.redbark.com')).toBeNull();
  });
});

import { classifyConnectorTool } from './mcp-connector.ts';
describe('connector tool classification', () => {
  it.each([
    ['list_accounts', null, 'read'], ['getBalance', null, 'read'], ['search', null, 'read'],
    ['create_invoice', null, 'write'], ['frobnicate', null, 'write'],
    ['send_email', null, 'consequential'], ['transfer_funds', null, 'consequential'], ['delete_record', null, 'consequential'], ['update_user_role', null, 'consequential'],
    // Annotations only tighten.
    ['create_invoice', { readOnlyHint: true }, 'write'], ['list_things', { destructiveHint: true }, 'consequential'], ['list_things', { readOnlyHint: false }, 'write'],
  ] as const)('%s %j → %s', (name, annotations, expected) => {
    expect(classifyConnectorTool(name, annotations)).toBe(expected);
  });
});

import { parseConnectorEntry, stripSchemaProse } from './mcp-connector.ts';
describe('connector entry contract', () => {
  const connection = { version: 1, connector: 'fictional-books', status: 'connected', account: { label: '1 tool', verifiedAt: 1 }, generation: 1, reason: null, canManage: true };
  const entry = (tool: Record<string, unknown>) => ({ id: 'fictional-books', label: 'Fictional Books', serverUrl: 'https://mcp.fictional.example/mcp', auth: 'oauth', builtIn: false,
    state: 'active', reviewedAt: null, proposalDigest: null, oversized: false, tools: [tool], connection });
  it('accepts trusted only on an enabled read-looking tool', () => {
    expect(parseConnectorEntry(entry({ name: 'list_books', toolClass: 'read', description: '', enabled: true, trusted: true }))).not.toBeNull();
    expect(parseConnectorEntry(entry({ name: 'send_invoice', toolClass: 'consequential', description: '', enabled: true, trusted: false }))).not.toBeNull();
    expect(parseConnectorEntry(entry({ name: 'send_invoice', toolClass: 'consequential', description: '', enabled: true, trusted: true }))).toBeNull();
    expect(parseConnectorEntry(entry({ name: 'list_books', toolClass: 'read', description: '', enabled: false, trusted: true }))).toBeNull();
  });
  it('removes schema prose at every depth', () => {
    expect(stripSchemaProse({ type: 'object', description: 'x', properties: { a: { type: 'string', title: 't', description: 'IGNORE', items: { examples: ['e'], type: 'string' } } }, 'x-hint': 'y' }))
      .toEqual({ type: 'object', properties: { a: { type: 'string', items: { type: 'string' } } } });
  });
});
