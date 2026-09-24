import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CareUnlockCard } from './CareUnlockCard';

const administration = vi.hoisted(() => ({ managed: true, configured: true, authenticated: false, expiresAt: null, configurationError: false }));
vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: { serviceAdmin: administration }, dispatch: vi.fn() }) }));
vi.mock('@/lib/use-service-admin-access', () => ({ useServiceAdminAccess: () => false }));

describe('service administrator sign-in', () => {
  it('says the password is the support-provisioned RealBud one, not the computer sign-in', () => {
    const html = renderToStaticMarkup(createElement(CareUnlockCard));
    expect(html).toContain('RealBud service administrator password that RealBud support set up for this installation');
    expect(html).toContain('It is not your Windows or Mac sign-in password.');
    expect(html).toContain('aria-label="Administrator password"');
  });
  it('does not describe a support password that has not been provisioned yet', () => {
    administration.configured = false;
    try {
      const html = renderToStaticMarkup(createElement(CareUnlockCard));
      expect(html).not.toContain('set up for this installation'); expect(html).not.toContain('aria-label="Administrator password"');
      expect(html).toContain('Administrator access has not been provisioned for this installation.');
    } finally { administration.configured = true; }
  });
});
