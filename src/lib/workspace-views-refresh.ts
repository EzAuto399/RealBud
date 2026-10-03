import { WORKSPACE_TABS_CHANGED } from '@/lib/workspace-tabs';

/** Bud's saved-view changes (`views_*` tools other than the read). */
const VIEWS_MUTATION = /views_(?:create|rename|set_visible|reorder|delete)\b/;

type ToolEvent = { type: string; itemType?: string; itemId?: string; title?: string; ok?: boolean };

/** Folds runtime events: when a saved-view change from Ask settles successfully,
 * tell `useWorkspaceTabs` to re-read GET /api/workspace-tabs. A completed tool
 * item that only reports a refusal costs one extra read, never a stale view. */
export function createWorkspaceViewsRefresh(announce: () => void = () => window.dispatchEvent(new Event(WORKSPACE_TABS_CHANGED))) {
  const pending = new Set<string>();
  return (event: ToolEvent) => {
    if (event.itemType !== 'tool' || typeof event.itemId !== 'string') return;
    if (event.type === 'item.started') {
      if (typeof event.title !== 'string' || !VIEWS_MUTATION.test(event.title.toLowerCase())) return;
      pending.add(event.itemId);
      if (pending.size > 50) pending.delete(pending.values().next().value!);
      return;
    }
    if (event.type === 'item.completed' && pending.delete(event.itemId) && event.ok === true) announce();
  };
}
