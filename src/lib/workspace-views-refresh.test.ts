import { describe, expect, it, vi } from 'vitest';

vi.mock('@/state/store', () => ({ api: vi.fn() }));

import { WORKSPACE_TABS_CHANGED } from '@/lib/workspace-tabs';
import { createWorkspaceViewsRefresh } from './workspace-views-refresh';

describe('saved views refresh after Bud changes them', () => {
  it('announces only a successful views change, once per tool item', () => {
    const announce = vi.fn();
    const fold = createWorkspaceViewsRefresh(announce);
    fold({ type: 'item.started', itemType: 'tool', itemId: 'a', title: 'mcp_workspace_views_views_create' });
    fold({ type: 'item.completed', itemType: 'tool', itemId: 'a', ok: true });
    fold({ type: 'item.completed', itemType: 'tool', itemId: 'a', ok: true });
    expect(announce).toHaveBeenCalledTimes(1);
    // A failed change, the read and unrelated tools never refresh.
    fold({ type: 'item.started', itemType: 'tool', itemId: 'b', title: 'mcp__workspace-views__views_delete' });
    fold({ type: 'item.completed', itemType: 'tool', itemId: 'b', ok: false });
    fold({ type: 'item.started', itemType: 'tool', itemId: 'c', title: 'views_list' });
    fold({ type: 'item.completed', itemType: 'tool', itemId: 'c', ok: true });
    fold({ type: 'item.started', itemType: 'tool', itemId: 'd', title: 'set_reminder' });
    fold({ type: 'item.completed', itemType: 'tool', itemId: 'd', ok: true });
    expect(announce).toHaveBeenCalledTimes(1);
    for (const [id, title] of [['e', 'views_rename'], ['f', 'Views_Set_Visible'], ['g', 'views_reorder']]) {
      fold({ type: 'item.started', itemType: 'tool', itemId: id, title });
      fold({ type: 'item.completed', itemType: 'tool', itemId: id, ok: true });
    }
    expect(announce).toHaveBeenCalledTimes(4);
  });

  it('dispatches the window event useWorkspaceTabs listens for', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    try {
      const fold = createWorkspaceViewsRefresh();
      fold({ type: 'item.started', itemType: 'tool', itemId: 'a', title: 'views_set_visible' });
      fold({ type: 'item.completed', itemType: 'tool', itemId: 'a', ok: true });
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      expect(dispatchEvent.mock.calls[0]![0].type).toBe(WORKSPACE_TABS_CHANGED);
    } finally { vi.unstubAllGlobals(); }
  });
});
