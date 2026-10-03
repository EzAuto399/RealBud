import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDeskSections, type WorkspaceTab, type WorkspaceTabsResponse } from '@shared/workspace-tabs';
import { WorkspaceTabsManager } from './WorkspaceTabsManager';

const context = vi.hoisted(() => ({ data: null as WorkspaceTabsResponse | null, loading: false, saving: false, error: '', refresh: vi.fn(), save: vi.fn(), reset: vi.fn() }));
const dispatch = vi.hoisted(() => vi.fn());
vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ dispatch }) }));
vi.mock('@/lib/workspace-tabs', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/workspace-tabs')>(), useWorkspaceTabs: () => context }));
const tabs: WorkspaceTab[] = [
  { id: 'view-waiting', label: 'Waiting for a reply', visible: true, view: { kind: 'tasks', filter: 'waiting' } },
  { id: 'view-bills', label: 'Bills to review', visible: false, view: { kind: 'bills', filter: 'needs-you' } },
];
const response = (items = tabs): WorkspaceTabsResponse => ({ state: { version: 2, revision: 4, tabs: items, desk: { sections: defaultDeskSections() }, history: [] }, recovery: null });
const render = () => renderToStaticMarkup(createElement(WorkspaceTabsManager));
const control = (html: string, name: string) => html.match(new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`))?.[0];
beforeEach(() => { Object.assign(context, { data: response(), loading: false, saving: false, error: '' }); vi.clearAllMocks(); });

describe('saved views screen (read-only; Bud changes views)', () => {
  it('lists views with Open and points changes to Bud, with no manual edit controls', () => {
    const html = render();
    expect(html).toMatch(/<h1 tabindex="-1"[^>]*>Saved views<\/h1>/);
    expect(html).toContain('Bud sets these up. Ask Bud to add, rename, hide, reorder or remove a view.');
    expect(html).toMatch(/<button[^>]*>.*?Ask Bud<\/button>/);
    expect(control(html, 'Refresh views')).toBeDefined();
    expect(html).toContain('Open<span class="sr-only"> Waiting for a reply');
    for (const removed of ['Add saved view', 'Saved view editor', 'Edit<', 'More actions for', 'Hide<', 'Show<', 'Move up', 'Move down', 'Remove<', 'Customize desk', 'View options', 'Reset saved views']) expect(html).not.toContain(removed);
    expect(context.save).not.toHaveBeenCalled();
    expect(context.reset).not.toHaveBeenCalled();
  });

  it('marks a hidden view and disables its Open', () => {
    const html = render();
    expect(html).toContain('>Hidden</span>');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Open<span class="sr-only"> Bills to review/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Open<span class="sr-only"> Waiting for a reply/);
  });

  it('keeps the recovery alert and reset path when saved settings are damaged', () => {
    context.data = { state: null, recovery: { message: 'Saved views need recovery.', resetToken: 'a'.repeat(64) } };
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain('Saved views need recovery.');
    expect(html.match(/>Reset saved views<\/button>/g)).toHaveLength(1);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Reset saved views<\/button>/);
    expect(context.reset).not.toHaveBeenCalled();
  });

  it('keeps loading, failed read and pending save states explicit', () => {
    context.loading = true;
    expect(render()).toContain('Loading saved views…');
    expect(control(render(), 'Refresh views')).toContain('disabled');
    Object.assign(context, { loading: false, data: null, error: 'The saved result could not be confirmed.' });
    expect(render()).toContain('role="alert"');
    expect(render()).toContain('Refresh before making another change.');
    Object.assign(context, { data: response(), error: '', saving: true });
    expect(render()).toContain('Saving views…');
    expect(render()).toMatch(/<button[^>]*disabled=""[^>]*>Open<span class="sr-only"> Waiting for a reply/);
  });

  it('points an empty list to Bud', () => {
    context.data = response([]);
    expect(render()).toContain('No saved views yet. Ask Bud for one');
  });

  it('renders saved labels as text', () => {
    context.data = response([{ ...tabs[0], label: '<script>invoice</script>' }]);
    const html = render();
    expect(html).toContain('&lt;script&gt;invoice&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});
