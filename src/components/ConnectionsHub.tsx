import { useEffect, useMemo, useState } from "react";
import { BellRing, Search, X } from "lucide-react";

import {
  CONNECTION_DISCOVERY_ITEMS,
  categoryForYouFocus,
  connectionSearchRequestsMethods,
  filterConnectionDiscovery,
  type ConnectionCategoryId,
} from "@/lib/connection-discovery";
import { buildConnectionRoster, connectionRosterSummary } from "@/lib/connection-roster";
import { cn } from "@/lib/cn";
import type { SourceConnection } from "@/lib/source-connections";
import { useStore } from "@/state/store";
import { ComputerUseConnectionCard } from "./ComputerUseConnectionCard";
import { ComposioAccountCard } from "./ComposioAccountCard";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { ExecutionFoundationsPanel } from "./ExecutionFoundationsPanel";
import { PocketConnectionCard } from "./PocketConnectionCard";
import { SourceConnectionsPanel } from "./SourceConnectionsPanel";
import { VerifiedConnectionCard } from "./VerifiedConnectionCard";

const CATEGORIES: ReadonlyArray<{ id: ConnectionCategoryId; label: string }> = [
  { id: "common", label: "Common" },
  { id: "all", label: "All" },
  { id: "portfolio", label: "Portfolio" },
  { id: "inbox", label: "Inbox & calendar" },
  { id: "desktop", label: "This Mac" },
  { id: "pocket", label: "Pocket" },
];

function categoryCount(id: ConnectionCategoryId): number {
  if (id === "all") return CONNECTION_DISCOVERY_ITEMS.length;
  if (id === "common") return CONNECTION_DISCOVERY_ITEMS.filter((item) => item.common).length;
  return CONNECTION_DISCOVERY_ITEMS.filter((item) => item.category === id).length;
}

export function ConnectionsHub({
  deskRevision,
  desktopRemindersAvailable,
  remindersOn,
  focus,
  onToggleReminders,
  onOpenDesk,
  onOpenAsk,
}: {
  deskRevision?: number;
  desktopRemindersAvailable: boolean;
  remindersOn: boolean;
  focus?: string | null;
  onToggleReminders?: () => void;
  onOpenDesk: () => void;
  onOpenAsk: () => void;
}) {
  const { state } = useStore();
  const desktop = useDesktopCapabilities();
  const [query, setQuery] = useState(focus === "composio-account" ? "composio" : "");
  const [category, setCategory] = useState<ConnectionCategoryId>(categoryForYouFocus(focus));
  useEffect(() => {
    setCategory(categoryForYouFocus(focus));
    if (focus === "composio-account") setQuery("composio");
  }, [focus]);
  const matches = useMemo(() => filterConnectionDiscovery(query, category), [category, query]);
  const revealSourceMethods = connectionSearchRequestsMethods(query);
  const showComposio = /\bcomposio\b/i.test(query);
  const visible = useMemo(() => new Set(matches.map((item) => item.id)), [matches]);
  const sourceIds = (["property-book", "inbound-mail-calendar"] as const)
    .filter((id) => visible.has(id)) satisfies SourceConnection["id"][];
  const pocketChannels = (["telegram", "whatsapp-business"] as const)
    .filter((id) => visible.has(id));
  const showDesktop = visible.has("advanced-work") || visible.has("computer-use") || visible.has("desktop-reminders");
  const roster = useMemo(
    () => buildConnectionRoster({
      deskMode: state.desk?.mode,
      deskRecovery: Boolean(state.desk?.recovery?.active),
      sourceLabels: state.desk?.sources,
      pocketTelegram: state.config?.pocket?.channels.telegram.state,
      pocketWhatsapp: state.config?.pocket?.channels.whatsappCloud.state,
      computerUseAvailable: desktop.capabilities.localComputer.available,
      remindersAvailable: desktopRemindersAvailable,
      remindersOn,
    }),
    [
      desktop.capabilities.localComputer.available,
      desktopRemindersAvailable,
      remindersOn,
      state.config?.pocket?.channels.telegram.state,
      state.config?.pocket?.channels.whatsappCloud.state,
      state.desk?.mode,
      state.desk?.recovery?.active,
      state.desk?.sources,
    ],
  );
  const visibleRoster = roster.filter((row) => visible.has(row.id));
  const summary = connectionRosterSummary(visibleRoster);
  const clear = () => {
    setQuery("");
    setCategory("common");
  };

  return (
    <div className="space-y-4">
      <div className="border border-line bg-sheet">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Office connections</h2>
            <p className="mt-0.5 max-w-[48rem] text-[12.5px] leading-relaxed text-ink-muted">
              Tell Ask the PMS, inbox or portal this office already uses, or name it here. Connected means RealBud can read that source. Keys stay in You.
            </p>
          </div>
          <span className="text-[12px] tabular-nums text-ink-muted">
            {summary.connected} connected · {summary.notYet} not yet
            {summary.attention ? ` · ${summary.attention} need you` : ""}
          </span>
        </div>

        <div className="space-y-3 px-4 py-3.5">
          <label htmlFor="connection-search" className="sr-only">Search connections</label>
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3 top-3 text-ink-muted" />
            <input
              id="connection-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value.slice(0, 120))}
              placeholder="Search PMS, inbox, portal or Pocket"
              className="pm-search-input pm-control w-full rounded border border-line bg-inset pl-9 pr-12 text-[13.5px] text-ink placeholder:text-ink-muted focus:border-agency"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear connection search"
                className="pm-control pm-tactile absolute right-0 top-0 flex w-10 items-center justify-center rounded text-ink-muted hover:bg-raised hover:text-ink"
              >
                <X size={15} />
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter connections">
            {CATEGORIES.map((item) => {
              const count = categoryCount(item.id);
              const selected = category === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setCategory(item.id)}
                  className={cn(
                    "pm-control pm-tactile rounded border px-3 text-[12px] font-medium",
                    selected
                      ? "border-agency bg-selected text-agency"
                      : "border-line bg-sheet text-ink-muted hover:border-agency/55 hover:text-ink",
                  )}
                >
                  {item.label} <span className="ml-1 tabular-nums opacity-70">{count}</span>
                </button>
              );
            })}
          </div>

          {visibleRoster.length ? (
            <ul className="divide-y divide-line/70 border border-line bg-paper" aria-label="Connection status">
              {visibleRoster.map((row) => (
                <li key={row.id}>
                  <a
                    href={`#${row.href}`}
                    className="pm-tactile flex items-center justify-between gap-3 px-3 py-2 text-[12.5px] hover:bg-selected/40"
                  >
                    <span className="font-medium text-ink">{row.label}</span>
                    <span className={cn(
                      "shrink-0 text-[12px] font-medium",
                      row.tone === "ready" ? "text-agency" : row.tone === "attention" ? "text-hold" : "text-ink-muted",
                    )}>
                      {row.status}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          <p className="text-[12px] text-ink-muted" aria-live="polite">
            {matches.length === 1 ? "1 connection shown." : `${matches.length} connections shown.`}
          </p>
        </div>
      </div>

      {!matches.length ? (
        <div className="border border-line bg-sheet px-5 py-8 text-center">
          <h3 className="text-[14px] font-semibold text-ink">No connections match</h3>
          <p className="mt-1 text-[12.5px] text-ink-muted">
            Try the PMS you already use, “inbox”, “portal”, or “mobile”.
          </p>
          <button
            type="button"
            onClick={clear}
            className="pm-control pm-tactile mt-4 rounded border border-line bg-sheet px-3 text-[12.5px] font-semibold text-ink hover:border-agency/60 hover:bg-selected/45"
          >
            Show common connections
          </button>
        </div>
      ) : (
        <>
          {showComposio ? <ComposioAccountCard /> : null}
          {sourceIds.length ? (
            <section aria-labelledby="source-capabilities-heading" className="space-y-2">
              <div className="flex items-baseline justify-between gap-3 px-1">
                <h3 id="source-capabilities-heading" className="text-[12px] font-medium uppercase tracking-[0.12em] text-ink-secondary">Sources and communication</h3>
                <span className="text-[12px] text-ink-muted">Read and stage only</span>
              </div>
              <SourceConnectionsPanel
                deskRevision={deskRevision}
                visibleIds={sourceIds}
                revealMethods={revealSourceMethods}
                onOpenDesk={onOpenDesk}
                onOpenAsk={onOpenAsk}
              />
            </section>
          ) : null}

          {showDesktop ? (
            <section aria-labelledby="desktop-capabilities-heading" className="space-y-2">
              <div className="flex items-baseline justify-between gap-3 px-1">
                <h3 id="desktop-capabilities-heading" className="text-[12px] font-medium uppercase tracking-[0.12em] text-ink-secondary">On this Mac</h3>
                <span className="text-[12px] text-ink-muted">Local and private</span>
              </div>
              {visible.has("computer-use") ? (
                <section id="computer-use-setup" tabIndex={-1} className="scroll-m-28 outline-none">
                  <ComputerUseConnectionCard />
                </section>
              ) : null}
              {visible.has("advanced-work") ? (
                <section id="advanced-work" tabIndex={-1} className="scroll-m-28 outline-none">
                  <ExecutionFoundationsPanel />
                </section>
              ) : null}
              {visible.has("desktop-reminders") ? (
                <section id="desktop-reminders-setup" tabIndex={-1} className="scroll-m-28 outline-none">
                  <VerifiedConnectionCard
                    icon={<BellRing size={18} />}
                    title="Desktop reminders"
                    description="Alerts only when a routine fails, is missed, is interrupted, or leaves held work. The banner contains no property, tenant or balance details."
                    meta="Local desktop only · opens Desk or Schedule · never messages a tenant, owner or tradie"
                    state={!desktopRemindersAvailable ? "off" : remindersOn ? "ready" : "off"}
                    status={!desktopRemindersAvailable ? "Desktop app only" : remindersOn ? "On" : "Off"}
                    action={!desktopRemindersAvailable || !onToggleReminders
                      ? undefined
                      : { label: remindersOn ? "Turn off" : "Turn on", onClick: onToggleReminders }}
                  />
                </section>
              ) : null}
            </section>
          ) : null}

          {pocketChannels.length ? <PocketConnectionCard visibleChannels={pocketChannels} /> : null}
        </>
      )}
    </div>
  );
}
