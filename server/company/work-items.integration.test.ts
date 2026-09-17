import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createCompanyKernel, migrateCompanySchema, type CompanyKernel } from './index.ts';

const url = process.env.REALBUD_COMPANY_TEST_URL;
const SECRET = 'SECRET-PRIVATE-NOTE';

describe.skipIf(!url)('company shared work items on PostgreSQL', () => {
  let admin: Pool, app: Pool, second: Pool, kernel: CompanyKernel, other: CompanyKernel;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!/^\/realbud_company_test_[a-z0-9_]+$/.test(target.pathname)) throw new Error('Disposable database required');
    admin = new Pool({ connectionString: target.toString() });
    await migrateCompanySchema(admin, { applicationRole: 'rb_company_test_app' });
    target.username = 'rb_company_test_app';
    app = new Pool({ connectionString: target.toString(), max: 3 });
    second = new Pool({ connectionString: target.toString(), max: 3 });
    kernel = createCompanyKernel(app);
    other = createCompanyKernel(second);
  });
  afterAll(async () => { await Promise.all([admin?.end(), app?.end(), second?.end()]); });

  async function office() {
    const owner = await kernel.createCompany({ name: 'Shared work fixture', ownerName: 'Owner' });
    const join = async (displayName: string) => other.redeemInvitation((await kernel.issueInvitation(owner.sessionToken, { displayName })).invitationToken);
    const [alice, bob, carol] = await Promise.all([join('Alice'), join('Bob'), join('Carol')]);
    return { owner, alice, bob, carol };
  }

  function draft(recipientId: string, requestId: string = randomUUID(), extra: Record<string, unknown> = {}) {
    return {
      requestId,
      title: 'Reviewed draft',
      summary: 'Please check the draft conclusions.',
      purpose: 'request-review' as const,
      recipientMemberIds: [recipientId],
      assigneeMemberId: recipientId,
      ...extra,
    };
  }

  it('shares only to named recipients and leaves private knowledge untouched', async () => {
    const { owner, alice, bob, carol } = await office();
    await kernel.replaceKnowledge(alice.sessionToken, { scopeId: alice.privateScope.id, key: 'note', expectedRevision: '0', content: SECRET });
    await expect(kernel.shareWork(alice.sessionToken, draft(bob.memberId, randomUUID(), { purpose: 'handoff', assigneeMemberId: null }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(kernel.shareWork(alice.sessionToken, draft(alice.memberId))).rejects.toMatchObject({ code: 'invalid_input' });
    const requestId = randomUUID();
    const item = await kernel.shareWork(alice.sessionToken, draft(bob.memberId, requestId));
    expect(item.id).toBe(requestId);
    expect(item.scopeId).not.toBe(alice.privateScope.id);
    expect(item.state).toBe('open');
    expect(item.response).toBe('');
    expect(item.owner.id).toBe(alice.memberId);
    expect(item.assignee?.id).toBe(bob.memberId);
    expect(item.audience.map(p => p.id).sort()).toEqual([alice.memberId, bob.memberId].sort());
    const listed = await other.listSharedWork(bob.sessionToken);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(item.id);
    expect(JSON.stringify(listed)).not.toMatch(SECRET);
    expect(await kernel.listSharedWork(owner.sessionToken)).toEqual([]);
    expect(await other.listSharedWork(carol.sessionToken)).toEqual([]);
    expect((await kernel.readKnowledge(alice.sessionToken, { scopeId: alice.privateScope.id, key: 'note' }))?.content).toBe(SECRET);
    expect(await kernel.readKnowledge(alice.sessionToken, { scopeId: item.scopeId, key: 'note' })).toBeNull();
    await expect(kernel.replaceKnowledge(alice.sessionToken, {
      scopeId: item.scopeId, key: 'realbud-work-item:v1', expectedRevision: item.revision, content: '{}',
    })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await kernel.readKnowledge(alice.sessionToken, { scopeId: item.scopeId, key: 'realbud-work-item:v1' })).toBeTruthy();
    await expect(other.readKnowledge(carol.sessionToken, { scopeId: item.scopeId, key: 'realbud-work-item:v1' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await kernel.listWorkMembers(alice.sessionToken)).map(p => p.displayName)).toEqual(['Alice', 'Bob', 'Carol', 'Owner']);
    const copied = await kernel.shareWork(alice.sessionToken, draft(bob.memberId, randomUUID(), {
      purpose: 'share-result', assigneeMemberId: null, title: 'Share result', summary: 'Finished analysis for review copy.',
    }));
    expect(copied.assignee).toBeNull();
    expect(copied.purpose).toBe('share-result');
  });

  it('retains readable legacy work, upgrades it on an explicit action, and rejects another company', async () => {
    const { alice, bob } = await office();
    const created = await kernel.shareWork(alice.sessionToken, draft(bob.memberId));
    const legacy = { title: created.title, summary: created.summary, purpose: created.purpose, state: 'open',
      assigneeMemberId: bob.memberId, recipientMemberIds: [bob.memberId], response: '' };
    await admin.query(`UPDATE realbud_company.knowledge_revisions SET content=$3 WHERE company_id=$1 AND scope_id=$2`, [alice.companyId, created.scopeId, JSON.stringify(legacy)]);
    const old = (await other.listSharedWork(bob.sessionToken))[0];
    expect(old.evidence).toBeNull(); expect(old.acceptedBy).toBeNull();
    const accepted = await other.acceptSharedWork(bob.sessionToken, { id: old.id, expectedRevision: old.revision });
    expect(accepted.state).toBe('accepted');
    const strangers = await office();
    await expect(kernel.sharedWorkHistory(strangers.alice.sessionToken, { id: old.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(kernel.acceptSharedWork(strangers.alice.sessionToken, { id: old.id, expectedRevision: accepted.revision })).rejects.toMatchObject({ code: 'not_found' });
    await expect(kernel.reassignSharedWork(strangers.alice.sessionToken, { id: old.id, expectedRevision: accepted.revision, assigneeMemberId: strangers.bob.memberId })).rejects.toMatchObject({ code: 'not_found' });
    expect((await kernel.sharedWorkHistory(alice.sessionToken, { id: old.id })).events.map(event => event.action)).toEqual(['accepted', 'shared']);
    expect(JSON.parse((await admin.query(`SELECT content FROM realbud_company.knowledge_revisions WHERE company_id=$1 AND scope_id=$2 AND revision=1`, [alice.companyId, old.scopeId])).rows[0].content)).toEqual(legacy);
  });

  it('pages immutable history and does not let a non-assigned audience member provide the named review', async () => {
    const { alice, bob, carol } = await office();
    let work = await kernel.shareWork(alice.sessionToken, draft(bob.memberId, randomUUID(), { recipientMemberIds: [bob.memberId, carol.memberId] }));
    expect((await other.listSharedWork(carol.sessionToken))[0].actions.respond).toBe(false);
    await expect(other.respondToSharedWork(carol.sessionToken, { id: work.id, expectedRevision: work.revision, response: 'Wrong named reviewer' })).rejects.toMatchObject({ code: 'forbidden' });
    for (let index = 0; index < 21; index++) work = await other.respondToSharedWork(bob.sessionToken, { id: work.id, expectedRevision: work.revision, response: `Reviewed revision ${index}` });
    const page = await kernel.sharedWorkHistory(alice.sessionToken, { id: work.id });
    expect(page.events).toHaveLength(20); expect(page.hasMore).toBe(true);
    expect(page.events[0].revision).toBe('22');
    const cursor = page.events.at(-1)!.revision;
    const older = await kernel.sharedWorkHistory(alice.sessionToken, { id: work.id, beforeRevision: cursor });
    await expect(kernel.sharedWorkHistory(alice.sessionToken, { id: work.id, beforeRevision: Number(cursor) })).resolves.toMatchObject({
      events: older.events,
    });
    expect(older.events.map(event => event.revision)).toEqual(['2', '1']); expect(older.hasMore).toBe(false);
    expect(new Set([...page.events, ...older.events].map(event => event.revision)).size).toBe(22);
    await expect(kernel.sharedWorkHistory(alice.sessionToken, { id: work.id, beforeRevision: 'invalid' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('replays identical requests, rejects collisions and stale replies, and closes in-band', async () => {
    const { alice, bob } = await office();
    const input = draft(bob.memberId);
    const raced = await Promise.allSettled([kernel.shareWork(alice.sessionToken, input), other.shareWork(alice.sessionToken, input)]);
    expect(raced.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    const opened = await kernel.shareWork(alice.sessionToken, input);
    expect(opened.id).toBe(input.requestId);
    expect((await kernel.listSharedWork(alice.sessionToken)).filter(item => item.id === input.requestId)).toHaveLength(1);
    await expect(kernel.shareWork(alice.sessionToken, { ...input, summary: 'Changed summary that must conflict' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(kernel.respondToSharedWork(alice.sessionToken, { id: opened.id, expectedRevision: opened.revision, response: 'owner cannot reply' })).rejects.toMatchObject({ code: 'forbidden' });
    const replied = await other.respondToSharedWork(bob.sessionToken, { id: opened.id, expectedRevision: opened.revision, response: 'Looks good' });
    expect(replied.state).toBe('responded');
    expect(replied.response).toBe('Looks good');
    expect(replied.title).toBe(opened.title);
    expect(replied.summary).toBe(opened.summary);
    expect(replied.purpose).toBe(opened.purpose);
    expect(replied.assignee?.id).toBe(bob.memberId);
    expect(replied.updatedBy.id).toBe(bob.memberId);
    await expect(other.respondToSharedWork(bob.sessionToken, { id: opened.id, expectedRevision: opened.revision, response: 'stale' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(other.closeSharedWork(bob.sessionToken, { id: opened.id, expectedRevision: replied.revision })).rejects.toMatchObject({ code: 'forbidden' });
    const closed = await kernel.closeSharedWork(alice.sessionToken, { id: opened.id, expectedRevision: replied.revision });
    expect(closed.state).toBe('closed');
    expect(closed.response).toBe('Looks good');
    expect(closed.updatedBy.id).toBe(alice.memberId);
    await expect(other.respondToSharedWork(bob.sessionToken, { id: opened.id, expectedRevision: closed.revision, response: 'too late' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(kernel.closeSharedWork(alice.sessionToken, { id: opened.id, expectedRevision: closed.revision })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('drops visibility when grants are removed or the recipient is revoked', async () => {
    const granted = await office();
    const shared = await kernel.shareWork(granted.alice.sessionToken, draft(granted.bob.memberId));
    const scope = (await kernel.listScopes(granted.alice.sessionToken)).find(item => item.id === shared.scopeId);
    expect(scope).toBeTruthy();
    await kernel.setScopeGrant(granted.alice.sessionToken, {
      scopeId: shared.scopeId, memberId: granted.bob.memberId, permissions: [], expectedRevision: scope!.revision,
    });
    expect(await other.listSharedWork(granted.bob.sessionToken)).toEqual([]);
    await expect(other.respondToSharedWork(granted.bob.sessionToken, {
      id: shared.id, expectedRevision: shared.revision, response: 'still here',
    })).rejects.toMatchObject({ code: 'not_found' });
    expect((await kernel.listSharedWork(granted.alice.sessionToken))[0].audience.map(person => person.id)).toEqual([granted.alice.memberId]);

    const revoked = await office();
    const again = await kernel.shareWork(revoked.alice.sessionToken, draft(revoked.bob.memberId));
    await kernel.revokeMember(revoked.owner.sessionToken, revoked.bob.memberId);
    await expect(other.listSharedWork(revoked.bob.sessionToken)).rejects.toMatchObject({ code: 'unauthenticated' });
    const remaining = await kernel.listSharedWork(revoked.alice.sessionToken);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(again.id);
    expect(remaining[0].audience.map(person => person.id)).toEqual([revoked.alice.memberId]);
    expect(await kernel.readKnowledge(revoked.alice.sessionToken, { scopeId: revoked.alice.privateScope.id, key: 'note' })).toBeNull();
  });

  it('reports current viewer actions and refuses a stale writer after a read-only downgrade', async () => {
    const { alice, bob } = await office();
    const shared = await kernel.shareWork(alice.sessionToken, draft(bob.memberId));
    expect(shared.actions).toEqual({ respond: false, close: true, accept: false, reassign: true, addRecipient: true });
    expect((await other.listSharedWork(bob.sessionToken))[0].actions).toEqual({ respond: true, close: false, accept: true, reassign: false, addRecipient: false });
    const scope = (await kernel.listScopes(alice.sessionToken)).find(item => item.id === shared.scopeId)!;
    await kernel.setScopeGrant(alice.sessionToken, {
      scopeId: scope.id, memberId: bob.memberId, permissions: ['read'], expectedRevision: scope.revision,
    });
    const readonly = (await other.listSharedWork(bob.sessionToken))[0];
    expect(readonly.summary).toBe(shared.summary);
    expect(readonly.actions).toEqual({ respond: false, close: false, accept: false, reassign: false, addRecipient: false });
    await expect(other.respondToSharedWork(bob.sessionToken, {
      id: shared.id, expectedRevision: shared.revision, response: 'Stale write after downgrade',
    })).rejects.toMatchObject({ code: 'forbidden' });
    const closed = await kernel.closeSharedWork(alice.sessionToken, { id: shared.id, expectedRevision: shared.revision });
    expect(closed.actions).toEqual({ respond: false, close: false, accept: false, reassign: false, addRecipient: false });
    expect((await other.listSharedWork(bob.sessionToken))[0].actions).toEqual({ respond: false, close: false, accept: false, reassign: false, addRecipient: false });
  });
  it('pages within the chosen audience without hiding older open work behind sent items', async () => {
    const { alice, bob } = await office();
    for (let i = 0; i < 11; i++) await kernel.shareWork(alice.sessionToken, draft(bob.memberId, randomUUID(), { title: `Review ${i}` }));
    await other.shareWork(bob.sessionToken, draft(alice.memberId));
    const first = await kernel.listSharedWork(alice.sessionToken, { offset: 0, filter: 'by-me' });
    const next = await kernel.listSharedWork(alice.sessionToken, { offset: 10, filter: 'by-me' });
    expect(first).toHaveLength(10); expect(next).toHaveLength(1);
    expect(new Set([...first, ...next].map(item => item.id)).size).toBe(11);
    expect(await kernel.listSharedWork(alice.sessionToken, { filter: 'with-me' })).toHaveLength(1);
    await expect(kernel.listSharedWork(alice.sessionToken, { offset: -1 })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('reports damaged shared records instead of silently showing an empty list', async () => {
    const { alice, bob } = await office();
    const item = await kernel.shareWork(alice.sessionToken, draft(bob.memberId));
    // Deliberate corruption in this disposable database using the fixture admin.
    await admin.query(`UPDATE realbud_company.knowledge_revisions SET content='{}'
      WHERE company_id=$1 AND scope_id=$2 AND key='realbud-work-item:v1'`, [alice.companyId, item.scopeId]);
    await expect(other.listSharedWork(bob.sessionToken)).rejects.toMatchObject({ code: 'recovery_required' });
    await expect(other.respondToSharedWork(bob.sessionToken, { id: item.id, expectedRevision: '1', response: 'Do not overwrite' })).rejects.toMatchObject({ code: 'recovery_required' });
    expect((await admin.query('SELECT content FROM realbud_company.knowledge_revisions WHERE company_id=$1 AND scope_id=$2', [alice.companyId, item.scopeId])).rows[0].content).toBe('{}');
  });

  it('does not let generic case APIs alias shared work or turn a review into a worker claim', async () => {
    const { alice, bob } = await office();
    const item = await kernel.shareWork(alice.sessionToken, draft(bob.memberId));
    await expect(other.createCase(bob.sessionToken, { scopeId: item.scopeId, title: 'Alias' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(other.claimCase(bob.sessionToken, { caseId: item.id, ttlMs: 60_000 })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await other.listSharedWork(bob.sessionToken)).toEqual([{ ...item, actions: { respond: true, close: false, accept: true, reassign: false, addRecipient: false } }]);
  });

  it('preserves the exact reviewed whitespace and canonicalizes UUID casing', async () => {
    const { alice, bob } = await office();
    const input = draft(bob.memberId.toUpperCase(), randomUUID().toUpperCase(), { title: '  Exact title  ', summary: '  Exact summary\n' });
    const item = await kernel.shareWork(alice.sessionToken, input);
    expect(item.title).toBe(input.title); expect(item.summary).toBe(input.summary);
    expect(item.id).toBe(input.requestId.toLowerCase());
    await expect(kernel.shareWork(alice.sessionToken, draft(alice.memberId.toUpperCase()))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('handles overlapping recipients and revocation, then replays a saved request with its reduced audience', async () => {
    const { owner, alice, bob, carol } = await office();
    const first = { ...draft(bob.memberId), recipientMemberIds: [bob.memberId, carol.memberId] };
    const secondRequest = { ...draft(bob.memberId), recipientMemberIds: [carol.memberId, bob.memberId] };
    const replies = await Promise.allSettled([
      kernel.shareWork(alice.sessionToken, first), other.shareWork(owner.sessionToken, secondRequest),
      kernel.revokeMember(owner.sessionToken, carol.memberId),
    ]);
    expect(replies[2].status).toBe('fulfilled');
    for (let i = 0; i < 2; i++) {
      const result = replies[i];
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'not_found' });
      else {
        const token = i === 0 ? alice.sessionToken : owner.sessionToken;
        const replay = await kernel.shareWork(token, i === 0 ? first : secondRequest);
        expect(replay.audience.map(person => person.id)).not.toContain(carol.memberId);
      }
    }
    const saved = await kernel.shareWork(alice.sessionToken, draft(bob.memberId));
    const scope = (await kernel.listScopes(alice.sessionToken)).find(scope => scope.id === saved.scopeId)!;
    await kernel.setScopeGrant(alice.sessionToken, { scopeId: saved.scopeId, memberId: bob.memberId, permissions: [], expectedRevision: scope.revision });
    const replay = await kernel.shareWork(alice.sessionToken, draft(bob.memberId, saved.id));
    expect(replay.id).toBe(saved.id); expect(replay.audience.map(person => person.id)).toEqual([alice.memberId]);
  });

});
