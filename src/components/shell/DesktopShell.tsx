import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PanelRight } from "lucide-react";
import { Sidebar } from "../Sidebar";
import { useStore } from "@/state/store";
import { useWorkspaceTabs } from "@/lib/workspace-tabs";
import { queueCounts } from "@/lib/desk-queue";
import { visibleDeskAreas } from "@/lib/desk-view-state";
import { DESK_SECTION_LABELS } from "@shared/workspace-tabs";
import { ToastStack, useToasts } from "../ui/ToastStack";
import { AreaTabs, type AreaTab } from "./AreaTabs";
import { ContextSidebar } from "./ContextSidebar";
import { ContextPanel } from "./ContextPanel";
import { StatusBar } from "./StatusBar";
import { ArrangeDeskSheet, useBudDeskReceipt } from "./DeskArrangement";
import { useDeskNav, useDeskTabSlot, type DeskTabId } from "./use-desk-nav";
import { useShellBrowser, useShellBudget } from "./shell-status";
import "./shell.css";

const PANEL_ID = "rb-shell-content";

/** Windows draws min/max/close over the top-right of the frameless window (titleBarOverlay in
 *  electron/main.mjs). This strip is the drag area under them, so no control sits beneath. */
export function WindowsTitlebar() {
  return window.ogb?.platform === "win32" ? <div className="rb-win-titlebar" aria-hidden /> : null;
}

/** Rail, context sidebar, area tabs, main content, side panel and status bar. Regions
 *  hide by CSS breakpoint (1279 / 959 / 719); pages render unchanged in the middle. */
export function DesktopShell({ inert, children }: { inert: boolean; children: ReactNode }) {
  const { state, dispatch } = useStore();
  const nav = useDeskNav();
  const workspaceTabs = useWorkspaceTabs();
  const savedViews = workspaceTabs.data?.state?.tabs.filter(tab => tab.visible) ?? [];
  const areas = visibleDeskAreas(workspaceTabs.data?.state?.desk.sections);
  const toasts = useToasts();
  useBudDeskReceipt(toasts);
  const browser = useShellBrowser();
  const budget = useShellBudget();
  const [drawer, setDrawer] = useState(false);
  const deskArea = state.activeView === "desk" || state.activeView === "workspace";
  // On Desk the tabs join Desk's own row (Tasks / work areas / Hermios), which already
  // carries Tasks and the areas; elsewhere the shell keeps its own row with them.
  // No fallback row on Desk: a row that appears and then leaves would shift Desk's scroll.
  const slot = useDeskTabSlot();
  const onDesk = state.activeView === "desk";
  useEffect(() => { if (!deskArea) setDrawer(false); }, [deskArea]);
  const deskTabs: AreaTab[] = [
    ...(onDesk ? [] : [{ id: "today", label: "Tasks", count: queueCounts(nav.rows).now }, ...areas.map(id => ({ id, label: DESK_SECTION_LABELS[id] }))]),
    { id: "properties", label: "Properties" },
  ];
  const tabs: AreaTab[] = [...deskTabs, ...savedViews.map(tab => ({ id: tab.id, label: tab.label }))];
  const selected = state.activeView === "workspace" ? state.workspaceTabId : nav.tab;
  const choose = (id: string) => {
    if (deskTabs.some(tab => tab.id === id)) nav.openTab(id as DeskTabId);
    else dispatch({ type: "showWorkspaceTab", id });
  };
  const bar = (<>
    <AreaTabs label="Desk views" tabs={tabs} selected={selected} onSelect={choose} panelId={PANEL_ID} />
    <button type="button" className="rb-panel-toggle" aria-expanded={drawer} onClick={() => setDrawer(value => !value)}>
      <PanelRight size={16} aria-hidden /><span>Side panel</span>
    </button>
  </>);
  return (<>
    <WindowsTitlebar />
    <div inert={inert} className="rb-app-shell relative flex min-h-0 flex-1">
      <Sidebar />
      <ContextSidebar />
      <div className="rb-shell-main">
        {onDesk ? (slot ? createPortal(bar, slot) : null) : deskArea ? <div className="rb-shell-tabbar">{bar}</div> : null}
        <div className="rb-shell-body">
          <div id={PANEL_ID} className="rb-shell-content" {...(deskArea ? { role: "tabpanel", "aria-labelledby": selected ? `rb-area-tab-${selected}` : undefined } : {})}>{children}</div>
          {deskArea ? <ContextPanel browser={browser.browser} open={drawer} onClose={() => setDrawer(false)} /> : null}
        </div>
      </div>
      {/* TODO(ui-components): mount CommandPalette here once src/components/ui lands. */}
    </div>
    <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    <StatusBar browser={browser.browser} stopping={browser.stopping} stopError={browser.error} onStop={() => void browser.stop()} budget={budget} />
    <ArrangeDeskSheet />
  </>);
}
