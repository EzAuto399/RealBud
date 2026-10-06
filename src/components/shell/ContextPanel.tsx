import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { SHELL_PANEL_LABELS, SHELL_PANEL_WIDTH, type ShellPanelId } from "@shared/workspace-tabs";
import { EvidenceRail, SourceStamp } from "../pm";
import { queueCounts } from "@/lib/desk-queue";
import { isObservedStale } from "@/lib/observed-stale";
import { jobRunStatusChip } from "@/lib/job-run";
import { fmtDateTime } from "@/lib/au";
import { useStore } from "@/state/store";
import { CardMenu, useDeskArrangement } from "./DeskArrangement";
import { clampPanelWidth, nextLoopLine, shellPanelLocked } from "./shell-layout";
import { useDeskNav } from "./use-desk-nav";
import type { ShellBrowser } from "./shell-status";

const APPROVAL_LIMIT = 5;
const link = "rb-panel-link";

function openWorkspace(hash: string, dispatch: ReturnType<typeof useStore>["dispatch"]) {
  location.hash = hash;
  dispatch({ type: "showYou" });
}

function EvidencePanel() {
  const { state } = useStore();
  const nav = useDeskNav();
  const snap = state.desk, item = nav.selected;
  if (!snap || !item) return <p className="text-ink-muted">Select a case to see why it is here.</p>;
  const work = item.workItemId ? snap.workItems.find(row => row.id === item.workItemId) : undefined;
  const source = work?.sourceIds[0] ? snap.sources.find(row => row.id === work.sourceIds[0]) : snap.sources[0];
  const stale = isObservedStale(work?.observedAt);
  return (<>
    <p className="font-medium text-ink">{item.address}</p>
    <p className="mt-0.5 text-[13px] text-ink-secondary">{item.action}</p>
    <div className="mt-2"><SourceStamp label={source?.label ?? work?.sourceIds.join(", ") ?? "Book"} observedAt={work?.observedAt} authority={snap.demo ? "demo" : undefined} state={stale ? "stale" : "success"} /></div>
    {stale ? <p className="mt-1 text-[12px] text-hold">Stale: these facts are older than 12 hours. Check tasks again before relying on them.</p> : null}
    <button type="button" className={link} onClick={() => nav.openCase(item.id)}>Open the case to decide</button>
  </>);
}

function ApprovalsPanel() {
  const nav = useDeskNav();
  const waiting = nav.rows.filter(row => row.bucket === "now");
  if (!waiting.length) return <p className="text-ink-muted">Nothing is waiting for your approval.</p>;
  return (<>
    <ul className="space-y-1">
      {waiting.slice(0, APPROVAL_LIMIT).map(row => (
        <li key={row.id}>
          <button type="button" className="rb-panel-row" aria-label={`Open ${row.address}: ${row.action}`} onClick={() => nav.openCase(row.id)}>
            <span className="block truncate font-medium">{row.address.split(",")[0]}</span>
            <span className="block truncate text-[12px] text-ink-muted">{row.action}</span>
          </button>
        </li>
      ))}
    </ul>
    {waiting.length > APPROVAL_LIMIT ? <button type="button" className={link} onClick={() => nav.openFilter("now")}>See all {waiting.length} waiting</button> : null}
    <p className="mt-2 text-[12px] text-ink-muted">Approve, Stop and recovery stay on each case.</p>
  </>);
}

function TodayPanel() {
  const { state } = useStore();
  const nav = useDeskNav();
  const counts = queueCounts(nav.rows);
  // Only what main does not already say: the queue counts (each opens that status) and the next loop.
  return (<>
    {!nav.rows.length ? <p className="text-ink-muted">No tasks yet.</p> : <div className="grid grid-cols-3 gap-2 text-center">
      {([["now", "Needs you"], ["next", "Next"], ["waiting", "Waiting"]] as const).map(([filter, label]) => (
        <button key={filter} type="button" aria-label={`${label}: ${counts[filter]}`} aria-current={nav.filter === filter ? "true" : undefined} onClick={() => nav.openFilter(filter)}
          className="rb-panel-count"><span className="block text-[11px] text-ink-muted">{label}</span><span className="block text-[16px] font-semibold tabular-nums">{counts[filter]}</span></button>
      ))}
    </div>}
    <p className="mt-2 text-[12px] text-ink-muted">{nextLoopLine(state.loops)}</p>
  </>);
}

function ActivityPanel() {
  const { state } = useStore();
  const runs = state.jobRuns.slice(0, 5);
  if (state.activityLoad.jobs === "loading") return <p className="text-ink-muted">Loading Bud activity…</p>;
  if (state.activityLoad.jobs === "error") return <p className="text-hold">Bud activity could not be loaded.</p>;
  if (!runs.length) return <p className="text-ink-muted">No Bud activity yet.</p>;
  return (
    <ul className="space-y-1.5">
      {runs.map(run => <li key={run.id} className="text-[13px]"><span className="block truncate text-ink">{run.jobTitle}</span><span className="text-[12px] text-ink-muted">{jobRunStatusChip(run.status).label} · {fmtDateTime(run.finishedAt ?? run.startedAt ?? run.createdAt)}</span></li>)}
    </ul>
  );
}

function AccountsPanel({ browser }: { browser: ShellBrowser }) {
  const { state, dispatch } = useStore();
  const apps = state.config?.composio;
  return (<>
    <p className="text-[13px] text-ink">Work browser: <span className="text-ink-secondary">{!state.connected ? "RealBud is offline" : !browser ? "Not checked" : browser.active ? `In use · ${browser.account}` : browser.ready ? `Ready · ${browser.account}` : "Not connected"}</span></p>
    <p className="mt-1 text-[13px] text-ink">Office apps: <span className="text-ink-secondary">{apps?.configured ? "Set up" : apps ? "Not set up" : "Not checked"}</span></p>
    <button type="button" className={link} onClick={() => openWorkspace("you-connected-apps", dispatch)}>Open connected apps</button>
    <button type="button" className={link} onClick={() => openWorkspace("you-browser", dispatch)}>Open work browser</button>
  </>);
}

/** Right context panel: mirrors and links; decisions stay on the case. Inline from
 *  1280px, a drawer from 960px, hidden below. Width is saved per member. */
export function ContextPanel({ browser, open, onClose }: { browser: ShellBrowser; open: boolean; onClose: () => void }) {
  const arrangement = useDeskArrangement();
  // A delayed width save uses the newest stored layout and revision.
  const latest = useRef(arrangement);
  latest.current = arrangement;
  const stored = arrangement.shell.panelWidth;
  const [width, setWidth] = useState(stored);
  const [moreOpen, setMoreOpen] = useState(false);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const pendingSave = useRef<number | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => { if (!drag.current && pendingSave.current === null) setWidth(stored); }, [stored]);
  useEffect(() => { if (open) panel.current?.querySelector<HTMLElement>(".rb-panel-close")?.focus(); }, [open]);
  useEffect(() => () => { if (pendingSave.current !== null) window.clearTimeout(pendingSave.current); }, []);
  const persist = (next: number) => {
    if (pendingSave.current !== null) window.clearTimeout(pendingSave.current);
    pendingSave.current = window.setTimeout(() => {
      pendingSave.current = null;
      const current = latest.current;
      if (next !== current.shell.panelWidth) void current.save(current.sections, { ...current.shell, panelWidth: next });
    }, 400);
  };
  const resizeBy = (delta: number) => { const next = clampPanelWidth(width + delta); setWidth(next); persist(next); };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(clampPanelWidth(drag.current.width + drag.current.x - event.clientX));
  };
  const onPointerUp = () => { if (drag.current) { drag.current = null; persist(width); } };
  const onHandleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") { event.preventDefault(); resizeBy(step); }
    else if (event.key === "ArrowRight") { event.preventDefault(); resizeBy(-step); }
    else if (event.key === "Home") { event.preventDefault(); resizeBy(SHELL_PANEL_WIDTH.max); }
    else if (event.key === "End") { event.preventDefault(); resizeBy(-SHELL_PANEL_WIDTH.max); }
  };
  const bodies: Record<ShellPanelId, ReactNode> = {
    evidence: <EvidencePanel />, approvals: <ApprovalsPanel />, today: <TodayPanel />, activity: <ActivityPanel />, accounts: <AccountsPanel browser={browser} />,
  };
  const shown = arrangement.shell.panels.filter(item => item.visible);
  const hidden = arrangement.shell.panels.filter(item => !item.visible);
  return (<>
    {open ? <button type="button" className="rb-panel-backdrop" aria-label="Close side panel" tabIndex={-1} onClick={onClose} /> : null}
    <aside ref={panel} className="rb-context-panel" data-open={open ? "true" : undefined} aria-label="Side panel" style={{ "--rb-panel-width": `${width}px` } as React.CSSProperties}
      onKeyDown={event => { if (open && event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div role="separator" aria-orientation="vertical" aria-label="Resize side panel" aria-valuemin={SHELL_PANEL_WIDTH.min} aria-valuemax={SHELL_PANEL_WIDTH.max} aria-valuenow={width}
        tabIndex={0} className="rb-panel-resize" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onKeyDown={onHandleKey} />
      <div className="rb-panel-close-row"><button type="button" className="rb-panel-close" aria-label="Close side panel" onClick={onClose}><X size={16} aria-hidden /></button></div>
      <div className="rb-panel-scroll">
        {shown.map(item => (
          <section key={item.id} className="rb-panel" aria-label={SHELL_PANEL_LABELS[item.id]}>
            <EvidenceRail title={SHELL_PANEL_LABELS[item.id]}>{bodies[item.id]}</EvidenceRail>
            <div className="rb-panel-menu">
              <CardMenu label={SHELL_PANEL_LABELS[item.id]} locked={shellPanelLocked(item.id)} shown onHide={() => void arrangement.setPanel(item.id, false)} />
            </div>
          </section>
        ))}
        {hidden.length ? (
          <div className="rb-panel-more">
            <button type="button" className="rb-panel-link" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}>More panels</button>
            {moreOpen ? <ul className="mt-1">{hidden.map(item => (
              <li key={item.id}><button type="button" className="rb-panel-row" onClick={() => void arrangement.setPanel(item.id, true)}>Show {SHELL_PANEL_LABELS[item.id]}</button></li>
            ))}</ul> : null}
          </div>
        ) : null}
      </div>
    </aside>
  </>);
}
