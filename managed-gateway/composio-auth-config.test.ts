import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composioAuthConfigClient, GMAIL_AUTH_CONFIG_NAME, GMAIL_READONLY_SCOPE } from './composio-auth-config.ts';
const config = (changes: Record<string, unknown> = {}) => ({ id: 'ac_test', name: GMAIL_AUTH_CONFIG_NAME, toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', is_composio_managed: true, status: 'ENABLED', credentials: { scopes: GMAIL_READONLY_SCOPE }, ...changes });
const args = { projectKey: 'ak_fictional_office', allowCreate: true, beforeCreate() {} };
test('managed create uses only office project key and exact readonly scope, then reads back before returning', async () => {
  const calls: string[] = []; let created = false, journalled = false;
  const client = composioAuthConfigClient({ fetch: async (url, init) => {
    calls.push(init.method!); assert.equal(new Headers(init.headers).get('x-api-key'), args.projectKey); assert.equal(new Headers(init.headers).get('x-org-api-key'), null);
    if (init.method === 'POST') {
      assert.equal(journalled, true); created = true;
      assert.deepEqual(JSON.parse(init.body as string), { toolkit: { slug: 'gmail' }, auth_config: { type: 'use_composio_managed_auth', name: GMAIL_AUTH_CONFIG_NAME, credentials: { scopes: GMAIL_READONLY_SCOPE } } });
      return Response.json({ auth_config: { id: 'ac_test' } }, { status: 201 });
    }
    assert.equal(new URL(url).searchParams.get('show_disabled'), 'true');
    return Response.json({ items: created ? [config()] : [], next_cursor: null });
  } });
  assert.equal(await client.resolveGmail({ ...args, beforeCreate() { journalled = true; } }), 'ac_test');
  assert.equal(await client.resolveGmail({ ...args, allowCreate: false }), 'ac_test');
  assert.deepEqual(calls, ['GET', 'POST', 'GET', 'GET']);
});
test('uncertain create reconciles once; missing outcome refuses subsequent creation', async () => {
  for (const visible of [true, false]) {
    let posts = 0;
    const client = composioAuthConfigClient({ fetch: async (_url, init) => {
      if (init.method === 'POST') { posts++; throw new Error('lost response with secret'); }
      return Response.json({ items: visible && posts ? [config()] : [] });
    } });
    if (visible) assert.equal(await client.resolveGmail(args), 'ac_test');
    else await assert.rejects(client.resolveGmail(args), /connector_auth_config_create_unconfirmed/);
    if (!visible) await assert.rejects(client.resolveGmail({ ...args, allowCreate: false }), /connector_auth_config_create_unconfirmed/);
    assert.equal(posts, 1);
  }
});
test('disabled, custom, wrong-toolkit, non-OAuth and widened or unreadable scopes fail closed without writes', async () => {
  for (const changes of [{ status: 'DISABLED' }, { is_composio_managed: false }, { auth_scheme: 'API_KEY' }, { toolkit: { slug: 'slack' } }, { credentials: {} }, { credentials: { scopes: `${GMAIL_READONLY_SCOPE},https://mail.google.com/` } }]) {
    const client = composioAuthConfigClient({ fetch: async (_url, init) => { assert.equal(init.method, 'GET'); return Response.json({ items: [config(changes)] }); } });
    await assert.rejects(client.resolveGmail(args), /connector_auth_config_.*not_admitted/);
  }
});
test('pagination detects duplicates and refuses partial or looping lists', async () => {
  for (const kind of ['duplicate', 'loop', 'malformed']) {
    const client = composioAuthConfigClient({ fetch: async (url, init) => {
      assert.equal(init.method, 'GET'); const next = new URL(url).searchParams.has('cursor');
      return Response.json({ items: kind === 'malformed' ? null : [config()], next_cursor: !next || kind === 'loop' ? 'page2' : null });
    } });
    await assert.rejects(client.resolveGmail(args), /connector_auth_config_(ambiguous|list_partial|unreadable)/);
  }
});
test('redirects and provider bodies do not leak project keys', async () => {
  const client = composioAuthConfigClient({ fetch: async () => new Response(args.projectKey, { status: 302, headers: { location: 'https://other.invalid' } }) });
  await assert.rejects(client.resolveGmail(args), error => error instanceof Error && error.message === 'connector_auth_config_unconfirmed');
});

test('readback admits only adapter-reviewed basic sign-in scopes alongside gmail.readonly', async () => {
  for (const scopes of [`${GMAIL_READONLY_SCOPE},openid,email,profile,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/userinfo.profile`, [GMAIL_READONLY_SCOPE, 'openid']]) {
    const client = composioAuthConfigClient({ fetch: async () => Response.json({ items: [config({ credentials: { scopes } })] }) });
    assert.equal(await client.resolveGmail(args), 'ac_test');
  }
  const client = composioAuthConfigClient({ fetch: async () => Response.json({ items: [config({ credentials: { scopes: 'openid email profile' } })] }) });
  await assert.rejects(client.resolveGmail(args), /scopes_not_admitted/);
});
