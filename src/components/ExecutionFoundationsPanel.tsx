import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, History, Loader2, RefreshCw, ShieldCheck } from "lucide-react";

import type { ExecutionAdapterProjection } from "@shared/contracts";
import { cn } from "@/lib/cn";
import { api } from "@/state/store";

function stateStyle(state: ExecutionAdapterProjection["state"]): string {
  if (state === "ready") return "border-agency/30 bg-selected text-agency";
  if (state === "attention" || state === "stale") return "border-hold/35 bg-hold/10 text-hold";
  return "border-line bg-paper text-ink-muted";
}

function StateIcon({ state }: { state: ExecutionAdapterProjection["state"] }) {
  if (state === "ready") return <CheckCircle2 size={12} />;
  if (state === "attention" || state === "stale") return <AlertCircle size={12} />;
  if (state === "runtime-unavailable") return <History size={12} />;
  return <ShieldCheck size={12} />;
}

export function ExecutionFoundationsPanel() {
  const [adapters, setAdapters] = useState<ExecutionAdapterProjection[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError("");
    void api("/api/execution-adapters")
      .then((body) => {
        if (!active) return;
        if (!Array.isArray(body.adapters)) throw new Error("Execution foundation status could not be read.");
        setAdapters(body.adapters as ExecutionAdapterProjection[]);
      })
      .catch((cause) => {
        if (!active) return;
        setAdapters(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, [reload]);

  const readyCount = useMemo(() => adapters?.filter((item) => item.state === "ready").length ?? 0, [adapters]);

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-3 border border-hold/45 bg-hold/10 px-4 py-3 text-[12.5px] text-hold">
        <AlertCircle size={16} />
        <span className="min-w-[14rem] flex-1">{error} No work route was enabled.</span>
        <button
          type="button"
          onClick={() => setReload((value) => value + 1)}
          className="pm-control pm-tactile inline-flex items-center gap-1.5 rounded border border-line bg-sheet px-3 text-ink hover:border-agency/60"
        >
          <RefreshCw size={13} /> Try again
        </button>
      </div>
    );
  }

  if (!adapters) {
    return (
      <div aria-busy="true" className="flex items-center gap-2 border border-line bg-sheet px-4 py-4 text-[12.5px] text-ink-muted">
        <Loader2 size={15} className="animate-spin" /> Checking governed execution foundations…
      </div>
    );
  }

  return (
    <details className="group border border-line bg-sheet">
      <summary className="pm-tactile flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-agency/50">
        <span className="flex size-9 shrink-0 items-center justify-center rounded border border-line bg-paper text-agency">
          <ShieldCheck size={17} />
        </span>
        <span className="min-w-[12rem] flex-1">
          <span className="block text-[14px] font-semibold text-ink">Advanced work methods</span>
          <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-muted">
            Governed foundations for named APIs, restricted connectors, isolated tasks, cloud lanes and recovery history.
          </span>
        </span>
        <span className="text-right text-[11.5px] text-ink-muted">
          {readyCount} live · {adapters.length} foundations
        </span>
        <ChevronDown size={15} className="text-ink-muted transition-transform group-open:rotate-180" />
      </summary>

      <div className="border-t border-line">
        <div className="divide-y divide-line/70">
          {adapters.map((adapter) => (
            <article key={adapter.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(12rem,0.36fr)_1fr] sm:gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-[12.5px] font-semibold text-ink">{adapter.label}</h4>
                  <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium", stateStyle(adapter.state))}>
                    <StateIcon state={adapter.state} /> {adapter.status}
                  </span>
                </div>
                <p className="mt-1 text-[11.5px] text-ink-muted">{adapter.method}</p>
              </div>
              <div>
                <p className="text-[12px] leading-relaxed text-ink-muted">{adapter.detail}</p>
                <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-muted" aria-label={`${adapter.label} boundaries`}>
                  {adapter.capabilities.map((capability) => <li key={capability}>• {capability}</li>)}
                </ul>
              </div>
            </article>
          ))}
        </div>
        <p className="border-t border-line bg-paper px-4 py-3 text-[11.5px] leading-relaxed text-ink-muted">
          Foundation built does not mean connected. A method becomes live only from a fresh app-owned receipt for its exact version, named account and policy. Raw tools, ambient credentials, personal browsers and personal Hermes remain unavailable; cloud always has a complete local fallback.
        </p>
      </div>
    </details>
  );
}
