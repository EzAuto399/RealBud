// Seed an explicitly named synthetic test-lab host. No live services or files.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const [testRun, hostname, kitPath] = process.argv.slice(2);
assert.match(testRun, /^physical-macs(?:-v\d+)?-2026-09-14$/);
assert.match(hostname, /^100\.\d+\.\d+\.\d+$/);
const kit = resolve(kitPath);
assert.equal(JSON.parse(await readFile(join(kit, 'test-kit.json'), 'utf8')).atomicCredentialEnrollment, true);
const base = join(homedir(), '.realbud/test-lab', testRun);
const { url } = JSON.parse(await readFile(join(base, 'host/session.json'), 'utf8'));
assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
const headers = { 'content-type': 'application/json' };
async function call(path, body, expected = 200, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(url + path, { method, headers, signal: AbortSignal.timeout(30_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, expected, `${path}: unexpected response status`);
  return response.json();
}
headers['x-realbud-session'] = (await call('/api/session')).token;
headers['x-realbud-service-admin'] = (await call('/api/service-admin/login', { password: 'RealBud-Synthetic-Lab-2026' })).token;
const status = await call('/api/company/status');
if (!status.storageAvailable) await call('/api/company/setup', {});
const ownerCredential = { loginName: 'macbook.tester', password: 'Synthetic-macbook-test-2026' };
let owner;
if (status.configured) {
  const saved = JSON.parse(await readFile(join(base, 'owner-test-identity.json'), 'utf8'));
  owner = await call('/api/company/sign-in', ownerCredential);
  assert.equal(owner.company.id, saved.companyId); assert.equal(owner.member.id, saved.memberId);
} else {
  owner = await call('/api/company/create', { name: 'RealBud Two-Mac Practice Office', ownerName: 'MacBook Tester', credential: ownerCredential }, 201);
  assert.match(owner.recoveryKey, /^[A-Za-z0-9_-]{43}$/);
  await writeFile(join(base, 'owner-test-identity.json'), JSON.stringify({ companyId: owner.company.id, memberId: owner.member.id, credentials: ownerCredential, recoveryKey: owner.recoveryKey }), { flag: 'wx', mode: 0o600 });
}
headers['x-realbud-member-session'] = owner.memberToken;
if (!status.networkEnabled) await call('/api/company/network', { hostname });
const { hostCode } = await call('/api/company/host-code');
const fixture = JSON.parse(await readFile(join(kit, 'practice-pack.json'), 'utf8'));
await call('/api/workflow-packs/import', fixture);
const template = await call('/api/workflow-packs/company-template');
const savedTemplate = await call('/api/company/workflow-template');
if (savedTemplate.revision === '0') await call('/api/company/workflow-template', { expectedRevision: '0', template, companyId: owner.company.id, memberId: owner.member.id }, 200, 'PUT');
else assert.deepEqual(savedTemplate.template, template, 'Existing synthetic template must match');
const scopes = (await call('/api/company/scopes')).scopes;
const ownerPrivateScopeId = scopes.find(scope => scope.kind === 'private').id;
const invitation = await call('/api/company/invitations', { displayName: 'Mac Mini Tester' }, 201);
const bootstrap = { syntheticOnly: true, testRun, hostCode, invitationToken: invitation.invitationToken, companyId: owner.company.id, ownerPrivateScopeId, expectedTemplate: template,
  ownerLoginName: ownerCredential.loginName, credentials: { loginName: 'macmini.tester', password: 'Synthetic-macmini-test-2026' }, receiptTarget: hostname + ':' };
await writeFile(join(base, 'realbud-peer-bootstrap-v2.json'), JSON.stringify(bootstrap), { flag: 'wx', mode: 0o600 });
console.log('Synthetic host created with atomic sign-in, three shared plans and a one-use peer invitation. Private fixture written under the named test run.');
