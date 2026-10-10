import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectOfficeViewProps } from './ConnectOffice';

const fixture = vi.hoisted(() => ({ status: null as ConnectOfficeViewProps['status'], error: '', personName: undefined as string | undefined, reads: 0 }));
vi.mock('@/state/store', () => ({ useStore: () => ({ state: { config: { profile: { name: 'Fictional Kevin' } } } }) }));
vi.mock('./Avatar', () => ({ MausAvatar: () => null }));
vi.mock('./shell/DesktopShell', () => ({ WindowsTitlebar: () => null }));
// The link protocol is ConnectOffice's own (ConnectOffice.test.ts); the screen renders its real view.
vi.mock('./ConnectOffice', async importOriginal => ({
  ...(await importOriginal<typeof import('./ConnectOffice')>()),
  useConnectOffice: (personName?: string) => {
    fixture.personName = personName; fixture.reads++;
    const view: ConnectOfficeViewProps = { status: fixture.status, phase: { kind: 'idle' }, error: fixture.error, code: '', codeBusy: false,
      onStart: vi.fn(), onOpenAgain: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onCode: vi.fn(), onLinkCode: vi.fn(), onRefresh: vi.fn() };
    return { view };
  },
}));

import { LinkOfficeScreen } from './LinkOfficeScreen';

type Gate = 'unavailable' | 'not-linked' | 'revoked';
const render = (gate: Gate, onContinueRecovery?: () => void) => renderToStaticMarkup(createElement(LinkOfficeScreen, { gate, onRetry: () => {}, onOpenRecovery: () => {}, onContinueRecovery }));
/** No way past the screen except recovery, and none of the old exits. */
const noExit = (html: string) => {
  expect(html).not.toMatch(/sample desk/i);
  expect(html).not.toContain('without Bud');
};

describe('office link screen', () => {
  it('asks a computer that was never linked to connect, with the real code entry and no way around it', () => {
    fixture.status = { state: 'unlinked' }; fixture.error = '';
    const html = render('not-linked');
    expect(html).toContain('<h1 tabindex="-1"');
    expect(html).toContain('>Connect this computer to your office</h1>');
    expect(html).toContain('Bud and your office’s workflows start once it’s connected.');
    expect(html).toContain('Link code');
    expect(html).toContain('>Connect with this code</button>');
    expect(html).not.toContain('Open recovery');
    expect(html).not.toContain('Continue recovery');
    noExit(html);
    // The computer is named after the person on it.
    expect(fixture.personName).toBe('Fictional Kevin');
  });

  it('tells a disconnected computer its saved work is kept and asks it to connect again', () => {
    fixture.status = { state: 'revoked' }; fixture.error = '';
    const html = render('revoked');
    expect(html).toContain('>This computer was disconnected from your office</h1>');
    expect(html).toContain('Everything saved here is kept. Reconnect to use Bud and your workflows.');
    // Said once, in the heading; the card doesn't repeat it.
    expect(html).not.toContain('was removed from your office');
    expect(html).toContain('>Connect with this code</button>');
    expect(html).not.toContain('Open recovery');
    expect(html).not.toContain('Continue recovery');
    noExit(html);
  });

  it('offers Continue recovery below the link card only once first run started recovery', () => {
    fixture.error = '';
    for (const [gate, state] of [['not-linked', 'unlinked'], ['revoked', 'revoked']] as const) {
      fixture.status = { state };
      const html = render(gate, () => {});
      expect(html).toContain('>Connect with this code</button>');
      // A secondary button after the link card, reachable by keyboard like every other button.
      expect(html).toMatch(/<button type="button" class="pm-control[^"]*">Continue recovery<\/button>/);
      expect(html.indexOf('Continue recovery')).toBeGreaterThan(html.indexOf('Connect with this code'));
      expect(html).not.toContain('Open recovery');
      noExit(html);
    }
    // Can't finish checking keeps its own Open recovery and nothing else.
    const unavailable = render('unavailable', () => {});
    expect(unavailable).toContain('>Open recovery</button>');
    expect(unavailable).not.toContain('Continue recovery');
  });

  it('keeps the owner hand-off on screen when the office is at its computer limit', () => {
    fixture.status = { state: 'unlinked' };
    fixture.error = 'This office already has 5 computers. Disconnect one to pair another. Your code is kept.';
    const html = render('not-linked');
    expect(html).toContain('role="alert"');
    expect(html).toContain('already has 5 computers');
    expect(html).toContain('Copy request for your owner');
    noExit(html);
  });

  it('offers Try again and recovery when the check can’t finish, without asking for a code', () => {
    fixture.reads = 0;
    const html = render('unavailable');
    expect(html).toContain('<h1 tabindex="-1"');
    // True whether the link read failed or only the book read never answered.
    expect(html).toContain('>RealBud couldn’t finish checking this computer</h1>');
    expect(html).toContain('RealBud’s local service didn’t answer. Everything saved here is kept.');
    expect(html).toMatch(/<button type="button" class="pm-decision[^"]*">Try again<\/button>/);
    expect(html).toMatch(/<button type="button" class="pm-control[^"]*">Open recovery<\/button>/);
    expect(html.match(/class="pm-decision/g)).toHaveLength(1);
    // Nothing reads the link again behind the screen until Try again.
    expect(fixture.reads).toBe(0);
    expect(html).not.toContain('Link code');
    noExit(html);
  });
});
