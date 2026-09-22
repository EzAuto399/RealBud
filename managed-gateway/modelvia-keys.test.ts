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

function transport(handler: (url: string) => { status?: number; body?: unknown; text?: string; redirected?: boolean }) {
  const seen: { url: string; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const fetchLike: HttpTransport = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    seen.push({ url, authorization: headers.authorization, body: JSON.parse(String(init.body)) });
    const result = handler(url);
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
