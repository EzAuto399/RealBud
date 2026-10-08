import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorEvents, eventRequestId } from './connector-events.ts';
import { needsSession, sessionOk, SESSION_TOKEN } from './session-auth.ts';
import { MANUAL_JOB_REQUEST_ID } from '../shared/manual-job-request.ts';
import type { Loop, LoopId, LoopRun } from '../shared/contracts.ts';

const managed = { composio: { managed: { endpoint: 'https://service.example/', credential: `rbc_${'c'.repeat(64)}`, profile: 'property' } } };
const gmail = (connected = true) => ({ connected, status: connected ? 'ACTIVE' : 'NOT_CONNECTED', accounts: connected ? [{ id: 'fictional-account', status: 'ACTIVE' }] : [], accountSelectionRequired: false });
const statusBody = (extra: Record<string, unknown> = {}) => ({ checkedAt: '2026-10-07T00:00:00.000Z', managed: true, serviceExpiresAt: 1_900_000_000_000,
  sourceKind: 'personal', policyRevision: 3, services: { gmail: gmail() }, tools: { available: true, names: ['GMAIL_GET_PROFILE'] }, ...extra });
const mail = (seq: number) => ({ seq, kind: 'message', source: 'personal', app: 'gmail', event: 'new-message', messageId: 'fictional-message', receivedAt: '2026-10-07T00:00:00.000Z' });

/** A gateway stand-in: status, the event pull (pages in order, then empty) and the trigger switch. */
function gateway(options: { pages?: unknown[]; status?: unknown; pullFails?: boolean } = {}) {
  const pages = [...(options.pages ?? [])], calls: { path: string; body?: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, headers: init.headers as Record<string, string> });
    if (path === '/v1/connectors/status') return Response.json(options.status ?? statusBody());
    if (path === '/v1/connectors/events') {
      if (options.pullFails) throw new TypeError('fictional network failure');
      return Response.json(pages.shift() ?? { events: [], cursor: body.after, gap: false, more: false });
    }
    if (path === '/v1/connectors/triggers') {
      // Like the gateway: a reviewed office policy (revision 3 here) must be named on the switch.
      if ((init.headers as Record<string, string>)['x-realbud-policy-revision'] !== '3') return Response.json({ error: 'office_mailbox_review_required' }, { status: 409 });
      return Response.json({ app: body.app, event: body.event, source: 'personal', enabled: body.enabled, state: body.enabled ? 'enabled' : 'disabled' });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return { calls, pulls: () => calls.filter(call => call.path === '/v1/connectors/events').map(call => call.body!.after) };
}

/** LoopManager's runNow contract: a known request id returns its run; a busy loop throws 409. */
function loopManager(patch: Partial<Loop> = {}) {
  const loop: Loop = { id: 'inbound-triage', name: 'Morning priorities', description: 'Fictional', available: true, enabled: true,
    schedule: { type: 'daily', time: '07:30', weekdays: [1, 2, 3, 4, 5] }, revision: 4, nextRunAt: null, evaluatorId: 'inbound-triage', evaluatorVersion: 1, ...patch };
  const runs = new Map<string, LoopRun>(), started: string[] = [];
  let busy = false;
  const runNow = vi.fn((id: LoopId, request: { requestId: string; expectedRevision: number }): LoopRun | null => {
    const existing = runs.get(request.requestId);
    if (existing) return existing;
    if (busy) throw Object.assign(new Error('this loop is already running'), { status: 409 });
    if (!loop.enabled) return null;
    const run: LoopRun = { id: `run-${runs.size + 1}`, loopId: id, loopName: loop.name, scheduledFor: 0, createdAt: 0, status: 'queued', manual: true, requestId: request.requestId };
    runs.set(request.requestId, run); started.push(request.requestId);
    return run;
  });
  return { loop, runNow, started, setBusy: (value: boolean) => { busy = value; }, listLoops: () => [loop] };
}

const tmp = () => join(mkdtempSync(join(tmpdir(), 'connector-events-')), 'connector-events.json');
const created: ConnectorEvents[] = [];
async function events(loops: ReturnType<typeof loopManager>, options: { file?: string; cfg?: object; flag?: boolean } = {}) {
  const file = options.file ?? tmp();
  const service = new ConnectorEvents({ cfg: () => (options.cfg ?? managed) as never, company: () => 'fictional-workspace', loops, file });
  created.push(service);
  if (options.flag !== false) await service.setNewMail('inbound-triage', true);
  service.start();
  return { service, file };
}
afterEach(() => { for (const service of created.splice(0)) service.stop(); vi.unstubAllGlobals(); });

describe('new mail wakes a loop', () => {
  it('coalesces a batch into one run and never runs a re-pulled batch twice', async () => {
    const net = gateway({ pages: [{ events: [mail(5), mail(7), { seq: 8, kind: 'account_activated', source: 'personal' }], cursor: 8, gap: false, more: false }] });
    const loops = loopManager();
    const { service, file } = await events(loops);
    await service.tick();
    expect(loops.runNow).toHaveBeenCalledOnce();
    const [, request] = loops.runNow.mock.calls[0]!;
    expect(request).toEqual({ requestId: eventRequestId('fictional-workspace:inbound-triage:4:event:7'), expectedRevision: 4 });
    expect(request.requestId).toMatch(MANUAL_JOB_REQUEST_ID);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, cursor: 8, binding: expect.stringMatching(/^[a-f0-9]{32}$/), newMail: { 'inbound-triage': true } });
    // The same batch again (at-least-once, or a restart before the cursor was saved): same request id, no second run.
    gateway({ pages: [{ events: [mail(7)], cursor: 8, gap: false, more: false }] });
    const again = await events(loops);
    await again.service.tick();
    expect(loops.runNow).toHaveBeenCalledTimes(2);
    expect(loops.runNow.mock.calls[1]![1].requestId).toBe(request.requestId);
    expect(loops.started).toHaveLength(1);
    expect(net.pulls()).toEqual([0]);
  });

  it('keeps the cursor while the loop is busy and runs once it is free', async () => {
    const net = gateway({ pages: [{ events: [mail(3)], cursor: 3, gap: false, more: false }, { events: [mail(3)], cursor: 3, gap: false, more: false }] });
    const loops = loopManager();
    const { service, file } = await events(loops);
    loops.setBusy(true);
    await service.tick();
    expect(loops.started).toHaveLength(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).cursor).toBe(0);
    loops.setBusy(false);
    await service.tick();
    expect(loops.started).toHaveLength(1);
    expect(net.pulls()).toEqual([0, 0]);
    await service.tick();
    expect(net.pulls()).toEqual([0, 0, 3]);
  });

  it('runs once for a gap, then not again', async () => {
    gateway({ pages: [{ events: [], cursor: 9, gap: true, more: false }] });
    const loops = loopManager();
    const { service } = await events(loops);
    await service.tick(); await service.tick();
    expect(loops.started).toEqual([eventRequestId('fictional-workspace:inbound-triage:4:gap:9')]);
  });

  it('does nothing for a paused loop: no pull, no run, the cursor stays', async () => {
    const net = gateway({ pages: [{ events: [mail(2)], cursor: 2, gap: false, more: false }] });
    const loops = loopManager({ enabled: false });
    const { service, file } = await events(loops);
    await service.tick();
    expect(net.pulls()).toEqual([]);
    expect(loops.runNow).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, 'utf8')).cursor).toBe(0);
  });

  it('wakes a saved repeat that asked for new mail, never a paused one', async () => {
    const repeat = { id: 'recipe-fictional-repeat' as LoopId, name: 'Fictional inbox check', evaluatorId: 'recipe' };
    for (const enabled of [true, false]) {
      gateway({ pages: [{ events: [mail(4)], cursor: 4, gap: false, more: false }] });
      const loops = loopManager({ ...repeat, enabled });
      const { service } = await events(loops, { flag: false });
      await service.setNewMail(repeat.id, true);
      await service.tick();
      expect(loops.started).toEqual(enabled ? [eventRequestId('fictional-workspace:recipe-fictional-repeat:4:event:4')] : []);
    }
  });

  it('does nothing without the flag or without managed connections', async () => {
    const net = gateway({ pages: [{ events: [mail(2)], cursor: 2, gap: false, more: false }] });
    const loops = loopManager();
    await (await events(loops, { flag: false })).service.tick();
    await (await events(loops, { flag: false, cfg: {} })).service.tick();
    expect(net.pulls()).toEqual([]);
    expect(loops.runNow).not.toHaveBeenCalled();
  });

  it('starts from 0 when the service endpoint or the computer credential changes, and never saves the credential', async () => {
    const net = gateway({ pages: [{ events: [mail(5)], cursor: 50, gap: false, more: false }, { events: [], cursor: 70, gap: false, more: false }] });
    const loops = loopManager(), file = tmp();
    let cfg: typeof managed = managed;
    const service = new ConnectorEvents({ cfg: () => cfg as never, company: () => 'fictional-workspace', loops, file });
    created.push(service);
    await service.setNewMail('inbound-triage', true);
    service.start();
    await service.tick();
    // A re-provisioned computer: cursor 50 belongs to the old credential and would acknowledge the new one's unread events.
    cfg = { composio: { managed: { ...managed.composio.managed, credential: `rbc_${'d'.repeat(64)}` } } };
    await service.tick(); await service.tick();
    cfg = { composio: { managed: { ...cfg.composio.managed, endpoint: 'https://other-service.example/' } } };
    await service.tick();
    expect(net.pulls()).toEqual([0, 0, 70, 0]);
    const saved = readFileSync(file, 'utf8');
    for (const secret of ['c'.repeat(64), 'd'.repeat(64)]) expect(saved).not.toContain(secret);
  });

  it('backs off after a failed pull without throwing into the timer', async () => {
    const net = gateway({ pullFails: true });
    const loops = loopManager();
    const { service } = await events(loops);
    await expect(service.tick()).resolves.toBeUndefined();
    await service.tick();
    expect(net.pulls()).toEqual([0]);
    expect(loops.runNow).not.toHaveBeenCalled();
  });
});

describe('the new-mail switch', () => {
  it('turns the gateway trigger on under the reviewed policy revision, then saves the flag', async () => {
    const net = gateway();
    const service = new ConnectorEvents({ cfg: () => managed as never, company: () => 'fictional-workspace', loops: loopManager(), file: tmp() });
    expect(await service.setNewMail('inbound-triage', true)).toEqual({ loopId: 'inbound-triage', enabled: true, available: true });
    const toggle = net.calls.find(call => call.path === '/v1/connectors/triggers')!;
    expect(toggle.body).toEqual({ app: 'gmail', event: 'new-message', enabled: true });
    expect(toggle.headers['x-realbud-policy-revision']).toBe('3');
    expect(await service.status('inbound-triage')).toEqual({ loopId: 'inbound-triage', enabled: true, available: true });
    expect(await service.setNewMail('inbound-triage', false)).toEqual({ loopId: 'inbound-triage', enabled: false, available: true });
  });

  it('says plainly why it is unavailable and saves nothing', async () => {
    const file = tmp();
    const off = new ConnectorEvents({ cfg: () => ({}) as never, company: () => 'w', loops: loopManager(), file });
    expect(await off.setNewMail('inbound-triage', true)).toEqual({ loopId: 'inbound-triage', enabled: false, available: false, reason: 'Available when Gmail is connected through your RealBud service.' });
    expect(await off.available()).toEqual({ available: false, reason: 'Available when Gmail is connected through your RealBud service.' });
    expect(existsSync(file)).toBe(false);
    gateway({ status: statusBody({ services: { gmail: gmail(false) }, tools: { available: false, names: [] } }) });
    const service = new ConnectorEvents({ cfg: () => managed as never, company: () => 'w', loops: loopManager(), file });
    expect(await service.setNewMail('inbound-triage', true)).toMatchObject({ enabled: false, available: false, reason: 'Connect Gmail in Connected apps first.' });
    expect(existsSync(file)).toBe(false);
  });

  it("surfaces the gateway's trigger state: expired asks to reconnect Gmail", async () => {
    const file = tmp();
    gateway();
    await new ConnectorEvents({ cfg: () => managed as never, company: () => 'w', loops: loopManager(), file }).setNewMail('inbound-triage', true);
    gateway({ status: statusBody({ services: { gmail: { connected: false, status: 'EXPIRED', accounts: [], accountSelectionRequired: false } }, tools: { available: false, names: [] },
      triggers: [{ app: 'gmail', event: 'new-message', source: 'personal', state: 'expired' }] }) });
    const service = new ConnectorEvents({ cfg: () => managed as never, company: () => 'w', loops: loopManager(), file });
    expect(await service.status('inbound-triage')).toEqual({ loopId: 'inbound-triage', enabled: true, available: false, reason: 'Reconnect Gmail in Connected apps. The morning run still happens.' });
    gateway({ status: statusBody({ triggers: [{ app: 'gmail', event: 'new-message', source: 'personal', state: 'provider_disabled' }] }) });
    expect((await service.status('inbound-triage')).reason).toBe('New-mail checks stopped. Turn this off and on again. The morning run still happens.');
  });

  it('turns off for an expired Gmail under the reviewed policy revision', async () => {
    const file = tmp();
    gateway();
    await new ConnectorEvents({ cfg: () => managed as never, company: () => 'w', loops: loopManager(), file }).setNewMail('inbound-triage', true);
    const net = gateway({ status: statusBody({ services: { gmail: { connected: false, status: 'EXPIRED', accounts: [], accountSelectionRequired: false } }, tools: { available: false, names: [] },
      triggers: [{ app: 'gmail', event: 'new-message', source: 'personal', state: 'expired' }] }) });
    const service = new ConnectorEvents({ cfg: () => managed as never, company: () => 'w', loops: loopManager(), file });
    expect(await service.setNewMail('inbound-triage', false)).toEqual({ loopId: 'inbound-triage', enabled: false, available: false, reason: 'Reconnect Gmail in Connected apps. The morning run still happens.' });
    expect(net.calls.find(call => call.path === '/v1/connectors/triggers')!.headers['x-realbud-policy-revision']).toBe('3');
    expect(JSON.parse(readFileSync(file, 'utf8')).newMail).toEqual({ 'inbound-triage': false });
  });

  it('keeps the shared Gmail trigger on while another loop still wants new mail', async () => {
    const net = gateway();
    const service = new ConnectorEvents({ cfg: () => managed as never, company: () => 'w', loops: loopManager(), file: tmp() });
    await service.setNewMail('inbound-triage', true);
    await service.setNewMail('recipe-fictional-repeat', true);
    const toggles = () => net.calls.filter(call => call.path === '/v1/connectors/triggers').map(call => call.body!.enabled);
    expect(await service.setNewMail('recipe-fictional-repeat', false)).toMatchObject({ enabled: false });
    expect(toggles()).toEqual([true, true]);
    await service.setNewMail('inbound-triage', false);
    expect(toggles()).toEqual([true, true, false]);
  });

  it('refuses every other loop id', async () => {
    const net = gateway();
    const service = new ConnectorEvents({ cfg: () => managed as never, company: () => 'w', loops: loopManager(), file: tmp() });
    for (const id of ['weekly-bills', 'morning-arrears', 'recipe-', 'recipe-../x']) {
      await expect(service.setNewMail(id, true)).rejects.toMatchObject({ status: 400 });
      await expect(service.status(id)).rejects.toMatchObject({ status: 400 });
    }
    await expect(service.setNewMail('inbound-triage', 'yes')).rejects.toMatchObject({ status: 400 });
    expect(net.calls).toEqual([]);
  });

  it('needs the per-boot session on the route', () => {
    for (const method of ['GET', 'POST']) {
      const path = '/api/loops/inbound-triage/new-mail';
      expect(needsSession(path, method)).toBe(true);
      const req = { url: path, method, headers: { host: '127.0.0.1:8799' } } as unknown as IncomingMessage;
      expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 401 });
      req.headers['x-realbud-session'] = SESSION_TOKEN;
      expect(sessionOk(req, 8799)).toEqual({ ok: true });
    }
  });
});
