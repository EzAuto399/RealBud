import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composioOrgClient, type HttpTransport } from './composio-org.ts';

const ORG_KEY = 'fictional-org-key';
const PROJECT_KEY = 'ak_fictional_project_key';
const project = (id: string) => ({ id, name: `realbud-${id}` });
const livePage = (data: unknown[], currentPage: number, totalPages: number, totalItems: number, nextCursor: string | null = null) =>
  ({ data, current_page: currentPage, total_pages: totalPages, total_items: totalItems, next_cursor: nextCursor });

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
    ? { body: livePage([{ id: 'pr_one', name: 'realbud-company-a', api_key: PROJECT_KEY }], 1, 1, 1) }
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

test('list follows only returned opaque cursors and verifies all v3.1 pages before returning projects', async () => {
  const cursor = 'cGFnZT0yL2xpbWl0PTUw==';
  const t = transport(url => {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('cursor')) return { body: livePage([project('pr_one')], 1, 2, 2, cursor) };
    assert.equal(parsed.searchParams.get('cursor'), cursor);
    assert.deepEqual([...parsed.searchParams.keys()], ['cursor']);
    return { body: livePage([project('pr_two')], 2, 2, 2) };
  });
  const client = composioOrgClient({ orgKey: () => ORG_KEY, fetch: t.fetchLike, base: 'https://composio.invalid' });
  assert.deepEqual(await client.listProjects(), [project('pr_one'), project('pr_two')]);
  assert.equal(t.seen.length, 2);
  assert.ok(t.seen.every(call => call.orgKey === ORG_KEY && call.method === 'GET'));
});

test('list preserves unpaginated legacy arrays and follows older items cursors', async () => {
  const legacyArray = transport(() => ({ body: [project('pr_one')] }));
  assert.deepEqual(await composioOrgClient({ orgKey: () => ORG_KEY, fetch: legacyArray.fetchLike }).listProjects(), [project('pr_one')]);
  const legacyItems = transport(url => ({ body: url.includes('?cursor=')
    ? { items: [project('pr_two')], next_cursor: null }
    : { items: [project('pr_one')], next_cursor: 'page2' } }));
  assert.deepEqual(await composioOrgClient({ orgKey: () => ORG_KEY, fetch: legacyItems.fetchLike }).listProjects(), [project('pr_one'), project('pr_two')]);
  assert.equal(legacyItems.seen.length, 2);
});

test('list refuses malformed, looped and truncated pages without returning a partial result', async () => {
  const first = livePage([project('pr_one')], 1, 2, 2, 'page2');
  const cases: { name: string; pages: unknown[] }[] = [
    { name: 'missing data', pages: [{ items: null, total_pages: 1, current_page: 1, total_items: 0 }] },
    { name: 'missing count metadata', pages: [{ data: [project('pr_one')], next_cursor: null }] },
    { name: 'missing next cursor', pages: [livePage([project('pr_one')], 1, 2, 2)] },
    { name: 'count shortage', pages: [livePage([project('pr_one')], 1, 1, 2)] },
    { name: 'wrong page number', pages: [first, livePage([project('pr_two')], 3, 3, 2)] },
    { name: 'changed total', pages: [first, livePage([project('pr_two')], 2, 2, 3)] },
    { name: 'duplicate project', pages: [first, livePage([project('pr_one')], 2, 2, 2)] },
    { name: 'repeated cursor', pages: [first, livePage([project('pr_two')], 2, 3, 3, 'page2')] },
    { name: 'shape switch', pages: [first, { items: [project('pr_two')] }] },
    { name: 'malformed cursor', pages: [livePage([project('pr_one')], 1, 2, 2, 'bad\nvalue')] },
  ];
  for (const item of cases) {
    let index = 0;
    const t = transport(() => ({ body: item.pages[Math.min(index++, item.pages.length - 1)] }));
    const client = composioOrgClient({ orgKey: () => ORG_KEY, fetch: t.fetchLike, base: 'https://composio.invalid' });
    await assert.rejects(() => client.listProjects(), /composio_(unreadable|project_list_partial)/, item.name);
    assert.ok(t.seen.length <= 2, item.name);
  }
});

test('list stops at its page bound even when the provider continues issuing fresh cursors', async () => {
  let calls = 0;
  const t = transport(() => ({ body: { items: [project(`pr_${++calls}`)], next_cursor: `page${calls + 1}` } }));
  await assert.rejects(() => composioOrgClient({ orgKey: () => ORG_KEY, fetch: t.fetchLike }).listProjects(), /composio_project_list_partial/);
  assert.equal(calls, 100);
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
