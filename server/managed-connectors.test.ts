import { fictionalPdf } from './testing/pdf-fixture.ts';
import { attachmentHash } from './source-attachments.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedMailBindingRevision, readManagedMailAttachment, authorizeManagedConnection, managedConnectorAccess, managedConnectorSettings, managedMailboxAccess, scanManagedMail, pullConnectorEvents, setConnectorTrigger, managedConnectorTriggers } from './managed-connectors.ts';
import { join } from 'node:path';
import { withWorkerProfile } from './hermes-profile.ts';
import { connectedAppsConfigured } from './connected-app-access.ts';
import { resolveConnectedAppsMcp } from './composio.ts';
import { ConnectionAuthorizationError, connectionFailureReply } from './connection-outcome.ts';
const cfg={composio:{managed:{endpoint:'https://service.example/',credential:`rbc_${'a'.repeat(64)}`,profile:'property'}}};
const access = () => ({ checkedAt: '2026-09-21T00:00:00.000Z', managed: true, serviceExpiresAt: 1_800_000_000_000,
  services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: 'account-one', label: 'Practice mailbox', status: 'ACTIVE' }], accountSelectionRequired: false } },
  tools: { available: true, names: ['GMAIL_GET_PROFILE'] } });
afterEach(()=>vi.unstubAllGlobals());
describe('managed connector client',()=>{
  it('provides scoped broker headers without a vendor project key and pins private profile',async()=>{
    expect(connectedAppsConfigured(cfg)).toBe(true);
    const settings=await resolveConnectedAppsMcp(cfg);
    expect(settings.url).toBe('https://service.example/v1/connectors/mcp');
    expect(settings.headers).toEqual({authorization:`Bearer ${cfg.composio.managed.credential}`,'x-realbud-profile':'property'});
    expect(()=>withWorkerProfile('different-member',()=>managedConnectorSettings(cfg))).toThrow(/private workspace/);
  });
  it.each(['http://remote.example/','https://user:pass@service.example/','https://service.example/path','https://service.example/?key=x','https://service.example/#x'])('rejects unsafe endpoint %s',endpoint=>{
    expect(()=>managedConnectorSettings({composio:{managed:{...cfg.composio.managed,endpoint}}})).toThrow();
  });
  it('does not fall back to a local project key after managed configuration is invalid',async()=>{
    const broken={composio:{...cfg.composio,key:'ak_legacy_fictional',managed:{...cfg.composio.managed,credential:'bad'}}};
    await expect(resolveConnectedAppsMcp(broken)).rejects.toThrow();
  });
  it('shows current suspension and never reflects an upstream body',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response('secret provider detail',{status:402}));vi.stubGlobal('fetch',fetcher);
    await expect(managedConnectorAccess(cfg)).rejects.toThrow(/paused or expired/);
    expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });
  it('projects every status level without accidental credentials or diagnostic fields', async () => {
    const safe = access();
    const value = { ...safe, credential: 'fictional-device-secret', diagnostics: { providerKey: 'ak_fictional_top_secret' },
      services: { gmail: { ...safe.services.gmail, providerKey: 'ak_fictional_nested_secret',
        accounts: [{ ...safe.services.gmail.accounts[0], credential: 'fictional-account-secret', debug: { requestHeaders: 'fictional-private-headers' } }] } },
      tools: { ...safe.tools, diagnostic: { token: 'fictional-tool-secret' } } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    expect(await managedConnectorAccess(cfg)).toEqual(safe);
  });
  it.each([
    null, {}, { id: 'account-one' }, { id: 17, status: 'ACTIVE' }, { id: '../../other', status: 'ACTIVE' },
    { id: 'account-one', status: { active: true } }, { id: 'account-one', status: 'ACTIVE', label: { private: 'detail' } },
    { id: 'account-one', status: 'ACTIVE', label: 'bad\nlabel' }, { id: 'account-one', status: 'ACTIVE', label: 'x'.repeat(201) },
  ].map(account => ({ account })))('rejects a malformed account before exposing or caching it', async ({ account }) => {
    const value = access();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...value, services: { gmail: { ...value.services.gmail, accounts: [account] } } }))));
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
  });
  it.each([
    { connected: true, status: 'ACTIVE', accounts: [], accountSelectionRequired: false },
    { connected: true, status: 'ACTIVE', accounts: [{ id: 'a', status: 'DISABLED' }], accountSelectionRequired: false },
    { connected: true, status: 'ACTIVE', accounts: [{ id: 'a', status: 'ACTIVE' }], accountSelectionRequired: true },
    { connected: true, status: 7, accounts: [{ id: 'a', status: 'ACTIVE' }], accountSelectionRequired: false },
  ])('rejects inconsistent or incomplete connection status', async gmail => {
    const value = access();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...value, services: { gmail } }))));
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
  });
  it('learns from status whether Gmail is a read-only shared mailbox, keeps that out of the projection, and rejects an unknown scope', async () => {
    const credential = cfg.composio.managed.credential;
    const answer = (extra: Record<string, unknown>) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...access(), ...extra })));
    answer({ sourceKind: 'office_shared', policyRevision: 4, mailboxAccess: 'read_only' });
    expect(await managedConnectorAccess(cfg)).not.toHaveProperty('mailboxAccess');
    expect(managedMailboxAccess(credential)).toBe('read_only');
    answer({ sourceKind: 'office_shared', policyRevision: 5, mailboxAccess: 'full' });
    await managedConnectorAccess(cfg); expect(managedMailboxAccess(credential)).toBe('full');
    // An older gateway: a shared mailbox without a reported grant is read-only; a personal one is unknown.
    answer({ sourceKind: 'office_shared', policyRevision: 6 });
    await managedConnectorAccess(cfg); expect(managedMailboxAccess(credential)).toBe('read_only');
    answer({ sourceKind: 'personal', policyRevision: 0 });
    await managedConnectorAccess(cfg); expect(managedMailboxAccess(credential)).toBeUndefined();
    answer({ sourceKind: 'office_shared', policyRevision: 7, mailboxAccess: 'everything' });
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
    expect(managedMailboxAccess('rbc_' + 'b'.repeat(64))).toBeUndefined();
  });
  it('mailbox mode both: projects the office mailbox beside the own one, keeps its scope separately, and selects it only by header', async () => {
    const credential = cfg.composio.managed.credential;
    const office = { connected: true, status: 'ACTIVE', accounts: [{ id: 'office-account', status: 'ACTIVE' }], accountSelectionRequired: false, debug: 'never' };
    const answer = (extra: Record<string, unknown>) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...access(), ...extra })));
    answer({ sourceKind: 'personal', policyRevision: 5, mailboxMode: 'both', mailboxAccess: 'full', officeShared: office, officeMailboxAccess: 'read_only' });
    const status = await managedConnectorAccess(cfg);
    expect(status).toMatchObject({ mailboxMode: 'both', services: { gmail: { accounts: [{ id: 'account-one' }] } } });
    expect(status.officeShared).toEqual({ connected: true, status: 'ACTIVE', accounts: [{ id: 'office-account', status: 'ACTIVE' }], accountSelectionRequired: false });
    expect(managedMailboxAccess(credential)).toBe('full'); expect(managedMailboxAccess(credential, 'office')).toBe('read_only');
    // No office mailbox outside `both`, and a malformed one is refused.
    answer({ sourceKind: 'office_shared', policyRevision: 6, mailboxMode: 'shared', officeShared: office });
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
    answer({ sourceKind: 'personal', policyRevision: 6, mailboxMode: 'both', officeShared: { ...office, connected: false } });
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
    answer({ sourceKind: 'personal', policyRevision: 6, mailboxMode: 'everyone' });
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
    answer({ sourceKind: 'personal', policyRevision: 7, mailboxMode: 'both' });
    expect((await managedConnectorAccess(cfg)).officeShared).toBeUndefined(); expect(managedMailboxAccess(credential, 'office')).toBeUndefined();
    expect(managedConnectorSettings(cfg as never, 7, 'office').headers['x-realbud-mailbox']).toBe('office');
    expect(managedConnectorSettings(cfg as never, 7).headers).not.toHaveProperty('x-realbud-mailbox');
  });
  it('accepts a bounded disconnected response without tools or accounts', async () => {
    const value = { ...access(), services: { gmail: { connected: false, status: 'NOT_CONNECTED', accounts: [], accountSelectionRequired: false } }, tools: { available: false, names: [] } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    expect(await managedConnectorAccess(cfg)).toEqual(value);
  });
  it('allows only provider-owned sign-in links and never sends arbitrary account identity',async()=>{
    const fetcher=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({url:'https://evil.invalid/'})));vi.stubGlobal('fetch',fetcher);
    await expect(authorizeManagedConnection(cfg,'gmail')).rejects.toThrow();
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({app:'gmail'});
    // Any toolkit slug goes to the gateway, which admits it into the office's
    // project or refuses; a malformed name never leaves this computer.
    await expect(authorizeManagedConnection(cfg,'bank')).rejects.toThrow(/needs review/);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({app:'bank'});
    await expect(authorizeManagedConnection(cfg,'Bank!')).rejects.toThrow(/Name the app/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async()=>new Response('provider detail',{status:404}));
    await expect(authorizeManagedConnection(cfg,'nosuchapp')).rejects.toThrow(/result needs review/);
  });
  it('keeps an explicit unsupported-app rejection distinct from an opened or uncertain sign-in', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'connector_app_not_admitted' }), { status: 403 })); vi.stubGlobal('fetch', fetcher);
    const error = await authorizeManagedConnection(cfg, 'googlesheets').catch(error => error);
    expect(error).toBeInstanceOf(ConnectionAuthorizationError);
    expect(error).toMatchObject({ outcome: 'not-started', reason: 'not-admitted', status: 403 });
    expect(connectionFailureReply('Google Sheets', error, true)).toContain('has not enabled sign-in');
    expect(connectionFailureReply('Google Sheets', error, true)).not.toContain('Finish any');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not invent an open sign-in window after the design preview returns 404 with an empty envelope', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 404 })); vi.stubGlobal('fetch', fetcher);
    const error = await authorizeManagedConnection(cfg, 'googlesheets').catch(error => error);
    expect(error).toBeInstanceOf(ConnectionAuthorizationError);
    expect(error).toMatchObject({ outcome: 'unknown', status: 404 });
    expect(error.message).toContain('result needs review');
    const reply = connectionFailureReply('Google Sheets', error, true);
    expect(reply).toContain("couldn't confirm whether Google Sheets sign-in was created");
    expect(reply).toContain('reconcile the existing attempt');
    expect(reply).not.toMatch(/Finish any|already open|did not start|No sign-in link was opened/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    { body: '{broken', status: 403 },
    { body: JSON.stringify({ error: 'connector_app_not_admitted', privateKey: 'fictional-private' }), status: 403 },
    { body: JSON.stringify({ error: 'connector_link_outcome_unknown' }), status: 409 },
    { body: 'x'.repeat(4097), status: 403 },
    { body: JSON.stringify({ error: 'connector_app_not_admitted' }), status: 502 },
    { body: JSON.stringify({ url: 'https://evil.invalid/?token=fictional-private' }), status: 200 },
    { body: JSON.stringify({}), status: 200 },
  ])('preserves unknown outcomes without disclosing error bodies or issuing a second request', async ({ body, status }) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status })); vi.stubGlobal('fetch', fetcher);
    const error = await authorizeManagedConnection(cfg, 'googlesheets').catch(error => error);
    expect(error).toMatchObject({ outcome: 'unknown' });
    expect(String(error)).not.toMatch(/fictional-private|evil|broken/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('distinguishes local setup refusal from a lost transport response and preserves valid links', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('secret lost response')).mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://connect.composio.dev/link/fictional' }))); vi.stubGlobal('fetch', fetcher);
    await expect(authorizeManagedConnection({ composio: { managed: { ...cfg.composio.managed, credential: 'invalid' } } }, 'googlesheets')).rejects.toMatchObject({ outcome: 'not-started', reason: 'setup' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(authorizeManagedConnection(cfg, 'googlesheets')).rejects.toMatchObject({ outcome: 'unknown' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await authorizeManagedConnection(cfg, 'googlesheets')).toEqual({ url: 'https://connect.composio.dev/link/fictional' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('managed mail source precondition', () => {
  const scope = { windowStartAt: 1_799_913_600_000, windowEndAt: 1_800_000_000_000, includeSent: false, maxMessages: 10, carryThreadIds: [] };
  const result = { accountId: 'account-reviewed', windowStartAt: scope.windowStartAt, windowEndAt: scope.windowEndAt, pages: 1, paginationComplete: true, threads: [], gaps: [] };
  it('sends the exact reviewed account as a gateway precondition alongside unchanged canonical scope', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(result))); vi.stubGlobal('fetch', fetcher);
    expect(await scanManagedMail(cfg, result.accountId, scope, new AbortController().signal)).toEqual(result);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ expectedAccountId: result.accountId, scope });
    expect(fetcher.mock.calls[0][1].headers['x-realbud-profile']).toBe('property');
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });
  it.each(['', '../other-account', 'a'.repeat(129), 'account\nsecret'])('rejects invalid reviewed account locally without transport: %s', async accountId => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(scanManagedMail(cfg, accountId, scope, new AbortController().signal)).rejects.toThrow(/Review and select/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('holds stale account admission with actionable local guidance and no upstream diagnostics', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('secret provider detail', { status: 409 })); vi.stubGlobal('fetch', fetcher);
    await expect(scanManagedMail(cfg, 'account-reviewed', scope, new AbortController().signal)).rejects.toThrow('The Gmail connection changed. Review the connected account and approve the mail source again before scanning.');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('fails closed against a legacy service and retains result-account validation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('secret server detail', { status: 400 })).mockResolvedValueOnce(new Response(JSON.stringify({ ...result, accountId: 'other-account' }))); vi.stubGlobal('fetch', fetcher);
    await expect(scanManagedMail(cfg, 'account-reviewed', scope, new AbortController().signal)).rejects.toThrow(/compatible managed service/);
    await expect(scanManagedMail(cfg, 'account-reviewed', scope, new AbortController().signal)).rejects.toThrow(/mail source or its coverage needs review/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('per-installation app allowlist', () => {
  const provisioned = async (apps: string[]) => {
    const { DATA_DIR } = await import('./config.ts');
    const { writePrivateJson } = await import('./private-json.ts');
    await writePrivateJson(join(DATA_DIR, 'service-provisioning.json'), { version: 1, state: 'active', installationId: 'installation-a',
      companyId: 'fictional-office', hostInstallationId: 'fictional-host-1', provider: 'modelvia', projectId: 'proj-fictional-01', keyId: 'rbkkey-01',
      baseUrl: 'https://api.modelvia.dev/v1', spendCapLabel: 'AU$40 per month', apps, provisionedAt: '2026-09-22T00:00:00.000Z' });
  };
  const reply = (value: unknown) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
  const outlook = { connected: true, status: 'ACTIVE', accounts: [{ id: 'account-two', status: 'ACTIVE' }], accountSelectionRequired: false };

  it('admits a granted app beyond Gmail and refuses one this installation was never granted', async () => {
    await provisioned(['gmail', 'outlook']);
    const value = { ...access(), services: { ...access().services, outlook }, tools: { available: true, names: ['GMAIL_GET_PROFILE', 'OUTLOOK_LIST_MESSAGES'] } };
    reply(value);
    expect(await managedConnectorAccess(cfg)).toEqual(value);
    // Without an admitted-app list the linked record is the grant: an unlisted app is refused.
    reply({ ...access(), services: { ...access().services, slack: outlook } });
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
    // The gateway's admitted-app list for this credential widens it (the office
    // admitted Slack on the person's ask), but can never drop a linked app.
    const admitted = { ...access(), apps: ['gmail', 'outlook', 'slack'], services: { ...access().services, slack: outlook }, tools: { available: true, names: ['GMAIL_GET_PROFILE', 'SLACK_LIST_CHANNELS', 'SLACK_POST_MESSAGE'] } };
    reply(admitted);
    const { apps: _apps, ...projected } = admitted;
    expect(await managedConnectorAccess(cfg)).toEqual(projected);
    reply({ ...admitted, apps: ['gmail', 'slack'] });
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
    // A destructive, bulk or administrative tool name is refused whatever the gateway lists.
    for (const name of ['SLACK_DELETE_MESSAGE', 'SLACK_ADMIN_USERS_REMOVE', 'SLACK_BULK_ARCHIVE']) {
      reply({ ...admitted, tools: { available: true, names: [name] } });
      await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
    }
    // Nor can it borrow another app's tool namespace, or add a Gmail tool.
    reply({ ...access(), tools: { available: true, names: ['SLACK_POST_MESSAGE'] } });
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
    reply({ ...access(), tools: { available: true, names: ['GMAIL_SEND_EMAIL'] } });
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
  });

  it('defaults to Gmail only when the installation carries no provisioning record', async () => {
    const { DATA_DIR } = await import('./config.ts');
    const { removePrivateJson } = await import('./private-json.ts');
    await removePrivateJson(join(DATA_DIR, 'service-provisioning.json'));
    reply({ ...access(), services: { ...access().services, outlook } });
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
    // Connecting is still open to any app: the gateway decides, not the record.
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'https://connect.composio.dev/link/fictional' }))); vi.stubGlobal('fetch', fetcher);
    expect(await authorizeManagedConnection(cfg, 'outlook')).toEqual({ url: 'https://connect.composio.dev/link/fictional' });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ app: 'outlook' });
  });
});

describe('managed saved PDF bytes',()=>{
  const bytes=fictionalPdf(),selected={accountId:'account-one',messageId:'aa',threadId:'bb',attachment:{id:'pdf-one',name:'fictional.pdf',mimeType:'application/pdf' as const,size:bytes.length}};
  const envelope={...selected,bytesBase64:bytes.toString('base64'),sha256:attachmentHash(bytes)};
  it('binds the returned bytes to the requested source and sends only scoped device credentials',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope)));vi.stubGlobal('fetch',fetcher);
    expect(await readManagedMailAttachment(cfg,selected,new AbortController().signal,5)).toEqual(envelope);
    expect(fetcher.mock.calls[0][1].headers['x-realbud-policy-revision']).toBe('5');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(selected);expect(String(fetcher.mock.calls[0][0]).endsWith('/v1/connectors/mail-attachment')).toBe(true);
  });
  it.each([{accountId:'other'},{sha256:'0'.repeat(64)},{downloadUrl:'https://evil.invalid'}])('rejects unbound or tampered gateway bytes %j',async change=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({...envelope,...change}))));
    await expect(readManagedMailAttachment(cfg,selected,new AbortController().signal)).rejects.toThrow();
  });
  it('rejects oversized source locally before transport',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await expect(readManagedMailAttachment(cfg,{...selected,attachment:{...selected.attachment,size:2_000_001}},new AbortController().signal)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  });
});


describe('office shared mailbox authority', () => {
  it('preserves trusted policy identity even before the owner connects a shared mailbox', async () => {
    const value = { ...access(), sourceKind: 'office_shared', policyRevision: 3,
      services: { gmail: { connected: false, status: 'NOT_CONNECTED', accounts: [], accountSelectionRequired: false } }, tools: { available: false, names: [] } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    expect(await managedConnectorAccess(cfg)).toEqual(value);
  });
  it.each([{ sourceKind: 'other', policyRevision: 1 }, { sourceKind: 'office_shared' }, { policyRevision: 1 }, { sourceKind: 'office_shared', policyRevision: -1 }, { sourceKind: 'personal', policyRevision: 1.5 }])('rejects incomplete policy identity %j', async policy => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...access(), ...policy }))));
    await expect(managedConnectorAccess(cfg)).rejects.toThrow(/needs review/);
  });
  it('invalidates a same-account binding after revoke/regrant, account replacement or source mode change', () => {
    const source = { ...access(), sourceKind: 'office_shared' as const, policyRevision: 1 };
    const revision = (value = source) => managedMailBindingRevision('workspace-a', 'property', cfg.composio, value);
    expect(revision()).toBe(revision({ ...source, checkedAt: '2026-09-22T00:00:00.000Z' }));
    expect(revision()).not.toBe(revision({ ...source, policyRevision: 3 }));
    expect(revision()).not.toBe(managedMailBindingRevision('workspace-a', 'property', cfg.composio, { ...source, sourceKind: 'personal' }));
    expect(revision()).not.toBe(revision({ ...source, services: { gmail: { ...source.services.gmail, accounts: [{ id: 'replacement', label: 'Replacement mailbox', status: 'ACTIVE' }] } } }));
  });
  it('pins the reviewed policy revision in MCP settings without upgrading another turn', async () => {
    expect((await resolveConnectedAppsMcp(cfg, null, 7)).headers['x-realbud-policy-revision']).toBe('7');
    expect((await resolveConnectedAppsMcp(cfg, null, 2)).headers['x-realbud-policy-revision']).toBe('2');
    expect(managedConnectorSettings(cfg).headers).not.toHaveProperty('x-realbud-policy-revision');
  });
  it('sends the reviewed policy revision and surfaces stale-policy scan denial', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 409 })); vi.stubGlobal('fetch', fetcher);
    const scope = { windowStartAt: 1_790_000_000_000, windowEndAt: 1_790_086_400_000, maxMessages: 10, includeSent: true, carryThreadIds: [] };
    await expect(scanManagedMail(cfg, 'account-one', scope, new AbortController().signal, 4)).rejects.toThrow(/changed/);
    expect(fetcher.mock.calls[0][1].headers['x-realbud-policy-revision']).toBe('4');
  });
});

describe('managed connector event triggers', () => {
  it('pulls event ids only, after the cursor, and refuses a malformed page', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ events: [{ seq: 4, kind: 'message', source: 'personal', app: 'gmail', event: 'new-message', messageId: 'fictional-message', receivedAt: '2026-10-07T00:00:00.000Z', subject: 'fictional subject' }], cursor: 6, gap: false, more: false }));
    vi.stubGlobal('fetch', fetcher);
    expect(await pullConnectorEvents(cfg as never, 2)).toEqual({ events: [{ seq: 4, kind: 'message', app: 'gmail', event: 'new-message' }], cursor: 6, gap: false, more: false });
    expect(new URL(fetcher.mock.calls[0][0]).pathname).toBe('/v1/connectors/events');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ after: 2 });
    expect(fetcher.mock.calls[0][1].headers.authorization).toBe(`Bearer ${cfg.composio.managed.credential}`);
    for (const page of [{ events: [{ seq: 'x', kind: 'message' }], cursor: 1, gap: false, more: false }, { events: [], cursor: -1, gap: false, more: false }, { events: [], cursor: 1, gap: 'no', more: false }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(page)));
      await expect(pullConnectorEvents(cfg as never, 0)).rejects.toThrow('The managed connection response needs review.');
    }
    await expect(pullConnectorEvents(cfg as never, -1)).rejects.toThrow();
  });
  it('switches the one trigger with the policy revision and keeps trigger states out of the status projection', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ app: 'gmail', event: 'new-message', source: 'personal', enabled: true, state: 'enabled' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await setConnectorTrigger(cfg as never, 'gmail', 'new-message', true, 3)).toEqual({ enabled: true, state: 'enabled' });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ app: 'gmail', event: 'new-message', enabled: true });
    expect(fetcher.mock.calls[0][1].headers['x-realbud-policy-revision']).toBe('3');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ app: 'gmail', event: 'new-message', source: 'personal', enabled: false, state: 'disabled' })));
    await expect(setConnectorTrigger(cfg as never, 'gmail', 'new-message', true)).rejects.toThrow('The managed connection response needs review.');
    const triggers = [{ app: 'gmail', event: 'new-message', source: 'office', state: 'expired' }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...access(), triggers })));
    expect(await managedConnectorAccess(cfg)).toEqual(access());
    expect(managedConnectorTriggers(cfg as never)).toEqual(triggers);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...access(), triggers: [{ ...triggers[0], state: 'Expired!' }] })));
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
  });
});
