/**
 * One monthly invoice per office (owner decision, 26 September 2026): the care
 * fee plus, for an office that accepted AI resale, its finalized Modelvia
 * customer invoices, so the office pays ONE amount through RealBud's Square
 * checkout. Plus the owner's per-office margin view.
 *
 * Month close (`commercial-cli.ts close`, an explicit operator action):
 *   1. An invoice already closed for the office and month is returned as it is,
 *      with no Modelvia call (idempotent re-run).
 *   2. Client-funded offices, and offices that never accepted AI resale: care only,
 *      with no Modelvia call.
 *   3. Otherwise the office's finalized Modelvia customer invoices for this month
 *      and any earlier month since its first AI resale acceptance, not yet
 *      consolidated, are read under the client key and checked: final, RealBud's
 *      client and this office's customer, RealBud's seller ABN, and nothing paid
 *      or started at Modelvia (else the office could pay twice).
 *   4. WAIT, the default, when Modelvia shows usage for the month (or for an
 *      earlier deferred month) but no finalized invoice for it: nothing closes
 *      (`modelvia_invoice_not_finalized`) until Modelvia's operator finalizes it.
 *      `deferAi` (explicit operator choice) closes without it and records the
 *      deferral; the next close picks the invoice up, because every
 *      unconsolidated earlier-month invoice is included. Each Modelvia invoice id
 *      can be consolidated once only (`office_ai_consolidations` primary key).
 *   Guards (409): Modelvia offering the office its own checkout
 *   (`modelvia_checkout_enabled`); an unconsolidated invoice dated before the
 *   office's first resale acceptance (`modelvia_invoice_before_acceptance`);
 *   AI owed while this month's terms carry no `aiUsage` (`ai_usage_unconsolidated`:
 *   an office that ever accepted resale keeps being read); GST that the AI lines
 *   and the one total cannot reconcile within a cent (`gst_reconciliation_required`).
 */
import { GatewayError, requireThat } from './contracts.ts';
import type { UsageLedger } from './ledger.ts';
import { consolidatedAiInvoices, ensureAiConsolidationTable, type AiInvoiceInput, type AiLineInput, type BillingService, type Invoice } from './billing.ts';
import type { CommercialTerms, ResaleAcceptance } from './commercial-terms.ts';
import type { ModelviaClientBilling, ModelviaCustomerMargin, ModelviaInvoiceLine } from './modelvia-client-billing.ts';
import { officeChargeDetail, officeMarkup } from './office-ai-terms.ts';
import { cents, periodAt } from './money.ts';
import { serialized } from './provisioning.ts';

export interface OfficeBilling {
  billing: BillingService;
  /** Absent when `REALBUD_MODELVIA_CLIENT_KEY` is not configured. */
  modelvia?: ModelviaClientBilling;
  /** `REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES`: AI is free for these offices. */
  clientFundedCompanies: ReadonlySet<string>;
  /** The deployment's default markup for new terms, for the margin view only. */
  defaultMarkupBasisPoints?: number;
}
export interface MonthClose { invoice: Invoice; ai: 'care_only' | 'consolidated' | 'no_ai_usage' | 'deferred' | 'already_closed' }

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const officeCustomer = (ledger: UsageLedger, companyId: string): string | undefined => {
  ledger.db.run('CREATE TABLE IF NOT EXISTS office_modelvia_customer (tenant TEXT PRIMARY KEY, customer TEXT NOT NULL UNIQUE)');
  return ledger.db.get<{ customer: string }>('SELECT customer FROM office_modelvia_customer WHERE tenant=?', companyId)?.customer;
};
const resaleSince = (ledger: UsageLedger, companyId: string): string | undefined =>
  ledger.db.all<{ body: string }>("SELECT body FROM events WHERE tenant=? AND kind='ai_resale_terms_accepted' ORDER BY seq", companyId)
    .map(row => (JSON.parse(row.body) as ResaleAcceptance).period).sort()[0];

export function closeOfficeMonth(options: OfficeBilling, companyId: string, period: string, termsVersion: string, close: { deferAi?: boolean } = {}): Promise<MonthClose> {
  requireThat(MONTH.test(period), 'invalid_billing_period');
  return serialized(`office-month-close:${companyId}`, async () => {
    const { billing } = options, ledger = billing.ledger;
    if (ledger.db.get('SELECT id FROM invoices WHERE tenant=? AND period=?', companyId, period))
      return { invoice: billing.finalizeCommercialInvoice(companyId, period, termsVersion), ai: 'already_closed' };
    requireThat(billing.commercialTerms, 'commercial_terms_unavailable', 503);
    const terms = billing.commercialTerms.accepted(companyId, period, termsVersion).terms;
    const since = resaleSince(ledger, companyId);
    // A client-funded office's AI is RealBud's cost; terms that bill it are a mistake.
    if (options.clientFundedCompanies.has(companyId)) requireThat(!terms.aiUsage, 'client_funded_office_ai_not_billable', 409);
    // Never resold: nothing at Modelvia can belong on this invoice.
    if (options.clientFundedCompanies.has(companyId) || (!terms.aiUsage && since === undefined)) return finalize(billing, companyId, period, termsVersion, undefined, 'care_only');
    const customerId = officeCustomer(ledger, companyId);
    requireThat(customerId, 'office_modelvia_customer_unbound', 409);
    requireThat(options.modelvia, 'modelvia_client_unconfigured', 503);
    const month = await options.modelvia.customerMonth(customerId, period);
    // Modelvia must not also offer the office a way to pay these invoices.
    requireThat(month.customerCheckout === 'off', 'modelvia_checkout_enabled', 409);
    const done = consolidatedAiInvoices(ledger, companyId);
    const due = month.invoices.filter(entry => !done.has(entry.id)).sort((a, b) => a.period.localeCompare(b.period) || a.id.localeCompare(b.id));
    // Usage billed at Modelvia before the office accepted resale was never agreed to here.
    requireThat(!due.some(entry => since === undefined || entry.period < since), 'modelvia_invoice_before_acceptance', 409);
    // Months still waiting for Modelvia: this one, and any deferred earlier month
    // whose invoice has not appeared yet.
    const invoiced = (p: string) => month.invoices.some(entry => entry.period === p) || [...done.values()].some(entry => entry.period === p);
    const outstanding: string[] = [];
    for (const p of deferredPeriods(ledger, companyId).filter(p => p < period && !invoiced(p))) {
      const earlier = await options.modelvia.customerMonth(customerId, p);
      if (earlier.usageExpected && !earlier.invoices.some(entry => entry.period === p)) outstanding.push(p);
    }
    if (month.usageExpected && !month.invoices.some(entry => entry.period === period)) outstanding.push(period);
    // Terms without AI resale cannot carry AI that is owed: refuse rather than drop it.
    requireThat(terms.aiUsage || (!due.length && !outstanding.length), 'ai_usage_unconsolidated', 409);
    if (outstanding.length && !close.deferAi) throw new GatewayError('modelvia_invoice_not_finalized', 409);
    const invoices: AiInvoiceInput[] = [];
    let usedBy: string | undefined;
    for (const entry of due) {
      const found = await options.modelvia.customerInvoice(customerId, entry.id);
      requireThat(found.period === entry.period && found.totalCents === entry.totalCents && found.gstCents === entry.gstCents, 'modelvia_invoice_changed', 409);
      requireThat(found.seller.abn === terms.seller.abn, 'modelvia_invoice_seller_mismatch', 409);
      requireThat(!found.paid && found.paymentState === 'not_started' && !found.checkoutAvailable && !found.directPaymentAvailable, 'modelvia_invoice_payment_started', 409);
      invoices.push({ id: found.id, period: found.period, totalCents: found.totalCents, gstCents: found.gstCents, lines: found.lines.map(officeLine) });
      usedBy ??= found.usedBy?.displayName;
    }
    if (!terms.aiUsage) return finalize(billing, companyId, period, termsVersion, undefined, 'care_only');
    const closed = finalize(billing, companyId, period, termsVersion, { invoices, ...(outstanding.length ? { deferredPeriods: outstanding } : {}),
      modelviaCustomerId: customerId, ...(usedBy ? { usedBy } : {}), chargeDetail: officeChargeDetail(ledger, companyId) },
      outstanding.length ? 'deferred' : invoices.length ? 'consolidated' : 'no_ai_usage');
    if (outstanding.length && closed.ai === 'deferred') {
      try { ledger.db.transaction(() => ledger.db.append(companyId, 'ai_usage_deferred', null, ledger.now(), { periods: outstanding, invoiceId: closed.invoice.id })); } catch { /* the invoice records it too */ }
    }
    return closed;
  });
}
/** A Modelvia invoice line as the office's invoice shows it: Modelvia's own
 * description with the request count written for people ("1,234 requests"), who
 * used it, and Modelvia's split (kept only for an itemized office at close). */
function officeLine(line: ModelviaInvoiceLine): AiLineInput {
  const count = line.requestCount;
  const description = count !== undefined && count >= 1000
    ? line.description.replace(new RegExp(`— ${count} (requests?)`), `— ${count.toLocaleString('en-AU')} $1`) : line.description;
  const usedBy = line.usedBy ? `${line.usedBy.displayName}${line.usedBy.projectId ? ` · project ${line.usedBy.projectId}` : ''}` : undefined;
  return { description, amountCents: line.amountCents, gstCents: line.gstCents,
    ...(line.model !== undefined ? { model: line.model } : {}), ...(count !== undefined ? { requestCount: count } : {}),
    ...(usedBy ? { usedBy } : {}), ...(line.components ? { components: line.components } : {}) };
}
/** Close, reporting `already_closed` when another process closed the month first. */
function finalize(billing: BillingService, companyId: string, period: string, termsVersion: string, ai: Parameters<BillingService['finalizeCommercialInvoice']>[3], outcome: MonthClose['ai']): MonthClose {
  const report: { existing?: boolean } = {};
  const invoice = billing.finalizeCommercialInvoice(companyId, period, termsVersion, ai, report);
  return { invoice, ai: report.existing ? 'already_closed' : outcome };
}
/** Months an earlier invoice deferred, read from the immutable invoices themselves. */
const deferredPeriods = (ledger: UsageLedger, companyId: string): string[] => [...new Set(ledger.db.all<{ body: string }>('SELECT body FROM invoices WHERE tenant=?', companyId)
  .flatMap(row => (JSON.parse(row.body) as Invoice).aiUsage?.deferredPeriods ?? []))].sort();

// ---------------------------------------------------------------------------
// Owner margin view
// ---------------------------------------------------------------------------

export type OfficeBillingKind = 'resale' | 'client_funded' | 'unconfigured';
export interface MarginRow {
  companyId: string; customerName: string; billing: OfficeBillingKind;
  /** The office's accepted markup (basis points), what it is billed at; null before acceptance. */
  markupBasisPoints: number | null;
  /** An operator's proposal the office has not accepted yet. */
  proposedMarkupBasisPoints: number | null;
  /** Whether Modelvia was last seen pricing at the accepted markup. */
  markupPolicy: 'synced' | 'sync_failed' | 'not_synced' | null;
  /** What the office pays for the month's AI: Modelvia price incl. RealBud's markup. */
  aiRetailCents: string | null;
  /** Modelvia's wholesale incl. its platform fee. */
  modelviaCostCents: string | null;
  /** aiRetail − modelviaCost. Negative for a client-funded office. */
  markupCents: string | null;
  /** The care fee net of care credits: the closed invoice's non-AI lines, else the month's terms. */
  careCents: string;
  totalCents: string | null;
  /** markup + care. */
  marginCents: string | null;
  invoiceId: string | null; invoiceState: 'not_closed' | 'closed' | 'paid';
  /** AI usage consolidated onto this month's RealBud invoice (reconciliation). */
  aiBilledCents: string; modelviaInvoices: string[];
  modelviaSource: 'margin_report' | 'analytics' | 'unavailable';
  note: string | null;
}
export interface MarginReport {
  period: string; generatedAt: string; currency: 'AUD'; gstInclusive: true; rows: MarginRow[];
  totals: { aiRetailCents: string; modelviaCostCents: string; markupCents: string; careCents: string; totalCents: string; marginCents: string };
}

/** Per-office margin for one month, GST inclusive, in cents. Money from Modelvia
 * is its margin report when it exists, else its usage analytics (admission-month
 * estimates); the billed AI on the RealBud invoice is shown beside it. */
export async function officeMargins(options: OfficeBilling, period: string): Promise<MarginReport> {
  requireThat(MONTH.test(period), 'invalid_billing_period');
  const { billing } = options, ledger = billing.ledger;
  ensureAiConsolidationTable(ledger);
  const internal = billing.commercialTerms?.internalCompanyId;
  const tenants = ledger.db.all<{ body: string }>('SELECT body FROM tenants ORDER BY id')
    .map(row => JSON.parse(row.body) as { companyId: string; customerName: string; billingMode?: string })
    .filter(t => t.companyId !== internal && t.billingMode !== 'internal_cost');
  const customers = new Map(tenants.map(t => [t.companyId, officeCustomer(ledger, t.companyId)]));
  let margins = new Map<string, ModelviaCustomerMargin>(), unavailable: string | null = options.modelvia ? null : 'Modelvia client key is not configured.';
  const bound = [...customers.values()].filter((c): c is string => !!c);
  if (options.modelvia && bound.length) {
    try { margins = await options.modelvia.customerMargins(bound, period); }
    catch (error) { unavailable = `Modelvia could not be read (${error instanceof GatewayError ? error.code : 'modelvia_unreadable'}).`; }
  }
  const rows = tenants.map((tenant): MarginRow => {
    const invoiceRow = ledger.db.get<{ id: string; body: string }>('SELECT id,body FROM invoices WHERE tenant=? AND period=?', tenant.companyId, period);
    const invoice = invoiceRow ? JSON.parse(invoiceRow.body) as Invoice : undefined;
    const latest = ledger.db.get<{ body: string }>('SELECT body FROM commercial_terms WHERE tenant=? AND period=? ORDER BY seq DESC LIMIT 1', tenant.companyId, period);
    const terms = latest ? JSON.parse(latest.body) as CommercialTerms : undefined;
    const resale = !!(invoice?.aiUsage || terms?.aiUsage || resaleSinceFor(ledger, tenant.companyId, period));
    const kind: OfficeBillingKind = options.clientFundedCompanies.has(tenant.companyId) ? 'client_funded' : resale ? 'resale' : 'unconfigured';
    const aiLines = invoice?.lines.filter(l => l.modelviaInvoice) ?? [];
    const care = invoice ? invoice.lines.filter(l => !l.modelviaInvoice).reduce((s, l) => s + BigInt(l.amountCents), 0n) : BigInt(terms?.careCents ?? '0');
    const customerId = customers.get(tenant.companyId), margin = customerId ? margins.get(customerId) : undefined;
    const retail = margin && margin.retailNanoAud !== null ? cents(BigInt(margin.retailNanoAud)) : null;
    const cost = margin ? cents(BigInt(margin.costNanoAud)) : null;
    const markup = retail !== null && cost !== null ? retail - cost : null;
    const paid = invoiceRow ? !!ledger.db.get('SELECT id FROM payments WHERE invoice=?', invoiceRow.id) : false;
    const notes = [
      !customerId ? 'No Modelvia customer is bound to this office.' : !margin ? unavailable : null,
      margin && !margin.complete ? 'Modelvia figures are provisional: requests are pending or unpriced.' : null,
      invoice?.aiUsage?.deferredPeriods?.length ? `AI for ${invoice.aiUsage.deferredPeriods.join(', ')} deferred to a later invoice.` : null,
    ].filter((n): n is string => !!n);
    const markup_ = officeMarkup(ledger, tenant.companyId, options.defaultMarkupBasisPoints);
    return {
      companyId: tenant.companyId, customerName: tenant.customerName, billing: kind,
      markupBasisPoints: markup_.acceptedBasisPoints, proposedMarkupBasisPoints: markup_.proposedBasisPoints, markupPolicy: markup_.policy,
      aiRetailCents: retail?.toString() ?? null, modelviaCostCents: cost?.toString() ?? null, markupCents: markup?.toString() ?? null,
      careCents: care.toString(), totalCents: retail !== null ? (retail + care).toString() : null, marginCents: markup !== null ? (markup + care).toString() : null,
      invoiceId: invoice?.id ?? null, invoiceState: !invoice ? 'not_closed' : paid ? 'paid' : 'closed',
      aiBilledCents: aiLines.reduce((s, l) => s + BigInt(l.amountCents), 0n).toString(), modelviaInvoices: aiLines.map(l => l.modelviaInvoice!),
      modelviaSource: margin?.source ?? 'unavailable', note: notes.length ? notes.join(' ') : null,
    };
  });
  const sum = (field: 'aiRetailCents' | 'modelviaCostCents' | 'markupCents' | 'careCents' | 'totalCents' | 'marginCents') =>
    rows.reduce((s, row) => s + BigInt(row[field] ?? '0'), 0n).toString();
  return { period, generatedAt: new Date(ledger.now()).toISOString(), currency: 'AUD', gstInclusive: true, rows,
    totals: { aiRetailCents: sum('aiRetailCents'), modelviaCostCents: sum('modelviaCostCents'), markupCents: sum('markupCents'), careCents: sum('careCents'), totalCents: sum('totalCents'), marginCents: sum('marginCents') } };
}
const resaleSinceFor = (ledger: UsageLedger, companyId: string, period: string) => { const since = resaleSince(ledger, companyId); return !!since && since <= period; };

/** A month string for "the month before `now`" on the Brisbane billing clock. */
export function previousPeriod(now: number): string {
  const [year, month] = periodAt(now).split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/** CSV for a spreadsheet: dollars with two decimals; text cells that a
 * spreadsheet would read as a formula are prefixed with an apostrophe. */
export function marginCsv(report: MarginReport): string {
  const dollars = (value: string | null) => {
    if (value === null) return '';
    const n = BigInt(value), abs = n < 0n ? -n : n;
    return `${n < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  };
  const text = (value: string | null) => {
    const safe = value === null ? '' : /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const header = ['period', 'company_id', 'office', 'billing', 'ai_retail_aud', 'modelvia_cost_aud', 'realbud_markup_aud', 'care_fee_aud', 'total_aud', 'margin_aud',
    'realbud_invoice', 'invoice_state', 'ai_billed_aud', 'modelvia_invoices', 'modelvia_source', 'note', 'markup_percent', 'proposed_markup_percent', 'markup_policy'];
  const percent = (bps: number | null) => bps === null ? '' : `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}`;
  const lines = report.rows.map(r => [report.period, text(r.companyId), text(r.customerName), r.billing, dollars(r.aiRetailCents), dollars(r.modelviaCostCents), dollars(r.markupCents),
    dollars(r.careCents), dollars(r.totalCents), dollars(r.marginCents), text(r.invoiceId), r.invoiceState, dollars(r.aiBilledCents), text(r.modelviaInvoices.join(' ')), r.modelviaSource, text(r.note),
    percent(r.markupBasisPoints), percent(r.proposedMarkupBasisPoints), r.markupPolicy ?? ''].join(','));
  const t = report.totals;
  lines.push([report.period, '', 'Total', '', dollars(t.aiRetailCents), dollars(t.modelviaCostCents), dollars(t.markupCents), dollars(t.careCents), dollars(t.totalCents), dollars(t.marginCents), '', '', '', '', '', '', '', '', ''].join(','));
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}
