import { describe, expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
import { CONNECTORS_UNREADABLE, createConnectorRegistryApi } from './mcp-connector-api';

const registry = { version: 1, canManage: true, connectors: [] };
const http = (status: number, message = 'private detail') => () => { throw Object.assign(new Error(message), { status }); };
function service(routes: Record<string, unknown>) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    const value = routes[`${init?.method ?? 'GET'} ${path}`];
    if (value === undefined) throw new Error(`unexpected ${path}`);
    return typeof value === 'function' ? (value as () => unknown)() : value;
  });
}

describe('added services client', () => {
  it('reads and validates the list', async () => {
    await expect(createConnectorRegistryApi(service({ 'GET /api/connectors': registry })).list()).resolves.toEqual(registry);
    await expect(createConnectorRegistryApi(service({ 'GET /api/connectors': { ...registry, token: 'x' } })).list()).rejects.toThrow(CONNECTORS_UNREADABLE);
  });

  it('adds, reviews and removes with JSON bodies, and explains refusals', async () => {
    const request = service({ 'POST /api/connectors': registry, 'POST /api/connectors/fictional-books/review': registry, 'POST /api/connectors/fictional-books/remove': http(403) });
    const api = createConnectorRegistryApi(request);
    expect((await api.add({ serverUrl: 'https://mcp.fictional.example/mcp', label: 'Fictional', auth: 'oauth' })).kind).toBe('settled');
    const selection = { enabled: ['list_books'], trusted: [], consequential: [] };
    expect((await api.review('fictional-books', 'a'.repeat(64), selection)).kind).toBe('settled');
    expect(request).toHaveBeenCalledWith('/api/connectors/fictional-books/review', { method: 'POST', body: JSON.stringify({ digest: 'a'.repeat(64), ...selection }) }, expect.anything());
    expect(await api.remove('fictional-books')).toEqual({ kind: 'refused', message: 'Only the office owner or an administrator can change added services.' });
  });

  it('sends a token once and never keeps it in the outcome', async () => {
    const state = { version: 1, connector: 'fictional-books', status: 'connected', account: { label: '3 tools', verifiedAt: 1 }, generation: 1, reason: null, canManage: true };
    const outcome = await createConnectorRegistryApi(service({ 'POST /api/connectors/fictional-books/connection/token': state })).setToken('fictional-books', 'fictional-token-value');
    expect(outcome.kind).toBe('settled');
    expect(JSON.stringify(outcome)).not.toContain('fictional-token-value');
  });

  it('treats a lost reply as uncertain', async () => {
    expect((await createConnectorRegistryApi(service({ 'POST /api/connectors/fictional-books/check': http(500) })).check('fictional-books')).kind).toBe('uncertain');
  });
});
