import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedAppsStatus } from '@shared/office-sources';
import type { HermiosConnectionState } from '@shared/hermios-connection';
import type { HermiosConnectionView } from '@/lib/hermios-connection-api';
import { connectedAppCatalog, HERMIOS_APP_SLUG } from '@/lib/connected-app-catalog';
const fixture = vi.hoisted(() => ({ snapshot: null as ConnectedAppsStatus | null, preview: null as string | null, dispatch: vi.fn(), api: vi.fn() }));
vi.mock('@/lib/design-preview', () => ({ get DESIGN_PREVIEW_REASON() { return fixture.preview; } }));
vi.mock('@/state/store', () => ({ api: fixture.api, useStore: () => ({ state: { config: { composio: { managed: true } }, bots: [{ id: 'bud', busy: false }], connected: true }, dispatch: fixture.dispatch }) }));
vi.mock('@/lib/connected-apps-refresh', () => ({ officeSources: { refresh: vi.fn() }, useOfficeSources: () => ({ snapshot: fixture.snapshot, loading: false, error: '' }) }));
vi.mock('./GmailReadOnlySetup', () => ({ connectedAppsMode: () => 'consumer', selectedConnectedAppsConfigured: () => true, useConnectionSettingsPending: () => false, hasUnconfirmedGmailSettingsChange: () => false }));
import { BankFeedTile, ConnectedAppsCard, HermiosFeaturedTile } from './ConnectedAppsCard';
import type { ConnectorState } from '@shared/mcp-connector';
import type { ConnectorView } from '@/lib/redbark-connection-api';
import { REDBARK_APP_SLUG } from '@/lib/connected-app-catalog';
beforeEach(() => { vi.clearAllMocks(); fixture.preview = null; fixture.snapshot = { configured: true, checkedAt: new Date().toISOString(), sourceKind: 'office_shared', policyRevision: 3, services: { gmail: { connected: false, status: 'NOT_CONNECTED', accounts: [], accountSelectionRequired: false } }, tools: { available: false, names: [] } }; });
const html = () => renderToStaticMarkup(createElement(ConnectedAppsCard));
it('shows owner setup instead of desktop OAuth for an unconnected shared mailbox', () => {
  expect(html()).toContain('realbud.app → Computers → Gmail for this office');
  expect(html()).not.toContain('Connect Gmail');
});
it('uses an already connected shared mailbox without another sign-in prompt', () => {
  fixture.snapshot!.services.gmail = { connected: true, status: 'ACTIVE', accounts: [{ id: 'office-mail', status: 'ACTIVE' }], accountSelectionRequired: false };
  fixture.snapshot!.tools = { available: true, names: ['GMAIL_GET_PROFILE'] };
  expect(html()).toContain('No additional sign-in is needed');
  expect(html()).not.toContain('Connect Gmail');
});
it('preserves personal connect and holds connection prompts while managed status is unknown', () => {
  fixture.snapshot!.sourceKind = 'personal'; expect(html()).toContain('Connect Gmail');
  fixture.snapshot = null; expect(html()).not.toContain('Connect Gmail');
});
it('offers to connect any app in a managed office, and lists an admitted but unsigned app to connect', () => {
  fixture.snapshot!.sourceKind = 'personal';
  fixture.snapshot!.services.xero = { connected: false, status: 'NOT_CONNECTED', accounts: [], accountSelectionRequired: false };
  const markup = html();
  expect(markup).toContain('Find another app');
  expect(markup).toContain('aria-label="App to connect"');
  expect(markup).toContain('Connect Xero');
  expect(markup).toContain('Find Outlook connection');
  expect(markup).not.toContain('Gmail read-only configured');
  expect(markup).toContain('Office connection service configured');
  expect(markup).toContain('aria-label="Search apps"');
  expect(markup).toContain('Common apps are suggestions');
});
it('shows connected account labels and status beside the app while preserving email selection', () => {
  fixture.snapshot!.services.gmail = { connected: true, status: 'ACTIVE', accounts: [{ id: 'office-mail', label: 'Office mailbox', status: 'ACTIVE' }, { id: 'team-mail', label: 'Team mailbox', status: 'ACTIVE' }], accountSelectionRequired: true };
  fixture.snapshot!.tools = { available: true, names: ['GMAIL_GET_PROFILE'] };
  const markup = html();
  expect(markup).toContain('Connected · Choose account');
  expect(markup).toContain('Office mailbox');
  expect(markup).toContain('Team mailbox');
  expect(markup).toContain('<option value="office-mail">Office mailbox</option>');
  expect(markup).toContain('Prepare follow-ups');
  expect(markup).not.toContain('Connect Gmail');
});
it('features Hermios first with its logo, claiming nothing before Bud\'s connection is read', () => {
  const markup = html();
  const tiles = [...markup.matchAll(/data-app-slug="([^"]+)"/g)].map(match => match[1]);
  expect(tiles[0]).toBe(HERMIOS_APP_SLUG);
  expect(markup).toMatch(/data-app-slug="hermios-native" data-featured="true"><div[^>]*><img src="\/brand\/hermios-icon.svg" alt="" aria-hidden="true"/);
  expect(markup).toContain('>Hermios CRM</h4>');
  expect(markup).toContain('Customer records for your office');
  expect(markup).toContain('Checking Bud&#x27;s Hermios connection…');
  expect(markup).not.toContain('Native integration setup is not available yet.');
  expect(markup).not.toContain('Planned');
  expect(markup).not.toContain('Connected as');
  expect(markup).not.toContain('Find Hermios');
});

describe('featured Hermios tile', () => {
  const account = { displayName: 'Alex Example', workspaceLabel: 'Example Realty', workspaceId: 'ws-fixture', profileId: 'profile-fixture', verifiedAt: 1_780_000_000_000 };
  const hermios = (status: HermiosConnectionState['status'], reason: string | null = null): HermiosConnectionState =>
    ({ version: 1, status, account: status === 'connected' ? account : null, generation: 1, reason });
  function tile(state: HermiosConnectionState | null, view: Partial<HermiosConnectionView> = {}, disabled = false) {
    const app = connectedAppCatalog(null, { configured: true, readOnly: false, managed: true, hermios: state })[0];
    const controls = { view: { state, loading: false, readError: null, busy: null, notice: null, ...view }, connect: vi.fn(async () => {}), check: vi.fn(async () => {}), refresh: vi.fn(async () => {}) };
    const onOpenDesk = vi.fn();
    const element = createElement(HermiosFeaturedTile, { app, controls, disabled, onOpenDesk });
    return { markup: renderToStaticMarkup(element).replace(/&#x27;/g, "'"), controls, onOpenDesk, element };
  }
  const buttons = (markup: string) => [...markup.matchAll(/<button [^>]*>(.*?)<\/button>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));

  it.each([
    ['not_connected', 'Not connected', ['Connect Bud to your Hermios', 'Go to Desk']],
    ['connecting', 'Finish signing in to Hermios in your browser', ['Check again for Hermios', 'Go to Desk']],
    ['connected', 'Connected as Alex Example · Example Realty', ['Go to Desk']],
    ['needs_reconnect', 'Sign in to Hermios again.', ['Connect again to Hermios', 'Go to Desk']],
    ['unavailable', "Bud's Hermios connection isn't available right now.", ['Connect again to Hermios', 'Go to Desk']],
  ] as const)('shows %s from Bud\'s Hermios connection', (status, line, labels) => {
    const { markup } = tile(hermios(status, status === 'needs_reconnect' ? 'Sign in to Hermios again.' : null));
    expect(markup).toContain(line);
    expect(buttons(markup)).toEqual(labels);
    expect(markup).toContain("Your Hermios window and Bud's connection are separate.");
    expect(markup).toContain('Hermios is the tab beside Needs you on Desk.');
    expect(markup).not.toMatch(/\bHermes\b|\bMCP\b|\bbroker\b/i);
    expect(markup).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    for (const button of markup.match(/<button [^>]*>/g) ?? []) expect(button).toContain('class="pm-control ');
    expect(markup).not.toContain('profile-fixture');
  });

  it('offers a retry when the state could not be read, and keeps the last good state otherwise', () => {
    const unread = tile(null, { readError: "Bud's Hermios connection couldn't be checked. Try again." }).markup;
    expect(unread).toContain("Bud's Hermios connection couldn't be checked. Try again.");
    expect(buttons(unread)).toEqual(['Check again for Hermios', 'Go to Desk']);
    const stale = tile(hermios('connected'), { readError: "Bud's Hermios connection couldn't be checked. Try again." }).markup;
    expect(stale).toContain('Connected as Alex Example');
    expect(stale).toContain('role="alert"');
  });

  it('holds connection changes in preview or while busy, but Desk stays reachable', () => {
    const { markup } = tile(hermios('not_connected'), {}, true);
    expect(markup).toMatch(/<button [^>]*disabled=""[^>]*>Connect Bud to your Hermios/);
    expect(markup).toMatch(/<button type="button" class="pm-control [^"]*">Go to Desk/);
    expect(tile(hermios('connecting'), { busy: 'check' }).markup).toContain('Checking…');
  });

  it('connects through the shared client and opens Desk through the given route', () => {
    const { element, controls, onOpenDesk } = tile(hermios('not_connected'));
    let tree: ReactNode;
    function Capture() { tree = HermiosFeaturedTile(element.props); return null; }
    renderToStaticMarkup(createElement(Capture));
    const found: ReactElement<Record<string, unknown>>[] = [];
    const visit = (node: ReactNode) => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== 'object' || !('props' in node)) return;
      const child = node as ReactElement<Record<string, unknown>>;
      found.push(child); visit(child.props.children as ReactNode);
    };
    visit(tree);
    const press = (label: string) => (found.find(child => child.type === 'button' && JSON.stringify(child.props.children).includes(label))!.props.onClick as () => void)();
    press('Connect Bud to your Hermios');
    expect(controls.connect).toHaveBeenCalledTimes(1);
    press('Go to Desk');
    expect(onOpenDesk).toHaveBeenCalledTimes(1);
  });
});

function appControls() {
  let tree: ReactNode;
  function Capture() { tree = ConnectedAppsCard(); return null; }
  renderToStaticMarkup(createElement(Capture));
  const elements: ReactElement<Record<string, unknown>>[] = [];
  function visit(node: ReactNode) {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    const element = node as ReactElement<Record<string, unknown>>;
    elements.push(element); visit(element.props.children as ReactNode);
  }
  visit(tree);
  return elements;
}

it('keeps preview catalog search usable but blocks both connect and follow-up handlers', async () => {
  fixture.preview = 'This design preview uses example data.';
  fixture.snapshot!.services.gmail = { connected: true, status: 'ACTIVE', accounts: [{ id: 'office-mail', status: 'ACTIVE' }], accountSelectionRequired: false };
  fixture.snapshot!.tools = { available: true, names: ['GMAIL_GET_PROFILE'] };
  expect(html()).toContain(fixture.preview);
  const elements = appControls();
  const search = elements.find(element => element.props['aria-label'] === 'Search apps')!;
  expect(search.props.disabled).toBeUndefined();
  const connect = elements.find(element => element.props['aria-label'] === 'Find Google Sheets connection')!;
  const prepare = elements.find(element => element.type === 'button' && element.props.children === 'Prepare follow-ups')!;
  for (const button of [connect, prepare]) {
    expect(button.props.disabled).toBe(true);
    await (button.props.onClick as () => unknown)();
  }
  expect(fixture.dispatch).not.toHaveBeenCalled();
  expect(fixture.api).not.toHaveBeenCalled();
});

it('preserves the normal suggested-app Ask connection action outside preview', () => {
  const connect = appControls().find(element => element.props['aria-label'] === 'Find Google Sheets connection')!;
  expect(connect.props.disabled).toBe(false);
  (connect.props.onClick as () => unknown)();
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: 'send', botId: 'bud', text: 'connect Google Sheets' });
});

describe('bank feed tile', () => {
  const feed = (status: ConnectorState['status'], canManage = true): ConnectorState => ({ version: 1, connector: 'redbark', status, generation: 1, canManage,
    reason: status === 'needs_reconnect' ? 'Sign in to Redbark again.' : null, account: status === 'connected' ? { label: 'Fictional Bank · 1 account', verifiedAt: 1_780_000_000_000 } : null });
  function tile(state: ConnectorState | null, view: Partial<ConnectorView> = {}) {
    const app = connectedAppCatalog(null, { configured: true, readOnly: false, managed: true, bankFeed: state }).find(row => row.slug === REDBARK_APP_SLUG)!;
    const controls = { view: { state, loading: false, readError: null, busy: null, notice: null, ...view }, connect: vi.fn(async () => {}), check: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), refresh: vi.fn(async () => {}) };
    const element = createElement(BankFeedTile, { app, controls, disabled: false });
    return { markup: renderToStaticMarkup(element).replace(/&#x27;/g, "'"), controls, element };
  }
  const buttons = (markup: string) => [...markup.matchAll(/<button [^>]*>(.*?)<\/button>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));

  it('is listed after Hermios, not featured, with a neutral bank icon and read-only copy', () => {
    const markup = html();
    const tiles = [...markup.matchAll(/data-app-slug="([^"]+)"/g)].map(match => match[1]);
    expect(tiles[0]).toBe('hermios-native');
    expect(tiles).toContain(REDBARK_APP_SLUG);
    expect(markup).not.toMatch(/data-app-slug="redbark-native" data-featured/);
    expect(markup).toContain('>Bank feed (Redbark)</h4>');
    expect(markup).toContain('Bud can read accounts and transactions only. It cannot move money or change anything.');
    expect(markup).toContain('Checking the bank feed…');
    expect(markup).not.toMatch(/redbark[^"]*\.(?:svg|png)/i);
    expect(markup).toContain('Add a connector');
    expect(markup).toContain('Checking added services…');
  });

  it.each([
    ['not_connected', true, 'Not connected', ['Connect bank feed for the bank feed']],
    ['not_connected', false, 'Not connected. The office owner can connect it.', []],
    ['connecting', true, 'Finish signing in to Redbark in your browser', ['Check again for the bank feed']],
    ['connected', true, 'Connected as Fictional Bank · 1 account', ['Check for the bank feed', 'Disconnect for the bank feed']],
    ['connected', false, 'Connected as Fictional Bank · 1 account', ['Check for the bank feed']],
    ['needs_reconnect', true, 'Sign in to Redbark again.', ['Connect again for the bank feed']],
    ['unavailable', true, "The bank feed isn't available right now.", ['Check again for the bank feed', 'Connect again for the bank feed']],
  ] as const)('shows %s (manage: %s)', (status, canManage, line, labels) => {
    const { markup } = tile(feed(status, canManage));
    expect(markup).toContain(line);
    expect(buttons(markup)).toEqual(labels);
    expect(markup).not.toMatch(/\bHermes\b|\bMCP\b|\bbroker\b/i);
    expect(markup).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    for (const button of markup.match(/<button [^>]*>/g) ?? []) expect(button).toContain('class="pm-control ');
  });

  it('asks before disconnecting', () => {
    const { element, controls } = tile(feed('connected'));
    const found: ReactElement<Record<string, unknown>>[] = [];
    const visit = (node: ReactNode) => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== 'object' || !('props' in node)) return;
      const child = node as ReactElement<Record<string, unknown>>; found.push(child); visit(child.props.children as ReactNode);
    };
    function Capture() { visit(BankFeedTile(element.props)); return null; }
    renderToStaticMarkup(createElement(Capture));
    const label = (child: ReactElement<Record<string, unknown>>) => [child.props.children].flat(2).filter(part => typeof part === 'string').join('');
    const disconnectButton = found.find(child => child.type === 'button' && label(child) === 'Disconnect')!;
    expect(disconnectButton).toBeDefined();
    (disconnectButton.props.onClick as () => void)();
    expect(controls.disconnect).not.toHaveBeenCalled();
    expect(buttons(tile(feed('connected')).markup)).not.toContain('Confirm disconnect for the bank feed');
  });
});
