import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ConnectedAppsStatus } from '@shared/office-sources';
const fixture = vi.hoisted(() => ({ snapshot: null as ConnectedAppsStatus | null }));
vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: { config: { composio: { managed: true } }, bots: [], connected: true }, dispatch: vi.fn() }) }));
vi.mock('@/lib/connected-apps-refresh', () => ({ officeSources: { refresh: vi.fn() }, useOfficeSources: () => ({ snapshot: fixture.snapshot, loading: false, error: '' }) }));
vi.mock('./GmailReadOnlySetup', () => ({ connectedAppsMode: () => 'consumer', selectedConnectedAppsConfigured: () => true, useConnectionSettingsPending: () => false, hasUnconfirmedGmailSettingsChange: () => false }));
import { ConnectedAppsCard } from './ConnectedAppsCard';
beforeEach(() => { fixture.snapshot = { configured: true, checkedAt: new Date().toISOString(), sourceKind: 'office_shared', policyRevision: 3, services: { gmail: { connected: false, status: 'NOT_CONNECTED', accounts: [], accountSelectionRequired: false } }, tools: { available: false, names: [] } }; });
const html = () => renderToStaticMarkup(createElement(ConnectedAppsCard));
it('shows owner setup instead of desktop OAuth for an unconnected shared mailbox', () => {
  expect(html()).toContain('Ask the office owner to connect it');
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
