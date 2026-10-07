/**
 * Composio event triggers, gateway side. Each office project has one webhook
 * subscription; its signed deliveries arrive at `POST /v1/webhooks/composio/{companyId}`
 * and are kept as ids only, then pulled by the desktops they belong to
 * (`POST /v1/connectors/events`). A device turns a trigger on or off with
 * `POST /v1/connectors/triggers`; the gateway picks the account, never the caller.
 *
 * Payload `data` is provider data: nothing in it is stored or forwarded except
 * the one allowlisted message id. Subject, sender and body never reach a table.
 *
 * Composio facts here come from its docs and are UNVERIFIED against a live
 * project unless a test proves them: the subscription routes and their response
 * fields, the V3 payload shape, the signing key (the secret string itself), the
 * Gmail trigger slug and config, and the trigger-instance response fields.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { GatewayError, exact, integer, object, requireThat } from './contracts.ts';
import type { UsageLedger } from './ledger.ts';
import type { ConnectorDevice } from './connectors.ts';
import type { OfficeMailbox } from './office-mailbox.ts';
import { composioProjectRest, TRIGGER_ID, type AppBinding, type ComposioAppAdapter } from './composio-apps.ts';
import type { HttpTransport } from './composio-org.ts';

/** The four events the office subscription asks for (V3 payloads). */
export const WEBHOOK_EVENTS = ['composio.trigger.message', 'composio.connected_account.expired', 'composio.connected_account.activated', 'composio.trigger.disabled'] as const;
const KINDS = new Map<string, string>([['composio.trigger.message', 'message'], ['composio.connected_account.expired', 'account_expired'],
  ['composio.connected_account.activated', 'account_activated'], ['composio.trigger.disabled', 'trigger_disabled']]);
/** UNVERIFIED config fields. Composio-managed Gmail auth polls no faster than every 15 minutes. */
export const GMAIL_NEW_MESSAGE_CONFIG: Record<string, unknown> = { interval: 15 };
/** The only triggers a device may turn on: a fixed slug and config per (app, event). */
const TRIGGERS = new Map([['gmail:new-message', { app: 'gmail', event: 'new-message', slug: 'GMAIL_NEW_GMAIL_MESSAGE', config: GMAIL_NEW_MESSAGE_CONFIG }]]);
export type TriggerSpec = NonNullable<ReturnType<typeof TRIGGERS.get>>;
export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const SIGNATURE_TOLERANCE_S = 300, PAGE = 100;
const REF = /^[A-Za-z0-9._:@+-]{1,256}$/, MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function triggerSpec(app: unknown, event: unknown): TriggerSpec {
  const spec = typeof app === 'string' && typeof event === 'string' ? TRIGGERS.get(`${app}:${event}`) : undefined;
  requireThat(spec, 'connector_trigger_not_allowed', 403);
  return spec!;
}
/** Secret-store name of the office's webhook signing secret (provisioning writes it). */
/** One secret name per office, injective: a lossy slug of the id would let two
 * offices whose ids differ only in punctuation or case share a signing secret. */
export const webhookSecretName = (companyId: string) => `REALBUD_COMPOSIO_WEBHOOK_${createHash('sha256').update(companyId).digest('hex').toUpperCase()}`;
/** The office mailbox's provider user, as OfficeMailbox creates it. */
export const officeUserId = (companyId: string) => `office_${createHash('sha256').update(companyId).digest('hex')}`;

/** Accepts any one of several space-separated `v1,<base64>` (or bare `<base64>`)
 * signatures (secret rotation), each compared in constant time, then a 300 s
 * timestamp window. The HMAC key is the secret's UTF-8 bytes, not base64-decoded
 * (docs.composio.dev/docs/webhook-verification, read 7 Oct 2026). */
export function verifyComposioSignature(secret: string, headers: { id?: unknown; timestamp?: unknown; signature?: unknown }, raw: Uint8Array, nowMs: number): string {
  const { id, timestamp, signature } = headers;
  requireThat(typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) && typeof timestamp === 'string' && /^[0-9]{1,12}$/.test(timestamp)
    && typeof signature === 'string' && signature.length <= 4096, 'invalid_composio_signature', 401);
  const expected = createHmac('sha256', secret).update(`${id}.${timestamp}.`).update(raw).digest();
  const valid = (signature as string).split(' ').some(entry => {
    const match = /^(?:v1,)?([A-Za-z0-9+/]{43}=)$/.exec(entry);
    const supplied = match ? Buffer.from(match[1]!, 'base64') : undefined;
    return supplied !== undefined && supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
  });
  requireThat(valid, 'invalid_composio_signature', 401);
  requireThat(Math.abs(nowMs / 1000 - Number(timestamp)) <= SIGNATURE_TOLERANCE_S, 'stale_composio_event', 401);
  return id as string;
}

export interface TriggerRow { trigger_id: string; company: string; user_id: string; slug: string; connected_account: string; project_key_env: string; state: string; updated: number }
interface EventRow { seq: number; kind: string; trigger_id: string | null; user_id: string; provider_msg_id: string | null; received: number }
type Db = UsageLedger['db'];
function tables(db: Db) {
  // Registry: one row per trigger instance the gateway made. `replaced` rows are
  // older instances of the same (user, slug), kept so their late events are known.
  db.run('CREATE TABLE IF NOT EXISTS composio_triggers (trigger_id TEXT PRIMARY KEY, company TEXT NOT NULL, user_id TEXT NOT NULL, slug TEXT NOT NULL, connected_account TEXT NOT NULL, project_key_env TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL)');
  db.run('CREATE INDEX IF NOT EXISTS composio_triggers_user ON composio_triggers(company, user_id, slug)');
  // Ids only. Never subject, sender, body or any other `data` field.
  db.run('CREATE TABLE IF NOT EXISTS composio_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT NOT NULL, webhook_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, trigger_id TEXT, user_id TEXT NOT NULL, kind TEXT NOT NULL, provider_msg_id TEXT, received INTEGER NOT NULL)');
  db.run('CREATE INDEX IF NOT EXISTS composio_events_company ON composio_events(company, seq)');
  db.run('CREATE TABLE IF NOT EXISTS composio_event_cursors (device TEXT PRIMARY KEY, company TEXT NOT NULL, acked INTEGER NOT NULL)');
  // Highest seq per provider user deleted unread by age: a cursor behind it has a gap.
  db.run('CREATE TABLE IF NOT EXISTS composio_event_retention (company TEXT NOT NULL, user_id TEXT NOT NULL, pruned_through INTEGER NOT NULL, PRIMARY KEY(company, user_id))');
  // Highest seq ever stored per office. A device's cursor is compared with its own
  // office's top, never the table-wide sequence, which would show other offices' traffic.
  db.run('CREATE TABLE IF NOT EXISTS composio_event_tops (company TEXT PRIMARY KEY, top INTEGER NOT NULL)');
}

export interface TriggerDeps { ledger: UsageLedger; secret: (name: string) => string | undefined; apps: Pick<ComposioAppAdapter, 'setTriggerStatus'> }
/**
 * Turn off the office's live trigger instances that `match` selects (device
 * revoke, mailbox mode change). The local state goes first, so their events are
 * dropped from here on whatever the provider says; a provider call that fails is
 * audited, never a reason to fail the caller.
 */
export async function disableTriggers(deps: TriggerDeps, company: string, match: (row: TriggerRow) => boolean, reason: string): Promise<void> {
  const db = deps.ledger.db; tables(db);
  const rows = db.all<TriggerRow>("SELECT * FROM composio_triggers WHERE company=? AND state NOT IN ('disabled','replaced')", company).filter(match);
  for (const row of rows) {
    const now = deps.ledger.now();
    db.transaction(() => {
      db.run('UPDATE composio_triggers SET state=?, updated=? WHERE trigger_id=?', 'disabled', now, row.trigger_id);
      db.append(company, 'composio_trigger_disabled', null, now, { triggerId: row.trigger_id, userId: row.user_id, reason });
    });
    try {
      const apiKey = deps.secret(row.project_key_env); requireThat(apiKey, 'connector_not_configured', 503);
      await deps.apps.setTriggerStatus({ apiKey: apiKey! }, row.trigger_id, false, AbortSignal.timeout(15_000));
    } catch { db.append(company, 'composio_trigger_disable_unconfirmed', null, deps.ledger.now(), { triggerId: row.trigger_id, reason }); }
  }
}

export interface TriggerServiceDeps extends TriggerDeps {
  devices: () => ConnectorDevice[]; mailbox: Pick<OfficeMailbox, 'readyForDevice'>; apps: Pick<ComposioAppAdapter, 'upsertTrigger' | 'setTriggerStatus'>;
}
export class ComposioTriggers {
  private readonly deps: TriggerServiceDeps;
  constructor(deps: TriggerServiceDeps) { this.deps = deps; tables(deps.ledger.db); }
  private get db() { return this.deps.ledger.db; }
  private current(company: string, userId: string, slug: string) {
    return this.db.get<TriggerRow>("SELECT * FROM composio_triggers WHERE company=? AND user_id=? AND slug=? AND state<>'replaced' ORDER BY updated DESC LIMIT 1", company, userId, slug);
  }
  private source(company: string, userId: string) { return userId === officeUserId(company) ? 'office' : 'personal'; }
  /** The provider users whose events this device may read: its own, and the
   * office mailbox's only while this computer holds the mailbox grant. */
  private users(device: ConnectorDevice): string[] {
    return this.deps.mailbox.readyForDevice(device) ? [device.userId, officeUserId(device.companyId)] : [device.userId];
  }
  disable(company: string, match: (row: TriggerRow) => boolean, reason: string) { return disableTriggers(this.deps, company, match, reason); }

  /** Enable (upsert, then explicitly enable) or disable the one allowlisted
   * trigger for `binding`, which the connector broker resolved itself. */
  async set(company: string, projectKeyEnv: string, binding: AppBinding, spec: TriggerSpec, enabled: boolean, signal: AbortSignal) {
    const row = this.current(company, binding.userId, spec.slug), now = () => this.deps.ledger.now();
    const result = (state: string) => ({ app: spec.app, event: spec.event, source: this.source(company, binding.userId), enabled: state === 'enabled', state });
    if (!enabled) {
      if (!row) return result('disabled');
      if (row.state !== 'disabled') {
        await this.deps.apps.setTriggerStatus(binding, row.trigger_id, false, signal);
        this.db.transaction(() => {
          this.db.run('UPDATE composio_triggers SET state=?, updated=? WHERE trigger_id=?', 'disabled', now(), row.trigger_id);
          this.db.append(company, 'composio_trigger_disabled', null, now(), { triggerId: row.trigger_id, userId: row.user_id, reason: 'device_request' });
        });
      }
      return result('disabled');
    }
    // UNVERIFIED: whether upsert re-enables a disabled instance, so it is enabled explicitly.
    const triggerId = await this.deps.apps.upsertTrigger(binding, spec.slug, spec.config, signal);
    await this.deps.apps.setTriggerStatus(binding, triggerId, true, signal);
    binding.assertAuthority?.();
    this.db.transaction(() => {
      this.db.run("UPDATE composio_triggers SET state='replaced', updated=? WHERE company=? AND user_id=? AND slug=? AND trigger_id<>? AND state<>'replaced'", now(), company, binding.userId, spec.slug, triggerId);
      this.db.run('INSERT INTO composio_triggers(trigger_id,company,user_id,slug,connected_account,project_key_env,state,updated) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(trigger_id) DO UPDATE SET state=excluded.state, connected_account=excluded.connected_account, updated=excluded.updated',
        triggerId, company, binding.userId, spec.slug, binding.accountId!, projectKeyEnv, 'enabled', now());
      this.db.append(company, 'composio_trigger_enabled', null, now(), { triggerId, userId: binding.userId, slug: spec.slug });
    });
    // An older instance (another connected account) stops polling too; best effort.
    if (row && row.trigger_id !== triggerId && row.state === 'enabled') {
      try { await this.deps.apps.setTriggerStatus(binding, row.trigger_id, false, signal); }
      catch { this.db.append(company, 'composio_trigger_disable_unconfirmed', null, now(), { triggerId: row.trigger_id, reason: 'replaced' }); }
    }
    return result('enabled');
  }

  /** `/v1/connectors/status`: this device's triggers, with an expired account or a provider-disabled trigger said plainly. */
  status(device: ConnectorDevice) {
    const users = this.users(device);
    return this.db.all<TriggerRow>(`SELECT * FROM composio_triggers WHERE company=? AND state<>'replaced' AND user_id IN (${users.map(() => '?').join(',')}) ORDER BY updated`, device.companyId, ...users)
      .flatMap(row => { const spec = [...TRIGGERS.values()].find(item => item.slug === row.slug); return spec ? [{ app: spec.app, event: spec.event, source: this.source(row.company, row.user_id), state: row.state }] : []; });
  }

  /** Drop rows older than the retention window, remembering how far each provider user's were cut. */
  private prune(company: string) {
    const cutoff = this.deps.ledger.now() - EVENT_RETENTION_MS;
    const aged = this.db.all<{ user_id: string; seq: number }>('SELECT user_id, max(seq) AS seq FROM composio_events WHERE company=? AND received<? GROUP BY user_id', company, cutoff);
    if (!aged.length) return;
    this.db.transaction(() => {
      this.db.run('DELETE FROM composio_events WHERE company=? AND received<?', company, cutoff);
      for (const row of aged) this.db.run('INSERT INTO composio_event_retention(company,user_id,pruned_through) VALUES(?,?,?) ON CONFLICT(company,user_id) DO UPDATE SET pruned_through=max(pruned_through,excluded.pruned_through)', company, row.user_id, row.seq);
    });
  }

  /**
   * One signed delivery for `company`. The path only chose the secret; the body
   * is trusted after the signature, and then only for the ids the registry
   * already knows. At-least-once: a duplicate `webhook-id` answers `replayed`.
   */
  webhook(company: string, headers: { id?: unknown; timestamp?: unknown; signature?: unknown }, raw: Uint8Array): { received: true; replayed?: true; ignored?: true } {
    const secret = typeof company === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(company) ? this.deps.secret(webhookSecretName(company)) : undefined;
    // An office without a subscription answers like a bad signature: no office enumeration.
    requireThat(secret, 'invalid_composio_signature', 401);
    const webhookId = verifyComposioSignature(secret!, headers, raw, this.deps.ledger.now());
    let event: unknown;
    try { event = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { throw new GatewayError('invalid_composio_event'); }
    object(event);
    const kind = typeof event.type === 'string' ? KINDS.get(event.type) : undefined;
    if (!kind) return { received: true, ignored: true };
    const digest = createHash('sha256').update(raw).digest('hex');
    const replay = () => {
      const prior = this.db.get<{ digest: string }>('SELECT digest FROM composio_events WHERE webhook_id=?', webhookId);
      if (prior) requireThat(prior.digest === digest, 'composio_event_conflict', 409);
      return Boolean(prior);
    };
    if (replay()) return { received: true, replayed: true };
    const meta = event.metadata; object(meta);
    requireThat(typeof meta.user_id === 'string' && REF.test(meta.user_id) && typeof meta.connected_account_id === 'string' && REF.test(meta.connected_account_id), 'invalid_composio_event');
    const now = this.deps.ledger.now();
    let rows: TriggerRow[];
    if (kind === 'message' || kind === 'trigger_disabled') {
      const row = typeof meta.trigger_id === 'string' && TRIGGER_ID.test(meta.trigger_id)
        ? this.db.get<TriggerRow>('SELECT * FROM composio_triggers WHERE company=? AND trigger_id=?', company, meta.trigger_id) : undefined;
      if (!row || row.connected_account !== meta.connected_account_id || row.user_id !== meta.user_id) {
        this.db.append(company, 'composio_event_refused', null, now, { webhookId, kind, error: 'composio_trigger_unknown' });
        throw new GatewayError('composio_trigger_unknown', 403);
      }
      if (kind === 'message' && row.state !== 'enabled') return { received: true, ignored: true };
      rows = [row];
    } else {
      rows = this.db.all<TriggerRow>("SELECT * FROM composio_triggers WHERE company=? AND connected_account=? AND user_id=? AND state<>'replaced'", company, meta.connected_account_id, meta.user_id);
      if (!rows.length) return { received: true, ignored: true };
    }
    // UNVERIFIED: the Gmail message id field in `data`. It is the only `data` value kept.
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    const messageId = kind === 'message' ? [data.message_id, data.id].find(value => typeof value === 'string' && MESSAGE_ID.test(value)) as string | undefined : undefined;
    const state = kind === 'account_expired' ? 'expired' : kind === 'trigger_disabled' ? 'provider_disabled' : undefined;
    this.prune(company);
    return this.db.transaction(() => {
      if (replay()) return { received: true as const, replayed: true as const };
      const seq = Number(this.db.run('INSERT INTO composio_events(company,webhook_id,digest,trigger_id,user_id,kind,provider_msg_id,received) VALUES(?,?,?,?,?,?,?,?)',
        company, webhookId, digest, kind === 'message' || kind === 'trigger_disabled' ? rows[0]!.trigger_id : null, meta.user_id as string, kind, messageId ?? null, now).lastInsertRowid);
      this.db.run('INSERT INTO composio_event_tops(company,top) VALUES(?,?) ON CONFLICT(company) DO UPDATE SET top=max(top,excluded.top)', company, seq);
      if (state) for (const row of rows) if (row.state === 'enabled') this.db.run('UPDATE composio_triggers SET state=?, updated=? WHERE trigger_id=?', state, now, row.trigger_id);
      this.db.append(company, 'composio_event_received', null, now, { webhookId, kind, seq, ...(rows.length === 1 ? { triggerId: rows[0]!.trigger_id } : {}) });
      return { received: true as const };
    });
  }

  /**
   * Events after `after` for this device only, and acknowledgement of
   * everything up to it. A device's own rows go once it acks them; office
   * mailbox rows once every granted computer has; anything else after 7 days.
   * `gap` says rows this device could have read were dropped unread (or the
   * cursor is ahead of anything stored): the desktop should rescan.
   */
  pull(device: ConnectorDevice, value: unknown) {
    object(value); exact(value, ['after']); integer(value.after, Number.MAX_SAFE_INTEGER);
    const company = device.companyId, db = this.db, after = value.after as number;
    this.prune(company);
    const top = db.get<{ top: number }>('SELECT top FROM composio_event_tops WHERE company=?', company)?.top ?? 0;
    const users = this.users(device), office = officeUserId(company);
    const pruned = Math.max(0, ...users.map(user => db.get<{ pruned_through: number }>('SELECT pruned_through FROM composio_event_retention WHERE company=? AND user_id=?', company, user)?.pruned_through ?? 0));
    // A cursor ahead of anything stored is from another ledger: acknowledge nothing, start over.
    const from = after > top ? 0 : after, gap = after > top || after < pruned;
    db.transaction(() => {
      db.run('INSERT INTO composio_event_cursors(device,company,acked) VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET acked=max(acked,excluded.acked)', device.id, company, from);
      db.run('DELETE FROM composio_events WHERE company=? AND user_id=? AND seq<=?', company, device.userId, from);
      const granted = this.deps.devices().filter(d => d.companyId === company && d.active && this.deps.mailbox.readyForDevice(d));
      if (granted.length) {
        const floor = Math.min(...granted.map(d => db.get<{ acked: number }>('SELECT acked FROM composio_event_cursors WHERE device=?', d.id)?.acked ?? 0));
        db.run('DELETE FROM composio_events WHERE company=? AND user_id=? AND seq<=?', company, office, floor);
      }
    });
    const rows = db.all<EventRow>(`SELECT seq, kind, trigger_id, user_id, provider_msg_id, received FROM composio_events WHERE company=? AND seq>? AND user_id IN (${users.map(() => '?').join(',')}) ORDER BY seq LIMIT ?`,
      company, from, ...users, PAGE + 1);
    const more = rows.length > PAGE, page = rows.slice(0, PAGE);
    const slugs = new Map(db.all<{ trigger_id: string; slug: string }>('SELECT trigger_id, slug FROM composio_triggers WHERE company=?', company).map(row => [row.trigger_id, row.slug]));
    return { events: page.map(row => {
      const spec = row.trigger_id ? [...TRIGGERS.values()].find(item => item.slug === slugs.get(row.trigger_id!)) : undefined;
      return { seq: row.seq, kind: row.kind, source: row.user_id === office ? 'office' : 'personal', ...(spec ? { app: spec.app, event: spec.event } : {}),
        ...(row.provider_msg_id ? { messageId: row.provider_msg_id } : {}), receivedAt: new Date(row.received).toISOString() };
    }), cursor: more ? page[page.length - 1]!.seq : top, gap, more };
  }
}

/** The office project's one webhook subscription, under its own project key. */
export interface ComposioWebhookClient {
  list(apiKey: string): Promise<Array<{ id: string; url: string }>>;
  create(apiKey: string, url: string): Promise<{ id: string; secret: string }>;
  rotate(apiKey: string, id: string): Promise<{ id: string; secret: string }>;
}
export function composioWebhookClient(options: { fetch: HttpTransport; base?: string }): ComposioWebhookClient {
  const rest = composioProjectRest(options), signal = () => AbortSignal.timeout(30_000);
  const SUBSCRIPTION = /^[A-Za-z0-9_-]{1,128}$/;
  // The secret is checked for shape only and never echoed, logged or audited.
  const signed = (value: Record<string, unknown>, id: unknown) => {
    requireThat(typeof id === 'string' && SUBSCRIPTION.test(id) && typeof value.secret === 'string' && /^[\x21-\x7e]{16,512}$/.test(value.secret), 'connector_webhook_unconfirmed', 503);
    return { id: id as string, secret: value.secret as string };
  };
  return {
    async list(apiKey) {
      // UNVERIFIED: the list route and its `items` (or `data`) array.
      const value = await rest({ apiKey }, '/webhook_subscriptions', signal());
      const items = value.items ?? value.data;
      requireThat(Array.isArray(items) && items.length <= 50, 'connector_webhook_unconfirmed', 503);
      return (items as Record<string, unknown>[]).map(item => {
        requireThat(item && typeof item.id === 'string' && SUBSCRIPTION.test(item.id) && typeof item.webhook_url === 'string', 'connector_webhook_unconfirmed', 503);
        return { id: item.id as string, url: item.webhook_url as string };
      });
    },
    async create(apiKey, url) {
      const value = await rest({ apiKey }, '/webhook_subscriptions', signal(), { body: { webhook_url: url, enabled_events: [...WEBHOOK_EVENTS], version: 'V3' } });
      return signed(value, value.id);
    },
    async rotate(apiKey, id) {
      requireThat(SUBSCRIPTION.test(id), 'connector_webhook_unconfirmed', 503);
      return signed(await rest({ apiKey }, `/webhook_subscriptions/${id}/rotate_secret`, signal(), { method: 'POST' }), id);
    },
  };
}
