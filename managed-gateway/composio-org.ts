/**
 * Composio *organisation* surface for the vendor-side gateway: authenticated with
 * the org key (`x-org-api-key`), never a project key. One office gets one project;
 * deleting it with `?revoke_on_delete=true` is the only call here that actually
 * revokes the office's upstream OAuth credentials at Google/Microsoft/etc.
 *
 * PARITY NOTE. This is a deliberate minimal copy of `server/composio-project.ts`
 * (request shape, key/id regexes, fail-closed delete, never echoing a body or a
 * key). The gateway is an off-device service and must not import `server/`, so the
 * two are kept in step by hand: change one, change the other. Only the three calls
 * provisioning needs are copied — list, create, delete. Regenerate stays in
 * `server/` because regenerating invalidates a key an installation is already using.
 *
 * No default transport. The caller injects `fetch`; nothing here is deployed.
 */
import { GatewayError, requireThat } from './contracts.ts';

export const COMPOSIO_PLATFORM_API = 'https://backend.composio.dev/api/v3.1';

const PROJECT_API_KEY = /^ak_[a-zA-Z0-9_-]{6,512}$/;
const PROJECT_ID = /^pr_[a-zA-Z0-9_-]{1,128}$/;
const PROJECT_NAME_MAX = 200;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_PROJECT_PAGES = 100;
const MAX_PROJECT_ITEMS = 10_000;
const MAX_CURSOR_LENGTH = 1024;

export interface ComposioProject { id: string; name: string }
export interface ComposioCreatedProject extends ComposioProject { apiKey: string }
/** Injected so tests and the sandbox smoke run against a fake, never the network. */
export type HttpTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface ComposioOrgClient {
  listProjects(): Promise<ComposioProject[]>;
  createProject(name: string): Promise<ComposioCreatedProject>;
  /** Irreversible: deletes the project and revokes every upstream credential in it. */
  deleteProject(id: string): Promise<{ revokeJobId: string }>;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function readProject(value: unknown, requireKey: boolean): ComposioProject & { apiKey?: string } {
  requireThat(record(value), 'composio_unreadable', 502);
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  requireThat(PROJECT_ID.test(id) && name && name.length <= PROJECT_NAME_MAX && !/[\x00-\x1f\x7f]/.test(name), 'composio_unreadable', 502);
  const raw = value.api_key;
  if (raw === undefined || raw === null) { requireThat(!requireKey, 'composio_project_key_missing', 502); return { id, name }; }
  // The key value is never echoed, not even when it is rejected.
  requireThat(typeof raw === 'string' && PROJECT_API_KEY.test(raw), 'composio_project_key_unusable', 502);
  return { id, name, apiKey: raw as string };
}

type ProjectListPage = {
  items: unknown[];
  nextCursor?: string;
  kind: 'array' | 'items' | 'data';
  totalPages?: number;
  currentPage?: number;
  totalItems?: number;
};

function readProjectListPage(body: unknown): ProjectListPage {
  if (Array.isArray(body)) return { items: body, kind: 'array' };
  requireThat(record(body), 'composio_unreadable', 502);
  const hasData = Object.hasOwn(body, 'data');
  const hasItems = Object.hasOwn(body, 'items');
  requireThat(hasData !== hasItems, 'composio_unreadable', 502);
  const items = hasData ? body.data : body.items;
  requireThat(Array.isArray(items), 'composio_unreadable', 502);
  const rawCursor = body.next_cursor;
  requireThat(rawCursor == null || (typeof rawCursor === 'string' && rawCursor.length > 0 && rawCursor.length <= MAX_CURSOR_LENGTH && !/[\x00-\x1f\x7f]/.test(rawCursor)), 'composio_project_list_partial', 502);
  const nextCursor = rawCursor == null ? undefined : rawCursor as string;
  if (!hasData) {
    // The older `items` shape has no trustworthy count metadata. Its cursor is
    // still followed; accepting only its first page could hide a live project.
    requireThat(!Object.hasOwn(body, 'total_pages') && !Object.hasOwn(body, 'current_page') && !Object.hasOwn(body, 'total_items'), 'composio_unreadable', 502);
    return { items, nextCursor, kind: 'items' };
  }
  const { total_pages: totalPages, current_page: currentPage, total_items: totalItems } = body;
  requireThat(Number.isSafeInteger(totalPages) && Number.isSafeInteger(currentPage) && Number.isSafeInteger(totalItems)
    && (totalPages as number) >= 1 && (totalPages as number) <= MAX_PROJECT_PAGES
    && (currentPage as number) >= 1 && (currentPage as number) <= (totalPages as number)
    && (totalItems as number) >= 0 && (totalItems as number) <= MAX_PROJECT_ITEMS,
  'composio_project_list_partial', 502);
  return { items, nextCursor, kind: 'data', totalPages: totalPages as number, currentPage: currentPage as number, totalItems: totalItems as number };
}

/** Base URL is a test/self-hosted seam, not a user setting. A set but unusable
 * value fails closed rather than quietly falling back to Composio. */
function checkedBase(base: string | undefined): string {
  if (base === undefined) return COMPOSIO_PLATFORM_API;
  const raw = base.trim(); requireThat(raw, 'composio_base_invalid', 503);
  let url: URL; try { url = new URL(raw); } catch { throw new GatewayError('composio_base_invalid', 503); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  requireThat(!url.username && !url.password && !url.hash && !url.search && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)), 'composio_base_invalid', 503);
  return raw.replace(/\/+$/, '');
}

export function composioOrgClient(options: { orgKey: () => string | undefined; fetch: HttpTransport; base?: string }): ComposioOrgClient {
  const base = checkedBase(options.base);
  const key = () => {
    const value = options.orgKey();
    // A CR/LF or other control character makes fetch reject the header, which
    // would otherwise surface as an unrelated network failure.
    requireThat(typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value.trim()), 'composio_org_unconfigured', 503);
    return (value as string).trim();
  };
  /** Every response must be exactly 200: these endpoints document 200 for success,
   * and any other status leaves the outcome unconfirmed — including whether a
   * project was created before the call failed. Nothing retries. */
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const orgKey = key();
    let response: Response;
    try {
      response = await options.fetch(`${base}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'x-org-api-key': orgKey, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new GatewayError('composio_unreachable', 502); }
    // Following a redirect would carry the organisation key to another host.
    if (response.redirected) { await response.body?.cancel().catch(() => {}); throw new GatewayError('composio_redirected', 502); }
    // Provider error bodies can quote the key that was sent, so only a code is
    // reported — never the body, never the status text.
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw new GatewayError('composio_rejected', 502); }
    try { return await response.json(); } catch { throw new GatewayError('composio_unreadable', 502); }
  };
  return {
    async listProjects() {
      const projects: ComposioProject[] = [];
      const seenIds = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let kind: ProjectListPage['kind'] | undefined;
      let totalPages: number | undefined;
      let totalItems: number | undefined;
      for (let pageNumber = 1; pageNumber <= MAX_PROJECT_PAGES; pageNumber++) {
        // Only a server-returned opaque cursor is sent back. URLSearchParams
        // encodes it without interpreting or guessing the provider's format.
        const path = `/org/owner/project/list${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`;
        const page = readProjectListPage(await call('GET', path));
        requireThat(kind === undefined || page.kind === kind, 'composio_project_list_partial', 502);
        kind = page.kind;
        if (page.kind === 'data') {
          totalPages ??= page.totalPages;
          totalItems ??= page.totalItems;
          requireThat(page.currentPage === pageNumber && page.totalPages === totalPages && page.totalItems === totalItems, 'composio_project_list_partial', 502);
        }
        requireThat(projects.length + page.items.length <= MAX_PROJECT_ITEMS, 'composio_project_list_partial', 502);
        for (const item of page.items) {
          const { apiKey: _ignored, ...project } = readProject(item, false);
          requireThat(!seenIds.has(project.id), 'composio_project_list_partial', 502);
          seenIds.add(project.id);
          projects.push(project);
        }
        if (page.kind === 'data') {
          requireThat(projects.length <= totalItems! && Boolean(page.nextCursor) === (pageNumber < totalPages!), 'composio_project_list_partial', 502);
        }
        if (!page.nextCursor) {
          requireThat(page.kind !== 'data' || projects.length === totalItems, 'composio_project_list_partial', 502);
          return projects;
        }
        requireThat(page.items.length > 0 && pageNumber < MAX_PROJECT_PAGES && !seenCursors.has(page.nextCursor), 'composio_project_list_partial', 502);
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw new GatewayError('composio_project_list_partial', 502);
    },
    async createProject(name) {
      const projectName = typeof name === 'string' ? name.trim() : '';
      requireThat(projectName && projectName.length <= PROJECT_NAME_MAX && !/[\x00-\x1f\x7f]/.test(projectName), 'composio_project_name_invalid', 400);
      // Ask for the key up front: Composio returns it only from create and regenerate.
      const created = readProject(await call('POST', '/org/owner/project/new', { name: projectName, should_create_api_key: true }), true);
      return { id: created.id, name: created.name, apiKey: created.apiKey! };
    },
    async deleteProject(id) {
      const projectId = typeof id === 'string' ? id.trim() : '';
      // The id is interpolated into the path, so its shape is what keeps a
      // caller-supplied string from reaching any other endpoint.
      requireThat(PROJECT_ID.test(projectId), 'composio_project_id_invalid', 400);
      let body: unknown;
      // Fail closed and never retry: a second attempt is a second irreversible act
      // whose outcome nobody has seen. The caller reports "access may still be live".
      try { body = await call('DELETE', `/org/owner/project/${projectId}?revoke_on_delete=true`); }
      catch { throw new GatewayError('composio_delete_unconfirmed', 502); }
      requireThat(record(body) && body.status === 'success', 'composio_delete_unconfirmed', 502);
      const revokeJobId = (body as Record<string, unknown>).revoke_job_id;
      requireThat(typeof revokeJobId === 'string' && revokeJobId.trim(), 'composio_revocation_unconfirmed', 502);
      return { revokeJobId: (revokeJobId as string).trim() };
    },
  };
}
