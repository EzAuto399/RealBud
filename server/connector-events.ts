/**
 * "Also check when new mail arrives" for a loop. The gateway turns a Gmail
 * trigger on; this pulls its event ids about once a minute and wakes the
 * code-owned loop through `runNow`. Nothing from an event reaches the model: the
 * loop reads mail through its own reviewed scan. The clock stays the
 * completeness guarantee; events only cut latency (Gmail polls every 15 min).
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR, type AppConfig } from './config.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { managedConnectorAccess, managedConnectorConfigured, managedConnectorSettings, managedConnectorTriggers, pullConnectorEvents, setConnectorTrigger, type ManagedTrigger } from './managed-connectors.ts';
import type { Loop, LoopId, LoopRun } from './routines.ts';

/** Morning priorities and saved jobs (recipe-*, such as a repeat Bud proposed) have the switch; new mail
 * wakes a saved job only while its plan reads mail (`readsMail`), and turning it off always works. */
const eligible = (loopId: string) => loopId === 'inbound-triage' || /^recipe-[\w-]+$/.test(loopId);
const NEEDS_MAIL = 'Only a saved job that reads mail can also check when new mail arrives. Add "Read the reviewed mailbox" to its plan first.';
const NOT_MANAGED = 'Available when Gmail is connected through your RealBud service.';
const CONNECT_GMAIL = 'Connect Gmail in Connected apps first.';
const RECONNECT_GMAIL = 'Reconnect Gmail in Connected apps. The morning run still happens.';
const STOPPED = 'New-mail checks stopped. Turn this off and on again. The morning run still happens.';

export type NewMailState = { loopId: string; enabled: boolean; available: boolean; reason?: string };
/** `binding` names the service endpoint and computer credential the cursor came from (a hash prefix, never the credential). */
type State = { version: 1; cursor: number; binding?: string; newMail: Record<string, boolean> };

/** A cursor from another endpoint or credential would acknowledge events this computer never read. */
const cursorBinding = (cfg: AppConfig): string => {
  const { url, key } = managedConnectorSettings(cfg);
  return createHash('sha256').update(`realbud-connector-cursor\0${url}\0${key}`).digest('hex').slice(0, 32);
};

export interface ConnectorEventsOptions {
  cfg: () => AppConfig;
  /** Namespaces the derived run request ids (the workspace id). */
  company: () => string;
  loops: { listLoops(): Loop[]; runNow(id: LoopId, request: { requestId: string; expectedRevision: number }): LoopRun | null };
  /** Whether a saved job's (recipe-*) current plan has the read-mail ability. Without it no saved job wakes. */
  readsMail?: (loopId: string) => boolean;
  /** Background work runs in the member's worker profile and the workspace activity gate. */
  runContext?: <T>(work: () => Promise<T>) => Promise<T>;
  file?: string;
  intervalMs?: number;
  now?: () => number;
}

/** UUID-shaped (shared/manual-job-request.ts) and stable for one batch. */
export const eventRequestId = (key: string): string => {
  const hex = createHash('sha256').update(key).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

function parseState(value: unknown): State {
  if (value === undefined) return { version: 1, cursor: 0, newMail: {} };
  const record = value as Partial<State> | null;
  if (!record || typeof record !== 'object' || record.version !== 1 || !Number.isSafeInteger(record.cursor) || record.cursor! < 0 ||
    (record.binding !== undefined && (typeof record.binding !== 'string' || !/^[a-f0-9]{32}$/.test(record.binding))) ||
    !record.newMail || typeof record.newMail !== 'object' || Object.values(record.newMail).some(flag => typeof flag !== 'boolean')) {
    throw Object.assign(new Error('New-mail checks need recovery. Saved schedules are unchanged.'), { status: 503 });
  }
  return { version: 1, cursor: record.cursor!, ...(record.binding ? { binding: record.binding } : {}), newMail: { ...record.newMail } };
}

export class ConnectorEvents {
  private readonly options: ConnectorEventsOptions;
  private readonly file: string;
  private readonly now: () => number;
  private state: Promise<State> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pulling = false;
  private failures = 0;
  private retryAt = 0;

  constructor(options: ConnectorEventsOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, 'connector-events.json');
    this.now = options.now ?? Date.now;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A damaged file holds every change and is never cleared; a read error is retried. */
  private load(): Promise<State> {
    this.state ??= readPrivateJson(this.file).then(parseState);
    return this.state.catch(error => { this.state = null; throw error; });
  }

  /** Mutate the one in-memory state, then write it; writes go in order. */
  private async update(change: (state: State) => void) {
    const state = await this.load();
    change(state);
    const write = this.saving.then(() => writePrivateJson(this.file, state));
    this.saving = write.catch(() => {});
    // An unsaved change is dropped from memory too: the file stays the truth.
    try { await write; } catch (error) { this.state = null; throw error; }
  }

  /** One pull, never throwing into the timer. A failed pull backs off up to 15 minutes. */
  async tick(): Promise<void> {
    if (!this.timer || this.pulling || this.now() < this.retryAt) return;
    this.pulling = true;
    try {
      await (this.options.runContext ?? (work => work()))(() => this.pull());
      this.failures = 0; this.retryAt = 0;
    } catch {
      this.failures++;
      this.retryAt = this.now() + Math.min(15 * 60_000, (this.options.intervalMs ?? 60_000) * 2 ** this.failures);
    } finally { this.pulling = false; }
  }

  private async pull() {
    const cfg = this.options.cfg();
    if (!managedConnectorConfigured(cfg)) return;
    const state = await this.load();
    // A paused loop does nothing: no pull, no run, the cursor stays for when it resumes.
    const wake = () => this.options.loops.listLoops().filter(loop => this.wakes(loop.id) && state.newMail[loop.id] === true && loop.enabled && loop.available);
    if (!wake().length) return;
    // A cursor saved under another endpoint or credential starts over at 0, which acknowledges nothing.
    const binding = cursorBinding(cfg);
    const page = await pullConnectorEvents(cfg, state.binding === binding ? state.cursor : 0);
    const loops = wake();
    if (!this.timer || !loops.length) return;
    const mail = page.events.filter(event => event.kind === 'message' && event.app === 'gmail' && event.event === 'new-message');
    if (mail.length || page.gap) {
      // One run per batch. The id repeats for a re-pulled batch, so runNow returns that run instead of starting another.
      const batch = mail.length ? `event:${Math.max(...mail.map(event => event.seq))}` : `gap:${page.cursor}`;
      for (const loop of loops) {
        try {
          if (!this.options.loops.runNow(loop.id, { requestId: eventRequestId(`${this.options.company()}:${loop.id}:${loop.revision}:${batch}`), expectedRevision: loop.revision })) return;
        } catch { return; } // Busy or held: keep the cursor and try again on the next pull.
      }
    }
    await this.update(saved => { saved.cursor = page.cursor; saved.binding = binding; });
  }

  private assertEligible(loopId: string) {
    if (!eligible(loopId)) throw Object.assign(new Error('Only Morning priorities and saved jobs can also check when new mail arrives.'), { status: 400 });
  }

  private wakes(loopId: string) {
    return loopId === 'inbound-triage' || (eligible(loopId) && this.options.readsMail?.(loopId) === true);
  }

  /** Managed Gmail, connected, and the gateway trigger's last known state. */
  private async availability(cfg: AppConfig): Promise<{ available: boolean; reason?: string; policyRevision?: number; trigger?: ManagedTrigger }> {
    if (!managedConnectorConfigured(cfg)) return { available: false, reason: NOT_MANAGED };
    const access = await managedConnectorAccess(cfg);
    const triggers = managedConnectorTriggers(cfg).filter(row => row.app === 'gmail' && row.event === 'new-message');
    const trigger = triggers.find(row => row.state === 'expired') ?? triggers.find(row => row.state === 'provider_disabled') ?? triggers[0];
    // The revision travels here too: turning off an expired Gmail's trigger is still reviewed by the gateway.
    if (!access.services.gmail?.connected) return { available: false, reason: trigger?.state === 'expired' ? RECONNECT_GMAIL : CONNECT_GMAIL, policyRevision: access.policyRevision, trigger };
    return { available: true, policyRevision: access.policyRevision, trigger };
  }

  /** Whether new mail can wake a loop on this computer now (a repeat Bud proposes checks before its card). */
  async available(): Promise<{ available: boolean; reason?: string }> {
    try {
      const access = await this.availability(this.options.cfg());
      return { available: access.available, ...(access.reason ? { reason: access.reason } : {}) };
    } catch (error) {
      return { available: false, reason: error instanceof Error && error.message ? error.message : 'Gmail could not be checked. Try again.' };
    }
  }

  async status(loopId: string): Promise<NewMailState> {
    this.assertEligible(loopId);
    const enabled = (await this.load()).newMail[loopId] === true;
    try {
      const access = await this.availability(this.options.cfg());
      // Turned on here but not running at the gateway (expired, stopped by the provider, or turned off there).
      const reason = access.reason ?? (enabled && access.trigger && access.trigger.state !== 'enabled' ? STOPPED : undefined);
      return { loopId, enabled, available: access.available, ...(reason ? { reason } : {}) };
    } catch (error) {
      return { loopId, enabled, available: false, reason: error instanceof Error && error.message ? error.message : 'Gmail could not be checked. Try again.' };
    }
  }

  /** The gateway toggle first, then the saved flag. Turning on needs managed, connected Gmail. */
  async setNewMail(loopId: string, enabled: unknown): Promise<NewMailState> {
    this.assertEligible(loopId);
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('Send enabled as true or false.'), { status: 400 });
    if (enabled && !this.wakes(loopId)) throw Object.assign(new Error(NEEDS_MAIL), { status: 400 });
    const saved = (await this.load()).newMail[loopId] === true;
    const cfg = this.options.cfg(), access = await this.availability(cfg);
    const result = { loopId, available: access.available, ...(access.reason ? { reason: access.reason } : {}) };
    if (enabled && !access.available) return { ...result, enabled: saved };
    // Turning off always works: without managed Gmail there is no gateway trigger to stop.
    // The gateway trigger is one per mailbox, so it stays on while another existing loop still wants new mail.
    const wanted = (await this.load()).newMail, othersWant = this.options.loops.listLoops().some(loop => loop.id !== loopId && wanted[loop.id] === true);
    if (managedConnectorConfigured(cfg) && (enabled || !othersWant)) await setConnectorTrigger(cfg, 'gmail', 'new-message', enabled, access.policyRevision);
    await this.update(state => { state.newMail[loopId] = enabled; });
    return { ...result, enabled };
  }
}
