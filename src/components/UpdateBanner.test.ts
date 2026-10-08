import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdaterState } from '@/types/ogb';

const updater = vi.hoisted(() => ({ state: null as UpdaterState | null }));
vi.mock('@/lib/updater', () => ({ useUpdaterState: () => updater.state }));
import { UpdateBanner } from './UpdateBanner';

const render = (state: UpdaterState) => {
  updater.state = state;
  (globalThis as { window?: unknown }).window = { ogb: { updater: { check: vi.fn(), download: vi.fn(), install: vi.fn(), onState: vi.fn() } } };
  return renderToStaticMarkup(createElement(UpdateBanner));
};
afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe('UpdateBanner', () => {
  it('says a downloaded update waits for Bud in one plain line and keeps the existing restart option', () => {
    const message = 'Bud is still working. RealBud will restart to update when the work finishes.';
    const html = render({ status: 'downloaded', version: '0.2.0', deferred: 'busy', message });
    expect(html).toContain('0.2.0 is ready');
    expect(html).toContain(message);
    expect(html).not.toContain('Restart to finish updating.');
    expect(html).toContain('Restart to update');
    expect(html).not.toMatch(/Hermes|MCP|broker|service_busy/i);
  });

  it('stays out of the way while an update is found and downloaded in the background', () => {
    expect(render({ status: 'available', version: '0.2.0' })).toBe('');
    expect(render({ status: 'downloading', version: '0.2.0', percent: 40 })).toBe('');
  });

  it('asks for a restart when nothing holds the update', () => {
    const html = render({ status: 'downloaded', version: '0.2.0' });
    expect(html).toContain('Restart to finish updating.');
    expect(html).toContain('Restart to update');
  });
});
