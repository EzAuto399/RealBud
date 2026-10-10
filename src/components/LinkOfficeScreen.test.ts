import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectOfficeViewProps } from './ConnectOffice';

const fixture = vi.hoisted(() => ({ status: null as ConnectOfficeViewProps['status'], error: '', personName: undefined as string | undefined }));
vi.mock('@/state/store', () => ({ useStore: () => ({ state: { config: { profile: { name: 'Fictional Kevin' } } } }) }));
vi.mock('./Avatar', () => ({ MausAvatar: () => null }));
vi.mock('./shell/DesktopShell', () => ({ WindowsTitlebar: () => null }));
// The link protocol is ConnectOffice's own (ConnectOffice.test.ts); the screen renders its real view.
vi.mock('./ConnectOffice', async importOriginal => ({
  ...(await importOriginal<typeof import('./ConnectOffice')>()),
  useConnectOffice: (personName?: string) => {
    fixture.personName = personName;
    const view: ConnectOfficeViewProps = { status: fixture.status, phase: { kind: 'idle' }, error: fixture.error, code: '', codeBusy: false,
      onStart: vi.fn(), onOpenAgain: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onCode: vi.fn(), onLinkCode: vi.fn(), onRefresh: vi.fn() };
    return { view };
  },
}));

import { LinkOfficeScreen } from './LinkOfficeScreen';

const render = (revoked: boolean) => renderToStaticMarkup(createElement(LinkOfficeScreen, { revoked, onLeave: () => {} }));

describe('office link screen', () => {
  it('asks a computer that was never linked to connect, with the real code entry and the sample desk as the exit', () => {
    fixture.status = { state: 'unlinked' }; fixture.error = '';
    const html = render(false);
    expect(html).toContain('<h1 tabindex="-1"');
    expect(html).toContain('>Connect this computer to your office</h1>');
    expect(html).toContain('Bud and your office’s workflows start once it’s connected.');
    expect(html).toContain('Link code');
    expect(html).toContain('>Connect with this code</button>');
    expect(html).toContain('>Explore the sample desk</button>');
    expect(html).not.toContain('Open saved work without Bud');
    // The computer is named after the person on it.
    expect(fixture.personName).toBe('Fictional Kevin');
  });

  it('tells a disconnected computer its saved work is kept and lets it open that work without Bud', () => {
    fixture.status = { state: 'revoked' }; fixture.error = '';
    const html = render(true);
    expect(html).toContain('>This computer was disconnected from your office</h1>');
    expect(html).toContain('Everything saved here is kept. Reconnect to use Bud and your workflows.');
    expect(html).toContain('>Connect with this code</button>');
    expect(html).toContain('>Open saved work without Bud</button>');
    expect(html).not.toContain('Explore the sample desk');
  });

  it('keeps the owner hand-off on screen when the office is at its computer limit', () => {
    fixture.status = { state: 'unlinked' };
    fixture.error = 'This office already has 5 computers. Disconnect one to pair another. Your code is kept.';
    const html = render(false);
    expect(html).toContain('role="alert"');
    expect(html).toContain('already has 5 computers');
    expect(html).toContain('Copy request for your owner');
    expect(html).toContain('>Explore the sample desk</button>');
  });
});
