import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPOSIO_OAUTH_REDIRECT_URI, composioAuthConfigClient, GMAIL_AUTH_CONFIG_NAME, GMAIL_READONLY_SCOPE, managedAuthConfigName, oauthAppsFromEnv, oauthProviderFor, ownAuthConfigName } from './composio-auth-config.ts';
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
test('a definitive provider refusal of the create is reported as rejected, without reconciling', async () => {
  const calls: string[] = [];
  const client = composioAuthConfigClient({ fetch: async (_url, init) => { calls.push(init.method!); return init.method === 'POST' ? new Response('{"error":"bad toolkit"}', { status: 400 }) : Response.json({ items: [] }); } });
  await assert.rejects(client.resolveAuthConfig!({ slug: 'xero', ...args }), /connector_auth_config_rejected/);
  assert.deepEqual(calls, ['GET', 'POST']);
  // Timeouts and rate limits stay uncertain and reconcile.
  const flaky = composioAuthConfigClient({ fetch: async (_url, init) => init.method === 'POST' ? new Response('', { status: 429 }) : Response.json({ items: [] }) });
  await assert.rejects(flaky.resolveAuthConfig!({ slug: 'xero', ...args }), /connector_auth_config_create_unconfirmed/);
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

// RealBud's own OAuth client (30 September 2026). Fictional values only.
const OWN_ID = 'fictional-client.apps.googleusercontent.com', OWN_SECRET = 'fictional-own-client-secret-value';
const googleEnv = { REALBUD_OAUTH_GOOGLE_CLIENT_ID: OWN_ID, REALBUD_OAUTH_GOOGLE_CLIENT_SECRET: OWN_SECRET };
/** A project's auth-config surface that stores what was created, exactly as posted. */
function project(initial: Record<string, unknown>[] = []) {
  const items = [...initial]; const posts: Record<string, unknown>[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body as string) as { toolkit: { slug: string }; auth_config: Record<string, unknown> };
      posts.push(body); const id = `ac_created_${posts.length}`; const c = body.auth_config;
      items.push({ id, name: c.name, toolkit: { slug: body.toolkit.slug }, auth_scheme: 'OAUTH2', is_composio_managed: c.type === 'use_composio_managed_auth', status: 'ENABLED', credentials: { scopes: (c.credentials as Record<string, unknown> | undefined)?.scopes } });
      return Response.json({ auth_config: { id } }, { status: 201 });
    }
    const slug = new URL(url).searchParams.get('toolkit_slug');
    return Response.json({ items: items.filter(i => (i.toolkit as { slug: string }).slug === slug), next_cursor: null });
  };
  return { items, posts, fetch };
}
test('own OAuth client is chosen when the provider env is present, with a versioned own name and gmail.readonly only', async () => {
  const p = project();
  const client = composioAuthConfigClient({ fetch: p.fetch, oauthApps: oauthAppsFromEnv(googleEnv) });
  assert.equal(await client.resolveGmail(args), 'ac_created_1');
  assert.deepEqual(p.posts[0], { toolkit: { slug: 'gmail' }, auth_config: { type: 'use_custom_auth', authScheme: 'OAUTH2', name: 'realbud-gmail-own-v1',
    credentials: { client_id: OWN_ID, client_secret: OWN_SECRET, oauth_redirect_uri: COMPOSIO_OAUTH_REDIRECT_URI, scopes: GMAIL_READONLY_SCOPE } } });
  assert.equal(await client.resolveAuthConfig!({ slug: 'googlecalendar', ...args }), 'ac_created_2');
  assert.deepEqual(p.posts[1], { toolkit: { slug: 'googlecalendar' }, auth_config: { type: 'use_custom_auth', authScheme: 'OAUTH2', name: 'realbud-googlecalendar-own-v1',
    credentials: { client_id: OWN_ID, client_secret: OWN_SECRET, oauth_redirect_uri: COMPOSIO_OAUTH_REDIRECT_URI } } });
  // A toolkit on another provider, or none, stays Composio-managed.
  assert.equal(await client.resolveAuthConfig!({ slug: 'outlook', ...args }), 'ac_created_3');
  assert.equal(await client.resolveAuthConfig!({ slug: 'xero', ...args }), 'ac_created_4');
  assert.deepEqual(p.posts.slice(2).map(b => (b.auth_config as Record<string, unknown>).type), ['use_composio_managed_auth', 'use_composio_managed_auth']);
  assert.deepEqual(p.posts.slice(2).map(b => (b.auth_config as Record<string, unknown>).name), ['realbud-outlook-managed-v1', 'realbud-xero-managed-v1']);
});
test('without an operator OAuth app every toolkit falls back to the managed config exactly as before', async () => {
  for (const oauthApps of [undefined, oauthAppsFromEnv({}), oauthAppsFromEnv({ REALBUD_OAUTH_GOOGLE_CLIENT_ID: ' ', REALBUD_OAUTH_GOOGLE_CLIENT_SECRET: '' })]) {
    const p = project();
    const client = composioAuthConfigClient({ fetch: p.fetch, ...(oauthApps ? { oauthApps } : {}) });
    await client.resolveGmail(args); await client.resolveAuthConfig!({ slug: 'googledrive', ...args });
    assert.deepEqual(p.posts, [
      { toolkit: { slug: 'gmail' }, auth_config: { type: 'use_composio_managed_auth', name: GMAIL_AUTH_CONFIG_NAME, credentials: { scopes: GMAIL_READONLY_SCOPE } } },
      { toolkit: { slug: 'googledrive' }, auth_config: { type: 'use_composio_managed_auth', name: 'realbud-googledrive-managed-v1' } },
    ]);
  }
});
test('switching to the own client leaves the old managed Gmail config untouched and creates a separately named one', async () => {
  const old = config({ id: 'ac_old_managed' });
  const p = project([old]);
  // Before the switch the office resolves its existing managed config with no write.
  assert.equal(await composioAuthConfigClient({ fetch: p.fetch }).resolveGmail(args), 'ac_old_managed');
  assert.equal(p.posts.length, 0);
  const own = composioAuthConfigClient({ fetch: p.fetch, oauthApps: oauthAppsFromEnv(googleEnv) });
  assert.equal(await own.resolveGmail(args), 'ac_created_1');
  assert.equal(await own.resolveGmail({ ...args, allowCreate: false }), 'ac_created_1');
  assert.equal(p.posts.length, 1);
  assert.deepEqual(p.items[0], old); // never mutated, still resolvable by its old name
  assert.equal(await composioAuthConfigClient({ fetch: p.fetch }).resolveGmail({ ...args, allowCreate: false }), 'ac_old_managed');
  assert.notEqual(ownAuthConfigName('gmail'), managedAuthConfigName('gmail'));
  assert.notEqual(ownAuthConfigName('googledrive'), managedAuthConfigName('googledrive'));
});
test('an own-named config that is Composio-managed, disabled or has widened Gmail scopes fails closed', async () => {
  const own = (changes: Record<string, unknown>) => ({ ...config(), name: 'realbud-gmail-own-v1', is_composio_managed: false, ...changes });
  for (const changes of [{ is_composio_managed: true }, { status: 'DISABLED' }, { auth_scheme: 'API_KEY' }, { credentials: { scopes: `${GMAIL_READONLY_SCOPE},https://mail.google.com/` } }]) {
    const client = composioAuthConfigClient({ fetch: async (_url, init) => { assert.equal(init.method, 'GET'); return Response.json({ items: [own(changes)] }); }, oauthApps: oauthAppsFromEnv(googleEnv) });
    await assert.rejects(client.resolveGmail(args), /connector_auth_config_.*not_admitted/);
  }
});
test('the client secret never appears in errors, and half a configuration names only the missing variable', async () => {
  const outcomes: unknown[] = [];
  for (const failure of ['throw', 'reject', 'unconfirmed', 'redirect'] as const) {
    const client = composioAuthConfigClient({ oauthApps: oauthAppsFromEnv(googleEnv), fetch: async (_url, init) => {
      if (init.method !== 'POST') return Response.json({ items: [] });
      if (failure === 'throw') throw new Error(`socket closed ${OWN_SECRET}`);
      if (failure === 'reject') return new Response(`{"error":"invalid ${OWN_SECRET}"}`, { status: 400 });
      if (failure === 'redirect') return new Response(OWN_SECRET, { status: 302, headers: { location: 'https://other.invalid' } });
      return new Response(OWN_SECRET, { status: 500 });
    } });
    try { await client.resolveGmail(args); } catch (error) { outcomes.push(error); }
  }
  assert.equal(outcomes.length, 4);
  for (const error of outcomes) {
    const text = `${(error as Error).message} ${(error as Error).stack} ${JSON.stringify(error)}`;
    assert.ok(!text.includes(OWN_SECRET) && !text.includes(OWN_ID), text);
  }
  const half = oauthAppsFromEnv({ REALBUD_OAUTH_GOOGLE_CLIENT_ID: OWN_ID });
  assert.throws(() => half('google'), (e: Error) => e.message === 'connector_oauth_app_unconfigured:REALBUD_OAUTH_GOOGLE_CLIENT_SECRET');
  const other = oauthAppsFromEnv({ REALBUD_OAUTH_MICROSOFT_CLIENT_SECRET: OWN_SECRET });
  assert.throws(() => other('microsoft'), (e: Error) => e.message === 'connector_oauth_app_unconfigured:REALBUD_OAUTH_MICROSOFT_CLIENT_ID' && !e.message.includes(OWN_SECRET));
  assert.equal(oauthAppsFromEnv({})('google'), undefined);
});
test('toolkits map to one provider; unknown and prototype names map to none', () => {
  for (const slug of ['gmail', 'googlecalendar', 'googledrive', 'googlesheets', 'googledocs', 'googlemeet']) assert.equal(oauthProviderFor(slug), 'google');
  for (const slug of ['outlook', 'one_drive', 'microsoft_teams', 'share_point']) assert.equal(oauthProviderFor(slug), 'microsoft');
  for (const slug of ['xero', 'slack', 'constructor', 'toString', '__proto__']) assert.equal(oauthProviderFor(slug), undefined);
});
