import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Database, Loader2, Mail, PauseCircle, RefreshCw } from "lucide-react";

import { cn } from "@/lib/cn";
import type { SourceConnection, SourceConnectionMethodState, SourceConnectionState } from "@/lib/source-connections";
import { api } from "@/state/store";

function stateStyle(state: SourceConnectionState): string {
  if (state === "ready") return "border-agency/30 bg-selected text-agency";
  if (state === "attention") return "border-hold/35 bg-hold/10 text-hold";
  return "border-line bg-paper text-ink-muted";
}

function StateIcon({ state }: { state: SourceConnectionState }) {
  if (state === "ready") return <CheckCircle2 size={12} />;
  if (state === "attention") return <AlertCircle size={12} />;
  return <PauseCircle size={12} />;
}

function methodStatus(state: SourceConnectionMethodState): string {
  if (state === "active") return "Available now";
  if (state === "practice") return "Practice only";
  if (state === "attention") return "Needs recheck";
  if (state === "pilot-gated") return "Pilot-gated";
  return "Not built";
}

function ConnectionRow({
  connection,
  revealMethods,
  suggestedAlias,
  onOpenDesk,
  onOpenAsk,
  onAliasSaved,
}: {
  connection: SourceConnection;
  revealMethods: boolean;
  suggestedAlias?: string;
  onOpenDesk?: () => void;
  onOpenAsk?: () => void;
  onAliasSaved?: (connections: SourceConnection[]) => void;
}) {
  const Icon = connection.id === "property-book" ? Database : Mail;
  const [methodsOpen, setMethodsOpen] = useState(revealMethods);
  const [aliasDraft, setAliasDraft] = useState(connection.alias ?? suggestedAlias ?? "");
  const [aliasBusy, setAliasBusy] = useState(false);
  const [aliasError, setAliasError] = useState("");
  const displayName = connection.alias || connection.title;
  return (
    <article id={connection.id} className={cn("border bg-sheet", connection.state === "attention" ? "border-hold/45" : "border-line")}>
      <div className="flex flex-wrap items-start gap-3 px-4 py-3.5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded border border-line bg-paper text-agency">
          <Icon size={18} />
        </div>
        <div className="min-w-[15rem] flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[14px] font-semibold text-ink">{displayName}</h3>
            <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", stateStyle(connection.state))}>
              <StateIcon state={connection.state} />
              {connection.status}
            </span>
          </div>
          <p className="mt-1 max-w-[52rem] text-[12.5px] leading-relaxed text-ink-muted">{connection.description}</p>
          {connection.alias ? <p className="mt-1 text-[11.5px] text-ink-muted">Official name: {connection.title}</p> : null}
          <form
            className="mt-2 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (aliasBusy) return;
              setAliasBusy(true);
              setAliasError("");
              void api("/api/source-connections/aliases", {
                method: "PATCH",
                body: JSON.stringify({ id: connection.id, alias: aliasDraft }),
              })
                .then((body: { connections?: SourceConnection[] }) => {
                  if (Array.isArray(body.connections)) onAliasSaved?.(body.connections);
                })
                .catch((cause) => setAliasError(cause instanceof Error ? cause.message : String(cause)))
                .finally(() => setAliasBusy(false));
            }}
          >
            <label className="min-w-[12rem] flex-1 text-[11.5px] text-ink-muted">
              Name this office uses
              <input
                value={aliasDraft}
                onChange={(event) => setAliasDraft(event.target.value.slice(0, 40))}
                placeholder={connection.id === "property-book" ? "The name on your PMS login" : "The inbox this office uses"}
                className="pm-control mt-1 w-full rounded border border-line bg-inset px-2.5 text-[12.5px] text-ink placeholder:text-ink-muted focus:border-agency"
              />
            </label>
            <button
              type="submit"
              disabled={aliasBusy}
              className="pm-control pm-tactile rounded border border-line bg-sheet px-2.5 text-[11.5px] font-semibold text-ink hover:border-agency/55 disabled:opacity-50"
            >
              {aliasBusy ? "Saving…" : "Save alias"}
            </button>
          </form>
          {aliasError ? <p className="mt-1 text-[11.5px] text-danger" role="alert">{aliasError}</p> : null}
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-muted" aria-label={`${connection.title} capabilities`}>
            {connection.capabilities.map((capability) => <li key={capability}>• {capability}</li>)}
          </ul>
        </div>
        {connection.id === "property-book" && onOpenDesk ? (
          <button
            type="button"
            onClick={onOpenDesk}
            className="pm-control pm-tactile rounded border border-line bg-sheet px-3 text-[12.5px] font-semibold text-ink hover:border-agency/60 hover:bg-selected/45"
          >
            Open Desk
          </button>
        ) : null}
      </div>
      <details
        open={methodsOpen}
        onToggle={(event) => setMethodsOpen(event.currentTarget.open)}
        className="group border-t border-line/70 px-4 py-2.5"
      >
        <summary className="pm-tactile flex cursor-pointer list-none items-center gap-2 text-[12px] font-medium text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-agency/50">
          <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
          Connection methods <span className="font-normal">(Advanced)</span>
        </summary>
        <div className="mt-2 divide-y divide-line/70 border border-line bg-paper">
          {connection.methods.map((method) => {
            const action = method.id === "local-export" && onOpenDesk
              ? { label: "Open Desk import", run: onOpenDesk }
              : (method.id === "selected-evidence" || method.id === "paste-manual") && onOpenAsk
                ? { label: "Open Ask", run: onOpenAsk }
                : null;
            return (
            <div key={method.id} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(10rem,0.28fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
              <div>
                <div className="text-[12.5px] font-medium text-ink">{method.label}</div>
                <div className={cn("mt-0.5 text-[11px]", method.state === "active" ? "text-agency" : method.state === "attention" ? "text-hold" : "text-ink-muted")}>{methodStatus(method.state)}</div>
              </div>
              <p className="text-[12px] leading-relaxed text-ink-muted">{method.detail}</p>
              {action ? (
                <button
                  type="button"
                  onClick={action.run}
                  className="pm-control pm-tactile justify-self-start rounded border border-line bg-sheet px-2.5 text-[11.5px] font-semibold text-ink hover:border-agency/55 hover:bg-selected/45 sm:justify-self-end"
                >
                  {action.label}
                </button>
              ) : null}
            </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-muted">
          The method never changes the authority boundary: one named account, an exact read operation list, no raw tools in Ask, and no send, pay or calendar-write path.
        </p>
      </details>
    </article>
  );
}

export function SourceConnectionsPanel({
  deskRevision,
  visibleIds,
  revealMethods = false,
  suggestedAliases,
  onOpenDesk,
  onOpenAsk,
}: {
  deskRevision?: number;
  visibleIds?: readonly SourceConnection["id"][];
  revealMethods?: boolean;
  suggestedAliases?: Partial<Record<SourceConnection["id"], string>>;
  onOpenDesk?: () => void;
  onOpenAsk?: () => void;
}) {
  const [connections, setConnections] = useState<SourceConnection[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError("");
    void api("/api/source-connections")
      .then((body) => {
        if (!active) return;
        if (!Array.isArray(body.connections)) throw new Error("Connection status could not be read.");
        setConnections(body.connections as SourceConnection[]);
      })
      .catch((cause) => {
        if (!active) return;
        setConnections(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, [deskRevision, reload]);

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-3 border border-hold/45 bg-hold/10 px-4 py-3 text-[12.5px] text-hold">
        <AlertCircle size={16} />
        <span className="min-w-[14rem] flex-1">{error} Existing Desk and routine work is unchanged.</span>
        <button type="button" onClick={() => setReload((value) => value + 1)} className="pm-control pm-tactile inline-flex items-center gap-1.5 rounded border border-line bg-sheet px-3 text-ink hover:border-agency/60">
          <RefreshCw size={13} /> Try again
        </button>
      </div>
    );
  }

  if (!connections) {
    return (
      <div aria-busy="true" className="flex items-center gap-2 border border-line bg-sheet px-4 py-4 text-[12.5px] text-ink-muted">
        <Loader2 size={15} className="animate-spin" /> Checking source connections…
      </div>
    );
  }

  const visible = visibleIds ? new Set(visibleIds) : null;
  const filtered = visible ? connections.filter((connection) => visible.has(connection.id)) : connections;
  if (!filtered.length) return null;

  return (
    <div className="space-y-2">
      {filtered.map((connection) => (
        <ConnectionRow
          key={`${connection.id}:${revealMethods ? "methods-open" : "methods-closed"}`}
          connection={connection}
          revealMethods={revealMethods}
          suggestedAlias={suggestedAliases?.[connection.id]}
          onOpenDesk={onOpenDesk}
          onOpenAsk={onOpenAsk}
          onAliasSaved={setConnections}
        />
      ))}
    </div>
  );
}
