import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultDeskSections, defaultShellLayout } from '@shared/workspace-tabs';

// DesktopShell's imports read window at load (desktop capabilities); node has none.
vi.hoisted(() => { vi.stubGlobal('window', {}); });
const store = vi.hoisted(() => ({ state: { connected: true, desk: null as unknown, loops: [] as unknown[] } }));
vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: store.state, dispatch: vi.fn() }) }));
import { clampPanelWidth, deskDataStatus, deskRunStatus, nextLoop, nextLoopLine, withDeskSection, withShellPanel } from './shell-layout';
import { tabKeyTarget, AreaTabs } from './AreaTabs';
import { parseShellBrowser } from './shell-status';
import { StatusBar } from './StatusBar';
import { CardMenu } from './DeskArrangement';
import { WindowsTitlebar } from './DesktopShell';

const HOUR = 3_600_000, now = Date.parse('2026-10-05T09:00:00+10:00');
const desk = (fields: Record<string, unknown>) => ({ demo: false, mode: 'live', lastRunAt: now - HOUR, ...fields }) as never;

describe('desktop shell facts', () => {
  it('never presents a sample, missing or stale Desk check as live', () => {
    expect(deskRunStatus(desk({ demo: true }), now)).toEqual({ label: 'Sample book · checked 1 h ago', tone: 'muted' });
    expect(deskRunStatus(desk({ mode: 'demo' }), now).label).toMatch(/^Sample book/);
    expect(deskRunStatus(desk({ lastRunAt: null }), now)).toEqual({ label: 'Desk not checked yet', tone: 'hold' });
    expect(deskRunStatus(desk({ lastRunAt: now - 13 * HOUR }), now)).toEqual({ label: 'Desk · stale, checked 13 h ago', tone: 'hold' });
    expect(deskRunStatus(desk({}), now)).toEqual({ label: 'Desk checked 1 h ago', tone: 'agency' });
    expect(deskRunStatus(null, now).label).toBe('Desk loading');
  });
  it('calls Desk data live only when the office is reachable and the check is fresh', () => {
    const office = (fields: Record<string, unknown> = {}) => ({ connected: true, link: 'linked', officeInactive: false, ...fields }) as never;
    expect(deskDataStatus(desk({}), office(), now)).toEqual({ live: true, notice: null });
    expect(deskDataStatus(desk({ lastRunAt: now - 72 * HOUR }), office({ link: 'not-linked' }), now)).toEqual({ live: false, notice: 'Not connected to your office · Last Desk check 3 days ago' });
    expect(deskDataStatus(desk({}), office({ connected: false }), now).notice).toBe('Office disconnected · Last Desk check 1 h ago');
    expect(deskDataStatus(desk({}), office({ officeInactive: true }), now).live).toBe(false);
    expect(deskDataStatus(desk({ lastRunAt: null }), office({ link: 'unavailable' }), now).notice).toBe('Office disconnected · Desk not checked yet');
    expect(deskDataStatus(desk({ lastRunAt: now - 72 * HOUR }), office(), now)).toEqual({ live: false, notice: 'Desk check is stale · Last checked 3 days ago' });
    // Link not read yet: not live, but never called disconnected.
    expect(deskDataStatus(desk({}), office({ link: undefined }), now)).toEqual({ live: false, notice: null });
    expect(deskDataStatus(null, office({ connected: false }), now).notice).toBeNull();
    expect(deskDataStatus(desk({ demo: true }), office({ connected: false }), now)).toEqual({ live: false, notice: null });
  });
  it('names only an enabled, scheduled, unpaused loop as next', () => {
    const loop = (fields: Record<string, unknown>) => ({ id: 'x', name: 'Morning arrears', available: true, enabled: true, nextRunAt: now + HOUR, ...fields }) as never;
    expect(nextLoopLine([loop({ enabled: false }), loop({ timezonePaused: true }), loop({ nextRunAt: null })], now)).toBe('No loop scheduled');
    expect(nextLoopLine([loop({ name: 'Owner letter', nextRunAt: now + 2 * HOUR }), loop({})], now)).toMatch(/^Next: Morning arrears /);
    expect(nextLoop([loop({ id: 'owner-letter', nextRunAt: now + 2 * HOUR }), loop({ id: 'morning-arrears' })], now)?.id).toBe('morning-arrears');
    expect(nextLoop([loop({ enabled: false })], now)).toBeNull();
  });
  it('keeps approval and recovery surfaces visible whatever the caller asks', () => {
    expect(withDeskSection(defaultDeskSections(), 'queue', false).find(section => section.id === 'queue')?.visible).toBe(true);
    expect(withDeskSection(defaultDeskSections(), 'brief', false).find(section => section.id === 'brief')?.visible).toBe(false);
    expect(withShellPanel(defaultShellLayout(), 'approvals', false).panels.find(panel => panel.id === 'approvals')?.visible).toBe(true);
    expect(withShellPanel(defaultShellLayout(), 'activity', true).panels.find(panel => panel.id === 'activity')?.visible).toBe(true);
    expect([clampPanelWidth(10), clampPanelWidth(900), clampPanelWidth(333.4)]).toEqual([280, 560, 333]);
  });
  it('moves tabs with arrows, Home and End, wrapping', () => {
    expect([tabKeyTarget('ArrowRight', 2, 3), tabKeyTarget('ArrowLeft', 0, 3), tabKeyTarget('Home', 2, 3), tabKeyTarget('End', 0, 3), tabKeyTarget('a', 0, 3)]).toEqual([0, 2, 0, 2, null]);
  });
  it('accepts only a validated browser status', () => {
    expect(parseShellBrowser({ state: 'ready', active: true, browsers: [{ id: 'b', name: 'Chrome', label: 'Fictional work profile' }], selectedBrowserId: 'b' })).toEqual({ active: true, ready: true, account: 'Fictional work profile' });
    expect(parseShellBrowser({ state: 'ready', active: 'yes', browsers: [] })).toBeNull();
    expect(parseShellBrowser(null)).toBeNull();
  });
});

describe('desktop shell markup', () => {
  it('renders a keyboard tablist with one tab in the tab order', () => {
    const html = renderToStaticMarkup(createElement(AreaTabs, { label: 'Desk views', tabs: [{ id: 'today', label: 'Today', count: 2 }, { id: 'properties', label: 'Properties' }], selected: 'properties', onSelect: () => {}, panelId: 'p' }));
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Desk views"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-selected="true"[^>]*tabindex="0"/);
  });
  it('shows Stop only while a browser task runs and labels sample facts and hides unreported spend', () => {
    store.state = { connected: true, desk: desk({ demo: true }), loops: [] };
    const idle = renderToStaticMarkup(createElement(StatusBar, { browser: { active: false, ready: true, account: 'Fictional' }, stopping: false, stopError: '', onStop: () => {}, budget: null }));
    expect(idle).toContain('Sample book');
    expect(idle).not.toContain('Spend');
    expect(idle).not.toContain('Stop browser task');
    const running = renderToStaticMarkup(createElement(StatusBar, { browser: { active: true, ready: true, account: 'Fictional work profile' }, stopping: false, stopError: '', onStop: () => {}, budget: { state: 'ready', percent: 12.5, label: '12.5%', committedNanoAud: '1' } }));
    expect(running).toContain('Browser task running · Fictional work profile');
    expect(running).toContain('Stop browser task');
    expect(running).toContain('Spend 12.5% of budget');
    // Facts with somewhere to go are buttons; the connection state is only a fact.
    expect(running).toMatch(/<button[^>]*title="Open Desk tasks"[^>]*>.*Sample book/);
    expect(running).toMatch(/<button[^>]*title="Open Schedule"[^>]*>No loop scheduled<\/button>/);
    expect(running).toMatch(/<button[^>]*title="Open AI usage in Workspace"[^>]*>Spend 12.5% of budget<\/button>/);
    expect(running).not.toMatch(/<button[^>]*>[^<]*<span[^>]*><\/span>Connected/);
  });
  it('offers Hide on ordinary cards and no Hide on locked ones', () => {
    const ordinary = renderToStaticMarkup(createElement(CardMenu, { label: 'Morning brief', locked: false, shown: true }));
    expect(ordinary).toContain('aria-label="Morning brief options"');
    expect(ordinary).toContain('>Hide<');
    const locked = renderToStaticMarkup(createElement(CardMenu, { label: 'Needs you', locked: true, shown: true }));
    expect(locked).not.toContain('>Hide<');
    expect(locked).toContain('Always shown');
    expect(renderToStaticMarkup(createElement(CardMenu, { label: 'Activity', locked: false, shown: false }))).toContain('Show on my Desk');
  });
  it('draws the drag strip under the caption buttons on Windows only', () => {
    for (const [platform, strip] of [['win32', true], ['darwin', false], [undefined, false]] as const) {
      vi.stubGlobal('window', { ogb: platform ? { platform } : undefined });
      expect(renderToStaticMarkup(createElement(WindowsTitlebar)).includes('class="rb-win-titlebar"')).toBe(strip);
    }
    vi.stubGlobal('window', {});
  });
});
