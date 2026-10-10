import { DEFAULT_WORKSPACE, useWorkspacePreferences } from "@/lib/workspace-preferences";

/** This computer's portfolio presentation, shown in Arrange Desk. Applies at once; never property data. */
export function WorkspaceLayout() {
  const { preferences: p, update, saved } = useWorkspacePreferences();
  return <div className="workspace-layout-options">
    <label>Spacing<select aria-label="Spacing" value={p.density} onChange={e => update({ density: e.target.value as typeof p.density })}><option value="auto">Automatic · compact at 50+</option><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
    <label>Property view<select aria-label="Property view" value={p.propertyView} onChange={e => update({ propertyView: e.target.value as typeof p.propertyView })}><option value="auto">Automatic · table at 50+</option><option value="cards">Cards</option><option value="table">Table</option></select></label>
    <label>Rows per page<select aria-label="Rows per page" value={p.pageSize} onChange={e => update({ pageSize: Number(e.target.value) as typeof p.pageSize })}>{[20, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
    <label>Queue width · {p.queueWidth}px<input aria-label="Queue width" type="range" min={240} max={360} step={10} value={p.queueWidth} onChange={e => update({ queueWidth: Number(e.target.value) })} /></label>
    <p>{saved ? "Applies at once and is saved in this app or browser. Automatic layouts adapt as your book grows." : "Storage is unavailable. These settings apply for this session."}</p>
    <button type="button" className="pm-control" onClick={() => update(DEFAULT_WORKSPACE)}>Reset layout</button>
  </div>;
}
