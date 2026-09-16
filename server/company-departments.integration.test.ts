import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCompanyInstallation } from './company-installation.ts';

// Six private application directories, one real PostgreSQL host, pinned TLS.
// This proves company coordination APIs, not shared Desk/Ask job execution.
describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('fictional agency department workday over company TLS', () => {
  type Installation = ReturnType<typeof createCompanyInstallation>;
  type Staff = { app: Installation; token: string; id: string; privateScope: string; login: string };
  let directory: string;
  let host: Installation;
  let owner: Staff;
  let companyScope: string;
  const staff: Record<string, Staff> = {};
  const scopes: Record<string, { id: string; revision: string }> = {};
  const password = 'Synthetic-department-password-2026';
  function installation(name: string) {
    return createCompanyInstallation({ dataDirectory: join(directory, name), binaryDirectory: process.env.REALBUD_TEST_POSTGRES_BIN,
      previewEnabled: true, hasAdminSession: req => req.headers['x-test-admin'] === 'synthetic',
      authorizeAdmin: req => req.headers['x-test-admin'] === 'synthetic'
        ? { ok: true, expiresAt: Date.now() + 60_000 } : { ok: false, status: 401, error: 'Service administration required' },
    });
  }
  async function request(app: Installation, path: string, body?: unknown, token = '', method = body === undefined ? 'GET' : 'POST', admin = false) {
    const result = await app.handle(`/api/company/${path}`, method, { headers: {
      'x-realbud-member-session': token, ...(admin ? { 'x-test-admin': 'synthetic' } : {}),
    } }, body);
    return { status: result.status, body: result.body as any };
  }
  const call = (person: Staff, path: string, body?: unknown, method?: string) => request(person.app, path, body, person.token, method);
  async function identify(app: Installation, result: any, login: string): Promise<Staff> {
    expect(result.status).toBe(201);
    const scopes = await request(app, 'scopes', undefined, result.body.memberToken);
    return { app, token: result.body.memberToken, id: result.body.member.id, login,
      privateScope: scopes.body.scopes.find((scope: any) => scope.kind === 'private').id };
  }
  async function grant(department: string, person: Staff, permissions: ('read' | 'write')[]) {
    const scope = scopes[department];
    const changed = await call(owner, 'grants', { scopeId: scope.id, memberId: person.id, permissions, expectedRevision: scope.revision }, 'PUT');
    expect(changed.status).toBe(200);
    scope.revision = changed.body.revision;
  }
  const record = (person: Staff, scopeId: string, key: string, content: string, expectedRevision = '0') =>
    call(person, 'knowledge', { scopeId, key, content, expectedRevision, sourceRefs: [`synthetic:${key}`] }, 'PUT');
  const read = (person: Staff, scopeId: string, key: string) => call(person, 'knowledge/read', { scopeId, key });
  const lease = (claim: any) => ({ caseId: claim.caseId, fence: claim.fence, claimToken: claim.claimToken });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rb-host-join-'));
    host = installation('host');
    expect((await request(host, 'setup', {}, '', 'POST', true)).status).toBe(200);
    owner = await identify(host, await request(host, 'create', { name: 'Fictional Acacia Agency', ownerName: 'Practice owner',
      credential: { loginName: 'practice.owner', password } }, '', 'POST', true), 'practice.owner');
    companyScope = (await call(owner, 'scopes')).body.scopes.find((scope: any) => scope.kind === 'company').id;
    expect((await request(host, 'network', { hostname: '127.0.0.1' }, owner.token, 'POST', true)).status).toBe(200);
    const hostCode = (await call(owner, 'host-code')).body.hostCode;
    for (const name of ['accounts', 'assistant', 'property', 'leasing', 'maintenance']) {
      const app = installation(name);
      // Retain the app immediately so even a failed enrollment is cleaned up.
      staff[name] = { app, token: '', id: '', privateScope: '', login: name };
      expect((await request(app, 'connect-host', { hostCode })).status).toBe(200);
      const invitation = await call(owner, 'invitations', { displayName: `Practice ${name}` });
      staff[name] = await identify(app, await request(app, 'join', { invitationToken: invitation.body.invitationToken,
        credential: { loginName: name, password } }), name);
    }
    for (const department of ['accounts', 'property', 'leasing', 'maintenance']) {
      const created = await call(owner, 'scopes', { kind: 'team', name: `Practice ${department} department` });
      expect(created.status).toBe(201); scopes[department] = created.body.scope;
      await grant(department, staff[department], ['read', 'write']);
    }
    await grant('accounts', staff.assistant, ['read', 'write']);
    await grant('accounts', staff.property, ['read']);
    await grant('maintenance', staff.property, ['read']);
  }, 60_000);

  afterAll(async () => {
    for (const person of Object.values(staff)) await person.app.close();
    await host?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 20_000);

  it('shares a sourced office procedure with all five staff without granting edit authority', async () => {
    expect((await record(owner, companyScope, 'morning-procedure', 'TRAINING: review exceptions before drafting follow-ups.')).status).toBe(200);
    for (const person of Object.values(staff)) {
      expect((await call(person, 'status')).body.transport).toBe('encrypted-company');
      expect((await read(person, companyScope, 'morning-procedure')).body.knowledge.sourceRefs).toEqual(['synthetic:morning-procedure']);
      expect([403, 404]).toContain((await record(person, companyScope, 'morning-procedure', 'Unauthorized edit', '1')).status);
    }
  });

  it('keeps each personal note private, including from the company owner', async () => {
    for (const person of Object.values(staff)) {
      expect((await record(person, person.privateScope, 'personal-note', `TRAINING: ${person.login} private note`)).status).toBe(200);
      expect((await read(person, person.privateScope, 'personal-note')).status).toBe(200);
      expect([403, 404]).toContain((await read(owner, person.privateScope, 'personal-note')).status);
      const visible = (await call(person, 'scopes')).body.scopes.map((scope: any) => scope.id);
      for (const other of Object.values(staff).filter(other => other !== person)) {
        expect(visible).not.toContain(other.privateScope);
        expect([403, 404]).toContain((await read(person, other.privateScope, 'personal-note')).status);
      }
    }
  });

  it('allows an explicit accounts handover and read-only PM review, hiding it from leasing', async () => {
    const scopeId = scopes.accounts.id;
    expect((await record(staff.accounts, scopeId, 'bills-review', 'TRAINING BILL-104: check source invoice; no payment.')).status).toBe(200);
    expect((await read(staff.assistant, scopeId, 'bills-review')).status).toBe(200);
    expect((await read(staff.property, scopeId, 'bills-review')).status).toBe(200);
    expect([403, 404]).toContain((await record(staff.property, scopeId, 'bills-review', 'Forbidden PM edit', '1')).status);
    expect([403, 404]).toContain((await read(staff.leasing, scopeId, 'bills-review')).status);
    expect([403, 404]).toContain((await read(staff.maintenance, scopeId, 'bills-review')).status);
    const maintenance = await record(staff.maintenance, scopes.maintenance.id, 'repair-review', 'TRAINING TAP-22: quote draft, access unconfirmed; do not send.');
    expect(maintenance.status).toBe(200);
    expect((await read(staff.property, scopes.maintenance.id, 'repair-review')).body.knowledge.content).toContain('access unconfirmed');
  });

  it('rejects a simultaneous stale edit and preserves both accepted versions with their sources', async () => {
    const scopeId = scopes.accounts.id;
    const results = await Promise.all([
      record(staff.accounts, scopeId, 'bills-review', 'TRAINING: reviewer A checked BILL-104', '1'),
      record(staff.assistant, scopeId, 'bills-review', 'TRAINING: reviewer B checked BILL-104', '1'),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const history = await call(staff.property, 'knowledge/history', { scopeId, key: 'bills-review' });
    expect(history.status).toBe(200);
    expect(history.body.history.map((entry: any) => entry.revision)).toEqual(['2', '1']);
    expect(history.body.history.every((entry: any) => entry.sourceRefs[0] === 'synthetic:bills-review')).toBe(true);
    expect([403, 404]).toContain((await call(staff.leasing, 'knowledge/history', { scopeId, key: 'bills-review' })).status);
  });

  it('gives one accountant the job, supports renewal and handover, and rejects stale or duplicate completion', async () => {
    const created = await call(staff.accounts, 'cases', { scopeId: scopes.accounts.id, title: 'TRAINING: prepare BILL-104 review, no payment' });
    expect(created.status).toBe(201);
    const caseId = created.body.caseId;
    const people = [staff.accounts, staff.assistant];
    const attempts = await Promise.all(people.map(person => call(person, 'cases/claim', { caseId, ttlMs: 60_000 })));
    expect(attempts.map(result => result.status).sort()).toEqual([200, 409]);
    expect(attempts.find(result => result.status === 409)?.body.code).toBe('claim_busy');
    const winnerIndex = attempts.findIndex(result => result.status === 200);
    const winner = people[winnerIndex], next = people[1 - winnerIndex];
    const first = lease(attempts[winnerIndex].body);
    expect((await call(next, 'cases/settle', { ...first, outcome: 'done' })).body.code).toBe('stale_claim');
    expect((await call(winner, 'cases/renew', { ...first, ttlMs: 60_000 })).status).toBe(200);
    expect((await call(winner, 'cases/settle', { ...first, outcome: 'released', note: 'TRAINING: explicit handover' })).body.status).toBe('open');
    const second = await call(next, 'cases/claim', { caseId, ttlMs: 60_000 });
    expect(second.status).toBe(200); expect(BigInt(second.body.fence)).toBeGreaterThan(BigInt(first.fence));
    expect((await call(winner, 'cases/renew', { ...first, ttlMs: 60_000 })).body.code).toBe('stale_claim');
    expect((await call(winner, 'cases/settle', { ...first, outcome: 'done' })).body.code).toBe('stale_claim');
    const finished = await call(next, 'cases/settle', { ...lease(second.body), outcome: 'done', note: 'TRAINING: review prepared, no external action' });
    expect(finished.status).toBe(200); expect(finished.body.receiptId).toBeTruthy();
    expect((await call(next, 'cases/settle', { ...lease(second.body), outcome: 'done' })).body.code).toBe('stale_claim');
    expect((await call(staff.accounts, 'cases/claim', { caseId, ttlMs: 60_000 })).body.code).toBe('conflict');
  });

  it('rejects forged authority and invalid lifecycle requests before they change work', async () => {
    const created = await call(staff.accounts, 'cases', { scopeId: scopes.accounts.id, title: 'TRAINING: validation fixture' });
    const claimed = await call(staff.accounts, 'cases/claim', { caseId: created.body.caseId, ttlMs: 60_000 });
    const claim = lease(claimed.body);
    expect((await call(staff.accounts, 'cases/settle', { ...claim, outcome: 'done', memberId: owner.id })).status).toBe(400);
    expect((await call(staff.accounts, 'cases/settle', { ...claim, outcome: 'paid' })).status).toBe(400);
    expect((await call(staff.accounts, 'cases/renew', { ...claim, ttlMs: 0 })).status).toBe(400);
    expect((await request(staff.accounts.app, 'cases/settle', { ...claim, outcome: 'done' })).status).toBe(401);
    expect((await call(staff.accounts, 'cases/settle', { ...claim, outcome: 'released' })).status).toBe(200);
  });

  it('removes department access immediately even with a warm session and an active claim', async () => {
    const created = await call(staff.assistant, 'cases', { scopeId: scopes.accounts.id, title: 'TRAINING: access-change review' });
    const claimed = await call(staff.assistant, 'cases/claim', { caseId: created.body.caseId, ttlMs: 60_000 });
    await grant('accounts', staff.assistant, []);
    expect([403, 404]).toContain((await read(staff.assistant, scopes.accounts.id, 'bills-review')).status);
    expect([403, 404]).toContain((await call(staff.assistant, 'cases/renew', { ...lease(claimed.body), ttlMs: 60_000 })).status);
    expect((await call(staff.accounts, 'cases/claim', { caseId: created.body.caseId, ttlMs: 60_000 })).body.code).toBe('claim_busy');
    await grant('accounts', staff.assistant, ['read', 'write']);
    expect((await call(staff.assistant, 'cases/settle', { ...lease(claimed.body), outcome: 'released' })).status).toBe(200);
  });

  it('lets only the owner cancel an unused invitation and prevents its redemption', async () => {
    const invitation = await call(owner, 'invitations', { displayName: 'Cancelled practice enrollment' });
    expect(invitation.body.invitationId).toBeTruthy();
    const body = { invitationId: invitation.body.invitationId };
    expect((await call(staff.leasing, 'invitations/revoke', body)).status).toBe(403);
    expect((await call(owner, 'invitations/revoke', body)).status).toBe(200);
    expect((await request(staff.leasing.app, 'join', { invitationToken: invitation.body.invitationToken,
      credential: { loginName: 'cancelled', password } })).status).toBe(401);
  });

  it('offboards a staff member, revokes sign-in and holds their active job for recovery', async () => {
    const created = await call(staff.leasing, 'cases', { scopeId: scopes.leasing.id, title: 'TRAINING: leasing checklist, no tenant decision' });
    const claimed = await call(staff.leasing, 'cases/claim', { caseId: created.body.caseId, ttlMs: 60_000 });
    expect((await call(staff.property, 'members/revoke', { memberId: staff.leasing.id })).status).toBe(403);
    expect((await call(owner, 'members/revoke', { memberId: owner.id })).status).toBe(403);
    expect((await call(owner, 'members/revoke', { memberId: staff.leasing.id })).status).toBe(200);
    expect((await call(staff.leasing, 'me')).status).toBe(401);
    expect((await call(staff.leasing, 'cases/settle', { ...lease(claimed.body), outcome: 'done' })).status).toBe(401);
    expect((await request(staff.leasing.app, 'sign-in', { loginName: 'leasing', password })).status).toBe(401);
    expect((await call(owner, 'cases/claim', { caseId: created.body.caseId, ttlMs: 60_000 })).body.code).toBe('recovery_required');
  });

  it('holds an expired lease for review instead of automatically repeating its work', async () => {
    const created = await call(staff.maintenance, 'cases', { scopeId: scopes.maintenance.id, title: 'TRAINING: interrupted quote review' });
    const claimed = await call(staff.maintenance, 'cases/claim', { caseId: created.body.caseId, ttlMs: 100 });
    expect(claimed.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 180));
    expect((await call(staff.maintenance, 'cases/renew', { ...lease(claimed.body), ttlMs: 60_000 })).body.code).toBe('stale_claim');
    expect((await call(owner, 'cases/claim', { caseId: created.body.caseId, ttlMs: 60_000 })).body.code).toBe('recovery_required');
  });

  it('reopens the host and every client, preserving company records, private records and offboarding', async () => {
    for (const person of Object.values(staff)) await person.app.close();
    await host.close(); host = installation('host'); owner.app = host;
    expect((await request(host, 'status')).body.networkEnabled).toBe(true);
    for (const [name, person] of Object.entries(staff)) {
      person.app = installation(name);
      const signedIn = await request(person.app, 'sign-in', { loginName: person.login, password });
      if (name === 'leasing') { expect(signedIn.status).toBe(401); continue; }
      expect(signedIn.status).toBe(200); person.token = signedIn.body.memberToken;
      expect((await read(person, companyScope, 'morning-procedure')).status).toBe(200);
      expect((await read(person, person.privateScope, 'personal-note')).body.knowledge.content).toContain(person.login);
      expect([403, 404]).toContain((await read(person, owner.privateScope, 'personal-note')).status);
    }
    expect((await read(staff.accounts, scopes.accounts.id, 'bills-review')).body.knowledge.revision).toBe('2');
  }, 30_000);
});
