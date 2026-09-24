import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composioOrgClient, type HttpTransport } from './composio-org.ts';

const ORG_KEY = 'fictional-org-key';
const PROJECT_KEY = 'ak_fictional_project_key';

function transport(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown; text?: string; redirected?: boolean }) {
  const seen: { url: string; method: string; orgKey: string | undefined; body: string | undefined }[] = [];
  const fetchLike: HttpTransport = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    seen.push({ url, method: String(init.method), orgKey: headers['x-org-api-key'], body: init.body as string | undefined });
    const result = handler(url, init);
    const response = new Response(result.text ?? JSON.stringify(result.body ?? {}), { status: result.status ?? 200 });
    if (result.redirected) Object.defineProperty(response, 'redirected', { value: true });
    return response;
  };
  return { seen, fetchLike };
}

test('list, create and delete use the org key header and the documented paths', async () => {
  const t = transport(url => url.endsWith('/org/owner/project/list')
    ? { body: { items: [{ id: 'pr_one', name: 'realbud-company-a', api_key: PROJECT_KEY }] } }
    : url.includes('/new') ? { body: { id: 'pr_two', name: 'realbud-company-b', api_key: PROJECT_KEY } }
    : { body: { status: 'success', revoke_job_id: 'job-one' } });
  const client = composioOrgClient({ orgKey: () => ORG_KEY, fetch: t.fetchLike, base: 'https://composio.invalid' });

  // A project key present in a list response is dropped: only create hands one back.
  assert.deepEqual(await client.listProjects(), [{ id: 'pr_one', name: 'realbud-company-a' }]);
  assert.deepEqual(await client.createProject('realbud-company-b'), { id: 'pr_two', name: 'realbud-company-b', apiKey: PROJECT_KEY });
  assert.deepEqual(await client.deleteProject('pr_two'), { revokeJobId: 'job-one' });

  assert.deepEqual(t.seen.map(call => `${call.method} ${call.url.replace('https://composio.invalid', '')}`), [
    'GET /org/owner/project/list', 'POST /org/owner/project/new', 'DELETE /org/owner/project/pr_two?revoke_on_delete=true']);
  assert.ok(t.seen.every(call => call.orgKey === ORG_KEY));
  assert.deepEqual(JSON.parse(t.seen[1]!.body!), { name: 'realbud-company-b', should_create_api_key: true });
});

test('a non-200, a redirect, a partial list or an unusable key fails closed without echoing the body', async () => {
  const cases: { name: string; handler: Parameters<typeof transport>[0]; expect: RegExp }[] = [
    { name: 'status', handler: () => ({ status: 403, text: `denied for ${ORG_KEY}` }), expect: /composio_rejected/ },
    { name: 'redirect', handler: () => ({ redirected: true, body: {} }), expect: /composio_redirected/ },
    { name: 'not json', handler: () => ({ text: `<html>${ORG_KEY}</html>` }), expect: /composio_unreadable/ },
    { name: 'partial list', handler: () => ({ body: { items: [], next_cursor: 'more' } }), expect: /composio_project_list_partial/ },
  ];
  for (const item of cases) {
    const t = transport(item.handler);
    const client = composioOrgClient({ orgKey: () => ORG_KEY, fetch: t.fetchLike, base: 'https://composio.invalid' });
    await assert.rejects(() => client.listProjects(), error => {
      assert.match(String((error as Error).message), item.expect);
      assert.ok(!String((error as Error).message).includes(ORG_KEY), `${item.name} echoed the org key`);
      return true;
    });
  }
});

test('create refuses a project with no readable key and delete refuses an unconfirmed outcome', async () => {
  const unkeyed = transport(() => ({ body: { id: 'pr_one', name: 'realbud-company-a' } }));
  await assert.rejects(() => composioOrgClient({ orgKey: () => ORG_KEY, fetch: unkeyed.fetchLike, base: 'https://composio.invalid' }).createProject('realbud-company-a'), /composio_project_key_missing/);

  const badKey = transport(() => ({ body: { id: 'pr_one', name: 'realbud-company-a', api_key: 'sk-not-a-project-key' } }));
  await assert.rejects(() => composioOrgClient({ orgKey: () => ORG_KEY, fetch: badKey.fetchLike, base: 'https://composio.invalid' }).createProject('realbud-company-a'), /composio_project_key_unusable/);

  for (const body of [{ status: 'pending', revoke_job_id: 'job' }, { status: 'success' }]) {
    const t = transport(() => ({ body }));
    await assert.rejects(() => composioOrgClient({ orgKey: () => ORG_KEY, fetch: t.fetchLike, base: 'https://composio.invalid' }).deleteProject('pr_one'),
      /composio_delete_unconfirmed|composio_revocation_unconfirmed/);
  }
});

test('an unset org key, an unusable base and a caller-shaped project id never reach the network', async () => {
  const t = transport(() => ({ body: {} }));
  await assert.rejects(() => composioOrgClient({ orgKey: () => undefined, fetch: t.fetchLike, base: 'https://composio.invalid' }).listProjects(), /composio_org_unconfigured/);
  await assert.rejects(() => composioOrgClient({ orgKey: () => 'key with\nnewline', fetch: t.fetchLike, base: 'https://composio.invalid' }).listProjects(), /composio_org_unconfigured/);
  for (const base of ['', 'not a url', 'http://composio.invalid', 'https://user:secret@composio.invalid', 'https://composio.invalid?k=secret']) {
    assert.throws(() => composioOrgClient({ orgKey: () => ORG_KEY, fetch: t.fetchLike, base }), /composio_base_invalid/);
  }
  const client = composioOrgClient({ orgKey: () => ORG_KEY, fetch: t.fetchLike, base: 'https://composio.invalid' });
  for (const id of ['', 'pr_one/../other', '../org', 'project-one']) await assert.rejects(() => client.deleteProject(id), /composio_project_id_invalid/);
  assert.equal(t.seen.length, 0);
});
