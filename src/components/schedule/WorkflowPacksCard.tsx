// Import first-party office packs onto Schedule. RealBud owns the clock;
// Hermes prepares steps after the workspace owner approves a plan.
import { useCallback, useEffect, useState } from "react";
import { PackagePlus, Loader2, CheckCircle2, CircleAlert, Download, Upload } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  type WorkflowPackStatus,
  workflowPackInstallLabel,
  workflowPackPhaseLabel,
} from "@/lib/workflow-packs";
import { api } from "@/state/store";
import { CompanyWorkflowTemplates } from './CompanyWorkflowTemplates';
import { CustomerPackSetupCard } from './CustomerPackSetupCard';
import { AgencyWorkflowSetup } from './AgencyWorkflowSetup';

type Props = {
  onInstalled?: () => void | Promise<void>;
  className?: string;
};

export function WorkflowPacksCard({ onInstalled, className }: Props) {
  const [packs, setPacks] = useState<WorkflowPackStatus[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const body = await api("/api/workflow-packs", undefined, { timeoutMs: 15_000 });
    setPacks(Array.isArray(body.packs) ? body.packs : []);
    setError("");
  }, []);

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Packs could not load.");
      setPacks([]);
    });
  }, [refresh]);

  const install = async (packId: string | "austin-phase-1") => {
    setBusy(packId);
    setNotice("");
    setError("");
    try {
      const path =
        packId === "austin-phase-1"
          ? "/api/workflow-packs/austin-phase-1/install"
          : `/api/workflow-packs/${packId}/install`;
      await api(path, { method: "POST" }, { timeoutMs: 30_000 });
      await refresh();
      await onInstalled?.();
      setNotice(
        packId === "austin-phase-1"
          ? "Missing Austin Phase 1 jobs were added for review. Existing plans and schedules were kept. Confirm sources and a cadence before enabling recurring work."
          : "Missing pack jobs were added for review. Existing plans and schedules were kept.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Install failed.");
    } finally {
      setBusy(null);
    }
  };

  const exportSnapshot = async () => {
    setBusy("export");
    setNotice("");
    setError("");
    try {
      const body = await api("/api/workflow-packs/export", undefined, { timeoutMs: 15_000 });
      const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `realbud-workflow-packs-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("Pack export downloaded. Keep it with office backups — it restores Schedule jobs, not source-account sign-ins or credentials.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  };

  const importSnapshot = async (file: File | null) => {
    if (!file) return;
    setBusy("import");
    setNotice("");
    setError("");
    try {
      if (file.size > 1_000_000) throw new Error("Pack snapshots must be smaller than 1 MB.");
      const text = await file.text();
      const payload = JSON.parse(text) as unknown;
      await api("/api/workflow-packs/import", { method: "POST", body: JSON.stringify(payload) }, { timeoutMs: 30_000 });
      await refresh();
      await onInstalled?.();
      setNotice("Snapshot checked. New jobs need local approval; existing plans were kept. Confirm sources and cadence before turning routines on.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed.");
    } finally {
      setBusy(null);
    }
  };

  const allInstalled = Boolean(packs?.length && packs.every((pack) => pack.installed));

  return (
    <section
      id="schedule-packs"
      tabIndex={-1}
      role="region"
      aria-label="Agency workflow setup and packs"
      className={cn("mb-6 rounded-xl border border-line bg-sheet p-4", className)}
    >
      <div className="flex items-start gap-3">
        <PackagePlus size={20} className="mt-0.5 shrink-0 text-agency" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-medium text-ink">Set up your workflows</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">
            The three workspace setup steps happen here: your agency’s name, timezone and pack on one form, then your own Gmail, then approving the selected work and turning its schedule on. Enabling a schedule stays a decision you take yourself.
          </p>
        </div>
      </div>

      <div className="mt-4"><AgencyWorkflowSetup onSaved={onInstalled} /></div>
      <CustomerPackSetupCard onInstalled={async () => { await refresh(); await onInstalled?.(); }} />
      <CompanyWorkflowTemplates onInstalled={async () => { await refresh(); await onInstalled?.(); }} />
      <details className="mt-5 border-t border-line pt-3">
        <summary className="min-h-11 cursor-pointer text-sm font-medium text-ink">Optional Austin Phase 1 examples and older pack snapshots</summary>
        <p className="mt-2 text-sm text-ink-secondary">These customer-specific examples are optional. Importing them does not select an agency, connect an account or enable a schedule. For your own agency, use the guided setup and preview a matching pack above.</p>

      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 rounded-lg border border-agency/25 bg-agency/10 px-3 py-2 text-[13px] text-ink">
          {notice}
        </p>
      ) : null}

      {packs == null ? (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-ink-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden /> Loading packs…
        </p>
      ) : packs.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-secondary">No office packs are available in this build.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {packs.map((pack) => {
            const label = workflowPackInstallLabel(pack);
            return (
              <li key={pack.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[14px] font-medium text-ink">{pack.title}</span>
                    <span className="rounded bg-raised px-2 py-0.5 text-[11px] text-ink-muted">
                      {workflowPackPhaseLabel(pack.phase)}
                    </span>
                    <span
                      className={cn(
                        "rounded px-2 py-0.5 text-[11px]",
                        pack.installed ? "bg-agency/15 text-agency" : "bg-hold/10 text-hold",
                      )}
                    >
                      {label}
                    </span>
                  </div>
                  <p className="mt-1 text-[12.5px] text-ink-secondary">{pack.summary}</p>
                </div>
                <button
                  type="button"
                  disabled={busy != null}
                  onClick={() => void install(pack.id)}
                  className="pm-control shrink-0 rounded-md border border-line bg-paper px-3 text-[13px] text-ink hover:bg-selected disabled:opacity-50"
                >
                  {busy === pack.id ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 size={14} className="animate-spin" aria-hidden /> Working…
                    </span>
                  ) : pack.installed ? (
                    "Refresh"
                  ) : (
                    "Import"
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy != null || packs == null}
          onClick={() => void install("austin-phase-1")}
          className="pm-control rounded-md border border-agency/40 bg-agency/10 px-3 text-[13px] text-ink hover:bg-agency/15 disabled:opacity-50"
        >
          {busy === "austin-phase-1" ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 size={14} className="animate-spin" aria-hidden /> Importing Phase 1…
            </span>
          ) : allInstalled ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 size={14} aria-hidden /> Refresh Austin Phase 1
            </span>
          ) : (
            "Import Austin Phase 1 packs"
          )}
        </button>
        <button
          type="button"
          disabled={busy != null}
          onClick={() => void exportSnapshot()}
          className="pm-control inline-flex items-center gap-1.5 rounded-md border border-line bg-paper px-3 text-[13px] text-ink hover:bg-selected disabled:opacity-50"
        >
          {busy === "export" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Download size={14} aria-hidden />}
          Export snapshot
        </button>
        <label className="pm-control inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-paper px-3 text-[13px] text-ink hover:bg-selected has-[:disabled]:opacity-50">
          {busy === "import" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Upload size={14} aria-hidden />}
          Restore snapshot
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            disabled={busy != null}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = "";
              void importSnapshot(file);
            }}
          />
        </label>
        <p className="text-[12px] text-ink-muted">
          <CircleAlert size={12} className="mr-1 inline align-text-bottom" aria-hidden />
          New jobs stay off until you approve the plan. Restore keeps identical local jobs and rejects conflicting edits.
        </p>
      </div>
      </details>
    </section>
  );
}
