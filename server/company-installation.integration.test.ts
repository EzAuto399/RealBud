import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCompanyInstallation } from './company-installation.ts';

describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('owned host setup and encrypted second-client joining', () => {
  let directory: string;
  let host: ReturnType<typeof createCompanyInstallation>;
  let client: ReturnType<typeof createCompanyInstallation>;
  let owner = '';
  let member = '';
  let memberId = '';
  let ownerMemberId = '';
  let sharedScope = '';
  const admin = { headers: { 'x-test-admin': 'synthetic' } };
  const request = (token = '', isAdmin = false) => ({ headers: { 'x-realbud-member-session': token, ...(isAdmin ? admin.headers : {}) } });
  // Membership binds from an authenticated host session. The separate workspace
  // manifest keeps the original private worker profile across membership changes.
  const seatIdentities: string[] = [];
  function installation(name: string, onSeatIdentity?: (memberId: string) => void) {
    return createCompanyInstallation({ dataDirectory: join(directory, name), binaryDirectory: process.env.REALBUD_TEST_POSTGRES_BIN,
      previewEnabled: true, hasAdminSession: req => req.headers['x-test-admin'] === 'synthetic',
      ...(onSeatIdentity ? { onSeatIdentity } : {}),
      authorizeAdmin: req => req.headers['x-test-admin'] === 'synthetic' ? { ok: true, expiresAt: Date.now() + 60_000 } : { ok: false, status: 401, error: 'Service administration required' },
    });
  }
  async function call(target: typeof host, path: string, body?: unknown, token = '', isAdmin = false) {
    const response = await target.handle('/api/company/' + path, body === undefined ? 'GET' : 'POST', request(token, isAdmin), body);
    return { ...response, body: response.body as any };
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rb-host-join-'));
    host = installation('host'); client = installation('client', memberId => seatIdentities.push(memberId));
  });
  afterAll(async () => {
    await client?.close(); await host?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 20_000);

  it('requires admin, creates a new owned database, then gives the owner independent sign-in', async () => {
    expect((await call(host, 'setup', {})).status).toBe(401);
    // Match a clean macOS GUI launch, where shell locale variables are absent.
    vi.stubEnv('LANG', undefined); vi.stubEnv('LC_ALL', undefined);
    let setup;
    try { setup = await call(host, 'setup', {}, '', true); }
    finally { vi.unstubAllEnvs(); }
    expect(setup).toMatchObject({ status: 200, body: { ok: true } });
    const created = await call(host, 'create', { name: 'Synthetic host office', ownerName: 'Alice', credential: { loginName: 'alice', password: 'Synthetic-owner-password-2026' } }, '', true);
    expect(created.status).toBe(201); owner = created.body.memberToken; ownerMemberId = created.body.member.id;
    expect(created.body.recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const scopes = await call(host, 'scopes', undefined, owner);
    sharedScope = scopes.body.scopes.find((s: any) => s.kind === 'company').id;
    const write = await host.handle('/api/company/knowledge', 'PUT', request(owner), { scopeId: sharedScope, key: 'office-guide', expectedRevision: '0', content: 'Synthetic shared instructions', sourceRefs: ['synthetic:office-guide'] });
    expect(write.status).toBe(200);
  }, 45_000);

  it('enables company-only TLS and joins from an independent client with a one-use invitation', async () => {
    expect((await call(host, 'network', { hostname: '127.0.0.1' }, owner)).status).toBe(401);
    expect((await call(host, 'network', { hostname: '127.0.0.1' }, owner, true)).status).toBe(200);
    const code = await call(host, 'host-code', undefined, owner);
    expect(code.status).toBe(200);
    expect((await call(client, 'connect-host', { hostCode: code.body.hostCode })).status).toBe(200);
    // A lost response must not strand a companion whose pairing was saved.
    expect((await call(client, 'connect-host', { hostCode: code.body.hostCode })).status).toBe(200);
    const invitation = await call(host, 'invitations', { displayName: 'Bob' }, owner);
    const joined = await call(client, 'join', { invitationToken: invitation.body.invitationToken, credential: { loginName: 'bob', password: 'Synthetic-member-password-2026' } });
    expect(joined.status).toBe(201); member = joined.body.memberToken; memberId = joined.body.member.id;
    // The joining seat adopts the identity it was just issued, so its desk can
    // resolve that seat's own worker profile. Without this a joined seat has no
    // identity at all and would fall back to the shared base profile.
    expect(seatIdentities).toContain(memberId);
    // A bound workspace rejects a second enrollment before contacting the host.
    expect((await call(client, 'join', { invitationToken: invitation.body.invitationToken, credential: { loginName: 'bob', password: 'Synthetic-member-password-2026' } })).status).toBe(409);
    const unusedSeat = installation('unused-seat');
    try {
      expect((await call(unusedSeat, 'connect-host', { hostCode: code.body.hostCode })).status).toBe(200);
      expect((await call(unusedSeat, 'join', { invitationToken: invitation.body.invitationToken, credential: { loginName: 'bob-again', password: 'Synthetic-member-password-2026' } })).status).toBe(401);
    } finally { await unusedSeat.close(); }
    expect(joined.body.recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await call(client, 'knowledge/read', { scopeId: sharedScope, key: 'office-guide' }, member)).body.knowledge.content).toBe('Synthetic shared instructions');
    const ownerScopes = await call(host, 'scopes', undefined, owner);
    const privateScope = ownerScopes.body.scopes.find((s: any) => s.kind === 'private').id;
    expect([403, 404]).toContain((await call(client, 'knowledge/read', { scopeId: privateScope, key: 'private-note' }, member)).status);
    expect((await call(client, 'create', { name: 'Forbidden', ownerName: 'Impersonator' }, member, true)).status).not.toBe(201);
  }, 20_000);

  it('puts reviewed work on the joined desktop and keeps private files on their own computers', async () => {
    const shared = await call(host, 'work', {
      requestId: randomUUID(),
      title: 'Synthetic invoice review',
      summary: 'Check the fictional invoice conclusions.',
      purpose: 'request-review',
      recipientMemberIds: [memberId],
      assigneeMemberId: memberId,
    }, owner);
    expect(shared.status).toBe(201);
    const listed = await call(client, 'work', undefined, member);
    expect(listed.status).toBe(200);
    expect(listed.body.items.some((item: { id: string }) => item.id === shared.body.item.id)).toBe(true);
    const history = await call(client, 'work/history', { id: shared.body.item.id }, member);
    expect(history.status).toBe(200);
    expect(history.body.events[0].revision).toMatch(/^[1-9][0-9]*$/);
    const older = await call(client, 'work/history', {
      id: shared.body.item.id,
      beforeRevision: history.body.events.at(-1).revision,
    }, member);
    expect(older.status).toBe(200);
    const files = ['host', 'client'].map(name => join(directory, name, 'Local notes.txt'));
    await writeFile(files[0], 'Accounts desktop only', { mode: 0o600 });
    await writeFile(files[1], 'Property management desktop only', { mode: 0o600 });
    expect(await readFile(files[0], 'utf8')).toBe('Accounts desktop only');
    expect(await readFile(files[1], 'utf8')).toBe('Property management desktop only');
  }, 20_000);

  it('holds peer work during host loss and reconnects without re-pairing or replaying writes', async () => {
    const pairingPath = join(directory, 'client/company-installation/peer.json');
    const pairing = await readFile(pairingPath);
    const original = await call(client, 'knowledge/read', { scopeId: sharedScope, key: 'office-guide' }, member);
    const files = ['host', 'client'].map(name => join(directory, name, 'Local notes.txt'));
    await writeFile(files[0], 'Accounts desktop only: SYN-A-719', { mode: 0o600 });
    await writeFile(files[1], 'Property management desktop only: SYN-B-823', { mode: 0o600 });
    await host.close();
    expect((await call(client, 'status', undefined, member)).status).toBe(503);
    const held = await client.handle('/api/company/knowledge', 'PUT', request(member), {
      scopeId: sharedScope, key: 'office-guide', expectedRevision: original.body.knowledge.revision,
      content: 'Must never appear after reconnect', sourceRefs: ['synthetic:offline-attempt'],
    });
    expect(held.status).toBe(503);
    // Local file availability is independent of company transport; this does
    // not claim an offline model, a worker turn, or physical desktop access.
    expect(await readFile(files[0], 'utf8')).toBe('Accounts desktop only: SYN-A-719');
    expect(await readFile(files[1], 'utf8')).toBe('Property management desktop only: SYN-B-823');
    host = installation('host');
    expect((await call(host, 'status')).body.networkEnabled).toBe(true);
    const connected = await call(client, 'status', undefined, member);
    expect(connected).toMatchObject({ status: 200, body: { transport: 'encrypted-company', member: { displayName: 'Bob' } } });
    const recovered = await call(client, 'knowledge/read', { scopeId: sharedScope, key: 'office-guide' }, member);
    expect(recovered.body.knowledge).toEqual(original.body.knowledge);
    expect(await readFile(pairingPath)).toEqual(pairing);
  }, 30_000);

  it('reopens the same host and client, signs in again and preserves shared company data', async () => {
    await client.close(); await host.close();
    host = installation('host'); client = installation('client');
    const hostState = await call(host, 'status');
    expect(hostState.body.configured).toBe(true); expect(hostState.body.networkEnabled).toBe(true);
    // The office binding survives restart independently of private worker identity.
    expect(await host.seatIdentity()).toBe(ownerMemberId);
    const signedIn = await call(client, 'sign-in', { loginName: 'BOB', password: 'Synthetic-member-password-2026' });
    expect(signedIn.status).toBe(200); member = signedIn.body.memberToken;
    expect((await call(client, 'status', undefined, member)).body.transport).toBe('encrypted-company');
    expect((await call(client, 'knowledge/read', { scopeId: sharedScope, key: 'office-guide' }, member)).body.knowledge.content).toBe('Synthetic shared instructions');
    expect((await call(client, 'logout', {}, member)).status).toBe(200);
    expect((await call(client, 'me', undefined, member)).status).toBe(401);
  }, 30_000);
  it('renews the host identity, leaves cleanly, and joins another office without changing private work', async () => {
    const identity = await client.workspaceIdentity();
    const before = await readFile(join(directory, 'client/Local notes.txt'), 'utf8');
    const signed = await call(client, 'sign-in', { loginName: 'bob', password: 'Synthetic-member-password-2026' });
    member = signed.body.memberToken;
    expect((await call(host, 'network', { hostname: '127.0.0.1', renewIdentity: true }, owner, true)).status).toBe(200);
    expect((await call(client, 'status', undefined, member)).status).toBe(503);
    const replacement = (await call(host, 'host-code', undefined, owner)).body.hostCode;
    expect((await call(client, 'connect-host', { hostCode: replacement, replaceExisting: true })).status).toBe(200);
    member = (await call(client, 'sign-in', { loginName: 'bob', password: 'Synthetic-member-password-2026' })).body.memberToken;
    expect((await call(client, 'leave-office', {}, member)).body.code).toBe('work_resolution_required');
    const shared = (await call(host, 'work', undefined, owner)).body.items;
    for (const item of shared) if (item.state !== 'closed') expect((await call(host, 'work/close', { id: item.id, expectedRevision: item.revision }, owner)).status).toBe(200);
    expect((await call(client, 'leave-office', {}, member)).status).toBe(200);
    expect((await call(host, 'me', undefined, member)).status).toBe(401);
    expect(await client.seatIdentity()).toBeNull();
    expect((await call(client, 'status')).body.remoteJoinAvailable).toBe(true);
    await client.close(); client = installation('client');
    expect(await client.workspaceIdentity()).toEqual(identity);
    const nextHost = installation('next-office');
    try {
      expect((await call(nextHost, 'setup', {}, '', true)).status).toBe(200);
      const nextOwner = (await call(nextHost, 'create', { name: 'Another synthetic office', ownerName: 'New owner', credential: { loginName: 'next.owner', password: 'Synthetic-next-password' } }, '', true)).body;
      expect((await call(nextHost, 'network', { hostname: '127.0.0.1' }, nextOwner.memberToken, true)).status).toBe(200);
      const nextCode = (await call(nextHost, 'host-code', undefined, nextOwner.memberToken)).body.hostCode;
      expect((await call(client, 'connect-host', { hostCode: nextCode })).status).toBe(200);
      const invited = (await call(nextHost, 'invitations', { displayName: 'Bob' }, nextOwner.memberToken)).body;
      const joined = await call(client, 'join', { invitationToken: invited.invitationToken, credential: { loginName: 'bob', password: 'Synthetic-next-member-password' } });
      expect(joined.status).toBe(201); expect(joined.body.member.id).not.toBe(memberId);
      expect(await client.workspaceIdentity()).toEqual(identity);
      expect(await readFile(join(directory, 'client/Local notes.txt'), 'utf8')).toBe(before);
      expect((await call(client, 'me', undefined, member)).status).toBe(401);
    } finally { await nextHost.close(); }
  }, 30_000);

});
