import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { departmentConfigurationReviewMaterial } from '../../shared/department-configuration.ts';
import { createCompanyKernel } from './index.ts';
import { startCompanyPostgresFixture } from './testing-postgres.ts';
import { createCompanyHost } from '../company-host.ts';
import { createHostCertificate } from './host-certificate.ts';
import { requestCompanyHost, startCompanyTransport } from './host-transport.ts';

describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('department API over pinned office TLS', () => {
  let fixture: Awaited<ReturnType<typeof startCompanyPostgresFixture>>;
  let transport: Awaited<ReturnType<typeof startCompanyTransport>>;
  let companyId:string, ownerToken: string, memberToken: string, memberId: string, cert: string, output: string;
  beforeAll(async () => {
    output = await mkdtemp(join(tmpdir(), 'rb-departments-tls-'));
    fixture = await startCompanyPostgresFixture({ outputDirectory: output, postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN });
    const kernel = createCompanyKernel(fixture.pool);
    const owner = await kernel.createCompany({ name: 'Fictional TLS office', ownerName: 'Practice owner' });
    ownerToken = owner.sessionToken; companyId=owner.companyId;
    const invitation = await kernel.issueInvitation(ownerToken, { displayName: 'Practice accountant' });
    const member = await kernel.redeemInvitation(invitation.invitationToken);
    memberToken = member.sessionToken; memberId = member.memberId;
    const host = createCompanyHost({ kernel, authorizeAdmin: () => ({ ok: false, status: 401, error: 'Admin unavailable' }), hasAdminSession: () => false });
    const certificate = await createHostCertificate('localhost'); cert = certificate.cert;
    transport = await startCompanyTransport({ ...certificate, host: '127.0.0.1', port: 0, handle: host.handle });
  }, 60_000);
  afterAll(async () => { await transport?.close(); await fixture?.stop(); if (output) await rm(output, { recursive: true, force: true }); });
  const call = (path: string, token: string, body: unknown, method = 'POST') => requestCompanyHost({ origin: `https://localhost:${transport.port}`, certificatePem: cert, path: `/api/company/${path}`, method, memberToken: token, body });
  it('refuses malformed Unicode department and case text with definitive 400 responses and no saved mutations', async () => {
    const valid = 'Fictional café 🏡';
    const made = await call('departments', ownerToken, { requestId: randomUUID(), name: valid });
    expect(made).toMatchObject({ status: 201, body: { department: { name: valid, revision: '0' } } });
    const departmentId = (made.body as { department: { id: string } }).department.id;
    const input = { departmentId, requestId: randomUUID(), title: valid, description: valid, assigneeMemberId: null };
    expect(await call('departments/cases/create', ownerToken, input)).toMatchObject({ status: 201, body: { item: { title: valid, description: valid, fence: '0' } } });
    const refusedIds: string[] = [];
    for (const value of ['\uD800', '\uDC00', 'Fictional\uD800text', '\uDC00\uD800']) {
      const malformed = [
        { path: 'departments', body: { requestId: randomUUID(), name: value } },
        ...(['title', 'description'] as const).map(field => ({ path: 'departments/cases/create', body: { ...input, requestId: randomUUID(), [field]: value } })),
        ...(['close', 'recover'] as const).map(action => ({ path: `departments/cases/${action}`, body: { departmentId, caseId: input.requestId, requestId: randomUUID(), expectedFence: '0', resolution: 'done', note: value } })),
        { path: 'departments/lifecycle', body: { departmentId, requestId: randomUUID(), expectedRevision: '0', retired: true, note: value } },
      ];
      for (const attempt of malformed) {
        refusedIds.push(attempt.body.requestId);
        expect(await call(attempt.path, ownerToken, attempt.body)).toMatchObject({ status: 400, body: { code: 'invalid_input' } });
      }
    }
    for (const table of ['cases', 'claim_receipts', 'audit_events', 'scopes']) {
      expect((await fixture.adminPool.query(`SELECT count(*)::int AS n FROM realbud_company.${table} WHERE id=ANY($1::uuid[])`, [refusedIds])).rows[0].n).toBe(0);
    }
    expect((await fixture.adminPool.query('SELECT status,fence,title,description FROM realbud_company.cases WHERE id=$1', [input.requestId])).rows[0]).toEqual({ status: 'open', fence: '0', title: valid, description: valid });
    expect(await call('departments/cases/close', ownerToken, { departmentId, caseId: input.requestId, requestId: randomUUID(), expectedFence: '0', resolution: 'done', note: valid })).toMatchObject({ status: 200, body: { item: { lastClosure: { note: valid } } } });
    expect(await call('departments/lifecycle', ownerToken, { departmentId, requestId: randomUUID(), expectedRevision: '0', retired: true, note: valid })).toMatchObject({ status: 200, body: { department: { retirementNote: valid } } });
  });
  it('authenticates, validates and persists department access across the reviewed LAN routes', async () => {
    expect((await call('departments/list', '', {})).status).toBe(401);
    expect((await call('departments', memberToken, { requestId: randomUUID(), name: 'Forbidden' })).status).toBe(403);
    expect((await call('departments', ownerToken, { requestId: randomUUID(), name: 'Bad identity', memberId })).status).toBe(400);
    const created = await call('departments', ownerToken, { requestId: randomUUID(), name: 'Accounts' });
    expect(created.status).toBe(201);
    const id = (created.body as { department: { id: string } }).department.id;
    expect((await call('departments/access', memberToken, { departmentId: id })).status).toBe(403);
    expect((await call('departments/access', ownerToken, { departmentId: id, memberId, access: 'read', expectedRevision: '0' }, 'PUT')).status).toBe(200);
    expect((await call('departments/list', memberToken, {})).body).toMatchObject({ canManage: false, departments: [{ id, name: 'Accounts', access: 'read' }] });
    expect((await call('departments/access', ownerToken, { departmentId: id, memberId, access: 'none', expectedRevision: '0' }, 'PUT')).status).toBe(409);
    expect((await call('departments/access', ownerToken, { departmentId: id })).body).toMatchObject({ department: { revision: '1' } });
  });
  it('reads, saves and replays reviewed configuration through pinned TLS with strict fields and owner authority',async()=>{
    const made=await call('departments',ownerToken,{requestId:randomUUID(),name:'Configured department'});
    const departmentId=(made.body as {department:{id:string}}).department.id;
    await call('departments/access',ownerToken,{departmentId,memberId,access:'read',expectedRevision:'0'},'PUT');
    expect((await call('departments/configuration',memberToken,{departmentId})).body).toMatchObject({configuration:null,canManage:false});
    const change={departmentId,expectedRevision:'1',configuration:{version:1 as const,template:'custom' as const,plans:[],workflowDefaults:[]},note:'Reviewed no allowed plans',sourceReceiptId:null};
    const input={...change,requestId:randomUUID(),reviewDigest:createHash('sha256').update(departmentConfigurationReviewMaterial(companyId,change)).digest('hex')};
    expect((await call('departments/configuration/save',memberToken,input)).status).toBe(403);
    expect((await call('departments/configuration/save',ownerToken,{...input,memberId})).status).toBe(400);
    expect((await call('departments/configuration/save',ownerToken,input))).toMatchObject({status:200,body:{department:{id:departmentId,revision:'2'},configuration:change.configuration,replayed:false}});
    expect((await call('departments/configuration/save',ownerToken,input)).body).toMatchObject({replayed:true});
    const unchanged={...change,expectedRevision:'2',note:'Another reason for the same definition'};
    const noOp={...unchanged,requestId:randomUUID(),reviewDigest:createHash('sha256').update(departmentConfigurationReviewMaterial(companyId,unchanged)).digest('hex')};
    expect(await call('departments/configuration/save',ownerToken,noOp)).toMatchObject({status:400,body:{code:'invalid_input'}});
    expect(await call('departments/configuration/save',ownerToken,{...noOp,note:'Malformed\uD800'})).toMatchObject({status:400,body:{code:'invalid_input'}});
    expect((await call('departments/configuration',ownerToken,{departmentId})).body).toMatchObject({department:{revision:'2'},configuration:change.configuration});
    expect((await call('departments/configuration/history',memberToken,{departmentId,beforeRevision:null,limit:10})).body).toMatchObject({entries:[{receiptId:input.requestId,configuration:change.configuration}]});
    expect((await call('departments/configuration/history',memberToken,{departmentId,beforeRevision:null,limit:999})).status).toBe(400);
  });
  it('serves bounded case review and owner recovery over the authenticated TLS allowlist', async () => {
    const created = await call('departments', ownerToken, { requestId: randomUUID(), name: 'Recovery' });
    const departmentId = (created.body as { department: { id: string } }).department.id;
    await call('departments/access', ownerToken, { departmentId, memberId, access: 'write', expectedRevision: '0' }, 'PUT');
    const work = await call('cases', memberToken, { scopeId: departmentId, title: 'Synthetic interrupted task' });
    const caseId = (work.body as { caseId: string }).caseId;
    const claim = await call('cases/claim', memberToken, { caseId, ttlMs: 60_000 });
    expect(claim.status).toBe(200);
    await call('departments/access', ownerToken, { departmentId, memberId, access: 'read', expectedRevision: '1' }, 'PUT');
    expect((await call('departments/cases', '', { departmentId })).status).toBe(401);
    expect((await call('departments/cases', ownerToken, { departmentId, memberId })).status).toBe(400);
    expect((await call('departments/cases', ownerToken, { departmentId, offset: 1 })).status).toBe(400);
    const list = await call('departments/cases', memberToken, { departmentId });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ canRecover: false, cases: [{ id: caseId, status: 'recovery_required', fence: '2' }] });
    const request = { departmentId, caseId, requestId: randomUUID(), expectedFence: '2', resolution: 'done', note: 'Checked synthetic result with previous holder.' };
    expect((await call('departments/cases/recover', memberToken, request)).status).toBe(403);
    expect((await call('departments/cases/recover', ownerToken, { ...request, actor: 'owner' })).status).toBe(400);
    const saved = await call('departments/cases/recover', ownerToken, request);
    expect(saved.status).toBe(200); expect(saved.body).toMatchObject({ replayed: false, item: { status: 'done', fence: '3', holder: null } });
    expect((await call('departments/cases/recover', ownerToken, request)).body).toMatchObject({ replayed: true });
    expect((await call('departments/cases/recover', ownerToken, { ...request, requestId: randomUUID() })).status).toBe(409);
    expect((await call('departments/cases', memberToken, { departmentId, filter: 'all' })).body).toMatchObject({ cases: [{ lastRecovery: { note: request.note } }] });
  });
  it('creates, assigns, closes and retires through pinned TLS with exact request retries and strict fields', async () => {
    const made = await call('departments', ownerToken, { requestId: randomUUID(), name: 'Lifecycle' });
    const departmentId = (made.body as { department: { id: string } }).department.id;
    await call('departments/access', ownerToken, { departmentId, memberId, access: 'write', expectedRevision: '0' }, 'PUT');
    expect((await call('departments/assignees', memberToken, { departmentId })).body).toMatchObject({ members: expect.arrayContaining([{ id: memberId, displayName: 'Practice accountant', role: 'member' }]) });
    const input = { departmentId, requestId: randomUUID(), title: 'Synthetic record', description: 'Reviewed instructions only.', assigneeMemberId: null };
    expect((await call('departments/cases/create', '', input)).status).toBe(401);
    expect((await call('departments/cases/create', memberToken, { ...input, holderMemberId: memberId })).status).toBe(400);
    const saved = await call('departments/cases/create', memberToken, input);
    expect(saved.status).toBe(201); expect(saved.body).toMatchObject({ replayed: false, item: { id: input.requestId, needsAssignment: true, fence: '0' } });
    expect((await call('departments/cases/create', memberToken, input)).body).toMatchObject({ replayed: true });
    expect((await call('departments/cases/create', memberToken, { ...input, description: 'Changed' })).status).toBe(409);
    const retire = { departmentId, requestId: randomUUID(), expectedRevision: '1', retired: true, note: 'Work has ended.' };
    expect((await call('departments/lifecycle', ownerToken, retire))).toMatchObject({ status: 409, body: { code: 'work_resolution_required' } });
    const assignment = { departmentId, caseId: input.requestId, requestId: randomUUID(), expectedFence: '0', assigneeMemberId: memberId };
    expect((await call('departments/cases/assign', memberToken, assignment))).toMatchObject({ status: 200, body: { item: { fence: '1', assignee: { id: memberId } } } });
    const closed = { departmentId, caseId: input.requestId, requestId: randomUUID(), expectedFence: '1', resolution: 'done', note: 'Checked by the assigned member.' };
    expect((await call('departments/cases/close', memberToken, { ...closed, note: '' })).status).toBe(400);
    expect((await call('departments/cases/close', memberToken, closed))).toMatchObject({ status: 200, body: { item: { fence: '2', lastClosure: { note: closed.note } } } });
    expect((await call('departments/lifecycle', memberToken, retire)).status).toBe(403);
    const retired = await call('departments/lifecycle', ownerToken, retire);
    expect(retired).toMatchObject({ status: 200, body: { department: { revision: '2', retirementNote: retire.note, unresolvedCases: 0 } } });
    expect((await call('departments/cases', memberToken, { departmentId, filter: 'all' })).body).toMatchObject({ canCreate: false, cases: [{ canAssign: false, canClose: false, status: 'done' }] });
    // A receipt lookup is observational even after department retirement.
    expect((await call('departments/cases/close', memberToken, closed)).body).toMatchObject({ replayed: true });
    expect((await call('cases', ownerToken, { scopeId: departmentId, title: 'Cannot bypass retirement' })).status).toBe(403);
    expect((await call('departments/lifecycle', ownerToken, { ...retire, requestId: randomUUID(), expectedRevision: '2', retired: false, note: 'Explicitly reopened.' })).body).toMatchObject({ department: { retiredAt: null } });
  });
});
