import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdaterState } from '@/types/ogb';
import { updateStatusLine } from '@/lib/updater';

const updater = vi.hoisted(() => ({ state: null as UpdaterState | null }));
vi.mock('@/lib/updater', async (actual) => ({ ...(await actual<typeof import('@/lib/updater')>()), useUpdaterState: () => updater.state }));
vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: vi.fn() }));
import { UpdateBanner, releaseNotesUrl } from './UpdateBanner';
import { setupStatusItem } from './shell/StatusBar';

const render = (state: UpdaterState, props: { docked?: boolean } = {}) => {
  updater.state = state;
  (globalThis as { window?: unknown }).window = { ogb: { updater: { check: vi.fn(), download: vi.fn(), install: vi.fn(), onState: vi.fn(), later: vi.fn(), cancelCountdown: vi.fn(), dismissNote: vi.fn() } } };
  return renderToStaticMarkup(createElement(UpdateBanner, props));
};
afterEach(() => { delete (globalThis as { window?: unknown }).window; });
const ready = (restart: UpdaterState['restart'], extra: Partial<UpdaterState> = {}) => render({ status: 'downloaded', version: '0.2.0', restart, ...extra });
const tomorrowAt = (hours: number, minutes: number) => { const at = new Date(); at.setDate(at.getDate() + 1); at.setHours(hours, minutes, 0, 0); return at.getTime(); };

describe('UpdateBanner', () => {
  it('stays out of the way while an update is found and downloaded in the background', () => {
    expect(render({ status: 'available', version: '0.2.0' })).toBe('');
    expect(render({ status: 'downloading', version: '0.2.0', percent: 40 })).toBe('');
    expect(render({ status: 'idle' })).toBe('');
  });

  it('keeps the plain restart instruction when an older main never restarts by itself', () => {
    const html = render({ status: 'downloaded', version: '0.2.0' });
    expect(html).toContain('0.2.0 is ready');
    expect(html).toContain('Restart to finish updating.');
    expect(html).toContain('Restart now</button>');
    expect(html).toContain('>Later</button>');
  });

  it('says a downloaded update restarts by itself when the person is away, with Restart now and Later', () => {
    const html = ready({ mode: 'when-away', required: false });
    expect(html).toContain('role="status"');
    expect(html).toContain('0.2.0 is ready');
    expect(html).toContain('RealBud restarts by itself when you’re away. Your work is kept.');
    expect(html).toContain('Restart now</button>');
    expect(html).toContain('>Later</button>');
    expect(html).toContain('aria-label="Dismiss update notice"');
    expect(html).not.toMatch(/!|Hermes|MCP|broker/);
  });

  it('names the time a Later hold ends', () => {
    const html = ready({ mode: 'when-away', required: false, laterUntil: tomorrowAt(15, 40) });
    expect(html).toContain('Restarts after 3:40 pm when you’re away.');
    expect(html).toContain('>Later</button>');
  });

  it('drops Later for a required update and says why it is required', () => {
    const unsupported = ready({ mode: 'when-away', required: true, requiredReason: 'unsupported' });
    expect(unsupported).toContain('This version is no longer supported. RealBud restarts to update as soon as you’re away.');
    expect(unsupported).toContain('Restart now</button>');
    expect(unsupported).not.toContain('>Later</button>');
    const waited = ready({ mode: 'when-away', required: true, requiredReason: 'waited', laterUntil: tomorrowAt(9, 0) });
    expect(waited).toContain('This update has waited a day. RealBud restarts as soon as you’re away.');
    expect(waited).not.toContain('>Later</button>');
  });

  it('counts down with Restart now and Not now, announcing the start once rather than every second', () => {
    const html = ready({ mode: 'countdown', at: Date.now() + 42_000, required: false }, { installFailed: { version: '0.1.9' } });
    expect(html).toMatch(/Restarting to update in (41|42) s/);
    expect(html).toContain('role="group" aria-label="Restarting to update"');
    // The only live region carries fixed words; the ticking title sits outside it.
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('<span role="status" class="sr-only">RealBud is about to restart to update. Choose Not now to keep working.</span>');
    expect(html).toContain('Restart now</button>');
    expect(html).toContain('>Not now</button>');
    expect(html).toContain('Your work is kept.');
    // Required: an approval card no longer holds it, so the card promises only what it keeps.
    expect(ready({ mode: 'countdown', at: Date.now() + 42_000, required: true, requiredReason: 'waited' })).toContain('Open drafts and running work are kept.');
    expect(html).not.toContain('>Later</button>');
    expect(html).not.toContain('didn’t install');
  });

  it('names what a waiting restart is waiting for', () => {
    const unsaved = ready({ mode: 'waiting', blockedBy: ['unsaved', 'busy'], required: false });
    expect(unsaved).toContain('Save or discard your open draft first.');
    expect(unsaved).toContain('Restart now</button>');
    const message = 'Bud is still working. RealBud will restart to update when the work finishes.';
    const busy = ready({ mode: 'waiting', blockedBy: ['busy'], required: false }, { deferred: 'busy', message });
    expect(busy).toContain(message);
    expect(ready({ mode: 'waiting', blockedBy: ['busy'], required: false })).toContain(message);
    expect(ready({ mode: 'waiting', blockedBy: ['approval'], required: false })).toContain('Bud is waiting for you to answer or finish a step. RealBud restarts after that.');
  });

  it('shows main’s sentence when Restart now met an unsaved draft', () => {
    const message = 'Save or discard your open draft first, then restart to update.';
    const html = ready({ mode: 'when-away', required: false }, { deferred: 'unsaved', message });
    expect(html).toContain(message);
    expect(html).toContain('Restart now</button>');
    expect(ready({ mode: 'when-away', required: false }, { deferred: 'unsaved' })).toContain('Save or discard your open draft first.');
  });

  it('keeps today’s deferred wording from main when the office service holds the restart', () => {
    const message = 'Bud is still working. RealBud will restart to update when the work finishes.';
    const html = render({ status: 'downloaded', version: '0.2.0', deferred: 'busy', message });
    expect(html).toContain(message);
    expect(html).not.toContain('Restart to finish updating.');
  });

  it('says an install did not land, with Try again, the download page and a dismiss', () => {
    const html = render({ status: 'downloaded', version: '0.2.0', installFailed: { version: '0.2.0' } });
    expect(html).toContain('0.2.0 didn’t install');
    expect(html).toContain('Try again</button>');
    expect(html).toContain('<a href="https://realbud.app/download" target="_blank" rel="noreferrer"');
    expect(html).toContain('>Download from realbud.app</a>');
    expect(html).toContain('aria-label="Dismiss update notice"');
    expect(html).not.toContain('is ready');
  });

  it('shows the fetch in progress after Try again instead of a dead button', () => {
    const html = render({ status: 'downloading', version: '0.2.1', percent: 40.4, installFailed: { version: '0.2.0' } });
    expect(html).toContain('0.2.0 didn’t install');
    expect(html).toContain('Getting 0.2.1…');
    expect(html).toContain('<span class="tabular-nums" aria-hidden="true">40%</span>');
    expect(html).not.toContain('Try again</button>');
    expect(html).toContain('>Download from realbud.app</a>');
    expect(render({ status: 'checking', installFailed: { version: '0.2.0' } })).toContain('Getting 0.2.0…');
  });

  it('notes a finished update once, with What’s new on the release page', () => {
    const html = render({ status: 'idle', updatedFrom: { from: '0.1.50', to: '0.1.51' } });
    expect(html).toContain('Updated to 0.1.51');
    expect(html).toContain('href="https://github.com/EzAuto399/RealBud/releases/tag/v0.1.51"');
    expect(html).toContain('>What’s new</a>');
    expect(html).toContain('aria-label="Dismiss update notice"');
    expect(releaseNotesUrl('0.1.51-beta.1')).toBe('https://github.com/EzAuto399/RealBud/releases/tag/v0.1.51-beta.1');
    expect(releaseNotesUrl('../../evil')).toBeNull();
    expect(render({ status: 'idle', updatedFrom: { from: '0.1.50', to: 'not a version' } })).not.toContain('<a ');
  });

  it('docks below a screen with no shell instead of floating over its buttons', () => {
    const floating = ready({ mode: 'when-away', required: false });
    expect(floating).toContain('class="rb-toast-stack fixed bottom-4 left-4 z-50 ');
    const docked = render({ status: 'downloaded', version: '0.2.0', restart: { mode: 'when-away', required: false } }, { docked: true });
    expect(docked).toContain('data-update-card="" class="mx-4 mb-4 shrink-0 ');
    expect(docked).toContain('Restart now</button>');
    expect(docked).not.toMatch(/rb-toast-stack|\bfixed\b|z-50/);
  });

  it('still offers Try again for a failed check', () => {
    const html = render({ status: 'error', message: 'getaddrinfo ENOTFOUND github.com' });
    expect(html).toContain('Update failed');
    expect(html).toContain("Couldn&#x27;t reach the update server.");
    expect(html).toContain('Try again</button>');
  });
});

describe('updateStatusLine', () => {
  const base: UpdaterState = { status: 'downloaded', version: '0.2.0' };
  it('words the status bar for ready, countdown and a draft in the way', () => {
    expect(updateStatusLine({ ...base, restart: { mode: 'when-away', required: false } }, null)).toBe('Update ready · restarts when you’re away');
    expect(updateStatusLine({ ...base, restart: { mode: 'countdown', at: 1, required: false } }, 37)).toBe('Restarting in 37 s');
    expect(updateStatusLine({ ...base, restart: { mode: 'waiting', blockedBy: ['unsaved'], required: false } }, null)).toBe('Update needs you');
    expect(updateStatusLine({ ...base, restart: { mode: 'waiting', blockedBy: ['busy'], required: false } }, null)).toBe('Update ready · restarts when you’re away');
    expect(updateStatusLine({ ...base, deferred: 'unsaved', restart: { mode: 'when-away', required: false } }, null)).toBe('Update needs you');
    expect(updateStatusLine(base, null)).toBe('Update ready');
  });
});

describe('status bar update item', () => {
  const setup = (stage: 'ready' | 'office-link') => ({ stage, degraded: { kind: 'updatePending' as const, message: 'A RealBud update is ready.' }, steps: [], next: null }) as unknown as Parameters<typeof setupStatusItem>[0];
  it('uses the updater’s own words once setup is done, and never hides setup progress', () => {
    const update = { label: 'Restarting in 12 s', title: 'Your work is kept.' };
    expect(setupStatusItem(setup('ready'), update)).toEqual(update);
    expect(setupStatusItem(setup('ready'))).toMatchObject({ label: 'Update ready', title: 'A RealBud update is ready.' });
    expect(setupStatusItem(setup('office-link'), update)).toBeNull();
  });
});
