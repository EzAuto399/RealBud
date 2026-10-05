import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

// Toasts are for background results only ("Morning money check finished",
// "Saved"). An error that needs someone to act stays inline on its card, where
// the retry or recovery control lives; never route it through here.

export const MAX_TOASTS = 3;
export const TOAST_MS = 5000;

export type Toast = { id: string; message: string };

/** Newest last; older toasts drop off once MAX_TOASTS are showing. */
export function addToast(list: readonly Toast[], toast: Toast): Toast[] {
  return [...list.filter(item => item.id !== toast.id), toast].slice(-MAX_TOASTS);
}

let nextId = 0;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, id = `toast-${++nextId}`) => { setToasts(list => addToast(list, { id, message })); return id; }, []);
  const dismiss = useCallback((id: string) => setToasts(list => list.filter(item => item.id !== id)), []);
  return { toasts, push, dismiss };
}

export function ToastStack({ toasts, onDismiss }: { toasts: readonly Toast[]; onDismiss: (id: string) => void }) {
  // The live region is always mounted so screen readers hear the first toast.
  return (
    <div role="status" aria-live="polite" aria-label="Updates" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
      {toasts.slice(-MAX_TOASTS).map(toast => <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />)}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(TOAST_MS);
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => { clearTimeout(timer); remaining.current -= Date.now() - started; };
  }, [paused, toast.id, onDismiss]);
  return (
    <div
      className="pointer-events-auto flex items-center gap-2 rounded-lg border border-line bg-sheet py-1 pl-4 pr-1 text-[14px] text-ink shadow-md transition-[opacity,transform] duration-200 starting:translate-y-2 starting:opacity-0 motion-reduce:transition-none"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="min-w-0 flex-1">{toast.message}</span>
      <button type="button" aria-label={`Dismiss: ${toast.message}`} className="pm-control flex min-w-11 items-center justify-center rounded-md text-ink-muted hover:bg-raised" onClick={() => onDismiss(toast.id)}>
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
