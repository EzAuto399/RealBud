import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownToLine, Building2, CalendarDays, Check, Loader2, MessageSquare, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useWorkspaceTabs } from '@/lib/workspace-tabs';
import '@/workspace-tabs.css';
import '@/sidebar-utilities.css';
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import { buildDeskQueue, queueCounts } from "@/lib/desk-queue";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { useUpdaterState } from "@/lib/updater";
import { WorkdayPulse } from "./WorkdayPulse";

function macDoorKeys(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac/i.test(uaData?.platform ?? navigator.platform);
}

function UpdateButton() {
  const s = useUpdaterState();
  const [checkedAt, setCheckedAt] = useState(0);
  const updater = window.ogb?.updater;
  const upToDate = Boolean(checkedAt) && (!s || s.status === "idle") && Date.now() - checkedAt < 3000;
  useEffect(() => {
    if (!upToDate) return;
    const timer = setTimeout(() => setCheckedAt(0), 3000);
    return () => clearTimeout(timer);
  }, [upToDate]);
  if (!updater) return null;

  const status = s?.status ?? "idle";
  const working = status === "checking" || status === "downloading";
  const label =
    status === "available"
      ? `Version ${s?.version ?? ""} available — download`
      : status === "downloading"
        ? `Downloading… ${Math.round(s?.percent ?? 0)}%`
        : status === "downloaded"
          ? `Version ${s?.version ?? ""} ready — restart to update`
          : status === "checking"
            ? "Checking for updates…"
            : upToDate
              ? "You're up to date"
              : "Check for updates";

  return (
    <button
      onClick={() => {
        if (status === "downloaded") return void updater.install();
        if (status === "available") return void updater.download();
        setCheckedAt(Date.now());
        void updater.check();
      }}
      disabled={working}
      title={label}
      aria-label={label}
      className="relative rounded-md p-2 text-accent hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agency disabled:opacity-60"
    >
      {working ? (
        <Loader2 size={18} className="animate-spin" />
      ) : upToDate ? (
        <Check size={18} />
      ) : status === "available" ? (
        <ArrowDownToLine size={18} />
      ) : (
        <RefreshCw size={18} />
      )}
      {status === "downloaded" && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" />}
    </button>
  );
}

export function Sidebar() {
  const { state, dispatch } = useStore();
  const workspaceTabs = useWorkspaceTabs();
  const { capabilities } = useDesktopCapabilities();
  const macInset = capabilities.windowChrome === "mac-inset";
  // The rail top drags the window on macOS (beside the traffic lights) and on Windows (below the title strip).
  const dragTop = macInset || window.ogb?.platform === "win32";
  const browser = capabilities.host.label === "Browser";

  // Sidebar re-renders on every store change, including each streamed chat
  // token. Rebuilding the whole queue there is invisible on a demo book and
  // jank on a real one.
  const desk = state.desk;
  const needYou = useMemo(
    () => (desk?.lastRunAt != null ? queueCounts(buildDeskQueue(desk)).now : 0),
    [desk],
  );

  const doorMod = macDoorKeys() ? "⌘" : "Ctrl+";
  const item = (
    view: typeof state.activeView,
    label: string,
    icon: React.ReactNode,
    action: () => void,
    extra?: ReactNode,
    shortcut?: string,
  ) => (
    <button
      onClick={action}
      aria-label={label}
      aria-current={state.activeView === view ? "page" : undefined}
      className={cn(
        "rb-sidebar-item rb-rail-item flex w-full items-center gap-3 rounded px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agency",
        state.activeView === view ? "bg-selected text-ink" : "text-ink hover:bg-raised/70",
      )}
    >
      {icon}
      <span className="rb-sidebar-label flex-1"><span className="block text-[15px] font-medium">{label}</span></span>
      {extra ? <span className="rb-sidebar-extra">{extra}</span> : null}
      {/* Visible on hover and keyboard focus; the accessible name is the aria-label. */}
      <span className="rb-rail-tip" aria-hidden>{label}{shortcut ? <span className="rb-rail-tip-key">{shortcut}</span> : null}</span>
    </button>
  );

  return (
    <aside className="rb-sidebar rb-rail flex h-full shrink-0 flex-col border-r border-line bg-sheet">
      <div
        className="rb-rail-top flex flex-col items-center gap-1.5 px-2 pb-1 pt-3"
        style={dragTop ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined}
      >
        {macInset ? <div className="rb-sidebar-traffic h-5 w-full" /> : browser ? (
          <div className="rb-sidebar-traffic flex items-center gap-1">
            <span className="size-2.5 rounded-full bg-[#ff5f57]" />
            <span className="size-2.5 rounded-full bg-[#febc2e]" />
            <span className="size-2.5 rounded-full bg-[#28c840]" />
          </div>
        ) : null}
        <div className="relative flex items-center justify-center" aria-label="RealBud">
          <MausAvatar color="green" state={state.connected ? "idle" : "sleeping"} size={26} label="RealBud" trackPointer={false} />
          {state.connected ? null : <span className="absolute -right-0.5 -top-0.5 size-2 animate-pulse rounded-full bg-hold motion-reduce:animate-none" aria-hidden />}
        </div>
        {/* Connected is the normal state, so only a reconnect is shown; the
            live region stays mounted so either change is still announced. */}
        <div className={state.connected ? "sr-only" : "rb-rail-reconnect text-[11px] text-ink-muted"} role="status" aria-live="polite">
          {state.connected ? "App connected" : "Reconnecting"}
        </div>
        <div style={dragTop ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}>
          <UpdateButton />
        </div>
      </div>

      <nav className="rb-sidebar-navigation flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pt-2" aria-label="Main navigation">
        {item(
          "desk",
          "Desk",
          <Building2 size={20} className={state.activeView === "desk" ? "text-agency" : "text-ink-muted"} />,
          () => dispatch({ type: "showDesk" }),
          needYou > 0 ? <span className="rb-rail-badge tabular-nums">{needYou}</span> : null,
          `${doorMod}1`,
        )}
        {item(
          "ask",
          "Work",
          <MessageSquare size={20} className={state.activeView === "ask" ? "text-agency" : "text-ink-muted"} />,
          () => dispatch({ type: "showAsk" }),
          undefined,
          `${doorMod}2`,
        )}
        {item(
          "schedule",
          "Schedule",
          <CalendarDays size={20} className={state.activeView === "schedule" ? "text-agency" : "text-ink-muted"} />,
          () => dispatch({ type: "showRoutines" }),
          state.loopRuns.some((run) => ["failed", "missed", "interrupted"].includes(run.status) && !run.seenAt) ? (
            <span className="size-2 rounded-full bg-danger" />
          ) : state.loopRuns.some((run) => ["partial", "awaiting-approval"].includes(run.status) && !run.seenAt) ? (
            <span className="size-2 rounded-full bg-hold" />
          ) : null,
          `${doorMod}3`,
        )}
        {/* Saved views live in the context sidebar; the rail keeps only the
            recovery entry so a damaged list stays reachable at every width. */}
        {workspaceTabs.error || workspaceTabs.data?.recovery ? <div className="rb-workspace-saved-navigation mt-2 border-t border-line pt-2">
          <button aria-label="Manage saved views" aria-current={state.activeView === 'workspace' && !state.workspaceTabId ? 'page' : undefined} className="rb-sidebar-item rb-rail-item rb-workspace-manage-view flex min-h-11 w-full items-center gap-3 rounded px-3 py-2.5 text-left text-ink hover:bg-raised/70 focus-visible:outline-2 focus-visible:outline-agency" onClick={() => dispatch({ type: 'showWorkspaceTab' })}><SlidersHorizontal size={20} className="shrink-0 text-hold" aria-hidden /><span className="rb-sidebar-label text-[14px]"><span>Saved views</span><span className="block text-[13px] text-hold">Needs attention</span></span><span className="rb-rail-tip" aria-hidden>Saved views need attention</span></button>
        </div> : null}
      </nav>
      <div className="rb-sidebar-utilities rb-rail-foot" aria-label="Workspace tools">
        <WorkdayPulse shortcut={`${doorMod}4`} />
        <span className="rb-rail-tip" aria-hidden>Workspace<span className="rb-rail-tip-key">{doorMod}4</span></span>
      </div>
    </aside>
  );
}
