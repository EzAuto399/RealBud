import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPrivateVault } from './private-vault.ts';
import { createCompanyOutbox } from './company-outbox.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const actor = { company: { id: randomUUID() }, member: { id: randomUUID() } };
const request = { headers: {} };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rb-outbox-')); roots.push(root);
  const input = { requestId: randomUUID(), title: 'Synthetic private review', summary: 'Prepared private draft', purpose: 'request-review' as const, recipientMemberIds: [randomUUID()], assigneeMemberId: '' };
  input.assigneeMemberId = input.recipientMemberIds[0];
  const items = new Map<string, unknown>(); let loseResponse = true;
  const forward = vi.fn(async (path: string, _method: string, _request: unknown, body?: unknown) => {
    if (path.endsWith('/me')) return { status: 200, body: actor };
    const value = body as typeof input;
    if (!items.has(value.requestId)) items.set(value.requestId, { ...value, id: value.requestId, owner: actor.member });
    if (loseResponse) { loseResponse = false; throw new Error('Response lost after commit'); }
    return { status: 201, body: { item: items.get(value.requestId) } };
  });
  const open = () => createCompanyOutbox({ vault: createPrivateVault(root), forward, departurePending: async () => false, matchesIdentity: async (company, member) => company === actor.company.id && member === actor.member.id });
  return { root, input, items, forward, open };
}
describe('durable reviewed sharing', () => {
  it('recovers the same encrypted request after restart and never creates a second work item', async () => {
    const f = await fixture();
    await expect(f.open().handle('/api/company/work', 'POST', request, f.input)).rejects.toThrow(/Response lost/);
    expect(f.items.size).toBe(1);
    const raw = await readFile(join(f.root, 'company-installation/private/outbox.json'), 'utf8');
    expect(raw).not.toContain(f.input.summary);
    const restarted = f.open();
    expect((await restarted.handle('/api/company/outbox', 'GET', request)).body).toMatchObject({ pending: { phase: 'pending', input: { requestId: f.input.requestId } } });
    expect((await restarted.handle('/api/company/work', 'POST', request, f.input)).status).toBe(201);
    expect(f.items.size).toBe(1);
    expect(await restarted.departureAllowed()).toBe(true);
    expect((await restarted.handle('/api/company/outbox/ack', 'POST', request, { requestId: f.input.requestId })).status).toBe(200);
    expect((await f.open().handle('/api/company/outbox', 'GET', request)).body).toMatchObject({ pending: null });
  });
  it('holds edited or replacement attempts while outcome is unknown', async () => {
    const f = await fixture(); const outbox = f.open();
    await expect(outbox.handle('/api/company/work', 'POST', request, f.input)).rejects.toThrow();
    expect((await outbox.handle('/api/company/work', 'POST', request, { ...f.input, summary: 'Changed' })).status).toBe(409);
    expect((await outbox.handle('/api/company/work', 'POST', request, { ...f.input, requestId: randomUUID() })).status).toBe(409);
    expect(await outbox.departureAllowed()).toBe(false);
    expect(f.items.size).toBe(1);
  });
  it('does not lose a confirmed original when the same request id is misused', async () => {
    const f = await fixture(); const outbox = f.open();
    await expect(outbox.handle('/api/company/work', 'POST', request, f.input)).rejects.toThrow();
    await outbox.handle('/api/company/work', 'POST', request, f.input);
    expect((await outbox.handle('/api/company/work', 'POST', request, { ...f.input, summary: 'Changed' })).status).toBe(409);
    expect((await outbox.handle('/api/company/work', 'POST', request, f.input)).status).toBe(201);
    expect(await outbox.departureAllowed()).toBe(true);
  });
  it('archives unknown outcomes only with explicit acknowledgement, preserving a recoverable encrypted record', async () => {
    const f = await fixture(); const outbox = f.open();
    await expect(outbox.handle('/api/company/work', 'POST', request, f.input)).rejects.toThrow();
    expect((await outbox.archive(f.input.requestId, false)).status).toBe(409);
    expect((await outbox.archive(f.input.requestId, true)).status).toBe(200);
    const receipt = await createPrivateVault(f.root).read(`share-${f.input.requestId}`);
    expect(receipt).toMatchObject({ outcome: 'unknown', input: { requestId: f.input.requestId } });
    expect(f.items.size).toBe(1); expect(await outbox.departureAllowed()).toBe(true);
    expect((await f.open().archives()).records).toMatchObject([{ requestId: f.input.requestId, outcome: 'unknown' }]);
    expect((await f.open().exportArchive(f.input.requestId)).body).toMatchObject({ record: { input: f.input, outcome: 'unknown' } });
    expect((await f.open().exportArchive('../development-key')).status).toBe(400);
  });
  it('does not reveal a saved payload to a different authenticated office identity', async () => {
    const f = await fixture(); await expect(f.open().handle('/api/company/work', 'POST', request, f.input)).rejects.toThrow();
    const other = createCompanyOutbox({ vault: createPrivateVault(f.root), forward: f.forward, departurePending: async () => false, matchesIdentity: async () => false });
    const reply = await other.handle('/api/company/outbox', 'GET', request);
    expect(reply.status).toBe(403); expect(JSON.stringify(reply)).not.toContain(f.input.summary);
  });
});
