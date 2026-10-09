import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CompanyStatus } from '@shared/company-api';
vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
import { CompanyAdministrationRecovery } from './CompanySetupCard';

const status: CompanyStatus = { storageAvailable: false, configured: false, setupAllowed: false, transport: 'local-only', limitations: [] };
describe('office hosting administration recovery', () => {
  it('offers the existing administration destination with a truthful private-work boundary', () => {
    const html = renderToStaticMarkup(createElement(CompanyAdministrationRecovery, { status, onOpen: vi.fn() }));
    expect(html).toContain('Open service administration'); expect(html).toContain('Your private book and Work remain available');
    expect(html).not.toContain('under Advanced'); expect(html).not.toContain('ready');
  });
  it('gives a staff member an owner request rather than an administrator credential action', () => {
    const html = renderToStaticMarkup(createElement(CompanyAdministrationRecovery, { status: { ...status, company: { id: 'fictional-company', name: 'Fictional office' }, member: { id: 'fictional-member', displayName: 'Fictional person', role: 'member' } }, onOpen: vi.fn() }));
    expect(html).toContain('Copy request for your owner'); expect(html).not.toContain('Open service administration');
    expect(html).toContain('Office membership does not grant service administration');
    expect(html).not.toContain('type="password"');
  });
  it('retains the public service-admin deep link for callers without a navigation callback', () => {
    const html = renderToStaticMarkup(createElement(CompanyAdministrationRecovery, { status }));
    expect(html).toContain('href="#you-service-admin"');
  });
});
