import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionStatus } from './composio.ts';

const config = (userId: string) => ({ composio: { key: 'ak_shared_project_fixture', userId } });
const account = (userId: string, id = 'ca_personal') => ({ id, user_id: userId, toolkit: { slug: 'gmail' },
  status: 'ACTIVE', is_disabled: false, experimental: { account_type: 'PRIVATE' } });
const reply = (items: unknown[], extra = {}) => new Response(JSON.stringify({ items, next_cursor: null, ...extra }));
afterEach(() => vi.unstubAllGlobals());

describe('one Composio project with separate people', () => {
  it('uses the same project credential with separate private-account queries', async () => {
    const calls: Array<{ user: string; key: string | null; kind: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (raw: string, init: RequestInit) => {
      const url = new URL(raw), user = url.searchParams.get('user_ids')!;
      calls.push({ user, key: new Headers(init.headers).get('x-api-key'), kind: url.searchParams.get('account_type') });
      return reply([account(user, `ca_${user}`)]);
    }));
    const [a, b] = await Promise.all([connectionStatus(config('alice'), ['gmail']), connectionStatus(config('bob'), ['gmail'])]);
    expect(a.gmail.accounts.map(x => x.id)).toEqual(['ca_alice']);
    expect(b.gmail.accounts.map(x => x.id)).toEqual(['ca_bob']);
    expect(calls).toEqual([
      { user: 'alice', key: 'ak_shared_project_fixture', kind: 'PRIVATE' },
      { user: 'bob', key: 'ak_shared_project_fixture', kind: 'PRIVATE' },
    ]);
  });
  it.each([
    account('bob'), { ...account('alice'), user_id: undefined },
    { ...account('alice'), experimental: { account_type: 'SHARED' } },
    { ...account('alice'), experimental: undefined },
  ])('rejects foreign or unverified ownership without returning account details', async value => {
    vi.stubGlobal('fetch', vi.fn(async () => reply([value])));
    await expect(connectionStatus(config('alice'), ['gmail'])).rejects.toThrow('Connected account ownership could not be verified');
  });
  it('does not mark a disabled account active', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply([{ ...account('alice'), is_disabled: true }])));
    expect((await connectionStatus(config('alice'), ['gmail'])).gmail).toMatchObject({ connected: false, status: 'DISABLED' });
  });
  it('does not claim complete coverage for a truncated list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply([account('alice')], { next_cursor: 'more' })));
    await expect(connectionStatus(config('alice'), ['gmail'])).rejects.toThrow('Connection listing is incomplete');
  });
  it('rejects repeated account IDs instead of presenting a false account choice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply([account('alice'), account('alice')])));
    await expect(connectionStatus(config('alice'), ['gmail'])).rejects.toThrow('invalid connection status');
  });
});
