import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { NeedsYouState } from '@/lib/needs-you';

// DesktopShell's imports read window at load (desktop capabilities); node has none.
vi.hoisted(() => { vi.stubGlobal('window', {}); });
const fake = vi.hoisted(() => ({ state: {} as Record<string, unknown>, needsYou: { snapshot: null, error: null, checking: false } as NeedsYouState }));
vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: fake.state, dispatch: vi.fn() }) }));
vi.mock('@/lib/workspace-tabs', () => ({ useWorkspaceTabs: () => ({ data: null, office: null, budChange: null }) }));
vi.mock('@/lib/needs-you', () => ({ useNeedsYou: vi.fn(() => fake.needsYou) }));
// The shell's other regions keep their own tests; here only its tab row and its Needs you read matter.
vi.mock('../Sidebar', () => ({ Sidebar: () => null }));
vi.mock('./ContextSidebar', () => ({ ContextSidebar: () => null }));
vi.mock('./ContextPanel', () => ({ ContextPanel: () => null }));
vi.mock('./StatusBar', () => ({ StatusBar: () => null }));
vi.mock('./DeskArrangement', () => ({ ArrangeDeskSheet: () => null, useBudDeskReceipt: () => {} }));
vi.mock('./shell-status', () => ({ useShellBrowser: () => ({ browser: null, stopping: false, error: null, stop: vi.fn() }), useShellBudget: () => null }));
import { useNeedsYou } from '@/lib/needs-you';
import { DesktopShell } from './DesktopShell';

const render = (activeView: string) => {
  fake.state = { activeView, desk: null, workspaceTabId: null };
  return renderToStaticMarkup(createElement(DesktopShell, { inert: false, children: null }));
};

describe('desktop shell Needs you read', () => {
  it('reads Needs you itself off Desk, so the area tab counts stay current, and leaves Desk as the one reader on Desk', () => {
    for (const [view, reads] of [['workspace', true], ['schedule', true], ['you', true], ['desk', false]] as const) {
      vi.mocked(useNeedsYou).mockClear();
      render(view);
      expect(vi.mocked(useNeedsYou).mock.calls, view).toEqual([[reads]]);
    }
  });

  it('counts each area tab off Desk from that read, keeping the title as the tab name', () => {
    fake.needsYou = { error: null, checking: false, snapshot: { checkedAt: new Date(0).toISOString(), items: [], unavailable: [], counts: { mail: { problem: 1, review: 1 } } } };
    const html = render('workspace');
    expect(html).toMatch(/<button [^>]*id="rb-area-tab-mail"[^>]*aria-describedby="rb-area-tab-mail-count"[^>]*><span class="truncate">Mail priorities<\/span>/);
    expect(html).toContain('<span id="rb-area-tab-mail-count" hidden="">2 items, 1 problem</span>');
  });
});
