/**
 * One office's Hermios CRM subscription (spec `docs/HERMIOS-PLANS-AND-CHECKOUT-2026-10-01.md`).
 *
 * Authority: the office is the portal bearer's company, never a body field, and
 * only the billing owner starts, changes or cancels. Prices, minimums and the
 * trial come from the operator catalog (`hermios-plans.ts`); a body names an
 * option key and a number of people and repeats the digest of the terms the
 * owner was shown (the office terms acceptance pattern: read terms + digest,
 * accept exactly that digest). Every accepted digest is kept, append-only.
 *
 * Lifecycle: `pending_payment` (record and acceptance written; card and Square
 * subscription not yet confirmed) -> `trialing` (card on file, Square
 * subscription created with the free trial phase) -> `active` -> `past_due`
 * (a failed charge) -> `canceled`. Start is idempotent per office and product
 * and resumable: each Square step is saved as it completes and retried with the
 * same idempotency key. A people change is a quantity change on the same
 * option: seats apply now, Square bills the new quantity from the next billing
 * date. A cadence switch (monthly <-> yearly) applies at period end. Cancel
 * applies at period end; in the trial the period is one day, so no charge.
 *
 * Past due is a flag for the operator: nothing here deletes, pauses or
 * uninstalls a subscription, a workspace or CRM data. Rows are never deleted
 * (a trigger refuses it); webhooks are verified, stored once by event id and
 * re-read from Square before any state changes.
 */
import { createHash } from 'node:crypto';
import { canonical, GatewayError, id, object, requireThat, type PortalPrincipal } from './contracts.ts';
import { digest, type UsageLedger } from './ledger.ts';
import { hermiosOption, hermiosOrderTemplate, hermiosYearlyComparison, loadHermiosCatalog, quoteHermiosPlan, type HermiosCadence, type HermiosCatalog, type HermiosPlanOption } from './hermios-plans.ts';
import { squareCatalogTarget } from './hermios-square-catalog.ts';
import { fromSquareDate, LocalSubscriptionFake, squareDate, SquareSubscriptionAdapter, type SquareSubscriptionStatus, type SubscriptionProvider, type SubscriptionSnapshot } from './square-subscriptions.ts';
import type { HttpTransport } from './composio-org.ts';

export const HERMIOS_PRODUCT = 'hermios-crm';
export const HERMIOS_CAPABILITY = 'hermios.crm';
export type HermiosState = 'pending_payment' | 'trialing' | 'active' | 'past_due' | 'canceled';
const DAY = 86_400_000;

export interface OfficeHermiosSubscription {
  id: string; companyId: string; product: typeof HERMIOS_PRODUCT; provider: SubscriptionProvider['id'];
  state: HermiosState; optionKey: string; people: number; cadence: HermiosCadence; catalogVersion: string;
  termsReference: string; termsDigest: string;
  startedBy: string; startedAt: number; trialEndsAt: number | null; currentPeriodEnd: number | null;
  square: { customerId: string | null; cardId: string | null; orderTemplateId: string | null; subscriptionId: string | null; planVariationId: string | null; status: SquareSubscriptionStatus | null };
  /** A cadence switch Square applies at `effectiveAt`. */
  pendingChange: { optionKey: string; people: number; cadence: HermiosCadence; termsDigest: string; planVariationId: string; effectiveAt: number | null } | null;
  cancelAt: number | null; chargeOnCancel: 'none' | 'through_period_end' | null; canceledAt: number | null;
  paymentFailedAt: number | null;
  /** Set by the later link-membership call; null until then. */
  hermiosWorkspaceId: string | null;
  updatedAt: number;
}
export interface HermiosSummary {
  optionKey: string; state: HermiosState; people: number; cadence: HermiosCadence;
  trialEndsAt: number | null; currentPeriodEnd: number | null;
  /** `hermios.crm` while the office holds the capability (trialing, active, past due); null otherwise. */
  capability: typeof HERMIOS_CAPABILITY | null;
  hermiosLinked: boolean;
}
/** Types only: the RealBud app reports the verified Hermios membership after OAuth (a later packet). */
export interface HermiosMembershipLinkRequest { hermiosWorkspaceId: string; hermiosMemberId: string; verifiedAt: number }
export interface HermiosMembershipLink extends HermiosMembershipLinkRequest { companyId: string; subscriptionId: string; reportedBy: string; source: 'realbud_app_oauth' }

export interface HermiosTerms {
  product: typeof HERMIOS_PRODUCT; capability: typeof HERMIOS_CAPABILITY; companyId: string; kind: 'start' | 'change';
  catalogVersion: string; termsReference: string; currency: 'AUD'; gstInclusive: true;
  option: Pick<HermiosPlanOption, 'key' | 'name' | 'cadence' | 'includedPeople' | 'baseCents' | 'extraPersonCents'>;
  people: number; totalCents: string; gstCents: string;
  trial: { days: number; cardRequired: boolean } | null;
  /** How a change of cadence and a cancellation take effect. */
  changes: 'people_now_billed_next_period__cadence_at_period_end'; cancellation: 'period_end__trial_no_charge';
}

/**
 * The office state from Square's subscription status and the payment record.
 * Canceled is terminal; a pause made in Square's dashboard keeps the previous
 * state (RealBud never pauses); a failed charge is past due until paid.
 */
export function hermiosStateFrom(input: { previous: HermiosState; squareStatus: SquareSubscriptionStatus; now: number; trialEndsAt: number | null; paymentFailed: boolean }): HermiosState {
  if (input.previous === 'canceled' || input.squareStatus === 'CANCELED' || input.squareStatus === 'DEACTIVATED') return 'canceled';
  if (input.squareStatus === 'PAUSED') return input.previous === 'pending_payment' ? 'trialing' : input.previous;
  if (input.paymentFailed) return 'past_due';
  return input.trialEndsAt !== null && input.now < input.trialEndsAt ? 'trialing' : input.squareStatus === 'PENDING' ? 'trialing' : 'active';
}

export function presentHermiosSubscription(record: OfficeHermiosSubscription): HermiosSummary {
  return { optionKey: record.optionKey, state: record.state, people: record.people, cadence: record.cadence,
    trialEndsAt: record.trialEndsAt, currentPeriodEnd: record.currentPeriodEnd,
    capability: ['trialing', 'active', 'past_due'].includes(record.state) ? HERMIOS_CAPABILITY : null,
    hermiosLinked: record.hermiosWorkspaceId !== null };
}

const hash = (...parts: unknown[]) => createHash('sha256').update(canonical(parts)).digest('hex');
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  object(value);
  const keys = Object.keys(value);
  requireThat(required.every(key => Object.hasOwn(value, key)) && keys.every(key => required.includes(key) || optional.includes(key)), 'invalid_fields');
  return value;
}
const owner = (actor: PortalPrincipal) => requireThat(actor.role === 'billing_owner', 'forbidden', 403);

export class OfficeHermiosSubscriptions {
  readonly catalog: HermiosCatalog;
  readonly provider: SubscriptionProvider;
  private readonly ledger: UsageLedger;
  private readonly cardForm: { applicationId: string | null };
  constructor(options: { ledger: UsageLedger; catalog: HermiosCatalog; provider: SubscriptionProvider; squareApplicationId?: string }) {
    this.ledger = options.ledger; this.catalog = options.catalog; this.provider = options.provider;
    this.cardForm = { applicationId: options.squareApplicationId || null };
    const db = this.ledger.db;
    db.sql.exec(`CREATE TABLE IF NOT EXISTS hermios_subscriptions (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, product TEXT NOT NULL, state TEXT NOT NULL, square_id TEXT UNIQUE, started INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS hermios_subscriptions_open ON hermios_subscriptions(tenant,product) WHERE state!='canceled';
      CREATE TABLE IF NOT EXISTS hermios_terms_acceptances (subscription TEXT NOT NULL, digest TEXT NOT NULL, tenant TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(subscription,digest));
      CREATE TABLE IF NOT EXISTS hermios_square_events (id TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS keep_hermios_subscriptions BEFORE DELETE ON hermios_subscriptions BEGIN SELECT RAISE(ABORT,'immutable_record'); END;`);
    for (const table of ['hermios_terms_acceptances', 'hermios_square_events'])
      for (const action of ['UPDATE', 'DELETE']) db.sql.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_record'); END;`);
  }

  private open(companyId: string): OfficeHermiosSubscription | undefined {
    const row = this.ledger.db.get<{ body: string }>("SELECT body FROM hermios_subscriptions WHERE tenant=? AND product=? AND state!='canceled'", companyId, HERMIOS_PRODUCT);
    return row ? JSON.parse(row.body) as OfficeHermiosSubscription : undefined;
  }
  private latest(companyId: string): OfficeHermiosSubscription | undefined {
    const row = this.ledger.db.get<{ body: string }>('SELECT body FROM hermios_subscriptions WHERE tenant=? AND product=? ORDER BY started DESC, rowid DESC LIMIT 1', companyId, HERMIOS_PRODUCT);
    return row ? JSON.parse(row.body) as OfficeHermiosSubscription : undefined;
  }
  private byId(subscriptionId: string): OfficeHermiosSubscription {
    const row = this.ledger.db.get<{ body: string }>('SELECT body FROM hermios_subscriptions WHERE id=?', subscriptionId);
    requireThat(row, 'hermios_subscription_not_found', 404);
    return JSON.parse(row.body) as OfficeHermiosSubscription;
  }
  /** Write a new version of the record and its audit event. Inside a transaction. */
  private save(record: OfficeHermiosSubscription, kind: string, detail: Record<string, unknown> = {}): OfficeHermiosSubscription {
    record.updatedAt = this.ledger.now();
    this.ledger.db.run('UPDATE hermios_subscriptions SET state=?, square_id=?, body=? WHERE id=?', record.state, record.square.subscriptionId, canonical(record), record.id);
    this.ledger.db.append(record.companyId, kind, null, this.ledger.now(), { subscriptionId: record.id, state: record.state, optionKey: record.optionKey, people: record.people, ...detail });
    return record;
  }
  /** Re-read the stored record and apply `change` to it atomically. */
  private update(subscriptionId: string, kind: string, change: (record: OfficeHermiosSubscription) => Record<string, unknown> | void): OfficeHermiosSubscription {
    return this.ledger.db.transaction(() => { const record = this.byId(subscriptionId); const detail = change(record); return this.save(record, kind, detail ?? {}); });
  }

  private customer(actor: PortalPrincipal): void {
    const tenant = this.ledger.tenant(actor.companyId);
    requireThat(tenant.active && tenant.billingMode !== 'internal_cost', 'hermios_office_not_eligible', 403);
  }
  private sellable(key: unknown): HermiosPlanOption {
    const option = hermiosOption(this.catalog, key);
    requireThat(option.role !== 'anchor', 'hermios_plan_not_purchasable', 409);
    requireThat(option.billing === 'square_subscription', 'hermios_plan_billed_on_realbud_invoice', 409);
    return option;
  }
  /** The exact terms an owner accepts, for this office, option and people. */
  termsFor(companyId: string, key: unknown, people: unknown, kind: 'start' | 'change'): { terms: HermiosTerms; digest: string } {
    const option = this.sellable(key), quote = quoteHermiosPlan(this.catalog, key, people);
    const terms: HermiosTerms = { product: HERMIOS_PRODUCT, capability: HERMIOS_CAPABILITY, companyId, kind,
      catalogVersion: this.catalog.version, termsReference: this.catalog.termsReference, currency: 'AUD', gstInclusive: true,
      option: { key: option.key, name: option.name, cadence: option.cadence, includedPeople: option.includedPeople, baseCents: option.baseCents, extraPersonCents: option.extraPersonCents },
      people: quote.people, totalCents: quote.totalCents, gstCents: quote.gstCents,
      trial: kind === 'start' ? { days: this.catalog.trialDays, cardRequired: this.catalog.trialCardRequired } : null,
      changes: 'people_now_billed_next_period__cadence_at_period_end', cancellation: 'period_end__trial_no_charge' };
    return { terms, digest: digest(terms) };
  }
  private accept(record: OfficeHermiosSubscription, actor: PortalPrincipal, terms: HermiosTerms, termsDigest: string): void {
    this.ledger.db.run('INSERT OR IGNORE INTO hermios_terms_acceptances(subscription,digest,tenant,body) VALUES(?,?,?,?)', record.id, termsDigest, record.companyId,
      canonical({ subscriptionId: record.id, companyId: record.companyId, subject: actor.subject, digest: termsDigest, terms, acceptedAt: this.ledger.now() }));
  }

  /** The catalog for the console: options, quotes at their included people, and the yearly comparison. */
  plans(actor: PortalPrincipal): unknown {
    this.ledger.tenant(actor.companyId);
    const fallback = this.catalog.options.find(option => option.role === 'default')!;
    return { catalogVersion: this.catalog.version, termsReference: this.catalog.termsReference, trialDays: this.catalog.trialDays, trialCardRequired: this.catalog.trialCardRequired,
      options: this.catalog.options.map(option => ({ key: option.key, name: option.name, role: option.role, billing: option.billing, cadence: option.cadence,
        includedPeople: option.includedPeople, baseCents: option.baseCents, extraPersonCents: option.extraPersonCents, requiresCareFee: option.requiresCareFee,
        purchasableHere: option.role !== 'anchor' && option.billing === 'square_subscription' })),
      comparison: hermiosYearlyComparison(this.catalog, fallback.includedPeople),
      card: { provider: this.provider.id, locationId: this.provider.locationId, applicationId: this.cardForm.applicationId } };
  }
  terms(actor: PortalPrincipal, query: { optionKey: string | null; people: string | null }): unknown {
    this.ledger.tenant(actor.companyId);
    requireThat(query.optionKey && query.people && /^[1-9][0-9]{0,2}$/.test(query.people), 'invalid_query');
    const kind = this.open(actor.companyId) ? 'change' : 'start';
    const { terms, digest: termsDigest } = this.termsFor(actor.companyId, query.optionKey, Number(query.people), kind);
    return { terms, digest: termsDigest, quote: quoteHermiosPlan(this.catalog, query.optionKey, Number(query.people)) };
  }

  /** Start (or resume) the office's subscription. Idempotent per office and product. */
  async start(actor: PortalPrincipal, body: unknown): Promise<HermiosSummary> {
    owner(actor); this.customer(actor);
    const value = fields(body, ['optionKey', 'people', 'termsDigest', 'cardSourceId'], ['verificationToken']);
    requireThat(typeof value.termsDigest === 'string' && typeof value.cardSourceId === 'string' && /^[A-Za-z0-9:_-]{8,512}$/.test(value.cardSourceId), 'invalid_start');
    requireThat(value.verificationToken === undefined || (typeof value.verificationToken === 'string' && /^[A-Za-z0-9:_-]{8,1024}$/.test(value.verificationToken)), 'invalid_start');
    const { terms, digest: termsDigest } = this.termsFor(actor.companyId, value.optionKey, value.people, 'start');
    requireThat(value.termsDigest === termsDigest, 'hermios_terms_changed', 409);
    const option = this.sellable(value.optionKey);
    const record = this.ledger.db.transaction(() => {
      const existing = this.open(actor.companyId);
      if (existing) {
        requireThat(existing.optionKey === option.key && existing.people === terms.people && existing.termsDigest === termsDigest, 'hermios_subscription_exists', 409);
        return existing;
      }
      const generation = this.ledger.db.get<{ count: number }>('SELECT count(*) AS count FROM hermios_subscriptions WHERE tenant=? AND product=?', actor.companyId, HERMIOS_PRODUCT)!.count;
      const now = this.ledger.now();
      const created: OfficeHermiosSubscription = { id: `hs-${hash(actor.companyId, HERMIOS_PRODUCT, generation).slice(0, 32)}`, companyId: actor.companyId, product: HERMIOS_PRODUCT, provider: this.provider.id,
        state: 'pending_payment', optionKey: option.key, people: terms.people, cadence: option.cadence, catalogVersion: this.catalog.version,
        termsReference: this.catalog.termsReference, termsDigest, startedBy: actor.subject, startedAt: now, trialEndsAt: null, currentPeriodEnd: null,
        square: { customerId: null, cardId: null, orderTemplateId: null, subscriptionId: null, planVariationId: null, status: null },
        pendingChange: null, cancelAt: null, chargeOnCancel: null, canceledAt: null, paymentFailedAt: null, hermiosWorkspaceId: null, updatedAt: now };
      this.ledger.db.run('INSERT INTO hermios_subscriptions(id,tenant,product,state,square_id,started,body) VALUES(?,?,?,?,?,?,?)', created.id, created.companyId, HERMIOS_PRODUCT, created.state, null, now, canonical(created));
      this.accept(created, actor, terms, termsDigest);
      this.ledger.db.append(created.companyId, 'hermios_subscription_requested', null, now, { subscriptionId: created.id, optionKey: created.optionKey, people: created.people, termsDigest, subject: actor.subject });
      return created;
    });
    if (record.state !== 'pending_payment') return presentHermiosSubscription(record);
    return presentHermiosSubscription(await this.complete(record.id, value.cardSourceId as string, value.verificationToken as string | undefined));
  }
  /** The Square steps of a start, each saved once done; the card comes first, so no trial starts without one. */
  private async complete(subscriptionId: string, cardSourceId: string, verificationToken: string | undefined): Promise<OfficeHermiosSubscription> {
    let record = this.byId(subscriptionId);
    const ids = await this.provider.catalogIds();
    const planVariationId = ids.planVariationIds[record.optionKey]; requireThat(planVariationId, 'hermios_square_catalog_incomplete', 503);
    const customerId = record.square.customerId ?? this.provider.customerFor(record.companyId);
    if (!record.square.cardId) {
      const cardId = await this.provider.saveCard({ customerId, sourceId: cardSourceId, ...(verificationToken ? { verificationToken } : {}), idempotencyKey: hash(record.id, 'card').slice(0, 40) });
      record = this.update(record.id, 'hermios_card_on_file', current => { current.square.customerId = customerId; current.square.cardId = cardId; });
    }
    if (!record.square.orderTemplateId) {
      const template = hermiosOrderTemplate(this.catalog, record.optionKey, record.people, { locationId: this.provider.locationId, itemVariationIds: ids.itemVariationIds }, customerId, record.id);
      const orderTemplateId = await this.provider.createOrderTemplate(template);
      record = this.update(record.id, 'hermios_order_template', current => { current.square.orderTemplateId = orderTemplateId; });
    }
    const snapshot = await this.provider.createSubscription({ customerId, cardId: record.square.cardId!, planVariationId, orderTemplateId: record.square.orderTemplateId!,
      paidOrdinal: this.catalog.trialDays > 0 ? 1 : 0, startDate: squareDate(record.startedAt), idempotencyKey: hash(record.id, 'subscription').slice(0, 40) });
    return this.update(record.id, 'hermios_subscription_started', current => {
      current.square.subscriptionId = snapshot.id; current.square.planVariationId = snapshot.planVariationId;
      current.trialEndsAt = fromSquareDate(snapshot.startDate) + this.catalog.trialDays * DAY;
      this.apply(current, snapshot);
      return { squareSubscriptionId: snapshot.id, trialEndsAt: current.trialEndsAt };
    });
  }
  /** Fold a Square read into the record. Never deletes, pauses or uninstalls anything. */
  private apply(record: OfficeHermiosSubscription, snapshot: SubscriptionSnapshot): void {
    requireThat(!record.square.subscriptionId || snapshot.id === record.square.subscriptionId, 'square_subscription_mismatch', 409);
    requireThat(!record.square.customerId || snapshot.customerId === record.square.customerId, 'square_subscription_mismatch', 409);
    const now = this.ledger.now();
    record.square.status = snapshot.status;
    if (record.pendingChange && snapshot.planVariationId === record.pendingChange.planVariationId) {
      const change = record.pendingChange;
      record.optionKey = change.optionKey; record.people = change.people; record.cadence = change.cadence; record.termsDigest = change.termsDigest; record.pendingChange = null;
    }
    record.square.planVariationId = snapshot.planVariationId;
    if (snapshot.chargedThroughDate) record.currentPeriodEnd = fromSquareDate(snapshot.chargedThroughDate);
    else if (record.currentPeriodEnd === null) record.currentPeriodEnd = record.trialEndsAt;
    if (snapshot.canceledDate) record.cancelAt = fromSquareDate(snapshot.canceledDate);
    const state = hermiosStateFrom({ previous: record.state, squareStatus: snapshot.status, now, trialEndsAt: record.trialEndsAt, paymentFailed: record.paymentFailedAt !== null });
    if (state === 'canceled' && record.state !== 'canceled') record.canceledAt = now;
    record.state = state;
  }

  /** People: same option, new quantity. Cadence: another Square-billed option, from the period end. */
  async change(actor: PortalPrincipal, body: unknown): Promise<HermiosSummary> {
    owner(actor); this.customer(actor);
    const value = fields(body, ['optionKey', 'people', 'termsDigest']);
    const record = this.open(actor.companyId); requireThat(record, 'hermios_subscription_not_found', 404);
    requireThat(record.state !== 'pending_payment' && record.square.subscriptionId, 'hermios_subscription_not_started', 409);
    requireThat(record.cancelAt === null && record.pendingChange === null, 'hermios_change_pending', 409);
    const { terms, digest: termsDigest } = this.termsFor(actor.companyId, value.optionKey, value.people, 'change');
    requireThat(value.termsDigest === termsDigest, 'hermios_terms_changed', 409);
    const option = this.sellable(value.optionKey);
    requireThat(option.key !== record.optionKey || terms.people !== record.people, 'hermios_change_noop', 409);
    const ids = await this.provider.catalogIds();
    const planVariationId = ids.planVariationIds[option.key]; requireThat(planVariationId, 'hermios_square_catalog_incomplete', 503);
    const changeNumber = this.ledger.db.get<{ count: number }>('SELECT count(*) AS count FROM hermios_terms_acceptances WHERE subscription=?', record.id)!.count;
    const orderTemplateId = await this.provider.createOrderTemplate(hermiosOrderTemplate(this.catalog, option.key, terms.people,
      { locationId: this.provider.locationId, itemVariationIds: ids.itemVariationIds }, record.square.customerId!, `${record.id.slice(0, 32)}-${changeNumber}`));
    const snapshot = await this.provider.swapPlan({ subscriptionId: record.square.subscriptionId!, planVariationId, orderTemplateId, paidOrdinal: this.catalog.trialDays > 0 ? 1 : 0 });
    return presentHermiosSubscription(this.ledger.db.transaction(() => {
      const current = this.byId(record.id);
      this.accept(current, actor, terms, termsDigest);
      if (option.key === current.optionKey) {
        // Seats change now; Square bills the new quantity from the next billing date.
        const from = current.people;
        current.people = terms.people; current.termsDigest = termsDigest; current.square.orderTemplateId = orderTemplateId;
        this.apply(current, snapshot);
        return this.save(current, 'hermios_people_changed', { from, to: terms.people, termsDigest, subject: actor.subject });
      }
      this.apply(current, snapshot);
      current.pendingChange = { optionKey: option.key, people: terms.people, cadence: option.cadence, termsDigest, planVariationId, effectiveAt: current.currentPeriodEnd };
      return this.save(current, 'hermios_cadence_change_scheduled', { to: option.key, effectiveAt: current.currentPeriodEnd, termsDigest, subject: actor.subject });
    }));
  }

  /** Cancel at period end. Before Square has a subscription, the request is simply closed. */
  async cancel(actor: PortalPrincipal, body: unknown): Promise<HermiosSummary> {
    owner(actor);
    fields(body ?? {}, []);
    const record = this.open(actor.companyId); requireThat(record, 'hermios_subscription_not_found', 404);
    if (!record.square.subscriptionId) {
      return presentHermiosSubscription(this.update(record.id, 'hermios_subscription_canceled', current => {
        current.state = 'canceled'; current.canceledAt = current.cancelAt = this.ledger.now(); current.chargeOnCancel = 'none'; return { subject: actor.subject, before: 'square_subscription' };
      }));
    }
    if (record.cancelAt !== null) return presentHermiosSubscription(record);
    const snapshot = await this.provider.cancel(record.square.subscriptionId);
    requireThat(snapshot.canceledDate, 'square_cancel_unconfirmed', 502);
    return presentHermiosSubscription(this.update(record.id, 'hermios_cancel_scheduled', current => {
      this.apply(current, snapshot);
      // In the trial Square's period is one day: the cancellation lands before the first charge.
      current.chargeOnCancel = current.trialEndsAt !== null && current.cancelAt! <= current.trialEndsAt ? 'none' : 'through_period_end';
      return { cancelAt: current.cancelAt, chargeOnCancel: current.chargeOnCancel, subject: actor.subject };
    }));
  }

  /** Re-read from Square (the local fake follows the clock). */
  async refresh(companyId: string): Promise<OfficeHermiosSubscription | undefined> {
    const record = this.open(companyId);
    if (!record?.square.subscriptionId) return record;
    const snapshot = await this.provider.retrieve(record.square.subscriptionId);
    return this.ledger.db.transaction(() => {
      const current = this.byId(record.id), before = canonical({ ...current, updatedAt: 0 });
      this.apply(current, snapshot);
      // A read that changes nothing writes nothing.
      return canonical({ ...current, updatedAt: 0 }) === before ? current : this.save(current, 'hermios_subscription_refreshed', { squareStatus: snapshot.status });
    });
  }
  async summary(actor: PortalPrincipal): Promise<HermiosSummary> {
    requireThat(actor.role === 'billing_owner' || actor.role === 'billing_reader', 'forbidden', 403);
    if (this.provider.id === 'local') await this.refresh(actor.companyId);
    const record = this.latest(actor.companyId); requireThat(record, 'hermios_subscription_not_found', 404);
    return presentHermiosSubscription(record);
  }
  operatorView(companyId: unknown): unknown {
    id(companyId);
    const rows = this.ledger.db.all<{ body: string }>('SELECT body FROM hermios_subscriptions WHERE tenant=? AND product=? ORDER BY started DESC, rowid DESC', companyId, HERMIOS_PRODUCT);
    const subscriptions = rows.map(row => JSON.parse(row.body) as OfficeHermiosSubscription);
    const acceptances = this.ledger.db.all<{ body: string }>('SELECT body FROM hermios_terms_acceptances WHERE tenant=? ORDER BY rowid', companyId)
      .map(row => { const { terms: _terms, ...rest } = JSON.parse(row.body) as Record<string, unknown>; return rest; });
    return { companyId, catalogVersion: this.catalog.version, provider: this.provider.id,
      subscriptions: subscriptions.map(record => ({ ...record, summary: presentHermiosSubscription(record) })), acceptances };
  }

  /**
   * Square subscription and invoice notifications. Verified (URL-bound HMAC,
   * merchant, age), stored once by event id, and only a trigger: the state
   * comes from re-reading the subscription (and invoice) from Square.
   */
  async webhook(raw: Uint8Array, signature: string): Promise<{ received: true; replayed?: true; matched: boolean }> {
    requireThat(this.provider.verifyEvent, 'square_webhook_unavailable', 503);
    const event = this.provider.verifyEvent!(raw, signature, this.ledger.now());
    const eventDigest = hash(Buffer.from(raw).toString('base64'));
    const prior = this.ledger.db.get<{ digest: string }>('SELECT digest FROM hermios_square_events WHERE id=?', event.eventId);
    if (prior) { requireThat(prior.digest === eventDigest, 'square_event_conflict', 409); return { received: true, replayed: true, matched: false }; }
    let squareSubscriptionId: string | null = null, paymentFailed: boolean | null = null;
    if (event.dataType === 'subscription' && event.type.startsWith('subscription.')) squareSubscriptionId = event.objectId;
    else if (event.dataType === 'invoice' && event.type.startsWith('invoice.')) {
      const invoice = await this.provider.retrieveInvoice(event.objectId);
      squareSubscriptionId = invoice.subscriptionId || null;
      if (invoice.status === 'PAID') paymentFailed = false;
      else if (invoice.status === 'FAILED' || event.type === 'invoice.scheduled_charge_failed') paymentFailed = true;
    }
    const row = squareSubscriptionId ? this.ledger.db.get<{ id: string }>('SELECT id FROM hermios_subscriptions WHERE square_id=?', squareSubscriptionId) : undefined;
    const snapshot = row ? await this.provider.retrieve(squareSubscriptionId!) : undefined;
    return this.ledger.db.transaction(() => {
      const again = this.ledger.db.get<{ digest: string }>('SELECT digest FROM hermios_square_events WHERE id=?', event.eventId);
      if (again) { requireThat(again.digest === eventDigest, 'square_event_conflict', 409); return { received: true as const, replayed: true as const, matched: false }; }
      this.ledger.db.run('INSERT INTO hermios_square_events(id,digest,body) VALUES(?,?,?)', event.eventId, eventDigest,
        canonical({ type: event.type, dataType: event.dataType, objectId: event.objectId, createdAt: event.createdAt, receivedAt: this.ledger.now(), subscriptionId: row?.id ?? null }));
      if (!row || !snapshot) return { received: true as const, matched: false };
      const current = this.byId(row.id);
      if (paymentFailed === true && current.paymentFailedAt === null) current.paymentFailedAt = this.ledger.now();
      if (paymentFailed === false) current.paymentFailedAt = null;
      this.apply(current, snapshot);
      this.save(current, 'hermios_square_event', { eventId: event.eventId, type: event.type, squareStatus: snapshot.status });
      return { received: true as const, matched: true };
    });
  }
}

/**
 * From the environment: `REALBUD_HERMIOS_SUBSCRIPTIONS` is `off` (default:
 * routes answer 503 naming the variable), `local-fake` (only with
 * `REALBUD_PAYMENT_MODE=local`; the deterministic fake, never Square) or
 * `square` (sandbox or live under the care collection rules, plus the Hermios
 * webhook's own notification URL and signature key). Asking for `square` with
 * a variable missing refuses to compose, naming the variable, never a value.
 */
export function composeHermiosSubscriptions(options: { env: NodeJS.ProcessEnv; ledger: UsageLedger; fetch: HttpTransport }): { subscriptions: OfficeHermiosSubscriptions } | { unavailable: string } {
  const value = (name: string) => (options.env[name] ?? '').trim();
  const selected = value('REALBUD_HERMIOS_SUBSCRIPTIONS') || 'off';
  if (selected === 'off') return { unavailable: 'hermios_subscriptions_unconfigured:REALBUD_HERMIOS_SUBSCRIPTIONS' };
  const mode = value('REALBUD_PAYMENT_MODE') || 'local';
  const catalog = loadHermiosCatalog(value('REALBUD_HERMIOS_CATALOG') || undefined);
  if (selected === 'local-fake') {
    requireThat(mode === 'local', 'hermios_subscriptions_unconfigured:REALBUD_PAYMENT_MODE', 503);
    return { subscriptions: new OfficeHermiosSubscriptions({ ledger: options.ledger, catalog, provider: new LocalSubscriptionFake({ catalog, now: options.ledger.now }) }) };
  }
  requireThat(selected === 'square', 'hermios_subscriptions_unconfigured:REALBUD_HERMIOS_SUBSCRIPTIONS', 503);
  let target;
  try { target = squareCatalogTarget(options.env, mode === 'live'); }
  catch (error) { throw new GatewayError(error instanceof GatewayError ? error.code.replace('square_catalog_', 'hermios_subscriptions_') : 'hermios_subscriptions_unconfigured', 503); }
  for (const name of ['HERMIOS_SQUARE_NOTIFICATION_URL', 'HERMIOS_SQUARE_WEBHOOK_SIGNATURE_KEY', 'REALBUD_INTERNAL_COMPANY_ID']) requireThat(value(name), `hermios_subscriptions_unconfigured:${name}`, 503);
  const provider = new SquareSubscriptionAdapter({ ledger: options.ledger, environment: target.environment, fetchImpl: options.fetch as unknown as typeof fetch,
    accessToken: target.accessToken, merchantId: target.merchantId, locationId: target.locationId, internalCompanyId: value('REALBUD_INTERNAL_COMPANY_ID'),
    notificationUrl: value('HERMIOS_SQUARE_NOTIFICATION_URL'), signatureKey: value('HERMIOS_SQUARE_WEBHOOK_SIGNATURE_KEY'), catalog });
  return { subscriptions: new OfficeHermiosSubscriptions({ ledger: options.ledger, catalog, provider, ...(value('SQUARE_APPLICATION_ID') ? { squareApplicationId: value('SQUARE_APPLICATION_ID') } : {}) }) };
}
