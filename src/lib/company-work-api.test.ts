import { describe, expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
import { createCompanyApi } from './company-api';

const alice = { id: 'a1234567-1234-4234-8234-123456789abc', displayName: 'Accounts QA' };
const bob = { id: 'b1234567-1234-4234-8234-123456789abc', displayName: 'Property QA' };
const token = 'synthetic_alice_member_session_1234567890';
const session = (person = alice, memberToken = token) => ({ memberToken,
  company: { id: 'c1234567-1234-4234-8234-123456789abc', name: 'Practice company' }, member: { ...person, role: 'member' } });
const item = { id: 'd1234567-1234-4234-8234-123456789abc', scopeId: 'e1234567-1234-4234-8234-123456789abc',
  revision: '1', title: 'Reviewed summary', summary: 'Fictional invoice review only.', purpose: 'request-review',
  state: 'open', owner: alice, assignee: bob, audience: [alice, bob], response: '', updatedBy: alice,
  updatedAt: '2026-09-15T00:00:00.000Z' };
const input = { requestId: item.id, title: item.title, summary: item.summary, purpose: 'request-review' as const,
  recipientMemberIds: [bob.id], assigneeMemberId: bob.id };

describe('shared work uses the current private member session', () => {
  it('uses member headers on all work operations and preserves the retry identity', async () => {
    const request = vi.fn().mockResolvedValueOnce(session())
      .mockResolvedValueOnce({ members: [alice, bob] }).mockResolvedValueOnce({ items: [item] })
      .mockResolvedValue({ item });
    const client = createCompanyApi(request);
    await client.signIn({ loginName: 'accounts', password: 'Synthetic-test-password' });
    await client.workMembers(); await client.sharedWork(); await client.shareWork(input); await client.shareWork(input);
    await client.respondToSharedWork({ id: item.id, expectedRevision: '1', response: 'Reviewed.' });
    await client.closeSharedWork({ id: item.id, expectedRevision: '1' });
    expect(request.mock.calls.slice(1).map(call => call[0])).toEqual([
      '/api/company/work-members', '/api/company/work', '/api/company/work', '/api/company/work',
      '/api/company/work/respond', '/api/company/work/close',
    ]);
    for (const [path, init] of request.mock.calls.slice(1)) {
      expect(new Headers(init.headers).get('x-realbud-member-session')).toBe(token);
      expect(path).not.toContain(token);
    }
    expect(request.mock.calls[3][1].body).toBe(request.mock.calls[4][1].body);
    expect(JSON.parse(request.mock.calls[3][1].body)).toEqual(input);
  });

  it('rejects a late work result after switching to another person', async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn().mockResolvedValueOnce(session()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(session(bob, 'synthetic_bob_member_session_1234567890'));
    const client = createCompanyApi(request);
    await client.signIn({ loginName: 'accounts', password: 'Synthetic-test-password' });
    const late = client.sharedWork(); const rejection = expect(late).rejects.toThrow();
    await client.signIn({ loginName: 'property', password: 'Synthetic-test-password' });
    finish({ items: [item] }); await rejection;
  });

  it('clears an expired member session without exposing server error details', async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const request = vi.fn().mockResolvedValueOnce(session()).mockRejectedValueOnce(Object.assign(new Error('PRIVATE-CANARY'), { status: 401 }));
    const client = createCompanyApi(request, storage);
    await client.signIn({ loginName: 'accounts', password: 'Synthetic-test-password' });
    await expect(client.sharedWork()).rejects.toMatchObject({ memberSessionEnded: true, message: expect.not.stringContaining('PRIVATE-CANARY') });
    expect(values.size).toBe(0);
  });

  it('does not automatically replay a failed share with uncertain delivery', async () => {
    const request = vi.fn().mockResolvedValueOnce(session()).mockRejectedValueOnce(new Error('Disconnected after commit'));
    const client = createCompanyApi(request);
    await client.signIn({ loginName: 'accounts', password: 'Synthetic-test-password' });
    await expect(client.shareWork(input)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('notifies mounted views before sign-out finishes and when a new member token arrives', async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn().mockResolvedValueOnce(session()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const client = createCompanyApi(request);
    const listener = vi.fn(); const unsubscribe = client.subscribeSession(listener);
    await client.signIn({ loginName: 'accounts', password: 'Synthetic-test-password' });
    const version = client.sessionVersion(); listener.mockClear();
    const leaving = client.logout();
    expect(listener).toHaveBeenCalled(); expect(client.sessionVersion()).toBeGreaterThan(version);
    finish({}); await leaving; unsubscribe();
  });

  it('distinguishes damaged-record recovery from a stale edit without reflecting raw service errors', async () => {
    const request = vi.fn().mockRejectedValueOnce(Object.assign(new Error('PRIVATE RAW DATABASE CONTENT'), { status: 422 }));
    await expect(createCompanyApi(request).sharedWork()).rejects.toMatchObject({ status: 422,
      message: 'Shared work needs service recovery. The original record is preserved. Contact service administration; retrying will not repair it.' });
  });

});
