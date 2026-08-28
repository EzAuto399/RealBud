import { useCallback, useEffect, useState } from "react";
import { Building2, Check, ChevronDown, Circle, Loader2, RefreshCw } from "lucide-react";

import { cn } from "@/lib/cn";
import { api } from "@/state/store";
import type { PilotDiscoveryProjection } from "@shared/contracts";
import { Card } from "./SettingsPrimitives";

function evidenceLabel(value: PilotDiscoveryProjection["shadowWorkflows"][number]["currentEvidence"]): string {
  if (value === "source-built") return "Source-built";
  if (value === "foundation-built") return "Safe foundation built";
  return "Pilot fields needed";
}

function FieldStateIcon({ state }: { state: PilotDiscoveryProjection["fields"][number]["state"] }) {
  if (state === "confirmed") return <Check size={14} aria-hidden="true" className="text-agency" />;
  if (state === "partial") return <Building2 size={14} aria-hidden="true" className="text-hold" />;
  return <Circle size={11} aria-hidden="true" className="text-ink-muted" />;
}

export function PilotDiscoveryCard({ discovery }: { discovery: PilotDiscoveryProjection }) {
  const progress = `${discovery.readiness.confirmedFields} of ${discovery.readiness.requiredFields}`;
  const officeState = discovery.office.state === "unconfigured"
    ? "Discovery needed"
    : discovery.office.state === "partial"
      ? "Setup incomplete"
      : "Contract complete";

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[16rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-medium text-ink">Agency systems</h2>
            <span className="rounded-full border border-hold/35 bg-hold/10 px-2 py-0.5 text-[10.5px] font-semibold text-hold">
              {officeState}
            </span>
          </div>
          <p className="mt-1 text-[13px] font-semibold text-ink">{discovery.office.agency ?? "No agency configured"}</p>
          <p className="mt-1 max-w-[48rem] text-[12.5px] leading-relaxed text-ink-secondary">
            {discovery.office.summary}
          </p>
        </div>
        <div className="min-w-[9.5rem] rounded border border-line bg-paper px-3 py-2 text-right">
          <div className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">Operational fields</div>
          <div className="mt-0.5 text-[17px] font-semibold tabular-nums text-ink">{progress} confirmed</div>
          <div className="mt-0.5 text-[10.5px] text-ink-muted">Release stays pilot-gated</div>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {discovery.office.signals.map((signal) => (
          <div key={signal} className="flex items-start gap-2 rounded border border-line bg-paper px-3 py-2 text-[11.5px] leading-relaxed text-ink-secondary">
            <Circle size={7} aria-hidden="true" className="mt-1.5 shrink-0 fill-current text-agency" />
            <span>{signal}</span>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted">First shadow workflows</div>
        <div className="mt-2 grid gap-2 lg:grid-cols-3">
          {discovery.shadowWorkflows.map((workflow) => (
            <article key={workflow.id} className="rounded border border-line bg-inset px-3 py-3">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-[12.5px] font-semibold text-ink">{workflow.label}</h3>
                <span className="shrink-0 text-[10.5px] font-medium text-agency">{evidenceLabel(workflow.currentEvidence)}</span>
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">{workflow.outcome}</p>
              <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-ink-muted">Ask on visit: {workflow.baselineQuestion}</p>
            </article>
          ))}
        </div>
      </div>

      <details className="group mt-4 border-t border-line pt-3">
        <summary className="pm-control pm-tactile flex cursor-pointer list-none items-center justify-between gap-3 rounded px-1 text-[12.5px] font-semibold text-ink marker:content-none">
          <span>Confirm the eight pilot fields</span>
          <ChevronDown size={15} aria-hidden="true" className="transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-2 divide-y divide-line border border-line bg-paper">
          {discovery.fields.map((item, index) => (
            <div key={item.id} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[1.35rem_minmax(10rem,0.65fr)_minmax(15rem,1.35fr)] sm:items-start">
              <span className="mt-0.5 flex size-5 items-center justify-center" aria-label={item.state.replace("-", " ")}>
                <FieldStateIcon state={item.state} />
              </span>
              <div className="text-[12px] font-semibold text-ink">
                {index + 1}. {item.label}
                <span className={cn("ml-1.5 font-normal", item.state === "confirmed" ? "text-agency" : item.state === "partial" ? "text-hold" : "text-ink-muted")}>
                  {item.value ?? "not confirmed"}
                </span>
              </div>
              <div className="text-[11.5px] leading-relaxed text-ink-muted">{item.question}</div>
            </div>
          ))}
        </div>
      </details>

      <details className="group mt-3 border-t border-line pt-3">
        <summary className="pm-control pm-tactile flex cursor-pointer list-none items-center justify-between gap-3 rounded px-1 text-[12.5px] font-semibold text-ink marker:content-none">
          <span>How RealBud fits common Australian systems</span>
          <ChevronDown size={15} aria-hidden="true" className="transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {discovery.systemFamilies.map((family) => (
            <article key={family.id} className="rounded border border-line bg-paper px-3 py-3">
              <h3 className="text-[12.5px] font-semibold text-ink">{family.label}</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                Recognises: {family.recognisedExamples.join(" · ")}
              </p>
              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
                Route: {family.routeOrder.join(" → ")}
              </p>
              <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-ink-muted">
                Proof before use: {family.proofNeeded}
              </p>
            </article>
          ))}
        </div>
      </details>

      <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-relaxed text-ink-muted">
        External research can shorten discovery, but it never enters this runtime projection or grants an account, browser session, legal authority, Pocket identity or release approval. Allow and human Submit remain locked.
      </p>
    </Card>
  );
}

export function PilotDiscoveryPanel() {
  const [discovery, setDiscovery] = useState<PilotDiscoveryProjection | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const body = await api("/api/pilot-discovery");
      if (body.discovery?.kind !== "realbud.pilot-discovery.v1") throw new Error("Pilot discovery returned an unsupported response.");
      setDiscovery(body.discovery as PilotDiscoveryProjection);
    } catch (cause) {
      setDiscovery(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Card title="Agency systems" subtitle="Loading the local, read-only discovery plan.">
        <div role="status" className="flex items-center gap-2 text-[12.5px] text-ink-muted">
          <Loader2 size={14} aria-hidden="true" className="animate-spin" /> Checking pilot discovery…
        </div>
      </Card>
    );
  }

  if (error || !discovery) {
    return (
      <Card title="Agency systems" subtitle="The local discovery plan could not be read. No setup or capability changed.">
        <p role="alert" className="text-[12.5px] text-danger">{error || "Pilot discovery is unavailable."}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="pm-control pm-tactile mt-3 inline-flex items-center gap-2 rounded border border-line bg-sheet px-3 text-[12.5px] font-semibold text-ink hover:border-agency/60"
        >
          <RefreshCw size={13} aria-hidden="true" /> Try again
        </button>
      </Card>
    );
  }

  return <PilotDiscoveryCard discovery={discovery} />;
}
