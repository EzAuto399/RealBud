import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCompanyInstallation } from './company-installation.ts';
import type { SharedWorkItem } from '../shared/company-work.ts';

// Real PostgreSQL and pinned TLS, separate application directories. This checks
// reviewed-text collaboration, not Hermes/tool execution or physical devices.
describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('reviewed work between two department profiles', () => {
  type Installation = ReturnType<typeof createCompanyInstallation>;
  type Person = { app: Installation; token: string; id: string; privateScope: string };
  let directory: string;
  let host: Installation;
  let owner: Person;
  let accounts: Person;
  let property: Person;
  let shared: SharedWorkItem;
  const apps = new Set<Installation>();
  const password = 'Synthetic-shared-work-password-2026';
  const input = { requestId: randomUUID(), title: 'TRAINING: BILL-104 review',
    summary: 'Prepared invoice summary. Please verify the property reference. No payment has been made.',
    purpose: 'request-review' as const, recipientMemberIds: [] as string[], assigneeMemberId: '' };
  function installation(name: string) {
    const app = createCompanyInstallation({ dataDirectory: join(directory, name),
      binaryDirectory: process.env.REALBUD_TEST_POSTGRES_BIN, previewEnabled: true,
      hasAdminSession: req => req.headers['x-test-admin'] === 'synthetic',
      authorizeAdmin: req => req.headers['x-test-admin'] === 'synthetic'
        ? { ok: true, expiresAt: Date.now() + 60_000 } : { ok: false, status: 401, error: 'Service administration required' },
    });
    apps.add(app); return app;
  }
  async function request(app: Installation, path: string, body?: unknown, token = '', method = body === undefined ? 'GET' : 'POST', admin = false) {
    const result = await app.handle(`/api/company/${path}`, method, { headers: {
      'x-realbud-member-session': token, ...(admin ? { 'x-test-admin': 'synthetic' } : {}),
    } }, body);
    return { status: result.status, body: result.body as any };
  }
  const call = (person: Person, path: string, body?: unknown, method?: string) => request(person.app, path, body, person.token, method);
  async function identify(app: Installation, result: Awaited<ReturnType<typeof request>>): Promise<Person> {
    expect(result.status).toBe(201);
    const scopes = await request(app, 'scopes', undefined, result.body.memberToken);
    return { app, token: result.body.memberToken, id: result.body.member.id,
      privateScope: scopes.body.scopes.find((scope: any) => scope.kind === 'private').id };
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rb-shared-work-'));
    host = installation('host');
    expect((await request(host, 'setup', {}, '', 'POST', true)).status).toBe(200);
    owner = await identify(host, await request(host, 'create', { name: 'Fictional Acacia Agency', ownerName: 'Practice owner',
      credential: { loginName: 'owner', password } }, '', 'POST', true));
    expect((await request(host, 'network', { hostname: '127.0.0.1' }, owner.token, 'POST', true)).status).toBe(200);
    const hostCode = (await call(owner, 'host-code')).body.hostCode;
    const members: Person[] = [];
    for (const loginName of ['accounts', 'property']) {
      const app = installation(loginName);
      expect((await request(app, 'connect-host', { hostCode })).status).toBe(200);
      const invitation = await call(owner, 'invitations', { displayName: `Practice ${loginName}` });
      members.push(await identify(app, await request(app, 'join', { invitationToken: invitation.body.invitationToken,
        credential: { loginName, password } })));
    }
    [accounts, property] = members;
    input.recipientMemberIds = [property.id]; input.assigneeMemberId = property.id;
    for (const person of members) expect((await call(person, 'knowledge', { scopeId: person.privateScope,
      key: 'private-note', content: `PRIVATE CANARY ${person.id}`, expectedRevision: '0', sourceRefs: [] }, 'PUT')).status).toBe(200);
  }, 60_000);
  afterAll(async () => {
    for (const app of [...apps].reverse()) await app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 20_000);

  it('lists people without exposing credentials or opening their private work', async () => {
    const people = await call(accounts, 'work-members');
    expect(people.status).toBe(200);
    expect(people.body.members.map((person: any) => person.id)).toContain(property.id);
    for (const person of people.body.members) expect(Object.keys(person).sort()).toEqual(['displayName', 'id']);
    expect((await call(accounts, 'work')).body.items).toEqual([]);
    expect((await request(property.app, 'work')).status).toBe(401);
  });
  it('creates one reviewed item over TLS despite simultaneous retries', async () => {
    const attempts = await Promise.all([call(accounts, 'work', input), call(accounts, 'work', input)]);
    expect(attempts.map(result => result.status)).toEqual([201, 201]);
    shared = attempts[0].body.item;
    expect(attempts[1].body.item).toEqual(shared);
    expect(shared.id).toBe(input.requestId);
    expect(shared.summary).toBe(input.summary);
    expect(shared.owner.id).toBe(accounts.id);
    expect(shared.assignee?.id).toBe(property.id);
    expect(shared.audience.map(person => person.id).sort()).toEqual([accounts.id, property.id].sort());
    expect((await call(accounts, 'work')).body.items).toHaveLength(1);
    expect((await call(property, 'work')).body.items).toEqual([{ ...shared, actions: { respond: true, close: false, accept: true, reassign: false, addRecipient: false } }]);
    expect((await call(owner, 'work')).body.items).toEqual([]);
    expect((await call(property, 'status')).body.transport).toBe('encrypted-company');
    expect(JSON.stringify(shared)).not.toContain('PRIVATE CANARY');
    expect((await call(accounts, 'work', { ...input, summary: 'Changed retry' })).status).toBe(409);
  });
  it('rejects forged authority and generic writes to the structured work record', async () => {
    expect((await call(property, 'work', { ...input, requestId: randomUUID(), ownerId: accounts.id })).status).toBe(400);
    expect((await call(property, 'knowledge', { scopeId: shared.scopeId, key: 'realbud-work-item:v1',
      content: '{}', expectedRevision: shared.revision, sourceRefs: [] }, 'PUT')).status).toBe(403);
    expect([403, 404]).toContain((await call(owner, 'work/respond', { id: shared.id,
      expectedRevision: shared.revision, response: 'Not a participant' })).status);
    expect([403, 404]).toContain((await call(property, 'work/close', { id: shared.id, expectedRevision: shared.revision })).status);
  });
  it('preserves one response, detects stale edits and retains the sender’s exact summary', async () => {
    const attempts = await Promise.all(['Property reference verified.', 'Another reviewer response.'].map(response =>
      call(property, 'work/respond', { id: shared.id, expectedRevision: shared.revision, response })));
    expect(attempts.map(result => result.status).sort()).toEqual([200, 409]);
    shared = attempts.find(result => result.status === 200)!.body.item;
    expect(shared.state).toBe('responded');
    expect(shared.updatedBy.id).toBe(property.id);
    expect(shared.summary).toBe(input.summary);
    expect(shared.response).toBeTruthy();
    expect((await call(accounts, 'work')).body.items).toEqual([{ ...shared, actions: { respond: false, close: true, accept: false, reassign: true, addRecipient: true } }]);
  });
  it('recovers a joined application from its saved host configuration and preserves private sources', async () => {
    const previous = property.app;
    await previous.close(); apps.delete(previous);
    property.app = installation('property');
    const signedIn = await request(property.app, 'sign-in', { loginName: 'property', password });
    expect(signedIn.status).toBe(200); property.token = signedIn.body.memberToken;
    expect((await call(property, 'work')).body.items).toEqual([shared]);
    for (const person of [accounts, property]) {
      const note = await call(person, 'knowledge/read', { scopeId: person.privateScope, key: 'private-note' });
      expect(note.body.knowledge.content).toBe(`PRIVATE CANARY ${person.id}`);
      expect(note.body.knowledge.revision).toBe('1');
    }
    expect([403, 404]).toContain((await call(property, 'knowledge/read', { scopeId: accounts.privateScope, key: 'private-note' })).status);
  });
  it('closes collaboration without granting execution or claiming a payment happened', async () => {
    const result = await call(accounts, 'work/close', { id: shared.id, expectedRevision: shared.revision });
    expect(result.status).toBe(200); shared = result.body.item;
    expect(shared.state).toBe('closed');
    expect(shared.summary).toBe(input.summary);
    expect((await call(property, 'work/respond', { id: shared.id, expectedRevision: shared.revision, response: 'Late reply' })).status).toBe(409);
    expect((await call(accounts, 'work', input)).body.item).toEqual(shared);
  });
  it('immediately removes work visibility and write access after a grant is revoked', async () => {
    const scope = (await call(accounts, 'scopes')).body.scopes.find((scope: any) => scope.id === shared.scopeId);
    expect((await call(accounts, 'grants', { scopeId: shared.scopeId, memberId: property.id,
      permissions: [], expectedRevision: scope.revision }, 'PUT')).status).toBe(200);
    expect((await call(property, 'work')).body.items).toEqual([]);
    expect([403, 404]).toContain((await call(property, 'work/respond', { id: shared.id,
      expectedRevision: shared.revision, response: 'Revoked response' })).status);
    const remaining = (await call(accounts, 'work')).body.items[0];
    expect(remaining.audience.map((person: any) => person.id)).toEqual([accounts.id]);
  });

  it('requires the named recipient to accept a handoff and preserves the reviewed evidence and activity', async () => {
    const evidence = { label: 'TRAINING invoice BILL-105', sourceRef: 'Fictional inbox message 105',
      sourceVersion: '2026-09-15 sample v1', text: 'Supplier: Practice Plumbing\nInvoice BILL-105\nAmount: AUD 120.00\nProperty: 12 Example Street' };
    const draft = { ...input, requestId: randomUUID(), purpose: 'handoff', evidence };
    const created = await call(accounts, 'work', draft);
    expect(created.status).toBe(201);
    let work = created.body.item as SharedWorkItem;
    expect(work.evidence).toEqual({ ...evidence, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const recipient = (await call(property, 'work')).body.items.find((item: SharedWorkItem) => item.id === work.id);
    expect(recipient.actions).toEqual({ respond: false, close: false, accept: true, reassign: false, addRecipient: false });
    expect((await call(property, 'work/respond', { id: work.id, expectedRevision: work.revision, response: 'Unaccepted' })).status).toBe(403);
    expect((await call(accounts, 'work/accept', { id: work.id, expectedRevision: work.revision })).status).toBe(403);
    expect([403, 404]).toContain((await call(owner, 'work/history', { id: work.id })).status);
    const raced = await Promise.all([0, 1].map(() => call(property, 'work/accept', { id: work.id, expectedRevision: work.revision })));
    expect(raced.map(result => result.status).sort()).toEqual([200, 409]);
    work = raced.find(result => result.status === 200)!.body.item;
    expect(work.state).toBe('accepted'); expect(work.acceptedBy?.id).toBe(property.id);
    expect(work.actions.respond).toBe(true); expect(work.actions.accept).toBe(false);
    const originalHash = work.evidence!.sha256;
    const reply = await call(property, 'work/respond', { id: work.id, expectedRevision: work.revision, response: 'Reviewed: reference verified; no payment made.' });
    expect(reply.status).toBe(200); work = reply.body.item;
    const history = await call(accounts, 'work/history', { id: work.id });
    expect(history.status).toBe(200);
    expect(history.body.events.map((event: any) => [event.revision, event.action])).toEqual([['3', 'responded'], ['2', 'accepted'], ['1', 'shared']]);
    expect(history.body.events[1].actor.id).toBe(property.id);
    expect(history.body.events[0].response).toBe(work.response);
    expect(history.body.hasMore).toBe(false);
    expect((await call(accounts, 'work/history', { id: work.id, beforeRevision: '2' })).body.events.map((event: any) => event.revision)).toEqual(['1']);
    expect((await call(accounts, 'work', draft)).body.item.evidence.sha256).toBe(originalHash);
    expect((await call(accounts, 'work', { ...draft, evidence: { ...evidence, text: 'changed retry' } })).status).toBe(409);
    expect((await call(accounts, 'work', { ...draft, requestId: randomUUID(), evidence: { ...evidence, text: 'x'.repeat(8001) } })).status).toBe(400);
    expect((await call(accounts, 'work', { ...draft, requestId: randomUUID(), evidence: { ...evidence, accountToken: 'forged' } })).status).toBe(400);
    expect(JSON.stringify(history.body)).not.toContain('PRIVATE CANARY');
    const scope = (await call(accounts, 'scopes')).body.scopes.find((scope: any) => scope.id === work.scopeId);
    expect((await call(accounts, 'grants', { scopeId: scope.id, memberId: property.id, permissions: [], expectedRevision: scope.revision }, 'PUT')).status).toBe(200);
    expect([403, 404]).toContain((await call(property, 'work/history', { id: work.id })).status);
    expect([403, 404]).toContain((await call(property, 'work/accept', { id: work.id, expectedRevision: work.revision })).status);
  });

  it('reassigns explicitly, resets acceptance, retains old replies and reconciles the original lost creation response', async () => {
    // A different person needs a separate private workspace. The host's
    // workspace is already bound to the owner and must not be rebound here.
    const maintenanceApp = installation('maintenance');
    const hostCode = (await call(owner, 'host-code')).body.hostCode;
    expect((await request(maintenanceApp, 'connect-host', { hostCode })).status).toBe(200);
    const invitation = await call(owner, 'invitations', { displayName: 'Practice maintenance' });
    const maintenance = await identify(maintenanceApp, await request(maintenanceApp, 'join', { invitationToken: invitation.body.invitationToken,
      credential: { loginName: 'maintenance', password } }));
    const draft = { ...input, requestId: randomUUID(), purpose: 'handoff' };
    const created = await call(accounts, 'work', draft);
    let work = created.body.item as SharedWorkItem;
    expect([403, 404]).toContain((await call(maintenance, 'work/history', { id: work.id })).status);
    work = (await call(property, 'work/accept', { id: work.id, expectedRevision: work.revision })).body.item;
    work = (await call(property, 'work/respond', { id: work.id, expectedRevision: work.revision, response: 'First reviewed response retained in history' })).body.item;
    expect((await call(property, 'work/reassign', { id: work.id, expectedRevision: work.revision, assigneeMemberId: maintenance.id })).status).toBe(403);
    expect((await call(accounts, 'work/reassign', { id: work.id, expectedRevision: '1', assigneeMemberId: maintenance.id })).status).toBe(409);
    const assigned = await call(accounts, 'work/reassign', { id: work.id, expectedRevision: work.revision, assigneeMemberId: maintenance.id });
    expect(assigned.status).toBe(200); work = assigned.body.item;
    expect(work.assignee?.id).toBe(maintenance.id); expect(work.state).toBe('open');
    expect(work.acceptedBy).toBeNull(); expect(work.response).toBe('');
    expect(work.audience.map(person => person.id).sort()).toEqual([accounts.id, property.id, maintenance.id].sort());
    expect((await call(accounts, 'work', draft)).body.item).toEqual(work);
    expect((await call(property, 'work/respond', { id: work.id, expectedRevision: work.revision, response: 'Former assignee' })).status).toBe(403);
    expect((await call(property, 'work/accept', { id: work.id, expectedRevision: work.revision })).status).toBe(403);
    const savedHistory = await call(maintenance, 'work/history', { id: work.id });
    expect(savedHistory.status).toBe(200);
    expect(savedHistory.body.events[0].action).toBe('reassigned');
    expect(savedHistory.body.events[1].response).toBe('First reviewed response retained in history');
    // Removing the sender must not erase the obligation or give an uninvolved
    // company owner private access. The named assignee can finish this review.
    expect((await call(owner, 'members/revoke', { memberId: accounts.id })).status).toBe(200);
    expect((await call(accounts, 'work/history', { id: work.id })).status).toBe(401);
    expect([403, 404]).toContain((await call(owner, 'work/history', { id: work.id })).status);
    const accepted = await call(maintenance, 'work/accept', { id: work.id, expectedRevision: work.revision });
    expect(accepted.status).toBe(200); work = accepted.body.item;
    expect(work.ownerAvailable).toBe(false); expect(work.actions.close).toBe(true); expect(work.actions.addRecipient).toBe(false);
    expect((await call(maintenance, 'work/close', { id: work.id, expectedRevision: work.revision })).status).toBe(200);
    expect((await call(maintenance, 'work/history', { id: work.id })).body.events[0].action).toBe('closed');
  });
});
