/**
 * RealBud's read of its offices' Modelvia AI invoices and AI margins, under
 * RealBud's Modelvia CLIENT integration key (`mgt_…`), never the operator
 * credential. Read only: nothing here finalizes, pays or changes anything at
 * Modelvia. Checked against Modelvia `main` 927a5c2 (`platform-admin.ts` client
 * routes, `customer-invoices.ts`, `customer-collection.ts`, `usage-analytics.ts`):
 *
 *   GET /v1/client/customers/{c}/billing?period=YYYY-MM
 *     → { clientId, customerId, period, payer, customerCheckout, customerGrossNanoAud,
 *         pendingRequests, unreconciledRequests, unknownCustomerPriceRequests, usageAvailable,
 *         invoices: [{ id, kind, period, currency, gstInclusive, totalCents, gstCents, … }] }
 *     The only way a client key discovers invoice ids. `invoices` lists every
 *     finalized customer invoice (any period); the money is the period's usage.
 *     `customerCheckout` ('client_app'|'portal'|'both'|'off', absent = client_app)
 *     is where Modelvia offers the customer its own checkout: RealBud consolidates
 *     only while it is 'off', so an office can never pay Modelvia directly too.
 *   GET /v1/client/customers/{c}/invoices/{id}
 *     → the finalized invoice (`state: "final"`, `CI-…` id, seller, totals) plus its
 *       payment summary (`paid`, `paymentState`, `checkoutAvailable`, `directPaymentAvailable`, …).
 *       Presented (Modelvia `main` bb73139, `charge-presentation.ts`): `lines` are
 *       grouped, one sale line per model with `model` and `requestCount`, each with
 *       `usedBy` ({displayName, projectId}) and, only when RealBud's client itemizes
 *       (`chargeDetail: "itemized"`), `components` {modelUsageCents, routingCents,
 *       serviceFeeCents}; Σ line cents and GST are the invoice's exactly.
 *   GET /v1/client/customers/{c}/invoices/{id}/requests.csv
 *     → one row per sold request: invoice_id, request_id, usage_period, usage_date,
 *       model, line, amount_nano_aud, amount_cents, gst_cents (customer prices only).
 *   GET /v1/client/analytics?period=&customerId=&requestsLimit=&requestsCursor=
 *     also pages `recentRequests` (createdAt, projectId, model, tokens, usedBy):
 *     read only to add date/time, user/project and tokens to the office's CSV.
 *   GET /v1/client/analytics?period=&customerId=
 *     → client scope, `summary.money`: `customerNetNanoAud` (retail the customer
 *       pays, null when a price is unknown) and `platformNetNanoAud` (wholesale incl.
 *       Modelvia's fee); nano-AUD, GST inclusive. Usage estimates by admission month.
 *   GET /v1/client/margin-report?period=   (feature-detected, see MARGIN_REPORT_PATH)
 *
 * Modelvia creates no invoice for a month without customer usage, and finalizes
 * one only by an operator action after the month closes. Error bodies may quote
 * the presented credential, so only a status-derived code is ever reported.
 */
import { GatewayError, requireThat } from './contracts.ts';
import type { HttpTransport } from './composio-org.ts';
import { modelviaOrigin } from './modelvia-keys.ts';

export const MODELVIA_CLIENT_KEY_ENV = 'REALBUD_MODELVIA_CLIENT_KEY';
/** Modelvia's per-customer margin report, being added in parallel. Tried once per
 * report; a 404/405 or an unrecognised shape falls back to analytics, so the
 * route may appear later without a RealBud change. Accepted shape: `{ customers |
 * rows: [{ customerId, customerNetNanoAud | retailNanoAud, platformNetNanoAud |
 * costNanoAud }] }`. */
export const MARGIN_REPORT_PATH = '/v1/client/margin-report';
const CLIENT_KEY = /^mgt_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/;
const PATH_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const INVOICE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,159}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const CENTS = /^-?(0|[1-9][0-9]{0,14})$/;
const NANO = /^-?(0|[1-9][0-9]{0,24})$/;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CSV_BYTES = 32 * 1024 * 1024;
/** Analytics pages read to enrich one invoice's CSV (500 requests each). */
const MAX_ANALYTICS_PAGES = 400;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,300}$/;
const TOKENS = /^(0|[1-9][0-9]{0,20})$/;

export interface ModelviaInvoiceSummary { id: string; period: string; totalCents: string; gstCents: string }
/** A finalized Modelvia customer invoice, reduced to what consolidation checks. */
/** One line of a Modelvia customer invoice as the office may see it: its exact
 * cents and GST, and who used it. `components` only when itemized. Never a
 * wholesale, platform-fee or markup figure. */
export interface ModelviaInvoiceLine {
  description: string; amountCents: string; gstCents: string;
  model?: string; requestCount?: number; usagePeriod?: string;
  /** Adjustment and refund lines name the invoice they correct. */
  sourceInvoice?: string; refundId?: string;
  usedBy?: { displayName: string; projectId: string | null };
  components?: { modelUsageCents: string; routingCents: string; serviceFeeCents: string };
}
export interface ModelviaCustomerInvoice extends ModelviaInvoiceSummary {
  kind: string; clientId: string; customerId: string;
  seller: { legalName: string; abn: string };
  /** The grouped lines, summing exactly to the invoice's cents and GST. */
  lines: ModelviaInvoiceLine[];
  /** Whose usage the invoice is (Modelvia's display name for the customer). */
  usedBy?: { displayName: string };
  chargeDetail: 'all_in' | 'itemized';
  /** From Modelvia's payment summary: whether anything was paid or a checkout
   * started there, and whether Modelvia offers the customer a way to pay it. */
  paid: boolean; paymentState: string; checkoutAvailable: boolean; directPaymentAvailable: boolean;
}
export interface ModelviaCustomerMonth {
  /** The finalized customer invoices Modelvia lists for the customer with a
   * period up to the one asked for. Later ones are skipped before validation. */
  invoices: ModelviaInvoiceSummary[];
  /** Where Modelvia offers this client's customers a checkout; 'off' for none. */
  customerCheckout: 'client_app' | 'portal' | 'both' | 'off';
  /** True unless Modelvia shows the month had no customer usage at all: an
   * unknown price, pending or unreconciled request, or an unreadable usage
   * total all count as usage that needs an invoice. */
  usageExpected: boolean;
}
export interface ModelviaCustomerMargin {
  source: 'margin_report' | 'analytics';
  /** What the customer pays (Modelvia price incl. RealBud's markup); null when a price is unknown. */
  retailNanoAud: string | null;
  /** Modelvia's wholesale incl. its platform fee. */
  costNanoAud: string;
  /** False while requests are pending, unknown or unpriced: an estimate, not final. */
  complete: boolean;
}
/** One sold request of a Modelvia customer invoice, from its requests CSV,
 * with what client analytics adds (absent when analytics has no such row). */
export interface ModelviaInvoiceRequest {
  invoiceId: string; requestId: string; usagePeriod: string; model: string;
  amountCents: string; gstCents: string;
  createdAt?: number; usedBy?: string; projectId?: string | null; tokensIn?: string; tokensOut?: string;
}
export interface ModelviaClientBilling {
  customerMonth(customerId: string, period: string): Promise<ModelviaCustomerMonth>;
  customerInvoice(customerId: string, invoiceId: string): Promise<ModelviaCustomerInvoice>;
  /** The invoice's sold requests with date/time, user/project and tokens. */
  customerInvoiceRequests?(customerId: string, invoiceId: string): Promise<ModelviaInvoiceRequest[]>;
  customerMargins(customerIds: readonly string[], period: string): Promise<Map<string, ModelviaCustomerMargin>>;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const str = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value);
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function modelviaClientBilling(options: {
  serviceOrigin: string; clientId: string;
  /** The client integration key, read per request and never stored or logged. */
  clientKey: () => string | undefined;
  fetch: HttpTransport;
}): ModelviaClientBilling {
  const base = modelviaOrigin(options.serviceOrigin);
  requireThat(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(options.clientId), 'modelvia_client_id_invalid', 503);
  /** 200 → the JSON body; 404 → undefined when `missing` allows it; anything else a code. */
  const read = async (path: string, missing = false, text = false): Promise<unknown> => {
    const key = (options.clientKey() ?? '').trim();
    requireThat(CLIENT_KEY.test(key), 'modelvia_client_unconfigured', 503);
    let response: Response;
    try {
      response = await options.fetch(`${base}${path}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
    } catch { throw new GatewayError('modelvia_unreachable', 502); }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      if (missing && (response.status === 404 || response.status === 405)) return undefined;
      if (response.status === 404) throw new GatewayError('modelvia_customer_invoice_not_found', 404);
      throw new GatewayError(response.status === 401 || response.status === 403 ? 'modelvia_client_rejected' : 'modelvia_rejected', 502);
    }
    if (text) {
      requireThat(/^text\/csv(?:;|$)/i.test(response.headers.get('content-type') ?? ''), 'modelvia_unreadable', 502);
      const body = await response.text().catch(() => { throw new GatewayError('modelvia_unreadable', 502); });
      requireThat(body.length <= MAX_CSV_BYTES, 'modelvia_unreadable', 502);
      return body;
    }
    try { return await response.json(); } catch { throw new GatewayError('modelvia_unreadable', 502); }
  };
  const customerPath = (customerId: string) => { requireThat(PATH_ID.test(customerId), 'invalid_modelvia_customer'); return `/v1/client/customers/${customerId}`; };
  const month = (period: string) => { requireThat(MONTH.test(period), 'invalid_billing_period'); return period; };
  const summary = (value: unknown): ModelviaInvoiceSummary => {
    requireThat(record(value) && str(value.id, INVOICE_ID) && str(value.period, MONTH) && str(value.totalCents, CENTS) && str(value.gstCents, CENTS)
      && value.currency === 'AUD' && value.gstInclusive === true, 'modelvia_unreadable', 502);
    return { id: value.id as string, period: value.period as string, totalCents: value.totalCents as string, gstCents: value.gstCents as string };
  };
  const analytics = async (customerId: string, period: string): Promise<ModelviaCustomerMargin> => {
    const body = await read(`/v1/client/analytics?${new URLSearchParams({ period, customerId })}`);
    requireThat(record(body) && record(body.summary) && record(body.summary.money), 'modelvia_unreadable', 502);
    const s = body.summary as Record<string, unknown>, money = s.money as Record<string, unknown>;
    requireThat((money.customerNetNanoAud === null || str(money.customerNetNanoAud, NANO)) && str(money.platformNetNanoAud, NANO), 'modelvia_unreadable', 502);
    const complete = s.pending === 0 && s.unknown === 0 && money.unknownCustomerPriceRequests === 0 && money.customerNetNanoAud !== null;
    return { source: 'analytics', retailNanoAud: money.customerNetNanoAud as string | null, costNanoAud: money.platformNetNanoAud as string, complete };
  };
  /** The margin report's rows by customer, or undefined when it is absent or unrecognised. */
  const marginReport = async (period: string): Promise<Map<string, ModelviaCustomerMargin> | undefined> => {
    let body: unknown;
    try { body = await read(`${MARGIN_REPORT_PATH}?${new URLSearchParams({ period })}`, true); } catch { return undefined; }
    const rows = record(body) ? (Array.isArray(body.customers) ? body.customers : Array.isArray(body.rows) ? body.rows : undefined) : undefined;
    if (!rows) return undefined;
    const found = new Map<string, ModelviaCustomerMargin>();
    for (const row of rows as unknown[]) {
      if (!record(row) || typeof row.customerId !== 'string') return undefined;
      const retail = row.customerNetNanoAud !== undefined ? row.customerNetNanoAud : row.retailNanoAud;
      const cost = row.platformNetNanoAud !== undefined ? row.platformNetNanoAud : row.costNanoAud;
      if (!(retail === null || str(retail, NANO)) || !str(cost, NANO)) return undefined;
      found.set(row.customerId, { source: 'margin_report', retailNanoAud: retail as string | null, costNanoAud: cost as string,
        complete: row.complete === undefined ? retail !== null : row.complete === true && retail !== null });
    }
    return found;
  };
  return {
    async customerMonth(customerId, period) {
      const body = await read(`${customerPath(customerId)}/billing?${new URLSearchParams({ period: month(period) })}`);
      requireThat(record(body) && body.clientId === options.clientId && body.customerId === customerId && body.period === period
        && Array.isArray(body.invoices), 'modelvia_unreadable', 502);
      // Resale needs RealBud's client to be the payer; otherwise Modelvia bills the office itself.
      requireThat(body.payer === 'client', 'modelvia_customer_not_client_paid', 409);
      const checkout = body.customerCheckout ?? 'client_app';
      requireThat(checkout === 'client_app' || checkout === 'portal' || checkout === 'both' || checkout === 'off', 'modelvia_unreadable', 502);
      // Only invoices up to this month matter to its close; a later or unusual
      // invoice must not stop it, so the period is read before anything else.
      const relevant = (body.invoices as unknown[]).filter(entry => {
        requireThat(record(entry) && str(entry.period, MONTH), 'modelvia_unreadable', 502);
        return (entry.period as string) <= period;
      });
      const invoices = relevant.map(summary);
      requireThat(new Set(invoices.map(i => i.id)).size === invoices.length, 'modelvia_unreadable', 502);
      const gross = body.customerGrossNanoAud;
      requireThat(gross === null || str(gross, NANO), 'modelvia_unreadable', 502);
      const usageExpected = body.usageAvailable !== true || gross === null || BigInt(gross as string) !== 0n
        || !count(body.pendingRequests) || (body.pendingRequests as number) > 0
        || !count(body.unreconciledRequests) || (body.unreconciledRequests as number) > 0
        || !count(body.unknownCustomerPriceRequests) || (body.unknownCustomerPriceRequests as number) > 0;
      return { invoices, customerCheckout: checkout as ModelviaCustomerMonth['customerCheckout'], usageExpected };
    },
    async customerInvoice(customerId, invoiceId) {
      requireThat(INVOICE_ID.test(invoiceId), 'invalid_modelvia_invoice');
      const body = await read(`${customerPath(customerId)}/invoices/${invoiceId}`);
      const base = summary(body), value = body as Record<string, unknown>;
      requireThat(base.id === invoiceId && value.state === 'final' && value.customerId === customerId && value.clientId === options.clientId
        && typeof value.kind === 'string' && record(value.seller) && typeof value.seller.legalName === 'string' && str(value.seller.abn, /^\d{11}$/)
        && typeof value.paid === 'boolean' && typeof value.paymentState === 'string'
        && (value.checkoutAvailable === undefined || typeof value.checkoutAvailable === 'boolean')
        && (value.directPaymentAvailable === undefined || typeof value.directPaymentAvailable === 'boolean'), 'modelvia_unreadable', 502);
      const seller = value.seller as Record<string, unknown>;
      requireThat(Array.isArray(value.lines) && value.lines.length <= 200_000, 'modelvia_unreadable', 502);
      const lines = (value.lines as unknown[]).map(invoiceLine);
      // The office sees these lines as they are; they must BE the invoice.
      requireThat(lines.reduce((n, l) => n + BigInt(l.amountCents), 0n).toString() === base.totalCents
        && lines.reduce((n, l) => n + BigInt(l.gstCents), 0n).toString() === base.gstCents, 'modelvia_invoice_lines_mismatch', 409);
      const usedBy = record(value.usedBy) && typeof value.usedBy.displayName === 'string' && LABEL.test(value.usedBy.displayName) ? { displayName: value.usedBy.displayName } : undefined;
      return { ...base, kind: value.kind as string, clientId: options.clientId, customerId,
        seller: { legalName: seller.legalName as string, abn: seller.abn as string }, lines, ...(usedBy ? { usedBy } : {}),
        chargeDetail: value.chargeDetail === 'itemized' ? 'itemized' : 'all_in',
        paid: value.paid as boolean, paymentState: value.paymentState as string,
        checkoutAvailable: value.checkoutAvailable === true, directPaymentAvailable: value.directPaymentAvailable === true };
    },
    async customerInvoiceRequests(customerId, invoiceId) {
      requireThat(INVOICE_ID.test(invoiceId), 'invalid_modelvia_invoice');
      const rows = parseRequestsCsv(await read(`${customerPath(customerId)}/invoices/${invoiceId}/requests.csv`, false, true) as string, invoiceId);
      // Date/time, user/project and tokens come from the customer's analytics
      // rows, paged per usage period until every request is found.
      const wanted = new Map(rows.map(r => [r.requestId, r]));
      for (const period of [...new Set(rows.map(r => r.usagePeriod))].sort()) {
        let cursor: string | null = null;
        for (let page = 0; page < MAX_ANALYTICS_PAGES; page++) {
          const query = new URLSearchParams({ period, customerId, requestsLimit: '500', ...(cursor ? { requestsCursor: cursor } : {}) });
          const body = await read(`/v1/client/analytics?${query}`);
          requireThat(record(body) && Array.isArray(body.recentRequests), 'modelvia_unreadable', 502);
          for (const entry of body.recentRequests as unknown[]) {
            if (!record(entry) || typeof entry.requestId !== 'string') continue;
            const row = wanted.get(entry.requestId); if (!row) continue;
            if (Number.isSafeInteger(entry.createdAt)) row.createdAt = entry.createdAt as number;
            if (entry.projectId === null || (typeof entry.projectId === 'string' && PATH_ID.test(entry.projectId))) row.projectId = entry.projectId as string | null;
            if (record(entry.usedBy) && typeof entry.usedBy.displayName === 'string' && LABEL.test(entry.usedBy.displayName)) row.usedBy = entry.usedBy.displayName;
            const tokens = record(entry.tokens) ? entry.tokens : undefined;
            const input = tokens ? (str(tokens.totalInput, TOKENS) ? tokens.totalInput : tokens.input) : undefined;
            if (str(input, TOKENS)) row.tokensIn = input as string;
            if (tokens && str(tokens.output, TOKENS)) row.tokensOut = tokens.output as string;
          }
          const next = record(body.recentRequestsPage) ? body.recentRequestsPage.nextCursor : null;
          if (typeof next !== 'string' || !next || rows.every(r => r.usagePeriod !== period || r.createdAt !== undefined)) break;
          cursor = next;
        }
      }
      return rows;
    },
    async customerMargins(customerIds, period) {
      month(period);
      const report = await marginReport(period);
      const result = new Map<string, ModelviaCustomerMargin>();
      for (const customerId of customerIds) {
        const row = report?.get(customerId);
        // A customer missing from the report had no usage there; analytics says so exactly.
        result.set(customerId, row ?? await analytics(customerId, period));
      }
      return result;
    },
  };
}

/** One presented Modelvia invoice line, reduced to what the office may see. */
function invoiceLine(value: unknown): ModelviaInvoiceLine {
  requireThat(record(value) && typeof value.description === 'string' && LABEL.test(value.description) && str(value.amountCents, CENTS) && str(value.gstCents, CENTS)
    && (value.model === undefined || (typeof value.model === 'string' && LABEL.test(value.model)))
    && (value.requestCount === undefined || (count(value.requestCount) && (value.requestCount as number) > 0))
    && (value.usagePeriod === undefined || str(value.usagePeriod, MONTH))
    && (value.sourceInvoice === undefined || str(value.sourceInvoice, INVOICE_ID))
    && (value.refundId === undefined || str(value.refundId, PATH_ID)), 'modelvia_unreadable', 502);
  const line: ModelviaInvoiceLine = { description: value.description as string, amountCents: value.amountCents as string, gstCents: value.gstCents as string,
    ...(value.model !== undefined ? { model: value.model as string } : {}), ...(value.requestCount !== undefined ? { requestCount: value.requestCount as number } : {}),
    ...(value.usagePeriod !== undefined ? { usagePeriod: value.usagePeriod as string } : {}),
    ...(value.sourceInvoice !== undefined ? { sourceInvoice: value.sourceInvoice as string } : {}), ...(value.refundId !== undefined ? { refundId: value.refundId as string } : {}) };
  const used = value.usedBy;
  if (record(used) && typeof used.displayName === 'string' && LABEL.test(used.displayName))
    line.usedBy = { displayName: used.displayName, projectId: typeof used.projectId === 'string' && PATH_ID.test(used.projectId) ? used.projectId : null };
  const c = value.components;
  if (record(c) && str(c.modelUsageCents, CENTS) && str(c.routingCents, CENTS) && str(c.serviceFeeCents, CENTS)
    && BigInt(c.modelUsageCents as string) + BigInt(c.routingCents as string) + BigInt(c.serviceFeeCents as string) === BigInt(line.amountCents))
    line.components = { modelUsageCents: c.modelUsageCents as string, routingCents: c.routingCents as string, serviceFeeCents: c.serviceFeeCents as string };
  return line;
}
const CSV_HEADER = 'invoice_id,request_id,usage_period,usage_date,model,line,amount_nano_aud,amount_cents,gst_cents';
/** Modelvia's RFC 4180 requests CSV, strictly: its exact header, then one row
 * per sold request of `invoiceId`. */
function parseRequestsCsv(text: string, invoiceId: string): ModelviaInvoiceRequest[] {
  const records: string[][] = []; let row: string[] = [], field = '', quoted = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; } field += c; i++; continue; }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') { row.push(field); records.push(row); row = []; field = ''; i += 2; continue; }
    requireThat(c !== '\r' && c !== '\n', 'modelvia_unreadable', 502);
    field += c; i++;
  }
  requireThat(!quoted && field === '' && row.length === 0 && records.length >= 1 && records[0].join(',') === CSV_HEADER, 'modelvia_unreadable', 502);
  return records.slice(1).map(r => {
    requireThat(r.length === 9 && r[0] === invoiceId && REQUEST_ID.test(r[1]) && MONTH.test(r[2]) && (r[4] === '' || LABEL.test(r[4])) && CENTS.test(r[7]) && CENTS.test(r[8]), 'modelvia_unreadable', 502);
    return { invoiceId, requestId: r[1], usagePeriod: r[2], model: r[4], amountCents: r[7], gstCents: r[8] };
  });
}

/** The client-key billing reader from the environment, or undefined when the key
 * or the Modelvia origin/client id is absent. Presence only; never a value. */
export function composeModelviaClientBilling(options: { env: NodeJS.ProcessEnv; fetch: HttpTransport }): ModelviaClientBilling | undefined {
  const value = (name: string) => (options.env[name] ?? '').trim();
  if (!CLIENT_KEY.test(value(MODELVIA_CLIENT_KEY_ENV)) || !value('REALBUD_MODELVIA_BASE_URL') || !value('REALBUD_MODELVIA_CLIENT_ID')) return undefined;
  try {
    return modelviaClientBilling({ serviceOrigin: value('REALBUD_MODELVIA_BASE_URL'), clientId: value('REALBUD_MODELVIA_CLIENT_ID'),
      clientKey: () => options.env[MODELVIA_CLIENT_KEY_ENV], fetch: options.fetch });
  } catch { return undefined; }
}
