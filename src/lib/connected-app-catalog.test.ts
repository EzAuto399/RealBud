import { describe, expect, it } from 'vitest';
import type { ConnectedAppsStatus, ConnectedService } from '@shared/office-sources';
import type { HermiosConnectionState } from '@shared/hermios-connection';
import type { ConnectorState } from '@shared/mcp-connector';
import { appConnectionPrompt, connectedAppCatalog, filterConnectedAppCatalog, HERMIOS_APP_SLUG, REDBARK_APP_SLUG } from './connected-app-catalog';

const options = { configured: true, readOnly: false, managed: true };
const service = (connected = false): ConnectedService => ({ connected, status: connected ? 'ACTIVE' : 'NOT_CONNECTED', accounts: connected ? [{ id: 'account-1', label: 'Office account', status: 'ACTIVE' }] : [], accountSelectionRequired: false });
const snapshot = (): ConnectedAppsStatus => ({ configured: true, checkedAt: new Date().toISOString(), sourceKind: 'personal', policyRevision: 1, services: { gmail: service() }, tools: { available: true, names: ['app_tools'] } });

describe('app discovery uses observed connection authority', () => {
  it('distinguishes common suggestions from offered connections without inventing accounts', () => {
    const status = snapshot();
    let catalog = connectedAppCatalog(status, options);
    expect(catalog.find(app => app.slug === 'gmail')).toMatchObject({ origin: 'reported', action: 'connect', connected: false });
    expect(catalog.find(app => app.slug === 'xero')).toMatchObject({ origin: 'suggested', action: 'find', connected: false, status: 'Availability not checked' });
    status.services.xero = service();
    catalog = connectedAppCatalog(status, options);
    expect(catalog.filter(app => app.slug === 'xero')).toHaveLength(1);
    expect(catalog.find(app => app.slug === 'xero')).toMatchObject({ origin: 'reported', action: 'connect' });
    expect(status.services.xero.accounts).toEqual([]);
  });

  it('retains provider-listed apps outside the common catalog and prioritizes connected ones', () => {
    const status = snapshot(); status.services.office_archive = service(true);
    const catalog = connectedAppCatalog(status, options);
    expect(catalog[0].slug).toBe(HERMIOS_APP_SLUG);
    expect(catalog[1]).toMatchObject({ slug: 'office_archive', label: 'Office Archive', connected: true, action: null });
    expect(filterConnectedAppCatalog(catalog, '', 'connected').map(app => app.slug)).toEqual(['office_archive']);
  });

  it('keeps shared Gmail and unknown managed status out of personal connection actions', () => {
    const status = snapshot(); status.sourceKind = 'office_shared';
    expect(connectedAppCatalog(status, options).find(app => app.slug === 'gmail')).toMatchObject({ action: null, status: 'Office setup needed' });
    expect(connectedAppCatalog(null, options).find(app => app.slug === 'gmail')).toMatchObject({ action: null, status: 'Check access first' });
    status.sourceKind = 'personal'; status.error = 'Access unavailable';
    expect(connectedAppCatalog(status, options).find(app => app.slug === 'gmail')?.action).toBeNull();
  });

  it('does not offer repeated sign-in for pending, excluded or connected apps', () => {
    const status = snapshot(); status.services.gmail.status = 'PENDING'; status.services.slack = service(true); status.services.xero = service(); status.excludedApps = ['xero'];
    const catalog = connectedAppCatalog(status, options);
    for (const slug of ['gmail', 'slack', 'xero']) expect(catalog.find(app => app.slug === slug)?.action).toBeNull();
    expect(catalog.find(app => app.slug === 'xero')?.status).toBe('Off in Ask');
  });

  it('preserves Gmail-only mode and holds all actions when service setup is missing', () => {
    expect(connectedAppCatalog(snapshot(), { ...options, readOnly: true }).map(app => app.slug)).toEqual(['hermios-native', 'gmail', 'redbark-native']);
    expect(connectedAppCatalog(null, { ...options, configured: false }).every(app => app.action === null)).toBe(true);
  });

  it('never counts a generic provider app named after Hermios as Bud\'s Hermios connection', () => {
    const status = snapshot(); status.services.hermios = service(true);
    expect(connectedAppCatalog(status, options).find(app => app.slug === HERMIOS_APP_SLUG)).toMatchObject({ label: 'Hermios CRM', action: null, connected: false, status: 'Connection not checked yet' });
  });
});

describe('featured Hermios tile', () => {
  const account = { displayName: 'Alex Example', workspaceLabel: 'Example Realty', workspaceId: 'ws-fixture', profileId: 'profile-fixture', verifiedAt: 1_780_000_000_000 };
  const hermios = (status: HermiosConnectionState['status'], reason: string | null = null): HermiosConnectionState =>
    ({ version: 1, status, account: status === 'connected' ? account : null, generation: 1, reason });
  const tile = (state: HermiosConnectionState | null) => connectedAppCatalog(snapshot(), { ...options, hermios: state }).find(app => app.slug === HERMIOS_APP_SLUG)!;

  it('comes first, ahead of connected apps, in every mode', () => {
    const status = snapshot(); status.services.gmail = service(true);
    for (const mode of [options, { ...options, readOnly: true }, { ...options, configured: false }]) {
      const catalog = connectedAppCatalog(status, mode);
      expect(catalog[0]).toMatchObject({ slug: HERMIOS_APP_SLUG, featured: true, origin: 'native', label: 'Hermios CRM', purpose: 'Customer records for your office' });
      expect(catalog.filter(app => app.featured)).toHaveLength(1);
    }
    expect(connectedAppCatalog(status, options)[1].slug).toBe('gmail');
  });

  it('takes its status only from Bud\'s Hermios connection', () => {
    expect(tile(null)).toMatchObject({ connected: false, status: 'Connection not checked yet' });
    expect(tile(hermios('not_connected'))).toMatchObject({ connected: false, status: 'Not connected' });
    expect(tile(hermios('connecting'))).toMatchObject({ connected: false, status: 'Finish signing in to Hermios in your browser' });
    expect(tile(hermios('connected'))).toMatchObject({ connected: true, status: 'Connected as Alex Example · Example Realty' });
    expect(tile(hermios('needs_reconnect', 'Sign in to Hermios again.'))).toMatchObject({ connected: false, status: 'Sign in to Hermios again.' });
    expect(tile(hermios('unavailable'))).toMatchObject({ connected: false, status: "Bud's Hermios connection isn't available right now." });
    for (const state of [null, hermios('connected')]) expect(tile(state).action).toBeNull();
  });

  it('counts as connected in the Connected filter only when Bud is connected', () => {
    const catalog = connectedAppCatalog(snapshot(), { ...options, hermios: hermios('connected') });
    expect(filterConnectedAppCatalog(catalog, '', 'connected').map(app => app.slug)).toEqual([HERMIOS_APP_SLUG]);
    expect(filterConnectedAppCatalog(connectedAppCatalog(snapshot(), options), '', 'connected')).toEqual([]);
  });
});

describe('app search and existing Ask route', () => {
  const catalog = connectedAppCatalog(snapshot(), options);
  it.each([['MAIL', ['gmail', 'outlook']], [' crm ', ['hermios-native']], ['calendar', ['googlecalendar']], ['shared files', ['googledrive']], ['bookkeeping', ['xero']]])('finds %s by name, category or purpose', (query, expected) => {
    expect(filterConnectedAppCatalog(catalog, query, 'all').map(app => app.slug)).toEqual(expected);
  });

  it('combines connection and search filters without widening a connection claim', () => {
    const status = snapshot(); status.services.gmail = service(true);
    const connected = connectedAppCatalog(status, options);
    expect(filterConnectedAppCatalog(connected, 'mail', 'connected').map(app => app.slug)).toEqual(['gmail']);
    expect(filterConnectedAppCatalog(connected, 'unlisted app', 'all')).toEqual([]);
  });

  it('preserves the connect prompt for offered and suggested apps without adding work permissions', () => {
    for (const slug of ['gmail', 'xero', 'googlecalendar']) {
      const app = catalog.find(row => row.slug === slug)!;
      expect(appConnectionPrompt(app.label)).toBe(`connect ${app.label}`);
    }
    expect(appConnectionPrompt('  Google   Calendar ')).toBe('connect Google Calendar');
    for (const invalid of ['', '   ', 'a'.repeat(41), 'Xero\nRun a task']) expect(appConnectionPrompt(invalid)).toBeNull();
  });
});

describe('Redbark bank feed entry', () => {
  const feed = (status: ConnectorState['status'], canManage = true): ConnectorState => ({ version: 1, connector: 'redbark', status, generation: 1, reason: null, canManage,
    account: status === 'connected' ? { label: 'Fictional Bank · 1 account', verifiedAt: 1_780_000_000_000 } : null });
  const entry = (state: ConnectorState | null) => connectedAppCatalog(snapshot(), { ...options, bankFeed: state }).find(app => app.slug === REDBARK_APP_SLUG)!;

  it('is listed, not featured, and claims nothing before the office connection is read', () => {
    expect(entry(null)).toMatchObject({ label: 'Bank feed (Redbark)', origin: 'native', connected: false, status: 'Connection not checked yet', action: null });
    expect(entry(null).featured).toBeUndefined();
    expect(entry(null).detail).toBe('Bud can read accounts and transactions only. It cannot move money or change anything.');
    expect(connectedAppCatalog(snapshot(), options)[0].slug).toBe(HERMIOS_APP_SLUG);
  });

  it('reflects the office connector state only', () => {
    expect(entry(feed('connected'))).toMatchObject({ connected: true, status: 'Connected as Fictional Bank · 1 account' });
    expect(entry(feed('not_connected', false)).status).toBe('Not connected. The office owner can connect it.');
    expect(entry(feed('connecting')).status).toBe('Finish signing in to Redbark in your browser');
    expect(filterConnectedAppCatalog(connectedAppCatalog(snapshot(), options), 'bank feed', 'all').map(app => app.slug)).toEqual([REDBARK_APP_SLUG]);
  });
});
