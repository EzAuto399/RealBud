import { useState } from "react";
import { AlertCircle, Download, Loader2, ShieldCheck } from "lucide-react";

import type { SupportReport } from "@shared/contracts";
import { cn } from "@/lib/cn";
import { api } from "@/state/store";

type RuntimeLabels = Pick<SupportReport, "app" | "evidence">;

function evidenceLabel(value: SupportReport["evidence"][keyof SupportReport["evidence"]]): string {
  if (value === "pilot-gated") return "Pilot details required";
  if (value === "contract-complete-unproved") return "Contract complete · live proof required";
  if (value === "requires-installed-proof") return "Installed proof required";
  return "Run separately · not embedded";
}

export function SupportEvidencePanel({ release }: { release?: RuntimeLabels | null }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const report = await api("/api/support-report") as SupportReport;
      if (report.kind !== "realbud.support-report.v1") throw new Error("The support report format was not recognised.");
      const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `realbud-support-${report.generatedAt.replace(/[:.]/g, "-")}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);
      setMessage({ ok: true, text: "Support report prepared. It contains health categories and counts, not tenant data or credentials." });
    } catch (cause) {
      setMessage({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-3 border-t border-line pt-3 font-sans">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded bg-selected text-agency"><ShieldCheck size={15} /></span>
        <div className="min-w-[15rem] flex-1">
          <h4 className="text-[12.5px] font-semibold text-ink">Build and evidence</h4>
          {release ? (
            <dl className="mt-1.5 grid gap-x-4 gap-y-1 text-[11.5px] text-ink-muted sm:grid-cols-2">
              <div><dt className="inline font-medium text-ink-secondary">Version </dt><dd className="inline">{release.app.version}</dd></div>
              <div><dt className="inline font-medium text-ink-secondary">Build </dt><dd className="inline">{release.app.buildId ?? "Unlabelled working tree"}</dd></div>
              <div><dt className="inline font-medium text-ink-secondary">Runtime </dt><dd className="inline">{release.app.distribution === "packaged" ? "Packaged app" : "Source run"}</dd></div>
              <div><dt className="inline font-medium text-ink-secondary">Source evidence </dt><dd className="inline">{evidenceLabel(release.evidence.source)}</dd></div>
              <div><dt className="inline font-medium text-ink-secondary">Installed evidence </dt><dd className="inline">{evidenceLabel(release.evidence.installed)}</dd></div>
              <div><dt className="inline font-medium text-ink-secondary">Office evidence </dt><dd className="inline">{evidenceLabel(release.evidence.namedOffice)}</dd></div>
            </dl>
          ) : <p className="mt-1 text-[11.5px] text-hold">Build labels are unavailable. Reopen RealBud before collecting evidence.</p>}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void download()}
          className="pm-control pm-tactile inline-flex items-center gap-1.5 rounded border border-line bg-paper px-3 text-[12px] font-medium text-ink hover:border-agency/60 disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {busy ? "Preparing…" : "Download support report"}
        </button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
        This report cannot prove source tests, installation, notarization or a named office workflow. Those remain separate evidence runs.
      </p>
      {message ? (
        <p role="status" className={cn("mt-2 flex items-center gap-1.5 text-[11.5px]", message.ok ? "text-agency" : "text-danger")}>
          {!message.ok ? <AlertCircle size={13} /> : null}{message.text}
        </p>
      ) : null}
    </section>
  );
}
