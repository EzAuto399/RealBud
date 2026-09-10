import { useEffect, useRef, type RefObject } from "react";

/** Keep focus inside a dialog and restore it without refocusing on every edit. */
export function useDialogKeyboard(ref: RefObject<HTMLElement | null>, onClose: () => void, busy = false) {
  const latest = useRef({ onClose, busy }); latest.current = { onClose, busy };
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex="0"]')].filter(el => el.getClientRects().length > 0);
    (root.querySelector<HTMLElement>('[data-dialog-autofocus]') ?? root).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (!latest.current.busy) latest.current.onClose();
      }
      if (event.key !== "Tab") return;
      const list = focusables(), first = list[0], last = list.at(-1);
      if (!first) { event.preventDefault(); root.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) { event.preventDefault(); first.focus(); }
    };
    root.addEventListener("keydown", onKey);
    return () => { root.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, [ref]);
}
