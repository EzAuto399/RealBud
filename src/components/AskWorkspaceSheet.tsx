import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useDialogKeyboard } from "@/lib/use-dialog-keyboard";

/** Existing setup and schedule owners, shown without unmounting the Ask draft. */
export function AskWorkspaceSheet({ title, onClose, children, origin = "Ask" }: { title: string; onClose: () => void; children: ReactNode; origin?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useDialogKeyboard(ref, onClose);
  useEffect(() => { ref.current?.focus(); }, [title]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-3 sm:p-5" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className="flex h-[min(820px,90dvh)] w-full max-w-[1000px] min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-paper shadow-xl">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-sheet px-4 py-2">
        <div><h2 id={id} className="text-[15px] font-semibold text-ink">{title}</h2><p className="text-[12px] text-ink-muted">Your work stays in {origin}.</p></div>
        <button type="button" aria-label={`Close ${title}`} onClick={onClose} className="pm-control inline-flex items-center gap-2 px-3">Back to {origin}<X size={16} aria-hidden /></button>
      </div>
      <div data-you-scroll className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  </div>;
}
