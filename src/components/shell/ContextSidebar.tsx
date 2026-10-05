import { Bookmark, Building2, CalendarDays, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { queueCounts, type QueueFilter } from "@/lib/desk-queue";
import { useWorkspaceTabs, WORKSPACE_VIEW_LABELS } from "@/lib/workspace-tabs";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { useDeskNav } from "./use-desk-nav";
import { openArrangeDesk } from "./shell-layout";

const PROPERTY_LIMIT = 8;
const GROUPS: Array<[QueueFilter, string]> = [["now", "Needs you"], ["next", "Next"], ["waiting", "Waiting"], ["done", "Done today"], ["all", "All tasks"]];

function Item({ current, onClick, children, label, detail }: { current?: boolean; onClick: () => void; children?: ReactNode; label: string; detail?: string }) {
  return (
    <button type="button" className={cn("rb-context-item", current && "is-current")} aria-current={current ? "true" : undefined} onClick={onClick}>
      <span className="min-w-0 flex-1"><span className="block truncate">{label}</span>{detail ? <span className="block truncate text-[12px] text-ink-muted">{detail}</span> : null}</span>
      {children}
    </button>
  );
}
const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="rb-context-group"><p className="rb-context-label">{label}</p>{children}</div>
);

function DeskContext() {
  const { state } = useStore();
  const nav = useDeskNav();
  const counts = queueCounts(nav.rows);
  const properties = state.desk?.properties ?? [];
  return (<>
    <Group label="Queue">
      {GROUPS.map(([filter, label]) => {
        const count = filter === "all" ? nav.rows.length : counts[filter];
        return <Item key={filter} label={label} current={nav.filter === filter} onClick={() => nav.openFilter(filter)}>{count ? <span className="rb-context-count">{count}</span> : null}</Item>;
      })}
    </Group>
    <Group label="Properties">
      {properties.length ? properties.slice(0, PROPERTY_LIMIT).map(property => (
        <Item key={property.id} label={property.address.split(",")[0]?.trim() || property.address} detail={property.tenantName || undefined}
          current={nav.scopeIds?.length === 1 && nav.scopeIds[0] === property.id} onClick={() => nav.openProperty(property.id, property.address)} />
      )) : <p className="px-3 py-1.5 text-[13px] text-ink-muted">{state.desk ? "No properties on the book yet." : "Loading the book…"}</p>}
      {properties.length ? <Item label={`All ${properties.length} properties`} current={nav.tab === "properties"} onClick={() => nav.openTab("properties")} /> : null}
    </Group>
    <button type="button" className="rb-context-item rb-context-arrange" onClick={openArrangeDesk}>Arrange Desk</button>
  </>);
}

function WorkContext() {
  const { state, dispatch } = useStore();
  const bud = state.bots.find(bot => bot.id === "bud" || bot.name === "Bud") ?? state.bots[0];
  const tasks = bud?.tasks ?? [];
  return (
    <Group label="Threads">
      {!bud ? <p className="px-3 py-1.5 text-[13px] text-ink-muted">{state.connected ? "Bud is starting…" : "Connecting…"}</p>
        : tasks.length > 1 ? tasks.map(task => (
          <Item key={task.threadId} label={task.title || "Conversation"} current={task.threadId === bud.threadId && state.activeView === "ask"}
            onClick={() => { if (task.threadId !== bud.threadId) dispatch({ type: "switchTask", botId: bud.id, threadId: task.threadId }); dispatch({ type: "showAsk" }); }} />
        )) : <Item label="Today with Bud" current={state.activeView === "ask"} onClick={() => dispatch({ type: "showAsk" })} />}
    </Group>
  );
}

function ScheduleContext() {
  const { state, dispatch } = useStore();
  const loops = state.loops.filter(loop => loop.available);
  return (
    <Group label="Loops">
      {loops.length ? loops.map(loop => (
        <Item key={loop.id} label={loop.name} detail={!loop.enabled ? "Off" : loop.timezonePaused ? "Paused" : loop.nextRunAt ? `Next ${new Date(loop.nextRunAt).toLocaleString("en-AU", { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "On"}
          onClick={() => dispatch({ type: "showRoutines" })} />
      )) : <p className="px-3 py-1.5 text-[13px] text-ink-muted">{state.activityLoad.routines === "loading" ? "Loading loops…" : "No loops available yet."}</p>}
    </Group>
  );
}

/** Saved views Bud set up; shown in plain words in every area. */
function SavedViews() {
  const { state, dispatch } = useStore();
  const tabs = useWorkspaceTabs().data?.state?.tabs.filter(tab => tab.visible) ?? [];
  if (!tabs.length) return null;
  return (
    <nav aria-label="Saved views" className="rb-context-group">
      <p className="rb-context-label">Saved views</p>
      {tabs.map(tab => {
        const current = state.activeView === "workspace" && state.workspaceTabId === tab.id;
        return (
          <button key={tab.id} type="button" aria-label={tab.label} title={tab.label} aria-current={current ? "page" : undefined}
            className={cn("rb-context-item", current && "is-current")} onClick={() => dispatch({ type: "showWorkspaceTab", id: tab.id })}>
            <Bookmark size={16} className="shrink-0 text-ink-muted" aria-hidden />
            <span className="min-w-0 flex-1"><span className="block break-words">{tab.label}</span><span className="block text-[12px] text-ink-muted">{WORKSPACE_VIEW_LABELS[tab.view.kind]}</span></span>
          </button>
        );
      })}
    </nav>
  );
}

const AREA = {
  desk: { title: "Desk", icon: Building2, body: DeskContext },
  ask: { title: "Work", icon: MessageSquare, body: WorkContext },
  schedule: { title: "Schedule", icon: CalendarDays, body: ScheduleContext },
} as const;

/** Per-area context beside the rail. Hidden below 960px, where the rail remains. */
export function ContextSidebar() {
  const { state } = useStore();
  const key = state.activeView === "workspace" || state.activeView === "chat" ? "desk" : state.activeView;
  if (key === "you") return null;
  const area = AREA[key];
  const Body = area.body;
  return (
    <div className="rb-context-sidebar" aria-label={`${area.title} context`} role="region">
      <p className="rb-context-title"><area.icon size={16} className="text-agency" aria-hidden />{area.title}</p>
      <div className="rb-context-scroll">
        <Body />
        <SavedViews />
      </div>
    </div>
  );
}
