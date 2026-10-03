/**
 * Hermios subscriptions through Square (mirrors `square-payment.ts`): card on
 * file, subscription create, plan swap (seats and cadence), cancel, reads, and
 * the signed webhook for subscription and invoice events. `office-subscriptions.ts`
 * owns the office record and decides; this file only talks to Square, or, in
 * local mode, to a deterministic fake that is never presented as Square.
 *
 * Card data never touches RealBud: the console tokenises the card in Square's
 * hosted Web Payments SDK field, and the gateway only exchanges that single-use
 * token for a card on file under the office's mapped Square customer.
 *
 * Square references (API version below):
 * - Cards (card on file):            https://developer.squareup.com/reference/square/cards-api/create-card
 * - Web Payments SDK (hosted field): https://developer.squareup.com/docs/web-payments/overview
 * - Orders (DRAFT order template):   https://developer.squareup.com/reference/square/orders-api/create-order
 * - Relative pricing / templates:    https://developer.squareup.com/docs/subscriptions-api/plans-and-variations
 * - Create subscription:             https://developer.squareup.com/reference/square/subscriptions-api/create-subscription
 * - Swap plan (subscription action): https://developer.squareup.com/reference/square/subscriptions-api/swap-plan
 *                                    https://developer.squareup.com/docs/subscriptions-api/swap-plan-variations
 * - Cancel subscription:             https://developer.squareup.com/reference/square/subscriptions-api/cancel-subscription
 * - Retrieve subscription:           https://developer.squareup.com/reference/square/subscriptions-api/retrieve-subscription
 * - Get invoice:                     https://developer.squareup.com/reference/square/invoices-api/get-invoice
 * - Webhook signature:               https://developer.squareup.com/docs/webhooks/step3validate
 * - Catalog lookup by name:          `hermios-square-catalog.ts`
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { abortable } from './abort.ts';
import { canonical, id, object, requireThat } from './contracts.ts';
import type { UsageLedger } from './ledger.ts';
import { squareBilledOptions, type HermiosCatalog } from './hermios-plans.ts';
import { ensureHermiosSquareCatalog, SquareCatalogWriter } from './hermios-square-catalog.ts';
import type { SquareEnvironment, SquareMapping } from './square-mapping.ts';

const HOSTS: Record<SquareEnvironment, string> = { production: 'https://connect.squareup.com', sandbox: 'https://connect.squareupsandbox.com' };
/** Same API version as `square-payment.ts`. */
const VERSION = '2026-08-19';
/** Square retries delivery; matches `square-payment.ts`. */
export const SUBSCRIPTION_EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Square dates are calendar dates at the seller location; RealBud bills in Brisbane time. */
export const HERMIOS_TIMEZONE = 'Australia/Brisbane';
export const WEBHOOK_PATH = '/v1/webhooks/square/subscriptions';

export type SquareSubscriptionStatus = 'PENDING' | 'ACTIVE' | 'CANCELED' | 'DEACTIVATED' | 'PAUSED';
export interface SubscriptionSnapshot {
  id: string; status: SquareSubscriptionStatus; customerId: string; locationId: string; planVariationId: string;
  startDate: string; chargedThroughDate: string | null; canceledDate: string | null;
}
export interface InvoiceSnapshot { id: string; subscriptionId: string; status: string; locationId: string }
export interface SubscriptionEvent { eventId: string; type: string; dataType: string; objectId: string; createdAt: number }
/** Square ids resolved from the catalog by name, never configured by hand. */
export interface HermiosSquareCatalogIds { planVariationIds: Record<string, string>; itemVariationIds: Record<string, string> }

/** What `office-subscriptions.ts` needs from Square. Every write carries a caller idempotency key. */
export interface SubscriptionProvider {
  readonly id: 'square-sandbox' | 'square-live' | 'local';
  readonly locationId: string;
  catalogIds(): Promise<HermiosSquareCatalogIds>;
  customerFor(companyId: string): string;
  saveCard(input: { customerId: string; sourceId: string; verificationToken?: string; idempotencyKey: string }): Promise<string>;
  createOrderTemplate(body: Record<string, unknown>): Promise<string>;
  createSubscription(input: { customerId: string; cardId: string; planVariationId: string; orderTemplateId: string; paidOrdinal: number; startDate: string; idempotencyKey: string }): Promise<SubscriptionSnapshot>;
  swapPlan(input: { subscriptionId: string; planVariationId: string; orderTemplateId: string; paidOrdinal: number }): Promise<SubscriptionSnapshot>;
  cancel(subscriptionId: string): Promise<SubscriptionSnapshot>;
  retrieve(subscriptionId: string): Promise<SubscriptionSnapshot>;
  retrieveInvoice(invoiceId: string): Promise<InvoiceSnapshot>;
  /** Signed webhook only; the local fake has none. */
  verifyEvent?(raw: Uint8Array, signature: string, now: number): SubscriptionEvent;
}

/** `YYYY-MM-DD` in Brisbane for an instant. */
export const squareDate = (time: number) => new Date(time + 36_000_000).toISOString().slice(0, 10);
/** Start of a Brisbane calendar date. */
export const fromSquareDate = (date: string) => { requireThat(/^\d{4}-\d{2}-\d{2}$/.test(date), 'square_date_invalid', 502); const time = Date.parse(`${date}T00:00:00+10:00`); requireThat(Number.isFinite(time), 'square_date_invalid', 502); return time; };
const STATUSES: readonly string[] = ['PENDING', 'ACTIVE', 'CANCELED', 'DEACTIVATED', 'PAUSED'];

export function parseSubscription(value: unknown): SubscriptionSnapshot {
  object(value);
  [value.id, value.customer_id, value.location_id, value.plan_variation_id].forEach(id);
  requireThat(typeof value.status === 'string' && STATUSES.includes(value.status), 'square_subscription_status_unknown', 502);
  const date = (field: unknown) => field === undefined || field === null ? null : (fromSquareDate(String(field)), String(field));
  return { id: value.id as string, status: value.status as SquareSubscriptionStatus, customerId: value.customer_id as string, locationId: value.location_id as string,
    planVariationId: value.plan_variation_id as string, startDate: date(value.start_date) ?? '', chargedThroughDate: date(value.charged_through_date), canceledDate: date(value.canceled_date) };
}

/** HMAC-SHA256 over the notification URL then the exact raw body (Square's scheme). */
export function verifySquareSignature(raw: Uint8Array, signature: string, signatureKey: string, notificationUrl: string): void {
  requireThat(raw.byteLength <= 256_000 && /^[A-Za-z0-9+/]{43}=$/.test(signature), 'invalid_square_signature', 401);
  const expected = createHmac('sha256', signatureKey).update(notificationUrl).update(raw).digest();
  const supplied = Buffer.from(signature, 'base64');
  requireThat(supplied.byteLength === expected.byteLength && timingSafeEqual(expected, supplied), 'invalid_square_signature', 401);
}
export function parseSubscriptionEvent(raw: Uint8Array, merchantId: string, now: number): SubscriptionEvent {
  let parsed: unknown; try { parsed = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { requireThat(false, 'invalid_square_event'); }
  object(parsed); [parsed.event_id, parsed.merchant_id].forEach(id);
  requireThat(parsed.merchant_id === merchantId, 'square_merchant_mismatch', 403);
  requireThat(typeof parsed.created_at === 'string', 'invalid_square_event');
  const created = Date.parse(parsed.created_at);
  requireThat(Number.isSafeInteger(created) && created <= now + 300_000 && now - created <= SUBSCRIPTION_EVENT_MAX_AGE_MS, 'stale_square_event', 401);
  object(parsed.data); id(parsed.data.id);
  requireThat(typeof parsed.type === 'string' && /^[a-z_.]{1,80}$/.test(parsed.type) && typeof parsed.data.type === 'string', 'invalid_square_event');
  return { eventId: parsed.event_id as string, type: parsed.type, dataType: parsed.data.type, objectId: parsed.data.id as string, createdAt: created };
}

export class SquareSubscriptionAdapter implements SubscriptionProvider {
  readonly id: 'square-sandbox' | 'square-live';
  readonly locationId: string;
  private readonly host: string;
  private readonly options: { ledger: UsageLedger; environment: SquareEnvironment; fetchImpl: typeof fetch; accessToken: string; signatureKey: string; notificationUrl: string; merchantId: string; locationId: string; internalCompanyId: string; catalog: HermiosCatalog };
  private ids?: Promise<HermiosSquareCatalogIds>;
  constructor(options: { ledger: UsageLedger; environment: SquareEnvironment; fetchImpl?: typeof fetch; accessToken: string; signatureKey: string; notificationUrl: string; merchantId: string; locationId: string; internalCompanyId: string; catalog: HermiosCatalog }) {
    requireThat(options.environment === 'sandbox' || options.environment === 'production', 'square_environment_invalid');
    [options.merchantId, options.locationId, options.internalCompanyId].forEach(id);
    requireThat(options.accessToken.length > 0 && options.signatureKey.length > 0, 'square_credentials_required', 503);
    const notify = new URL(options.notificationUrl);
    requireThat(notify.protocol === 'https:' && !notify.username && !notify.password && !notify.search && !notify.hash && notify.pathname === WEBHOOK_PATH, 'hermios_notification_url_invalid', 503);
    this.options = { ...options, fetchImpl: options.fetchImpl ?? fetch };
    this.host = HOSTS[options.environment]; this.id = options.environment === 'sandbox' ? 'square-sandbox' : 'square-live'; this.locationId = options.locationId;
  }
  private async request(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(10_000);
    const response = await abortable(this.options.fetchImpl(`${this.host}${path}`, { method, redirect: 'error', signal,
      headers: { Authorization: `Bearer ${this.options.accessToken}`, 'Square-Version': VERSION, 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: canonical(payload) }) }), signal);
    // Status only: a Square error body can echo request content.
    if (!response.ok) { void response.body?.cancel().catch(() => {}); requireThat(false, 'square_request_failed', 502); }
    const text = await abortable(response.text(), signal);
    requireThat(text.length <= 1_000_000, 'square_response_too_large', 502);
    let parsed: unknown; try { parsed = JSON.parse(text); } catch { requireThat(false, 'invalid_square_response', 502); }
    object(parsed); requireThat(!parsed.errors, 'square_api_error', 502);
    return parsed;
  }
  /** Plan variation and item ids, read from Square by the catalog's exact names; cached once complete. */
  catalogIds(): Promise<HermiosSquareCatalogIds> {
    this.ids ??= (async () => {
      const { environment, accessToken, merchantId, locationId, fetchImpl, catalog } = this.options;
      const results = await ensureHermiosSquareCatalog(new SquareCatalogWriter({ environment, accessToken, merchantId, locationId }, fetchImpl), catalog, false);
      requireThat(results.every(result => result.state === 'found' && result.id), 'hermios_square_catalog_incomplete', 503);
      const planVariationIds: Record<string, string> = {}, itemVariationIds: Record<string, string> = {};
      for (const option of squareBilledOptions(catalog)) planVariationIds[option.key] = results.find(result => result.key === `variation_${option.key}`)!.id!;
      for (const result of results.filter(entry => entry.type === 'ITEM')) { id(result.itemVariationId); itemVariationIds[result.name] = result.itemVariationId; }
      return { planVariationIds, itemVariationIds };
    })().catch(error => { this.ids = undefined; throw error; });
    return this.ids;
  }
  /** The office's reviewed Square customer (`square-mapping.ts`), on this merchant and location. */
  customerFor(companyId: string): string {
    id(companyId); requireThat(companyId !== this.options.internalCompanyId, 'internal_usage_not_collectible', 403);
    const row = this.options.ledger.db.get<{ body: string }>('SELECT body FROM square_mappings WHERE tenant=?', companyId);
    requireThat(row, 'square_mapping_required', 409);
    const mapping = JSON.parse(row.body) as SquareMapping;
    requireThat(mapping.companyId === companyId && mapping.merchantId === this.options.merchantId && mapping.locationId === this.options.locationId && mapping.customerId, 'square_mapping_mismatch', 403);
    return mapping.customerId;
  }
  async saveCard(input: { customerId: string; sourceId: string; verificationToken?: string; idempotencyKey: string }): Promise<string> {
    const response = await this.request('POST', '/v2/cards', { idempotency_key: input.idempotencyKey, source_id: input.sourceId,
      ...(input.verificationToken ? { verification_token: input.verificationToken } : {}), card: { customer_id: input.customerId } });
    object(response.card); id(response.card.id);
    requireThat(response.card.customer_id === input.customerId && response.card.enabled !== false, 'square_card_mismatch', 409);
    return response.card.id as string;
  }
  async createOrderTemplate(body: Record<string, unknown>): Promise<string> {
    const response = await this.request('POST', '/v2/orders', body); object(response.order); id(response.order.id);
    requireThat(response.order.state === 'DRAFT' && response.order.location_id === this.locationId, 'square_order_mismatch', 409);
    return response.order.id as string;
  }
  async createSubscription(input: { customerId: string; cardId: string; planVariationId: string; orderTemplateId: string; paidOrdinal: number; startDate: string; idempotencyKey: string }): Promise<SubscriptionSnapshot> {
    const response = await this.request('POST', '/v2/subscriptions', { idempotency_key: input.idempotencyKey, location_id: this.locationId,
      plan_variation_id: input.planVariationId, customer_id: input.customerId, card_id: input.cardId, start_date: input.startDate, timezone: HERMIOS_TIMEZONE,
      phases: [{ ordinal: input.paidOrdinal, order_template_id: input.orderTemplateId }] });
    const snapshot = parseSubscription(response.subscription);
    requireThat(snapshot.customerId === input.customerId && snapshot.locationId === this.locationId && snapshot.planVariationId === input.planVariationId, 'square_subscription_mismatch', 409);
    return snapshot;
  }
  /** A swap applies at the end of the current billing cycle (Square). */
  async swapPlan(input: { subscriptionId: string; planVariationId: string; orderTemplateId: string; paidOrdinal: number }): Promise<SubscriptionSnapshot> {
    id(input.subscriptionId);
    const response = await this.request('POST', `/v2/subscriptions/${encodeURIComponent(input.subscriptionId)}/swap-plan`, { new_plan_variation_id: input.planVariationId,
      phases: [{ ordinal: input.paidOrdinal, order_template_id: input.orderTemplateId }] });
    return this.own(parseSubscription(response.subscription), input.subscriptionId);
  }
  /** Square sets `canceled_date` to the end of the current billing period. */
  async cancel(subscriptionId: string): Promise<SubscriptionSnapshot> {
    id(subscriptionId);
    const response = await this.request('POST', `/v2/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {});
    return this.own(parseSubscription(response.subscription), subscriptionId);
  }
  async retrieve(subscriptionId: string): Promise<SubscriptionSnapshot> {
    id(subscriptionId);
    const response = await this.request('GET', `/v2/subscriptions/${encodeURIComponent(subscriptionId)}`);
    return this.own(parseSubscription(response.subscription), subscriptionId);
  }
  async retrieveInvoice(invoiceId: string): Promise<InvoiceSnapshot> {
    id(invoiceId);
    const response = await this.request('GET', `/v2/invoices/${encodeURIComponent(invoiceId)}`); object(response.invoice);
    const invoice = response.invoice; id(invoice.id); requireThat(invoice.id === invoiceId && invoice.location_id === this.locationId, 'square_invoice_mismatch', 409);
    requireThat(typeof invoice.status === 'string', 'invalid_square_response', 502);
    return { id: invoiceId, subscriptionId: typeof invoice.subscription_id === 'string' ? invoice.subscription_id : '', status: invoice.status, locationId: this.locationId };
  }
  verifyEvent(raw: Uint8Array, signature: string, now: number): SubscriptionEvent {
    verifySquareSignature(raw, signature, this.options.signatureKey, this.options.notificationUrl);
    return parseSubscriptionEvent(raw, this.options.merchantId, now);
  }
  private own(snapshot: SubscriptionSnapshot, subscriptionId: string): SubscriptionSnapshot {
    requireThat(snapshot.id === subscriptionId && snapshot.locationId === this.locationId, 'square_subscription_mismatch', 409);
    return snapshot;
  }
}

type LocalSubscription = SubscriptionSnapshot & { cadence: 'monthly' | 'yearly'; swap?: { planVariationId: string; from: string } };
/**
 * Local mode: a deterministic in-process fake with Square's shapes. Ids are
 * hashes of the inputs, dates follow the injected clock, and it never reaches a
 * network. Its records say `provider: local` and are never evidence of Square.
 */
export class LocalSubscriptionFake implements SubscriptionProvider {
  readonly id = 'local' as const;
  readonly locationId = 'local-location';
  private readonly catalog: HermiosCatalog;
  private readonly now: () => number;
  private readonly subscriptions = new Map<string, LocalSubscription>();
  /** Every call, for tests that assert what was (and was not) asked of the provider. */
  readonly calls: string[] = [];
  constructor(options: { catalog: HermiosCatalog; now: () => number }) { this.catalog = options.catalog; this.now = options.now; }
  private static hash(...parts: unknown[]) { return createHash('sha256').update(canonical(parts)).digest('hex').slice(0, 24); }
  async catalogIds(): Promise<HermiosSquareCatalogIds> {
    const planVariationIds: Record<string, string> = {}, itemVariationIds: Record<string, string> = {};
    for (const option of squareBilledOptions(this.catalog)) {
      planVariationIds[option.key] = `local-variation-${option.key}`;
      for (const name of [option.square.baseItem, option.square.extraItem]) if (name) itemVariationIds[name] = `local-item-${LocalSubscriptionFake.hash(name)}`;
    }
    return { planVariationIds, itemVariationIds };
  }
  customerFor(companyId: string): string { id(companyId); return `local-customer-${LocalSubscriptionFake.hash(companyId)}`; }
  async saveCard(input: { customerId: string; sourceId: string; idempotencyKey: string }): Promise<string> {
    this.calls.push('saveCard');
    requireThat(/^[A-Za-z0-9:_-]{8,512}$/.test(input.sourceId), 'card_source_invalid');
    return `local-card-${LocalSubscriptionFake.hash(input.customerId, input.idempotencyKey)}`;
  }
  async createOrderTemplate(body: Record<string, unknown>): Promise<string> { this.calls.push('createOrderTemplate'); return `local-order-${LocalSubscriptionFake.hash(body)}`; }
  private cadenceOf(planVariationId: string) { return planVariationId.endsWith('yearly') ? 'yearly' as const : 'monthly' as const; }
  private chargedThrough(subscription: LocalSubscription): string {
    if (subscription.swap && fromSquareDate(subscription.swap.from) <= this.now()) {
      subscription.planVariationId = subscription.swap.planVariationId; subscription.cadence = this.cadenceOf(subscription.planVariationId); delete subscription.swap;
    }
    // End of the trial, then whole periods: the date the next charge covers from.
    const trialEnd = fromSquareDate(subscription.startDate) + this.catalog.trialDays * 86_400_000;
    if (this.now() < trialEnd) return squareDate(trialEnd);
    const months = subscription.cadence === 'yearly' ? 12 : 1;
    let end = new Date(trialEnd + 36_000_000);
    while (end.getTime() - 36_000_000 <= this.now()) end = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + months, end.getUTCDate()));
    return end.toISOString().slice(0, 10);
  }
  private view(subscriptionId: string): SubscriptionSnapshot {
    const stored = this.subscriptions.get(subscriptionId); requireThat(stored, 'square_subscription_unknown', 404);
    const canceled = stored.canceledDate !== null && fromSquareDate(stored.canceledDate) <= this.now();
    const chargedThroughDate = this.chargedThrough(stored);
    const { cadence: _cadence, swap: _swap, ...snapshot } = stored;
    return { ...snapshot, status: canceled ? 'CANCELED' : stored.status, chargedThroughDate };
  }
  async createSubscription(input: { customerId: string; cardId: string; planVariationId: string; orderTemplateId: string; startDate: string; idempotencyKey: string }): Promise<SubscriptionSnapshot> {
    this.calls.push('createSubscription');
    requireThat(input.cardId.startsWith('local-card-'), 'square_card_required', 409);
    const subscriptionId = `local-subscription-${LocalSubscriptionFake.hash(input.idempotencyKey)}`;
    if (!this.subscriptions.has(subscriptionId)) this.subscriptions.set(subscriptionId, { id: subscriptionId, status: 'ACTIVE', customerId: input.customerId, locationId: this.locationId,
      planVariationId: input.planVariationId, startDate: input.startDate, chargedThroughDate: null, canceledDate: null, cadence: this.cadenceOf(input.planVariationId) });
    return this.view(subscriptionId);
  }
  async swapPlan(input: { subscriptionId: string; planVariationId: string }): Promise<SubscriptionSnapshot> {
    this.calls.push('swapPlan');
    const stored = this.subscriptions.get(input.subscriptionId); requireThat(stored, 'square_subscription_unknown', 404);
    // As Square: the new variation applies from the next billing date.
    if (input.planVariationId !== stored.planVariationId) stored.swap = { planVariationId: input.planVariationId, from: this.chargedThrough(stored) };
    return this.view(input.subscriptionId);
  }
  async cancel(subscriptionId: string): Promise<SubscriptionSnapshot> {
    this.calls.push('cancel');
    const stored = this.subscriptions.get(subscriptionId); requireThat(stored, 'square_subscription_unknown', 404);
    if (stored.canceledDate === null) {
      const trialEnd = fromSquareDate(stored.startDate) + this.catalog.trialDays * 86_400_000;
      // In the trial the billing period is one day (the DAILY trial phase): it ends before any charge.
      stored.canceledDate = this.now() < trialEnd ? squareDate(this.now() + 86_400_000) : this.chargedThrough(stored);
    }
    return this.view(subscriptionId);
  }
  async retrieve(subscriptionId: string): Promise<SubscriptionSnapshot> { return this.view(subscriptionId); }
  async retrieveInvoice(): Promise<InvoiceSnapshot> { requireThat(false, 'local_fake_has_no_invoices', 404); }
}
