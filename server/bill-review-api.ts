import type { BillReviewDraftStore } from './bill-review-drafts.ts';
import type { BillProposalHistory } from '../shared/bill-proposals.ts';

function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function bodyFields(body: unknown, keys: string[]) {
  if (!object(body) || Object.keys(body).sort().join(',') !== [...keys].sort().join(',')) {
    fail('Choose the saved bill review and its current revision.');
  }
  return body;
}
function queryFields(params: URLSearchParams, page: boolean) {
  const seen = new Set<string>();
  for (const [key] of params) {
    if (!page || !['filter', 'limit', 'cursor'].includes(key) || seen.has(key)) fail('This saved review query is invalid. Refresh the list.');
    seen.add(key);
  }
  const filter = params.get('filter') ?? 'active';
  if (!['active', 'all'].includes(filter)) fail('Choose active reviews or all saved reviews.');
  const rawLimit = params.get('limit'), limit = rawLimit === null ? 20 : Number(rawLimit);
  if (rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit) || limit < 1 || limit > 100) fail('Choose between 1 and 100 saved reviews.');
  const cursor = params.get('cursor') ?? undefined;
  if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) fail('This saved review page is invalid. Refresh the list.');
  return { filter: filter as 'active' | 'all', limit, ...(cursor === undefined ? {} : { cursor }) };
}

/** Private workspace data routes. The host applies session/origin, JSON body and
 * restore barriers before dispatch. Receipt lookup never admits model work. */
export function createBillReviewApi(options: {
  drafts: () => BillReviewDraftStore;
  proposal: (requestId: string) => BillProposalHistory;
  recovery: () => boolean;
}) {
  return (url: URL, method: string, body?: unknown) => {
    const path = url.pathname;
    if (path.startsWith('/api/bill-proposals/')) {
      queryFields(url.searchParams, false);
      const match = path.match(/^\/api\/bill-proposals\/([^/]+)$/);
      if (!match) return { status: 404, body: { error: 'That saved preparation request is unavailable.' } };
      if (method !== 'GET') return { status: 405, body: { error: 'Saved preparation receipts are read-only.' } };
      return { status: 200, body: options.proposal(match[1]) };
    }
    if (!/^\/api\/bill-review-drafts(?:\/|$)/.test(path)) return undefined;
    const list = path === '/api/bill-review-drafts';
    const query = queryFields(url.searchParams, list && method === 'GET');
    const item = path.match(/^\/api\/bill-review-drafts\/([^/]+)$/);
    if (!list && !item) return { status: 404, body: { error: 'That saved bill review is unavailable.' } };
    if (method === 'GET') {
      if (list) return { status: 200, body: options.drafts().page(query) };
      const draft = options.drafts().get(item![1]);
      if (!draft) fail('That saved bill review is unavailable.', 404);
      return { status: 200, body: { draft } };
    }
    if (!(list && method === 'POST' || item && method === 'PUT')) return { status: 405, body: { error: 'Choose a supported bill review action.' } };
    if (options.recovery()) fail('Recover the private book before saving bill reviews. Existing drafts are kept.', 503);
    if (list) {
      const b = bodyFields(body, ['id', 'expectedRevision', 'value']);
      if (typeof b.id !== 'string' || b.expectedRevision !== null) fail('Choose a new bill review identifier.');
      return { status: 200, body: { draft: options.drafts().create(b.id, null, b.value) } };
    }
    const b = bodyFields(body, ['expectedRevision', 'value']);
    if (!Number.isSafeInteger(b.expectedRevision) || Number(b.expectedRevision) < 1) fail('Choose the saved bill review revision.');
    return { status: 200, body: { draft: options.drafts().update(item![1], Number(b.expectedRevision), b.value) } };
  };
}
