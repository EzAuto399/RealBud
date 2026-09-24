import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCompanyInstallation } from './company-installation.ts';
import { parseCompanyPairing } from './company/host-certificate.ts';
import { requestCompanyHost } from './company/host-transport.ts';

describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('owned office backup, standby restore and planned cutover', () => {
  let directory: string;
  const instances = new Set<ReturnType<typeof createCompanyInstallation>>();
  let source: ReturnType<typeof createCompanyInstallation>, target: typeof source;
  let owner: any, member: any, invitation: any, backup: any, targetOwner: any, pairing: ReturnType<typeof parseCompanyPairing>;
  const passphrase = 'Synthetic backup passphrase 2026';
  function installation(name: string) {
    const value = createCompanyInstallation({ dataDirectory: join(directory, name), binaryDirectory: process.env.REALBUD_TEST_POSTGRES_BIN, previewEnabled: true,
      authorizeAdmin: req => req.headers['x-test-admin'] === 'yes' ? { ok: true, expiresAt: Date.now() + 60_000 } : { ok: false, status: 401, error: 'Admin required' },
      hasAdminSession: req => req.headers['x-test-admin'] === 'yes' });
    instances.add(value); return value;
  }
  async function call(host: typeof source, path: string, body?: unknown, token = '', admin = true) {
    const result = await host.handle('/api/company/' + path, body === undefined ? 'GET' : 'POST', { headers: { 'x-realbud-member-session': token, ...(admin ? { 'x-test-admin': 'yes' } : {}) } }, body);
    return { ...result, body: result.body as any };
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rb-cutover-'));
    source = installation('source'); target = installation('target');
    expect((await call(source, 'setup', {})).status).toBe(200);
    expect((await call(target, 'setup', {})).status).toBe(200);
    owner = (await call(source, 'create', { name: 'Synthetic cutover office', ownerName: 'Owner', credential: { loginName: 'owner', password: 'Synthetic-owner-password' } })).body;
    const invited = (await call(source, 'invitations', { displayName: 'Member' }, owner.memberToken)).body;
    // A second actual client provides a separate private workspace and member.
    expect((await call(source, 'network', { hostname: '127.0.0.1' }, owner.memberToken)).status).toBe(200);
    const code = (await call(source, 'host-code', undefined, owner.memberToken)).body.hostCode;
    pairing = parseCompanyPairing(code);
    const client = installation('member');
    expect((await call(client, 'connect-host', { hostCode: code })).status).toBe(200);
    member = (await call(client, 'join', { invitationToken: invited.invitationToken, credential: { loginName: 'member', password: 'Synthetic-member-password' } })).body;
    invitation = (await call(source, 'invitations', { displayName: 'Unused invitation' }, owner.memberToken)).body;
    expect((await call(source, 'work', { requestId: randomUUID(), title: 'Synthetic review', summary: 'Retained through restore', purpose: 'request-review', recipientMemberIds: [member.member.id], assigneeMemberId: member.member.id }, owner.memberToken)).status).toBe(201);
  }, 60_000);
  afterAll(async () => { for (const instance of instances) await instance.close(); if (directory) await rm(directory, { recursive: true, force: true }); }, 30_000);
  it('requires service administration and the current owner, and never exposes recovery over TLS', async () => {
    expect((await call(source, 'host-recovery/backup', { passphrase, retireSource: false }, owner.memberToken, false)).status).toBe(401);
    expect((await call(source, 'host-recovery/backup', { passphrase, retireSource: false }, member.memberToken)).status).toBe(403);
    await expect(requestCompanyHost({ ...pairing, path: '/api/company/host-recovery/backup', method: 'POST', memberToken: owner.memberToken, body: { passphrase, retireSource: true } })).rejects.toThrow();
    const result = await call(source, 'host-recovery/backup', { passphrase, retireSource: false }, owner.memberToken);
    expect(result.status).toBe(200); backup = result.body.backup;
    expect(JSON.stringify(backup)).not.toContain('Synthetic review');
    expect(result.body.receipt).toMatchObject({ companyId: owner.company.id, sourceRetired: false });
    expect((await call(source, 'host-recovery')).body.mode).toBe('active');
  }, 15_000);
  it('rejects damaged encryption and wrong passphrases without creating an office', async () => {
    expect((await call(target, 'host-recovery/restore', { backup, passphrase: 'Incorrect synthetic passphrase' })).status).toBe(400);
    expect((await call(target, 'status')).body.configured).toBe(false);
    expect((await call(target, 'host-recovery/reset-empty', {})).status).toBe(200);
    expect((await call(target, 'status')).body.hostMode).toBe('active');
    const damaged = structuredClone(backup); damaged.payload.ct = 'AAAA';
    expect((await call(target, 'host-recovery/restore', { backup: damaged, passphrase })).status).toBe(400);
    expect((await call(target, 'status')).body.configured).toBe(false);
  });
  it('restores only to an empty host, starts held, invalidates tokens and requires explicit owner cutover', async () => {
    expect((await call(source, 'host-recovery/reset-empty', {})).status).toBe(409);
    expect((await call(source, 'host-recovery/restore', { backup, passphrase })).status).toBe(409);
    const restored = await call(target, 'host-recovery/restore', { backup, passphrase });
    expect(restored).toMatchObject({ status: 200, body: { mode: 'standby', receipt: { companyId: owner.company.id } } });
    // Lost response retry returns the same receipt, without importing twice.
    expect((await call(target, 'host-recovery/restore', { backup, passphrase })).body.receipt).toEqual(restored.body.receipt);
    expect((await call(target, 'me', undefined, owner.memberToken)).status).toBe(401);
    targetOwner = (await call(target, 'sign-in', { loginName: 'owner', password: 'Synthetic-owner-password' })).body;
    expect(targetOwner.member.id).toBe(owner.member.id);
    expect((await call(target, 'invitations', { displayName: 'Held' }, targetOwner.memberToken)).status).toBe(409);
    expect((await call(target, 'network', { hostname: '127.0.0.1' }, targetOwner.memberToken)).status).toBe(409);
    expect((await call(target, 'host-recovery/activate', { companyId: owner.company.id, originalHostStopped: false }, targetOwner.memberToken)).status).toBe(400);
    // Use the real source-retirement path before activating the replacement.
    expect((await call(source, 'host-recovery/backup', { passphrase, retireSource: true }, owner.memberToken)).body.receipt.sourceRetired).toBe(true);
    expect((await call(target, 'host-recovery/activate', { companyId: owner.company.id, originalHostStopped: true }, targetOwner.memberToken)).status).toBe(200);
    const listed = await call(target, 'work', undefined, targetOwner.memberToken);
    expect(listed.status).toBe(200); expect(JSON.stringify(listed.body)).toContain('Retained through restore');
    expect((await target.workspaceIdentity()).workerMemberKey).toBe(null);
    // New work is enabled, but pre-backup invitation tokens are not valid.
    expect((await call(target, 'network', { hostname: '127.0.0.1' }, targetOwner.memberToken)).status).toBe(200);
    const newPairing = parseCompanyPairing((await call(target, 'host-code', undefined, targetOwner.memberToken)).body.hostCode);
    expect(newPairing.certificatePem).not.toBe(pairing.certificatePem);
    const joined = await requestCompanyHost({ ...newPairing, path: '/api/company/join', method: 'POST', body: { invitationToken: invitation.invitationToken, credential: { loginName: 'unused', password: 'Synthetic-unused-password' } } });
    expect(joined.status).toBe(401);
  }, 20_000);
  it('reconciles a restore receipt lost after the database commit', async () => {
    // The restore receipt is also committed in the database. Removing only its
    // local copy simulates COMMIT succeeding before the local receipt save.
    const { readFile, writeFile } = await import('node:fs/promises');
    await target.close(); instances.delete(target);
    const path = join(directory, 'target/company-installation/host-lifecycle.json');
    const state = JSON.parse(await readFile(path, 'utf8')); delete state.restored;
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });
    target = installation('target');
    expect((await call(target, 'host-recovery')).body.restored).toMatchObject({ companyId: owner.company.id, backupSha256: state.restoreHash });
  }, 30_000);
  it('keeps the retired source held across restart, including its existing TLS endpoint', async () => {
    const before = await requestCompanyHost({ ...pairing, path: '/api/company/invitations', method: 'POST', memberToken: owner.memberToken, body: { displayName: 'Blocked' } });
    expect(before.status).toBe(409);
    await source.close(); instances.delete(source); source = installation('source');
    expect((await call(source, 'host-recovery')).body.mode).toBe('retired');
    expect((await call(source, 'invitations', { displayName: 'Still blocked' }, owner.memberToken)).status).toBe(409);
    expect((await call(source, 'status', undefined, owner.memberToken)).body.hostMode).toBe('retired');
    await source.close(); instances.delete(source);
    await unlink(join(directory, 'source/company-installation/host-lifecycle.json'));
    source = installation('source');
    expect((await call(source, 'host-recovery')).body.mode).toBe('retired');
  }, 30_000);
});
