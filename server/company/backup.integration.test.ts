import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, scryptSync } from 'node:crypto';
import { startCompanyPostgresFixture } from './testing-postgres.ts';
import { createCompanyKernel } from './index.ts';
import { createOfficeBackup, restoreOfficeBackup, officeRestoreReceipt, type OfficeBackup } from './backup.ts';
import { decryptJson, encryptJson } from '../desk-crypto.ts';

describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('office backup data integrity on real PostgreSQL', () => {
  let source: Awaited<ReturnType<typeof startCompanyPostgresFixture>>, target: typeof source, legacyTarget: typeof source;
  let output: string, backup: OfficeBackup, owner: Awaited<ReturnType<ReturnType<typeof createCompanyKernel>['createCompany']>>;
  let claimedId: string, fence: string, departmentId: string, assignedCaseId: string, memberId: string;
  const passphrase = 'Synthetic integrity passphrase';
  beforeAll(async () => {
    output = await mkdtemp(join(tmpdir(), 'rb-restore-integrity-'));
    source = await startCompanyPostgresFixture({ outputDirectory: join(output, 'source'), postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN });
    target = await startCompanyPostgresFixture({ outputDirectory: join(output, 'target'), postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN });
    legacyTarget = await startCompanyPostgresFixture({ outputDirectory: join(output, 'legacy-target'), postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN });
    const kernel = createCompanyKernel(source.pool);
    owner = await kernel.createCompany({ name: 'Synthetic integrity office', ownerName: 'Owner' });
    const scope = (await kernel.listScopes(owner.sessionToken)).find(scope => scope.kind === 'company')!;
    const item = await kernel.createCase(owner.sessionToken, { scopeId: scope.id, title: 'Synthetic in-flight case' });
    claimedId = item.caseId;
    const claim = await kernel.claimCase(owner.sessionToken, { caseId: claimedId, ttlMs: 60_000 }); fence = claim.fence;
    const invite = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Fictional former assignee' });
    memberId = (await kernel.redeemInvitation(invite.invitationToken)).memberId;
    const department = await kernel.createDepartment(owner.sessionToken, { name: 'Completed office work', requestId: randomUUID() });
    departmentId = department.id;
    await kernel.setDepartmentAccess(owner.sessionToken, { departmentId, memberId, access: 'write', expectedRevision: '0' });
    assignedCaseId = randomUUID();
    await source.adminPool.query(`INSERT INTO realbud_company.cases(company_id,id,scope_id,title,status,description,assignee_member_id)
      VALUES($1,$2,$3,'Fictional retained task','cancelled','Original task instructions',$4)`, [owner.companyId, assignedCaseId, departmentId, memberId]);
    await source.adminPool.query(`UPDATE realbud_company.scopes SET retired_at=clock_timestamp(),retired_by=$1,
      retirement_note='Retained for office records',revision=revision+1 WHERE id=$2`, [owner.memberId, departmentId]);
    backup = (await createOfficeBackup(source.adminPool, passphrase, owner.companyId, true)).backup;
  }, 60_000);
  afterAll(async () => { await legacyTarget?.stop(); await target?.stop(); await source?.stop(); if (output) await rm(output, { recursive: true, force: true }); }, 30_000);
  function edited(change: (snapshot: any) => void) {
    const key = scryptSync(passphrase, Buffer.from(backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try { const snapshot = decryptJson(key, backup.payload); change(snapshot); return { ...backup, payload: encryptJson(key, snapshot) }; }
    finally { key.fill(0); }
  }
  function beforeExecution(snapshot:any){
    for(const table of ['department_execution_grants','department_execution_claims','department_execution_events'])delete snapshot.tables[table];
    for(const row of snapshot.tables.members)delete row.execution_epoch;
  }
  function legacy(change: (snapshot: any) => void = () => {}) {
    return edited(snapshot => {
      snapshot.migrations = snapshot.migrations.slice(0, 5); beforeExecution(snapshot);
      delete snapshot.tables.portal_member_bindings;
      for(const row of snapshot.tables.companies){delete row.remote_authority_incarnation;delete row.portal_issuer;delete row.portal_company_id;}
      for (const row of snapshot.tables.scopes) {
        delete row.retired_at; delete row.retired_by; delete row.retirement_note;
      }
      for (const row of snapshot.tables.cases) {
        delete row.description; delete row.assignee_member_id;
        if (row.status === 'cancelled') row.status = 'done';
      }
      change(snapshot);
    });
  }
  it('rejects another office in the payload and rolls back rows already inserted', async () => {
    const changed = edited(snapshot => { snapshot.tables.members[0].company_id = randomUUID(); });
    await expect(restoreOfficeBackup(target.adminPool, changed, passphrase)).rejects.toThrow(/another office/);
    expect((await target.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.companies')).rows[0].n).toBe(0);
  });
  it('rejects unknown columns and incompatible migrations rather than executing uploaded instructions', async () => {
    await expect(restoreOfficeBackup(target.adminPool, edited(snapshot => { snapshot.tables.members[0]['; DROP SCHEMA realbud_company CASCADE'] = 'not SQL'; }), passphrase)).rejects.toThrow(/unsupported fields/);
    await expect(restoreOfficeBackup(target.adminPool, edited(snapshot => { snapshot.migrations[0].checksum = 'wrong'; }), passphrase)).rejects.toThrow(/matching RealBud schema/);
    expect((await target.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.members')).rows[0].n).toBe(0);
  });
  it('admits only the exact trusted 0005 prefix, never unknown versions or altered checksums', async () => {
    for (const changed of [
      legacy(snapshot => { snapshot.migrations[4].checksum = 'wrong'; }),
      legacy(snapshot => { snapshot.migrations.pop(); }),
      legacy(snapshot => { snapshot.migrations.push({ id: '0007', checksum: 'unknown' }); }),
      legacy(snapshot => { snapshot.migrations.reverse(); }),
      legacy(snapshot => { snapshot.migrations[0].extra = 'not a migration'; }),
    ]) await expect(restoreOfficeBackup(legacyTarget.adminPool, changed, passphrase)).rejects.toThrow(/matching RealBud schema/);
    expect((await legacyTarget.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.companies')).rows[0].n).toBe(0);
  });
  it('rejects forged legacy columns and post-0005 state instead of deriving permissive defaults', async () => {
    for (const changed of [
      legacy(snapshot => { snapshot.tables.scopes[0].retired_at = null; }),
      legacy(snapshot => { delete snapshot.tables.scopes[0].purpose; }),
      legacy(snapshot => { snapshot.tables.cases[0].assignee_member_id = memberId; }),
      legacy(snapshot => { delete snapshot.tables.cases[0].claim_token_hash; }),
      legacy(snapshot => { snapshot.tables.cases[0].status = 'cancelled'; }),
      edited(snapshot => { delete snapshot.tables.scopes[0].retirement_note; }),
    ]) await expect(restoreOfficeBackup(legacyTarget.adminPool, changed, passphrase)).rejects.toThrow(/unsupported fields/);
    expect((await legacyTarget.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.companies')).rows[0].n).toBe(0);
  });
  it('rejects matching but untrusted target and uploaded migration checksums', async () => {
    const { checksum } = (await legacyTarget.adminPool.query("SELECT checksum FROM realbud_company.schema_migrations WHERE id='0006'")).rows[0];
    try {
      await legacyTarget.adminPool.query("UPDATE realbud_company.schema_migrations SET checksum='untrusted' WHERE id='0006'");
      const changed = edited(snapshot => { snapshot.migrations[5].checksum = 'untrusted'; });
      await expect(restoreOfficeBackup(legacyTarget.adminPool, changed, passphrase)).rejects.toThrow(/matching RealBud schema/);
    } finally {
      await legacyTarget.adminPool.query("UPDATE realbud_company.schema_migrations SET checksum=$1 WHERE id='0006'", [checksum]);
    }
    expect((await legacyTarget.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.companies')).rows[0].n).toBe(0);
  });
  it('upgrades a genuine 0005 shape with unassigned active defaults and preserves claim fencing', async () => {
    await restoreOfficeBackup(legacyTarget.adminPool, legacy(), passphrase);
    const scopes = (await legacyTarget.adminPool.query('SELECT retired_at,retired_by,retirement_note FROM realbud_company.scopes')).rows;
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every(row => row.retired_at === null && row.retired_by === null && row.retirement_note === '')).toBe(true);
    const cases = (await legacyTarget.adminPool.query('SELECT description,assignee_member_id FROM realbud_company.cases')).rows;
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every(row => row.description === '' && row.assignee_member_id === null)).toBe(true);
    const row = (await legacyTarget.adminPool.query('SELECT status,fence,claim_token_hash,lease_expires_at FROM realbud_company.cases WHERE id=$1', [claimedId])).rows[0];
    expect(row).toMatchObject({ status: 'recovery_required', fence: String(BigInt(fence) + 1n), claim_token_hash: null, lease_expires_at: null });
    await expect(createCompanyKernel(legacyTarget.pool).authenticateSession(owner.sessionToken)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('upgrades exact trusted 0006 with no implicit portal binding and rejects forged added fields', async () => {
    const clean = (change: (snapshot: any) => void = () => {}) => edited(snapshot => {
      snapshot.migrations = snapshot.migrations.slice(0, 6); beforeExecution(snapshot); delete snapshot.tables.portal_member_bindings;
      for (const row of snapshot.tables.companies) { delete row.remote_authority_incarnation; delete row.portal_issuer; delete row.portal_company_id; }
      change(snapshot);
    });
    const fresh = await startCompanyPostgresFixture({ outputDirectory: join(output,'legacy-0006'), postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN });
    try {
      await expect(restoreOfficeBackup(fresh.adminPool, clean(snapshot => { snapshot.tables.companies[0].portal_company_id='forged'; }), passphrase)).rejects.toThrow(/unsupported fields/);
      await expect(restoreOfficeBackup(fresh.adminPool, clean(snapshot => { snapshot.tables.portal_member_bindings=[]; }), passphrase)).rejects.toThrow(/unsupported fields/);
      await restoreOfficeBackup(fresh.adminPool, clean(), passphrase);
      const company = (await fresh.adminPool.query('SELECT remote_authority_incarnation,portal_issuer,portal_company_id FROM realbud_company.companies')).rows[0];
      expect(company.remote_authority_incarnation).toMatch(/^[a-f0-9-]{36}$/); expect(company.portal_issuer).toBeNull(); expect(company.portal_company_id).toBeNull();
      expect((await fresh.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.portal_member_bindings')).rows[0].n).toBe(0);
      const retained = (await fresh.adminPool.query('SELECT description,assignee_member_id FROM realbud_company.cases WHERE id=$1',[assignedCaseId])).rows[0];
      expect(retained).toEqual({description:'Original task instructions',assignee_member_id:memberId});
    } finally { await fresh.stop(); }
  },60_000);
  it('upgrades exact trusted 0007 without importing background authority or forged epoch defaults', async () => {
    const clean=(change:(snapshot:any)=>void=()=>{})=>edited(snapshot=>{snapshot.migrations=snapshot.migrations.slice(0,7);beforeExecution(snapshot);change(snapshot);});
    const fresh=await startCompanyPostgresFixture({outputDirectory:join(output,'legacy-0007'),postgresBinDirectory:process.env.REALBUD_TEST_POSTGRES_BIN});
    try{
      await expect(restoreOfficeBackup(fresh.adminPool,clean(snapshot=>{snapshot.tables.members[0].execution_epoch=42;}),passphrase)).rejects.toThrow(/unsupported fields/);
      await expect(restoreOfficeBackup(fresh.adminPool,clean(snapshot=>{snapshot.tables.department_execution_grants=[];}),passphrase)).rejects.toThrow(/unsupported fields/);
      await restoreOfficeBackup(fresh.adminPool,clean(),passphrase);
      expect((await fresh.adminPool.query('SELECT execution_epoch FROM realbud_company.members')).rows.every(row=>row.execution_epoch==='0')).toBe(true);
      expect((await fresh.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.department_execution_grants')).rows[0].n).toBe(0);
    }finally{await fresh.stop();}
  },60000);
  it('restores data while fencing in-flight claims and revoking restored credentials for sessions', async () => {
    const receipt = await restoreOfficeBackup(target.adminPool, backup, passphrase);
    expect(await officeRestoreReceipt(target.adminPool, receipt.backupSha256)).toEqual(receipt);
    const row = (await target.adminPool.query('SELECT status,fence,claim_token_hash,lease_expires_at FROM realbud_company.cases WHERE id=$1', [claimedId])).rows[0];
    expect(row).toMatchObject({ status: 'recovery_required', fence: String(BigInt(fence) + 1n), claim_token_hash: null, lease_expires_at: null });
    await expect(createCompanyKernel(target.pool).authenticateSession(owner.sessionToken)).rejects.toMatchObject({ code: 'unauthenticated' });
    const retained = (await target.adminPool.query(`SELECT c.status,c.description,c.assignee_member_id,s.retired_at,s.retired_by,s.retirement_note
      FROM realbud_company.cases c JOIN realbud_company.scopes s ON s.company_id=c.company_id AND s.id=c.scope_id WHERE c.id=$1`, [assignedCaseId])).rows[0];
    expect(retained).toMatchObject({ status: 'cancelled', description: 'Original task instructions', assignee_member_id: memberId,
      retired_by: owner.memberId, retirement_note: 'Retained for office records' });
    expect(retained.retired_at).toBeInstanceOf(Date);
    const client = await target.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('realbud.company_id',$1,true),set_config('realbud.member_id',$2,true)", [owner.companyId, memberId]);
      const allowed = (await client.query("SELECT realbud_company.scope_allowed($1,'read') AS read,realbud_company.scope_allowed($1,'write') AS write", [departmentId])).rows[0];
      expect(allowed).toEqual({ read: true, write: false });
      await expect(client.query(`INSERT INTO realbud_company.cases(company_id,id,scope_id,title) VALUES($1,$2,$3,'Forbidden restored edit')`,
        [owner.companyId, randomUUID(), departmentId])).rejects.toMatchObject({ code: '42501' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    await expect(restoreOfficeBackup(target.adminPool, backup, passphrase)).rejects.toThrow(/new, empty host/);
  });
});
