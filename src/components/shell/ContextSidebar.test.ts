import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { vi.stubGlobal('window', {}); });
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, rows: [] as unknown[], link: { link: 'linked' as string | undefined, officeInactive: false } }));
vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: store.state, dispatch: vi.fn() }) }));
vi.mock('@/lib/use-office-link', () => ({ useOfficeLinkStatus: () => store.link }));
vi.mock('@/lib/workspace-tabs', async original => ({ ...(await original<object>()), useWorkspaceTabs: () => ({ data: null }) }));
vi.mock('@/lib/desk-queue', async original => ({ ...(await original<object>()), buildDeskQueue: () => store.rows }));
import { openDeskProperty, openDeskQueueFilter, useDeskViewState } from '@/lib/desk-view-state';
import { ContextSidebar } from './ContextSidebar';

const now = Date.now();
const row = (id: string, bucket: string) => ({ id, bucket, updatedAt: now, address: `${id} Fictional St`, kind: 'arrears', action: 'Review', meta: '' });
const desk = (fields: Record<string, unknown>) => ({ demo: false, mode: 'live', lastRunAt: now, properties: [{ id: 'p1', address: '1 Fictional St, Testville', tenantName: 'A Tenant' }], ...fields });
const render = () => renderToStaticMarkup(createElement(ContextSidebar));

describe('Desk context queue', () => {
  it('shows each status with its count and marks the open filter', () => {
    openDeskQueueFilter('waiting');
    store.rows = [row('a', 'now'), row('b', 'now'), row('c', 'waiting')];
    store.state = { activeView: 'desk', desk: desk({}), connected: true, loops: [], bots: [] };
    const html = render();
    for (const [label, count] of [['Needs you', 2], ['Next', 0], ['Waiting', 1], ['Done today', 0], ['All tasks', 3]] as const) {
      expect(html).toMatch(new RegExp(`${label}</span></span><span class="rb-context-count">${count}<`));
    }
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="true"[^>]*><span[^>]*><span[^>]*>Waiting</);
  });

  it('collapses to one line that leads to Properties on an empty office book', () => {
    store.rows = [];
    store.state = { activeView: 'desk', desk: desk({ properties: [], lastRunAt: null }), connected: true, loops: [], bots: [] };
    const html = render();
    expect(html).toContain('No tasks yet');
    expect(html).toContain('Add properties to start');
    expect(html).not.toContain('Needs you');
    expect(html).not.toContain('>Properties<');
  });

  it('scopes an empty queue to saved data when the office is disconnected or the check is stale', () => {
    store.rows = [];
    store.state = { activeView: 'desk', desk: desk({}), connected: true, loops: [], bots: [] };
    expect(render()).toContain('No tasks right now.');
    store.link = { link: 'not-linked', officeInactive: false };
    expect(render()).toContain('No tasks in saved data.');
    expect(render()).not.toContain('No tasks right now');
    store.link = { link: 'linked', officeInactive: false };
    store.state = { ...store.state, desk: desk({ lastRunAt: now - 13 * 3_600_000 }) };
    expect(render()).toContain('No tasks in saved data.');
    store.state = { ...store.state, desk: desk({ properties: [], lastRunAt: null }), connected: false };
    expect(render()).toContain('No tasks in saved data');
    expect(render()).not.toContain('No tasks yet');
  });

  it('says why the queue is empty on an unchecked sample book, without dead filters', () => {
    store.rows = [];
    store.state = { activeView: 'desk', desk: desk({ demo: true, mode: 'demo', lastRunAt: null }), connected: true, loops: [], bots: [] };
    const html = render();
    expect(html).toContain('Check tasks on Desk to fill the queue.');
    expect(html).not.toContain('All tasks');
  });
});

describe('queue shortcut navigation', () => {
  it('opens the task queue on the chosen status from Hermios, Bills or Properties', () => {
    let setHermios: (value: boolean) => void = () => {};
    let setOtherWork: (value: 'bills' | null) => void = () => {};
    const Grab = () => { setHermios = useDeskViewState('hermios')[1]; setOtherWork = useDeskViewState('otherWork')[1]; return null; };
    const Read = () => createElement('pre', null, JSON.stringify({ mode: useDeskViewState('mode')[0], hermios: useDeskViewState('hermios')[0], otherWork: useDeskViewState('otherWork')[0], filter: useDeskViewState('filter')[0], query: useDeskViewState('query')[0] }));
    renderToStaticMarkup(createElement(Grab));
    openDeskProperty('1 Fictional St');
    setHermios(true); setOtherWork('bills');
    openDeskQueueFilter('next');
    expect(JSON.parse(renderToStaticMarkup(createElement(Read)).replace(/<\/?pre>/g, '').replace(/&quot;/g, '"'))).toEqual({ mode: 'cases', hermios: false, otherWork: null, filter: 'next', query: '' });
  });
});

describe('Schedule and Work context', () => {
  it('keeps a role pack\'s jobs out of Loops until that pack is imported, as the Schedule list does', () => {
    const loop = (id: string, name: string, fields: Record<string, unknown> = {}) => ({ id, name, available: true, enabled: false, nextRunAt: null, ...fields });
    store.state = { activeView: 'schedule', desk: null, connected: true, bots: [], activityLoad: {}, loopRuns: [{ loopId: 'weekly-bills' }], loops: [
      loop('morning-arrears', 'Morning money check'), loop('inbound-triage', 'Morning priorities'), loop('bank-references', 'Bank reference review'),
      loop('maintenance-review', 'Maintenance checks', { enabled: true, nextRunAt: now + 3_600_000 }), loop('weekly-bills', 'Weekly bills review'), loop('inspection-draft', 'Inspection draft'),
    ] };
    const html = render();
    for (const name of ['Morning money check', 'Morning priorities', 'Maintenance checks', 'Weekly bills review']) expect(html).toContain(`>${name}<`);
    for (const name of ['Bank reference review', 'Inspection draft']) expect(html).not.toContain(name);
  });

  it('lists loops and threads as buttons', () => {
    store.state = { activeView: 'schedule', desk: null, connected: true, bots: [], activityLoad: {}, loops: [{ id: 'morning-arrears', name: 'Morning money check', available: true, enabled: true, nextRunAt: now + 3_600_000 }] };
    expect(render()).toMatch(/<button[^>]*class="rb-context-item"[^>]*><span[^>]*><span[^>]*>Morning money check</);
    store.state = { activeView: 'ask', desk: null, connected: true, loops: [], bots: [{ id: 'bud', name: 'Bud', threadId: 't1', tasks: [] }] };
    expect(render()).toContain('Today with Bud');
  });
});
