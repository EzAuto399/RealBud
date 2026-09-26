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

export interface ModelviaInvoiceSummary { id: string; period: string; totalCents: string; gstCents: string }
/** A finalized Modelvia customer invoice, reduced to what consolidation checks. */
export interface ModelviaCustomerInvoice extends ModelviaInvoiceSummary {
  kind: string; clientId: string; customerId: string;
  seller: { legalName: string; abn: string };
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
export interface ModelviaClientBilling {
  customerMonth(customerId: string, period: string): Promise<ModelviaCustomerMonth>;
  customerInvoice(customerId: string, invoiceId: string): Promise<ModelviaCustomerInvoice>;
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
  const read = async (path: string, missing = false): Promise<unknown> => {
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
      return { ...base, kind: value.kind as string, clientId: options.clientId, customerId,
        seller: { legalName: seller.legalName as string, abn: seller.abn as string }, paid: value.paid as boolean, paymentState: value.paymentState as string,
        checkoutAvailable: value.checkoutAvailable === true, directPaymentAvailable: value.directPaymentAvailable === true };
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
