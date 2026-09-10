import { SlidersHorizontal } from "lucide-react";
import { DEFAULT_WORKSPACE, useWorkspacePreferences } from "@/lib/workspace-preferences";

export function WorkspaceLayout() {
  const { preferences: p, update, saved } = useWorkspacePreferences();
  return <details className="workspace-layout">
    <summary className="desk-secondary-button"><SlidersHorizontal size={15} aria-hidden />Layout</summary>
    <div className="workspace-layout-options" aria-label="Workspace layout">
      <label>Spacing<select aria-label="Spacing" value={p.density} onChange={e => update({ density: e.target.value as typeof p.density })}><option value="auto">Automatic · compact at 50+</option><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
      <label>Property view<select aria-label="Property view" value={p.propertyView} onChange={e => update({ propertyView: e.target.value as typeof p.propertyView })}><option value="auto">Automatic · table at 50+</option><option value="cards">Cards</option><option value="table">Table</option></select></label>
      <label>Rows per page<select aria-label="Rows per page" value={p.pageSize} onChange={e => update({ pageSize: Number(e.target.value) as typeof p.pageSize })}>{[20, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      <label>Queue width · {p.queueWidth}px<input aria-label="Queue width" type="range" min={240} max={360} step={10} value={p.queueWidth} onChange={e => update({ queueWidth: Number(e.target.value) })} /></label>
      <label className="workspace-layout-check"><input type="checkbox" checked={p.showBud} onChange={e => update({ showBud: e.target.checked })} />Keep Bud panel open on wide screens</label>
      <p>{saved ? "Saved on this Mac. Automatic layouts adapt as your book grows." : "Storage is unavailable. These settings apply for this session."}</p>
      <button type="button" onClick={() => update(DEFAULT_WORKSPACE)}>Reset layout</button>
    </div>
  </details>;
}
