#!/usr/bin/env node
// Real native PostgreSQL/TCP acceptance on the OS executing this script.
// No Unix sockets, fake operating-system override, customer data or models.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resources = process.env.REALBUD_TEST_RESOURCES ? resolve(process.env.REALBUD_TEST_RESOURCES) : root;
const compiled = resources !== root;
const load = path => import(pathToFileURL(join(resources, path.replace(/\.ts$/, compiled ? '.js' : '.ts'))).href);
const { openOwnedPostgres } = await load('server/company/host-runtime.ts');
const { createCompanyKernel } = await load('server/company/index.ts');
const { Pool } = compiled ? await import(pathToFileURL(join(resources, 'server/vendor/pg.mjs')).href) : await import('pg');
const output = resolve(process.env.REALBUD_TEST_OUTPUT || join(root, 'outputs', `company-portable-${Date.now()}`));
await mkdir(output, { recursive: true });
const checks = []; const abort = new AbortController();
let runtime, pools = [], temporary, failure, clean = false, postgres;
const timer = setTimeout(() => abort.abort(), 150_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
const check = name => { assert.equal(abort.signal.aborted, false, 'Test interrupted'); checks.push({ name, passed: true }); };
async function close() {
  for (const pool of pools) await pool.end();
  pools = []; if (runtime) { await runtime.stop(); runtime = undefined; }
}
function connections() {
  pools = [0, 1].map(() => new Pool({ connectionString: runtime.applicationUrl, max: 3, connectionTimeoutMillis: 3000, statement_timeout: 5000 }));
  for (const pool of pools) pool.on('error', () => {});
  return pools.map(pool => createCompanyKernel(pool));
}
try {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24 required');
  assert.ok(process.env.REALBUD_TEST_POSTGRES_BIN, 'Explicit installed PostgreSQL 16 binary directory required');
  temporary = await mkdtemp(join(tmpdir(), 'RealBud company native '));
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const options = { rootDirectory: join(temporary, 'owned database'), binaryDirectory: process.env.REALBUD_TEST_POSTGRES_BIN, port, signal: abort.signal };
  runtime = await openOwnedPostgres(options); postgres = runtime.version; check('New owned native PostgreSQL starts with paths containing spaces');
  let [aliceKernel, bobKernel] = connections();
  const alice = await aliceKernel.createCompany({ name: 'Synthetic two-profile office', ownerName: 'Alice', singleHost: true });
  const invitation = await aliceKernel.issueInvitation(alice.sessionToken, { displayName: 'Bob', expiresInMs: 60_000 });
  const bob = await bobKernel.redeemInvitation(invitation.invitationToken);
  assert.notEqual(alice.memberId, bob.memberId); assert.equal(alice.companyId, bob.companyId); check('Two individual profiles share one company');
  await assert.rejects(bobKernel.redeemInvitation(invitation.invitationToken), { code: 'unauthenticated' }); check('Invitation replay rejected');
  for (const [kernel, person, loginName] of [[aliceKernel, alice, 'alice'], [bobKernel, bob, 'bob']]) {
    await kernel.enrollMemberCredential(person.sessionToken, { loginName, password: `Synthetic-${loginName}-password-2026` });
  }
  check('Both profiles enroll independent credentials');
  await aliceKernel.replaceKnowledge(alice.sessionToken, { scopeId: alice.privateScope.id, key: 'private', expectedRevision: '0', content: 'Alice only synthetic note' });
  await assert.rejects(bobKernel.readKnowledge(bob.sessionToken, { scopeId: alice.privateScope.id, key: 'private' }), error => ['forbidden', 'not_found'].includes(error.code)); check('Private profile data denied to the other member');
  const scopeId = alice.companyScope.id;
  await aliceKernel.setScopeGrant(alice.sessionToken, { scopeId, memberId: bob.memberId, permissions: ['read', 'write'], expectedRevision: alice.companyScope.revision });
  const results = await Promise.allSettled([[aliceKernel, alice, 'Alice'], [bobKernel, bob, 'Bob']].map(([kernel, person, content]) =>
    kernel.replaceKnowledge(person.sessionToken, { scopeId, key: 'shared', expectedRevision: '0', content })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'conflict'); check('Concurrent writes admit exactly one revision');
  const before = await bobKernel.readKnowledge(bob.sessionToken, { scopeId, key: 'shared' });
  const work = await aliceKernel.createCase(alice.sessionToken, { scopeId, title: 'Synthetic single-owner work' });
  const claims = await Promise.allSettled([[aliceKernel, alice], [bobKernel, bob]].map(([kernel, person]) => kernel.claimCase(person.sessionToken, { caseId: work.caseId, ttlMs: 30_000 })));
  assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(claims.find(r => r.status === 'rejected').reason.code, 'claim_busy'); check('A shared job has exactly one active owner');
  const winner = claims.findIndex(r => r.status === 'fulfilled'); const claim = claims[winner].value;
  const [winnerKernel, winnerPerson] = winner === 0 ? [aliceKernel, alice] : [bobKernel, bob];
  const settlement = { caseId: work.caseId, fence: claim.fence, claimToken: claim.claimToken, outcome: 'done' };
  await winnerKernel.settleClaim(winnerPerson.sessionToken, settlement);
  await assert.rejects(winnerKernel.settleClaim(winnerPerson.sessionToken, settlement), { code: 'stale_claim' }); check('A completed claim cannot settle twice');
  await close(); check('Native database stops with its data preserved');
  runtime = await openOwnedPostgres(options); [aliceKernel, bobKernel] = connections();
  const signedIn = await bobKernel.signInMember({ companyId: bob.companyId, loginName: 'bob', password: 'Synthetic-bob-password-2026' });
  assert.equal((await bobKernel.authenticateSession(signedIn.sessionToken)).memberId, bob.memberId); check('Same member signs in after complete host restart');
  assert.deepEqual(await bobKernel.readKnowledge(signedIn.sessionToken, { scopeId, key: 'shared' }), before); check('Shared data survives native restart');
  await assert.rejects(bobKernel.claimCase(signedIn.sessionToken, { caseId: work.caseId, ttlMs: 30_000 }), { code: 'conflict' }); check('Completed work does not restart after host recovery');
} catch (error) { failure = error instanceof assert.AssertionError ? error.message : `Native rehearsal failed (${error?.code || error?.name || 'unknown'}); inspect the owned fixture locally.`; }
finally {
  clearTimeout(timer);
  try { await close(); if (temporary) await rm(temporary, { recursive: true, force: true }); clean = true; }
  catch { failure ||= 'Owned native database cleanup failed. Test data was preserved for recovery.'; }
  const passed = !failure && clean && checks.length === 12;
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed, generatedAt: new Date().toISOString(),
    platform: platform(), arch: arch(), osRelease: release(), node: process.version, postgres, checks, failure, cleanupComplete: clean,
    proofLayer: 'Real native database processes on this machine with two synthetic profiles; no installed app, physical second device or model execution',
    twoPhysicalDevices: false, windows11Verified: false, simulatedOS: false }, null, 2) + '\n');
  console.log(`${passed ? 'PASSED' : 'FAILED'} portable company rehearsal: ${join(output, 'result.json')}`);
  process.exitCode = passed ? 0 : 1;
}
