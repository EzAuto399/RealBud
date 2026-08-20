import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownToLine, Bot as BotIcon, Building2, CalendarDays, Check, Loader2, RefreshCw } from "lucide-react";
import { useStore } from "@/state/store";
import { InitialsAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { useUpdaterState } from "@/lib/updater";

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
      className="relative rounded-md p-2 text-accent hover:bg-raised disabled:opacity-60"
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
  const { capabilities } = useDesktopCapabilities();
  const macInset = capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser";

  const item = (
    view: typeof state.activeView,
    label: string,
    icon: React.ReactNode,
    action: () => void,
    extra?: ReactNode,
  ) => (
    <button
      onClick={action}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
        state.activeView === view ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
      )}
    >
      {icon}
      <span className="flex-1 text-[14px] font-medium">{label}</span>
      {extra}
    </button>
  );

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-r border-hairline/40 bg-panel">
      <div
        className="flex items-center justify-between px-4 pt-3.5 pb-1"
        style={macInset ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined}
      >
        {macInset ? (
          <div className="w-14" />
        ) : browser ? (
          <div className="flex items-center gap-2">
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

      <nav className="flex flex-1 flex-col gap-0.5 px-3 pt-2">
        {item("desk", "Desk", <Building2 size={20} className={state.activeView === "desk" ? "text-accent" : "text-ink-secondary"} />, () =>
          dispatch({ type: "showDesk" }),
        )}
        {item("ask", "Ask", <BotIcon size={20} className={state.activeView === "ask" ? "text-accent" : "text-ink-secondary"} />, () =>
          dispatch({ type: "showAsk" }),
        )}
        {item(
          "schedule",
          "Schedule",
          <CalendarDays size={20} className={state.activeView === "schedule" ? "text-accent" : "text-ink-secondary"} />,
          () => dispatch({ type: "showRoutines" }),
          state.loopRuns.some((run) => ["failed", "missed", "interrupted"].includes(run.status) && !run.seenAt) ? (
            <span className="size-2 rounded-full bg-danger" />
          ) : null,
        )}
        {item("you", "You", <InitialsAvatar initials={profileInitials(state.config?.profile)} size={20} />, () =>
          dispatch({ type: "showYou" }),
        )}
      </nav>
    </aside>
  );
}
