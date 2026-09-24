import { previewBillSource, type SourceBillRegister } from './source-bills.ts';
import type { BillMailSource, SourceBillsWorkspace } from '../shared/source-bills.ts';
import type { SourceBillOccurrenceResult, SourceBillSeriesResult, SourceBillCurrentSourceResult } from '../shared/source-bills-api.ts';
import { addBillDays } from '../shared/bill-dates.ts';
import { billPageQuery, billQuery, billQueryText } from './bill-api-query.ts';

const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export interface BillApiHost {
  register: () => SourceBillRegister;
  source: (itemId: string, messageId: string) => Promise<BillMailSource>;
  savedThread: (accountId: string, threadId: string) => Promise<SourceBillCurrentSourceResult>;
  propertyIds: () => string[];
  actorId: () => string;
  recovery: () => boolean;
  collect: () => Promise<unknown>;
  now?: () => number;
}
/** Called only behind desktop session/origin checks. Source bodies and actor
 * identities always come from the private host, never the submitted form. */
export function createSourceBillsApi(host: BillApiHost) {
  function property(value: unknown) {
    if (!record(value) || typeof value.propertyId !== 'string' || !host.propertyIds().includes(value.propertyId)) fail('Choose a current property from this private workspace.', 409);
  }
  return async (url: URL, method: string, body?: unknown) => {
    const path = url.pathname;
    if (!/^\/api\/bill-(?:register|evidence|occurrences|series|scan)(?:\/|$)/.test(path)) return null;
    if (method !== 'GET' && host.recovery()) fail('Recover the private book before changing bills or collecting mail.', 503);
    if (method !== 'GET') billQuery(url.searchParams, []);
    if (path === '/api/bill-register' && method === 'GET') {
      billQuery(url.searchParams, ['from', 'to', 'propertyId', 'limit']);
      const today = new Date((host.now ?? Date.now)()).toISOString().slice(0,10);
      const range = { from: url.searchParams.get('from') ?? today, to: url.searchParams.get('to') ?? addBillDays(today,366) };
      const query = billPageQuery(url.searchParams), register = host.register();
      // Validate the range before reading other pages; no full register arrays.
      const calendar = register.calendarPage({ ...range, ...query });
      const { revision, ...counts } = register.counts();
      const result: SourceBillsWorkspace = { version: 2, revision, counts, range, propertyId: query.propertyId ?? null,
        occurrences: register.occurrencePage(query), series: register.seriesPage(query), calendar };
      if ([result.occurrences, result.series, calendar].some(page => page.revision !== revision)) return fail('Saved bills changed while this view was being read. Refresh and try again.',409);
      return { status: 200, body: result };
    }
    if (path === '/api/bill-register/calendar' && method === 'GET') {
      billQuery(url.searchParams, ['from', 'to', 'propertyId', 'cursor', 'limit']);
      const today = new Date((host.now ?? Date.now)()).toISOString().slice(0,10);
      return { status: 200, body: host.register().calendarPage({ ...billPageQuery(url.searchParams),
        from: url.searchParams.get('from') ?? today, to: url.searchParams.get('to') ?? addBillDays(today,366) }) };
    }
    if ((path === '/api/bill-occurrences' || path === '/api/bill-series') && method === 'GET') {
      billQuery(url.searchParams, ['propertyId', 'cursor', 'limit']);
      const query = billPageQuery(url.searchParams), register = host.register();
      return { status: 200, body: path === '/api/bill-occurrences' ? register.occurrencePage(query) : register.seriesPage(query) };
    }
    if (path === '/api/bill-series/matching' && method === 'GET') {
      billQuery(url.searchParams, ['accountId', 'propertyId', 'kind', 'vendor', 'includeSeriesId']);
      const required = (name: string, max: number) => billQueryText(url.searchParams, name, max) ?? fail('Choose the saved bill being matched.');
      const includeSeriesId = billQueryText(url.searchParams, 'includeSeriesId', 48);
      return { status: 200, body: { series: host.register().matchingSeries({ accountId: required('accountId',200),
        propertyId: required('propertyId',200), kind: required('kind',80), vendor: required('vendor',160),
        ...(includeSeriesId ? { includeSeriesId } : {}) }) } };
    }
    const bySource = path.match(/^\/api\/bill-occurrences\/by-source\/([a-f0-9]{64})$/);
    if (bySource && method === 'GET') {
      billQuery(url.searchParams, []);
      const register = host.register(), saved = register.findBySourceIdentity(bySource[1]);
      const result: SourceBillOccurrenceResult = { occurrence: saved ?? null, originSeries: saved ? register.getSeriesForOccurrence(saved.id) ?? null : null };
      return { status: 200, body: result };
    }
    if (path === '/api/bill-scan' && method === 'POST') {
      if (!record(body) || Object.keys(body).length) fail('Mail scope comes from the reviewed bills setup.');
      return { status: 200, body: await host.collect() };
    }
    const evidence = path.match(/^\/api\/bill-evidence\/([a-f0-9]{64})$/);
    if (evidence && method === 'GET') {
      billQuery(url.searchParams, ['messageId']);
      const messageId = url.searchParams.get('messageId');
      if (!messageId || !/^[a-fA-F0-9]{1,128}$/.test(messageId)) return fail('Choose a saved message.');
      return { status: 200, body: previewBillSource(await host.source(evidence[1], messageId)) };
    }
    const occurrence = path.match(/^\/api\/bill-occurrences\/(source-bill:[a-f0-9]{64})$/);
    const occurrenceSource = path.match(/^\/api\/bill-occurrences\/(source-bill:[a-f0-9]{64})\/source$/);
    if (occurrenceSource && method === 'GET') {
      billQuery(url.searchParams, []);
      const saved = host.register().getOccurrence(occurrenceSource[1]);
      if (!saved) return fail('That saved bill is unavailable.',404);
      const result = await host.savedThread(saved.source.accountId, saved.source.threadId);
      if (result.accountId !== saved.source.accountId || result.thread.id !== saved.source.threadId || !/^[a-f0-9]{64}$/.test(result.itemId)) return fail('The saved source identity needs recovery.',503);
      return { status: 200, body: result };
    }
    if (occurrence && method === 'GET') {
      billQuery(url.searchParams, []);
      const register = host.register(), saved = register.getOccurrence(occurrence[1]);
      if (!saved) return fail('That saved bill is unavailable.',404);
      const result: SourceBillOccurrenceResult = { occurrence: saved, originSeries: register.getSeriesForOccurrence(saved.id) ?? null };
      return { status: 200, body: result };
    }
    if ((path === '/api/bill-occurrences' && method === 'POST') || (occurrence && method === 'PUT')) {
      if (!record(body) || typeof body.itemId !== 'string' || !/^[a-f0-9]{64}$/.test(body.itemId) || typeof body.messageId !== 'string' || !/^[a-fA-F0-9]{1,128}$/.test(body.messageId)) return fail('Choose the saved mail message being reviewed.');
      const { itemId, messageId, ...review } = body;
      const source = await host.source(itemId as string, messageId as string);
      // Recheck after the asynchronous read and before the synchronous CAS.
      if (host.recovery()) fail('The private book needs recovery.',503);
      property(review.facts);
      return { status: 200, body: occurrence ? host.register().correct(occurrence[1],review,source,host.actorId()) : host.register().accept(review,source,host.actorId()) };
    }
    if (path === '/api/bill-series' && method === 'POST') {
      if (!record(body)) return fail('Choose the received bill and reviewed arrival pattern.');
      const register = host.register();
      const occurrence = typeof body.occurrenceId === 'string' ? register.getOccurrence(body.occurrenceId) : undefined;
      if (!occurrence) return fail('Choose a current received bill to confirm this arrival pattern.',409);
      property(occurrence.facts);
      return { status: 200, body: register.approveSeries(body,host.actorId()) };
    }
    const series = path.match(/^\/api\/bill-series\/(bill-series:[a-f0-9-]{36})$/);
    if (series && method === 'GET') {
      billQuery(url.searchParams, []);
      const register = host.register(), saved = register.getSeries(series[1]);
      if (!saved) return fail('That arrival pattern is unavailable.',404);
      const origin = register.getOccurrence(saved.occurrenceId);
      if (!origin) return fail('The saved arrival pattern needs recovery.',503);
      const result: SourceBillSeriesResult = { series: saved, occurrence: origin };
      return { status: 200, body: result };
    }
    if (series && method === 'PUT') {
      const register = host.register();
      if (record(body) && body.active === true) {
        const saved = register.getSeries(series[1]);
        if (!saved) fail('That arrival pattern is unavailable.',404);
        property(saved);
      }
      return { status: 200, body: register.reviseSeries(series[1],body,host.actorId()) };
    }
    return { status: 404, body: { error: 'Unknown bill review action.' } };
  };
}
