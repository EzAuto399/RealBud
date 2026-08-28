import { useEffect, useRef } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, RefreshCw, X } from "lucide-react";

import { cn } from "@/lib/cn";
import type { PmsImportPreview } from "@shared/contracts";

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
}

function CountCell({ value, label, attention = false }: { value: number; label: string; attention?: boolean }) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className={cn("text-[20px] font-semibold tabular-nums", attention && value > 0 ? "text-hold" : "text-ink")}>{value}</div>
      <div className="mt-0.5 text-[10.5px] leading-tight text-ink-muted">{label}</div>
    </div>
  );
}

export function PmsImportReviewDialog({
  preview,
  fileLabel,
  busy,
  reviewing = false,
  error,
  onCancel,
  onConfirm,
  onReviewAgain,
}: {
  preview: PmsImportPreview;
  fileLabel: string;
  busy: boolean;
  reviewing?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
  onReviewAgain: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef(busy || reviewing);
  const cancelRef = useRef(onCancel);
  activeRef.current = busy || reviewing;
  cancelRef.current = onCancel;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => confirmRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !activeRef.current) {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (!controls.length) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus({ preventScroll: true });
    };
  }, []);

  const active = busy || reviewing;

  const importIssues = preview.rowsNeedingLink + preview.conflictingProperties + preview.missingProperties;
  const identityLabel = preview.identityKind === "code"
    ? "property code"
    : preview.identityKind === "address"
      ? "address"
      : "property ID";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-3" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pms-import-review-title"
        aria-describedby="pms-import-review-description"
        className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-[720px] flex-col overflow-hidden border border-line bg-sheet shadow-[0_18px_60px_rgb(37_35_31/0.18)]"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded border border-line bg-paper text-agency">
            <FileSpreadsheet size={17} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="pms-import-review-title" className="text-[16px] font-semibold text-ink">Review PMS import</h2>
            <p id="pms-import-review-description" className="mt-0.5 truncate text-[11.5px] text-ink-muted">
              {fileLabel} · {preview.totalRows} {preview.totalRows === 1 ? "row" : "rows"} · {formatBytes(preview.bytes)}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={active}
            aria-label="Close PMS import review"
            className="pm-control pm-tactile flex size-10 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-paper hover:text-ink disabled:opacity-40"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <section aria-labelledby="pms-import-impact-title">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id="pms-import-impact-title" className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">What RealBud found</h3>
              <span className="text-[11px] text-ink-muted">Matched by {identityLabel}</span>
            </div>
            <div className="mt-2 grid grid-cols-2 divide-x divide-y divide-line border border-line bg-paper min-[560px]:grid-cols-4 min-[560px]:divide-y-0">
              <CountCell value={preview.matchedProperties} label="properties matched" />
              <CountCell value={preview.rowsNeedingLink} label="rows need linking" attention />
              <CountCell value={preview.conflictingProperties} label="property conflicts" attention />
              <CountCell value={preview.missingProperties} label="book properties absent" attention />
            </div>
          </section>

          <section className="mt-4" aria-labelledby="pms-import-mapping-title">
            <h3 id="pms-import-mapping-title" className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Detected columns</h3>
            <div className="mt-2 divide-y divide-line border border-line bg-paper">
              {preview.columns.map((item) => (
                <div key={item.field} className="grid gap-1 px-3 py-2 text-[11.5px] min-[520px]:grid-cols-[minmax(10rem,0.8fr)_1.2fr_auto] min-[520px]:items-center">
                  <span className="font-semibold text-ink">{item.label}</span>
                  <span className="min-w-0 truncate font-mono text-[11px] text-ink-muted">{item.sourceHeader}</span>
                  <span className={item.required ? "text-agency" : "text-ink-muted"}>{item.required ? "Required" : "Optional"}</span>
                </div>
              ))}
            </div>
          </section>

          <section className={cn("mt-4 border px-3 py-3", preview.willVerifyLiveBook ? "border-agency/35 bg-selected/45" : "border-hold/45 bg-hold/10")}>
            <div className="flex items-start gap-2.5">
              {preview.willVerifyLiveBook
                ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-agency" aria-hidden="true" />
                : <AlertTriangle size={16} className="mt-0.5 shrink-0 text-hold" aria-hidden="true" />}
              <div>
                <h3 className="text-[12.5px] font-semibold text-ink">
                  {preview.willVerifyLiveBook
                    ? `${preview.matchedProperties} ${preview.matchedProperties === 1 ? "property is" : "properties are"} ready for one batch import`
                    : "This export cannot verify the live book yet"}
                </h3>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                  {preview.willVerifyLiveBook
                    ? `RealBud will update matched evidence in one encrypted commit. ${importIssues > 0 ? "Unclear coverage stays held on Desk." : "No coverage issue was found in this review."}`
                    : "You may still import the rows as held matching work, or cancel and choose the correct current export."}
                </p>
              </div>
            </div>
          </section>

          {preview.warnings.length ? (
            <ul className="mt-3 space-y-1.5 text-[11.5px] leading-relaxed text-ink-muted" aria-label="Import warnings">
              {preview.warnings.map((warning) => (
                <li key={warning} className="flex items-start gap-2">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0 text-hold" aria-hidden="true" />
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {error ? (
            <div role="alert" className="mt-4 border border-danger/35 bg-danger/10 px-3 py-2.5 text-[12px] text-danger">
              {error}
            </div>
          ) : null}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line bg-paper px-4 py-3">
          <p className="max-w-[25rem] text-[10.5px] leading-relaxed text-ink-muted">
            This review changes nothing. Import updates local evidence only; it never sends, pays or submits.
          </p>
          <div className="flex items-center gap-2">
            {error ? (
              <button
                type="button"
                onClick={onReviewAgain}
                disabled={active}
                className="pm-control pm-tactile inline-flex items-center gap-1.5 rounded border border-line bg-sheet px-3 text-[12px] font-semibold text-ink hover:border-agency/60 disabled:opacity-50"
              >
                {reviewing ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
                {reviewing ? "Reviewing…" : "Review again"}
              </button>
            ) : (
              <button
                type="button"
                onClick={onCancel}
                disabled={active}
                className="pm-control pm-tactile rounded border border-line bg-sheet px-3 text-[12px] font-semibold text-ink hover:border-agency/60 disabled:opacity-50"
              >
                Cancel
              </button>
            )}
            <button
              ref={confirmRef}
              type="button"
              onClick={onConfirm}
              disabled={active || Boolean(error)}
              aria-busy={busy}
              className="pm-control pm-tactile inline-flex items-center gap-2 rounded bg-agency px-3.5 text-[12.5px] font-semibold text-white hover:bg-agency-hover disabled:cursor-not-allowed disabled:opacity-55"
            >
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
              {busy ? "Importing…" : `Import ${preview.totalRows} ${preview.totalRows === 1 ? "row" : "rows"}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
