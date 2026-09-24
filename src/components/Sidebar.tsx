import { openWorkspaceSetup } from "@/lib/workspace-setup";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownToLine, Building2, CalendarDays, Check, Loader2, MessageSquare, RefreshCw, User, Bookmark, SlidersHorizontal } from "lucide-react";
import { useWorkspaceTabs, WORKSPACE_VIEW_LABELS } from '@/lib/workspace-tabs';
import '@/workspace-tabs.css';
import { useStore } from "@/state/store";
import { InitialsAvatar, MausAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import { buildDeskQueue, queueCounts } from "@/lib/desk-queue";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { useUpdaterState } from "@/lib/updater";
import { WorkdayPulse } from "./WorkdayPulse";

function macDoorKeys(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac/i.test(uaData?.platform ?? navigator.platform);
}

function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
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
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-current={state.activeView === view ? "page" : undefined}
      className={cn(
        "rb-sidebar-item flex w-full items-center gap-3 rounded px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agency",
        state.activeView === view ? "bg-selected text-ink" : "text-ink hover:bg-raised/70",
      )}
    >
      {icon}
      <span className="rb-sidebar-label flex-1"><span className="block text-[14px] font-medium">{label}</span><span className="mt-0.5 block text-[12px] text-ink-muted">{{ desk: "Tasks & properties", ask: "Work with Bud", schedule: "Jobs & routines", you: "Office & settings", chat: "Conversation", workspace: 'Saved views' }[view]}</span></span>
      {extra ? <span className="rb-sidebar-extra">{extra}</span> : null}
    </button>
  );

  return (
    <aside className="rb-sidebar flex h-full w-[200px] shrink-0 flex-col border-r border-line bg-sheet">
      <div
        className="px-4 pb-1 pt-3.5"
        style={macInset ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined}
      >
        <div className="flex items-center justify-between">
          {macInset ? (
            <div className="rb-sidebar-traffic w-14" />
          ) : browser ? (
            <div className="rb-sidebar-traffic flex items-center gap-2">
              <span className="size-3 rounded-full bg-[#ff5f57]" />
              <span className="size-3 rounded-full bg-[#febc2e]" />
              <span className="size-3 rounded-full bg-[#28c840]" />
            </div>
          ) : (
            <div />
          )}
          <div style={macInset ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}>
            <UpdateButton />
          </div>
        </div>
        <div className="mt-2.5 flex items-center justify-center gap-2 sm:justify-start" aria-label="RealBud">
          <MausAvatar color="green" state={state.connected ? "idle" : "sleeping"} size={26} label="RealBud" trackPointer={false} />
          <div className="rb-sidebar-brand min-w-0">
            <div className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink">RealBud</div>
            <div className="flex items-center gap-1.5 text-[12px] text-ink-muted" role="status" aria-live="polite">
              <span className={cn("size-1.5 rounded-full", state.connected ? "bg-agency" : "animate-pulse bg-hold motion-reduce:animate-none")} />
              {state.connected ? "App connected" : "Reconnecting"}
            </div>
          </div>
        </div>
      </div>

      <nav className="rb-sidebar-navigation flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-2" aria-label="Main navigation">
        <p className="rb-sidebar-label rb-sidebar-section-label">Workspace</p>
        {item(
          "desk",
          "Desk",
          <Building2 size={20} className={state.activeView === "desk" ? "text-agency" : "text-ink-muted"} />,
          () => dispatch({ type: "showDesk" }),
          needYou > 0 ? <span className="text-[11px] tabular-nums text-ink-muted">{needYou}</span> : null,
          `${doorMod}1`,
        )}
        {item(
          "ask",
          "Ask",
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
        {item(
          "you",
          "You",
          profileInitials(state.config?.profile) === "?" ? (
            <User size={20} className={state.activeView === "you" ? "text-agency" : "text-ink-muted"} aria-hidden />
          ) : (
            <InitialsAvatar initials={profileInitials(state.config?.profile)} size={20} />
          ),
          () => dispatch({ type: "showYou" }),
          undefined,
          `${doorMod}4`,
        )}
        <div className="rb-workspace-saved-navigation mt-3 border-t border-line pt-2">
          {workspaceTabs.data?.state?.tabs.filter(tab => tab.visible).map(tab => <button key={tab.id} aria-label={tab.label} title={tab.label} aria-current={state.activeView === 'workspace' && state.workspaceTabId === tab.id ? 'page' : undefined} className={cn('rb-sidebar-item rb-workspace-custom-tab flex min-h-11 w-full items-center gap-3 rounded px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-agency', state.activeView === 'workspace' && state.workspaceTabId === tab.id ? 'bg-selected text-ink' : 'text-ink hover:bg-raised/70')} onClick={() => dispatch({ type: 'showWorkspaceTab', id: tab.id })}><Bookmark size={20} className="shrink-0 text-ink-muted" aria-hidden /><span className="rb-sidebar-label min-w-0 flex-1"><span className="block break-words text-[14px] font-medium">{tab.label}</span><span className="block text-[12px] text-ink-muted">{WORKSPACE_VIEW_LABELS[tab.view.kind]}</span></span></button>)}
          <button aria-label="Manage saved views" title="Manage saved views" aria-current={state.activeView === 'workspace' && !state.workspaceTabId ? 'page' : undefined} className="rb-sidebar-item rb-workspace-manage-view flex min-h-11 w-full items-center gap-3 rounded px-3 py-2.5 text-left text-ink hover:bg-raised/70 focus-visible:outline-2 focus-visible:outline-agency" onClick={() => dispatch({ type: 'showWorkspaceTab' })}><SlidersHorizontal size={20} className="shrink-0 text-ink-muted" aria-hidden /><span className="rb-sidebar-label text-[14px]"><span>Manage views</span>{workspaceTabs.error || workspaceTabs.data?.recovery ? <span className="block text-[12px] text-hold">Needs attention</span> : null}</span></button>
        </div>
      </nav>
      <div className="rb-sidebar-pulse">
        <div className="px-3 pb-2"><button type="button" className="pm-control w-full border border-line" onClick={() => openWorkspaceSetup("apps")}>Connections</button></div>
        <WorkdayPulse />
      </div>
    </aside>
  );
}
