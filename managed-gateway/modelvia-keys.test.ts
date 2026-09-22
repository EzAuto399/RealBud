import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { modelviaKeyClient, operatorToken } from './modelvia-keys.ts';
import type { HttpTransport } from './composio-org.ts';

const OPERATOR_SECRET = 'fictional-modelvia-operator-secret-32ch';
const OPERATOR_SUBJECT = 'realbud-provisioning';
const CLOCK = Date.parse('2026-09-22T00:00:00Z');

/**
 * Verbatim copy of Modelvia's `managed-gateway/operator-token.ts`
 * (`verifyOperatorToken`) on `codex/neon-release`. Kept here so these tests prove
 * our bearer against THEIR rules rather than against our own assumption of them.
 */
function verifyOperatorToken(token: string, secret: string, now: number): { subject: string } {
  if (secret.length < 32) throw new Error('operator_unconfigured');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('unauthenticated');
  const [payload, signature] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(signature, 'base64url');
  if (!(given.length === expected.length && timingSafeEqual(given, expected))) throw new Error('unauthenticated');
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { claims = null; }
  if (claims === null || typeof claims !== 'object') throw new Error('unauthenticated');
  const c = claims as Record<string, unknown>;
  if (!(c.aud === 'managed-ai-operator' && typeof c.subject === 'string' && c.subject.length > 0 && c.subject.length <= 320
    && typeof c.iat === 'number' && Number.isSafeInteger(c.iat) && typeof c.exp === 'number' && Number.isSafeInteger(c.exp)
    && c.iat <= now + 60_000 && c.exp > now && c.exp > c.iat && c.exp - c.iat <= 300_000)) throw new Error('unauthenticated');
  return { subject: c.subject as string };
}
const MINTED = `rbk_0123456789abcdef_${'A'.repeat(43)}`;

function transport(handler: (url: string, method: string) => { status?: number; body?: unknown; text?: string; redirected?: boolean }) {
  const seen: { url: string; method: string; authorization: string | undefined; body: Record<string, unknown> | undefined }[] = [];
  const fetchLike: HttpTransport = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    const method = String(init.method);
    seen.push({ url, method, authorization: headers.authorization, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const result = handler(url, method);
    const response = new Response(result.text ?? JSON.stringify(result.body ?? {}), { status: result.status ?? 200 });
    if (result.redirected) Object.defineProperty(response, 'redirected', { value: true });
    return response;
  };
  return { seen, fetchLike };
}
let clock = CLOCK;
const client = (t: ReturnType<typeof transport>, operatorSecret: () => string | undefined = () => OPERATOR_SECRET) =>
  modelviaKeyClient({ serviceOrigin: 'https://api.modelvia.dev', environment: 'production', clientId: 'realbud',
    allowedModels: ['auto'], operatorSecret, operatorSubject: OPERATOR_SUBJECT, fetch: t.fetchLike, now: () => clock });

const project = { projectId: 'rb-install-one', name: 'RealBud installation install-one', customerId: 'cus-office',
  monthlyCapNanoAud: '100000000000', requestCapNanoAud: '1000000000', maxConcurrent: 4 };

test('createProject sends exactly the permitted operator-projects body with version 0', async () => {
  const t = transport(() => ({ body: { id: 'rb-install-one', customerId: 'cus-office', version: 1 } }));
  assert.deepEqual(await client(t).createProject(project), { projectId: 'rb-install-one', created: true });
  assert.equal(t.seen[0]!.url, 'https://api.modelvia.dev/v1/operator/projects');
  // The bearer must satisfy Modelvia's own verifier, not merely look like a token.
  const bearer = t.seen[0]!.authorization!.slice('Bearer '.length);
  assert.deepEqual(verifyOperatorToken(bearer, OPERATOR_SECRET, clock), { subject: OPERATOR_SUBJECT });
  // Modelvia rejects unknown fields, so this set must match its allowlist exactly.
  assert.deepEqual(t.seen[0]!.body, { id: 'rb-install-one', name: 'RealBud installation install-one', active: true,
    monthlyCapNanoAud: '100000000000', requestCapNanoAud: '1000000000', maxConcurrent: 4, allowedModels: ['auto'],
    version: 0, clientId: 'realbud', customerId: 'cus-office', environments: ['production'] });
});

test('a project id Modelvia already holds is reported, never re-capped or reparented', async () => {
  const t = transport(() => ({ status: 409, body: { error: 'account_version_conflict' } }));
  assert.deepEqual(await client(t).createProject(project), { projectId: 'rb-install-one', created: false });
  // Any other 409 is a failure, not a conflict we understand.
  const other = transport(() => ({ status: 409, body: { error: 'invalid_caps' } }));
  await assert.rejects(() => client(other).createProject(project), /modelvia_rejected/);
});

test('createProject refuses caps, ids and names it must not send', async () => {
  const t = transport(() => ({ body: { id: 'rb-install-one', customerId: 'cus-office' } }));
  const c = client(t);
  await assert.rejects(() => c.createProject({ ...project, requestCapNanoAud: '200000000000' }), /invalid_modelvia_caps/);
  await assert.rejects(() => c.createProject({ ...project, monthlyCapNanoAud: '-1' }), /invalid_modelvia_caps/);
  await assert.rejects(() => c.createProject({ ...project, maxConcurrent: 0 }), /invalid_modelvia_caps/);
  await assert.rejects(() => c.createProject({ ...project, projectId: 'rb/../other' }), /invalid_modelvia_account/);
  await assert.rejects(() => c.createProject({ ...project, name: '  ' }), /invalid_modelvia_project_name/);
  assert.equal(t.seen.length, 0);
  // A saved record for another project or customer is a scope mismatch.
  const wrong = transport(() => ({ body: { id: 'rb-somebody-else', customerId: 'cus-office' } }));
  await assert.rejects(() => client(wrong).createProject(project), /modelvia_project_scope_mismatch/);
});

test('mint posts the four permitted fields and ties the key id to the returned key', async () => {
  const t = transport(() => ({ body: { key: MINTED, record: { id: '0123456789abcdef', project: 'rb-install-one' } } }));
  const minted = await client(t).mint({ projectId: 'rb-install-one', label: 'company-a:install-one' });
  assert.deepEqual(minted, { key: MINTED, keyId: '0123456789abcdef', baseUrl: 'https://api.modelvia.dev/v1' });
  assert.equal(t.seen[0]!.url, 'https://api.modelvia.dev/v1/operator/keys');
  assert.deepEqual(t.seen[0]!.body, { projectId: 'rb-install-one', environment: 'production', label: 'company-a:install-one' });
});

test('revoke posts to the key id route and refuses an id that is not a key id', async () => {
  const t = transport(() => ({ body: { id: '0123456789abcdef', revokedAt: 1 } }));
  await client(t).revoke('0123456789abcdef');
  assert.equal(t.seen[0]!.url, 'https://api.modelvia.dev/v1/operator/keys/0123456789abcdef/revoke');
  for (const id of ['', 'ABCDEF0123456789', '0123456789abcdef/../other', 'short']) await assert.rejects(() => client(t).revoke(id), /invalid_key_id/);
  assert.equal(t.seen.length, 1);
});

test('a rejected, redirected, unreadable or mismatched mint fails closed without echoing the token', async () => {
  const mint = { projectId: 'rb-install-one', label: 'company-a:install-one' };
  const cases: { handler: Parameters<typeof transport>[0]; expect: RegExp }[] = [
    { handler: () => ({ status: 401, text: `bad token ${OPERATOR_SECRET}` }), expect: /modelvia_rejected/ },
    { handler: () => ({ redirected: true, body: {} }), expect: /modelvia_redirected/ },
    { handler: () => ({ text: `<html>${OPERATOR_SECRET}</html>` }), expect: /modelvia_unreadable/ },
    { handler: () => ({ body: { key: 'sk-not-a-modelvia-key', record: { id: '0123456789abcdef', project: 'rb-install-one' } } }), expect: /modelvia_key_unusable/ },
    // A record id that cannot revoke the returned key would leave a live credential.
    { handler: () => ({ body: { key: MINTED, record: { id: 'fedcba9876543210', project: 'rb-install-one' } } }), expect: /modelvia_key_unusable/ },
    { handler: () => ({ body: { key: MINTED, record: { id: '0123456789abcdef', project: 'rb-other' } } }), expect: /modelvia_key_scope_mismatch/ },
    { handler: () => ({ body: { key: MINTED } }), expect: /modelvia_unreadable/ },
  ];
  for (const item of cases) {
    const t = transport(item.handler);
    await assert.rejects(() => client(t).mint(mint), error => {
      assert.match(String((error as Error).message), item.expect);
      assert.ok(!String((error as Error).message).includes(OPERATOR_SECRET));
      return true;
    });
  }
});

test('an unset secret or an unusable origin, client id or model list never reaches the network', async () => {
  const t = transport(() => ({ body: {} }));
  await assert.rejects(() => client(t, () => undefined).revoke('0123456789abcdef'), /modelvia_operator_unconfigured/);
  // Modelvia refuses a secret under 32 characters outright.
  await assert.rejects(() => client(t, () => 'too-short-secret').revoke('0123456789abcdef'), /modelvia_operator_unconfigured/);
  const base = { environment: 'production', clientId: 'realbud', allowedModels: ['auto'], operatorSecret: () => OPERATOR_SECRET, operatorSubject: OPERATOR_SUBJECT, fetch: t.fetchLike };
  for (const serviceOrigin of ['not a url', 'http://api.modelvia.dev', 'https://api.modelvia.dev/v1', 'https://user:secret@api.modelvia.dev']) {
    assert.throws(() => modelviaKeyClient({ ...base, serviceOrigin }), /modelvia_base_invalid/);
  }
  assert.throws(() => modelviaKeyClient({ ...base, serviceOrigin: 'https://api.modelvia.dev', clientId: 'not a client id' }), /modelvia_client_id_invalid/);
  assert.throws(() => modelviaKeyClient({ ...base, serviceOrigin: 'https://api.modelvia.dev', allowedModels: [] }), /modelvia_models_invalid/);
  assert.throws(() => modelviaKeyClient({ ...base, serviceOrigin: 'https://api.modelvia.dev', allowedModels: ['auto', 'auto'] }), /modelvia_models_invalid/);
  assert.throws(() => modelviaKeyClient({ ...base, serviceOrigin: 'https://api.modelvia.dev', operatorSubject: '' }), /modelvia_operator_subject_invalid/);
  assert.equal(t.seen.length, 0);
});

test('a fresh bearer is minted per request and an old one is no longer accepted', async () => {
  const t = transport(() => ({ body: { id: '0123456789abcdef', revokedAt: 1 } }));
  const c = client(t);
  await c.revoke('0123456789abcdef');
  const first = t.seen[0]!.authorization!.slice('Bearer '.length);
  // Three minutes later the earlier bearer is outside Modelvia's window, and the
  // client must present a different, still-valid one rather than cache the first.
  clock = CLOCK + 180_000;
  await c.revoke('0123456789abcdef');
  const second = t.seen[1]!.authorization!.slice('Bearer '.length);
  assert.notEqual(first, second);
  assert.throws(() => verifyOperatorToken(first, OPERATOR_SECRET, clock), /unauthenticated/);
  assert.deepEqual(verifyOperatorToken(second, OPERATOR_SECRET, clock), { subject: OPERATOR_SUBJECT });
  // The two-minute window is inside Modelvia's five-minute ceiling.
  const claims = JSON.parse(Buffer.from(second.split('.')[0]!, 'base64url').toString('utf8'));
  assert.equal(claims.exp - claims.iat, 120_000);
  assert.equal(claims.aud, 'managed-ai-operator');
  clock = CLOCK;
});

test('operatorToken refuses a short secret, an empty subject and an over-long window', () => {
  assert.deepEqual(verifyOperatorToken(operatorToken(OPERATOR_SECRET, OPERATOR_SUBJECT, CLOCK), OPERATOR_SECRET, CLOCK), { subject: OPERATOR_SUBJECT });
  assert.throws(() => operatorToken('short', OPERATOR_SUBJECT, CLOCK), /modelvia_operator_unconfigured/);
  assert.throws(() => operatorToken(OPERATOR_SECRET, '', CLOCK), /modelvia_operator_unconfigured/);
  assert.throws(() => operatorToken(OPERATOR_SECRET, OPERATOR_SUBJECT, CLOCK, 300_001), /modelvia_operator_unconfigured/);
});

const ROTATED = `rbk_fedcba9876543210_${'B'.repeat(43)}`;
const stored = (over: Record<string, unknown> = {}) => ({ id: 'rb-install-one', name: 'RealBud installation install-one', active: true,
  monthlyCapNanoAud: '100000000000', requestCapNanoAud: '1000000000', maxConcurrent: 4, allowedModels: ['auto'], version: 3,
  clientId: 'realbud', customerId: 'cus-office', environments: ['production'], ...over });

test('listKeys reads secret-free records for one project and environment with a GET and no body', async () => {
  const t = transport(() => ({ body: { keys: [
    { id: '0123456789abcdef', companyId: 'billing-office', project: 'rb-install-one', environment: 'production', label: 'company-a:install-one', createdAt: 1, revokedAt: 5 },
    { id: 'fedcba9876543210', companyId: 'billing-office', project: 'rb-install-one', environment: 'production', label: 'company-a:install-one', createdAt: 6, lastUsedAt: 7 },
  ] } }));
  const keys = await client(t).listKeys('rb-install-one', 'production');
  assert.deepEqual(keys, [
    { keyId: '0123456789abcdef', projectId: 'rb-install-one', environment: 'production', label: 'company-a:install-one', revokedAt: 5 },
    { keyId: 'fedcba9876543210', projectId: 'rb-install-one', environment: 'production', label: 'company-a:install-one' },
  ]);
  assert.equal(t.seen[0]!.method, 'GET');
  assert.equal(t.seen[0]!.url, 'https://api.modelvia.dev/v1/operator/keys?projectId=rb-install-one&environment=production');
  assert.equal(t.seen[0]!.body, undefined);
  assert.deepEqual(verifyOperatorToken(t.seen[0]!.authorization!.slice('Bearer '.length), OPERATOR_SECRET, clock), { subject: OPERATOR_SUBJECT });
  // A record for another project is not ours to act on; a path-unsafe id never leaves.
  const stray = transport(() => ({ body: { keys: [{ id: '0123456789abcdef', project: 'rb-other', environment: 'production', createdAt: 1 }] } }));
  await assert.rejects(() => client(stray).listKeys('rb-install-one', 'production'), /modelvia_key_scope_mismatch/);
  await assert.rejects(() => client(t).listKeys('rb/../other', 'production'), /invalid_modelvia_account/);
  assert.equal(t.seen.length, 1);
});

test('rotate posts an empty body so the label is kept, and ties the replacement to the returned key', async () => {
  const t = transport(() => ({ body: { key: ROTATED, record: { id: 'fedcba9876543210', project: 'rb-install-one', label: 'company-a:install-one' }, replaced: '0123456789abcdef' } }));
  const rotated = await client(t).rotate('0123456789abcdef');
  assert.deepEqual(rotated, { key: ROTATED, keyId: 'fedcba9876543210', baseUrl: 'https://api.modelvia.dev/v1', projectId: 'rb-install-one', replaced: '0123456789abcdef' });
  assert.equal(t.seen[0]!.url, 'https://api.modelvia.dev/v1/operator/keys/0123456789abcdef/rotate');
  assert.deepEqual(t.seen[0]!.body, {});
  for (const body of [
    { key: ROTATED, record: { id: 'fedcba9876543210', project: 'rb-install-one' }, replaced: 'aaaaaaaaaaaaaaaa' },
    { key: ROTATED, record: { id: '0123456789abcdef', project: 'rb-install-one' }, replaced: '0123456789abcdef' },
    { key: 'sk-not-a-modelvia-key', record: { id: 'fedcba9876543210', project: 'rb-install-one' }, replaced: '0123456789abcdef' },
  ]) await assert.rejects(() => client(transport(() => ({ body }))).rotate('0123456789abcdef'), /modelvia_key_unusable/);
  await assert.rejects(() => client(t).rotate('../other'), /invalid_key_id/);
});

test('findProject reads the operator project list and refuses a project under another client', async () => {
  const t = transport(() => ({ body: { accounts: [stored({ id: 'rb-install-two' }), stored()] } }));
  assert.deepEqual(await client(t).findProject('rb-install-one'), { projectId: 'rb-install-one', clientId: 'realbud', customerId: 'cus-office',
    environments: ['production'], active: true, version: 3, monthlyCapNanoAud: '100000000000', requestCapNanoAud: '1000000000', maxConcurrent: 4 });
  assert.equal(t.seen[0]!.method, 'GET');
  assert.equal(t.seen[0]!.url, 'https://api.modelvia.dev/v1/operator/projects');
  assert.equal(await client(t).findProject('rb-absent'), undefined);
  const foreign = transport(() => ({ body: { accounts: [stored({ clientId: 'another-platform' })] } }));
  await assert.rejects(() => client(foreign).findProject('rb-install-one'), /modelvia_project_scope_mismatch/);
});

test('updateProjectCaps writes back the stored record at its version with only the caps changed', async () => {
  const caps = { monthlyCapNanoAud: '50000000000', requestCapNanoAud: '500000000', maxConcurrent: 2 };
  const t = transport((_url, method) => method === 'GET' ? { body: { accounts: [stored()] } } : { body: { ...stored(), ...caps, version: 4 } });
  assert.deepEqual(await client(t).updateProjectCaps('rb-install-one', caps), { updated: true, version: 4 });
  assert.deepEqual(t.seen.map(call => call.method), ['GET', 'POST']);
  assert.equal(t.seen[1]!.url, 'https://api.modelvia.dev/v1/operator/projects');
  // Exactly the fields Modelvia's accounts.put admits, the stored version, new caps.
  assert.deepEqual(t.seen[1]!.body, { ...stored(), ...caps });
  // Already applied: nothing is written.
  const same = transport(() => ({ body: { accounts: [stored(caps)] } }));
  assert.deepEqual(await client(same).updateProjectCaps('rb-install-one', caps), { updated: false, version: 3 });
  assert.deepEqual(same.seen.map(call => call.method), ['GET']);
  // A request cap above the monthly cap never leaves.
  await assert.rejects(() => client(t).updateProjectCaps('rb-install-one', { ...caps, requestCapNanoAud: '60000000000' }), /invalid_modelvia_caps/);
});

test('updateProjectCaps re-reads once after a version conflict, then gives up', async () => {
  const caps = { monthlyCapNanoAud: '50000000000', requestCapNanoAud: '500000000', maxConcurrent: 2 };
  let version = 3, posts = 0;
  const t = transport((_url, method) => {
    if (method === 'GET') return { body: { accounts: [stored({ version })] } };
    posts++;
    // Another writer moved the project between the first read and the write.
    if (posts === 1) { version = 5; return { status: 409, body: { error: 'account_version_conflict' } }; }
    return { body: { ...stored(), ...caps, version: 6 } };
  });
  assert.deepEqual(await client(t).updateProjectCaps('rb-install-one', caps), { updated: true, version: 6 });
  assert.deepEqual(t.seen.map(call => `${call.method}:${call.body?.version ?? ''}`), ['GET:', 'POST:3', 'GET:', 'POST:5']);
  const stuck = transport((_url, method) => method === 'GET' ? { body: { accounts: [stored()] } } : { status: 409, body: { error: 'account_version_conflict' } });
  await assert.rejects(() => client(stuck).updateProjectCaps('rb-install-one', caps), /modelvia_project_version_conflict/);
  assert.equal(stuck.seen.filter(call => call.method === 'POST').length, 2);
  // Any other refusal (a binding change, say) is not a conflict to retry.
  const refused = transport((_url, method) => method === 'GET' ? { body: { accounts: [stored()] } } : { status: 409, body: { error: 'account_binding_immutable' } });
  await assert.rejects(() => client(refused).updateProjectCaps('rb-install-one', caps), /modelvia_rejected/);
  const missing = transport(() => ({ body: { accounts: [] } }));
  await assert.rejects(() => client(missing).updateProjectCaps('rb-install-one', caps), /modelvia_project_missing/);
});
