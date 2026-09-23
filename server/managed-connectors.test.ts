import { fictionalPdf } from './testing/pdf-fixture.ts';
import { attachmentHash } from './source-attachments.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readManagedMailAttachment, authorizeManagedConnection, managedConnectorAccess, managedConnectorSettings, scanManagedMail } from './managed-connectors.ts';
import { join } from 'node:path';
import { withWorkerProfile } from './hermes-profile.ts';
import { connectedAppsConfigured } from './connected-app-access.ts';
import { resolveConnectedAppsMcp } from './composio.ts';
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
  it('accepts a bounded disconnected response without tools or accounts', async () => {
    const value = { ...access(), services: { gmail: { connected: false, status: 'NOT_CONNECTED', accounts: [], accountSelectionRequired: false } }, tools: { available: false, names: [] } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    expect(await managedConnectorAccess(cfg)).toEqual(value);
  });
  it('allows only provider-owned sign-in links and never sends arbitrary account identity',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({url:'https://evil.invalid/'})));vi.stubGlobal('fetch',fetcher);
    await expect(authorizeManagedConnection(cfg,'gmail')).rejects.toThrow();
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({app:'gmail'});
    await expect(authorizeManagedConnection(cfg,'bank')).rejects.toThrow(/not part of this computer/);
    expect(fetcher).toHaveBeenCalledOnce();
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
    // The response cannot widen the grant: this app is not in the record.
    reply({ ...access(), services: { ...access().services, slack: outlook } });
    await expect(managedConnectorAccess(cfg)).rejects.toThrow('The managed connection response needs review.');
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
    await expect(authorizeManagedConnection(cfg, 'outlook')).rejects.toThrow(/not part of this computer/);
  });
});

describe('managed saved PDF bytes',()=>{
  const bytes=fictionalPdf(),selected={accountId:'account-one',messageId:'aa',threadId:'bb',attachment:{id:'pdf-one',name:'fictional.pdf',mimeType:'application/pdf' as const,size:bytes.length}};
  const envelope={...selected,bytesBase64:bytes.toString('base64'),sha256:attachmentHash(bytes)};
  it('binds the returned bytes to the requested source and sends only scoped device credentials',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope)));vi.stubGlobal('fetch',fetcher);
    expect(await readManagedMailAttachment(cfg,selected,new AbortController().signal)).toEqual(envelope);
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
