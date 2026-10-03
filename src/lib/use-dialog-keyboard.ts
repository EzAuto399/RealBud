import { useEffect, useRef, type RefObject } from "react";

export const DIALOG_FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [href], [tabindex="0"]';

/** Content of a closed <details> can still report layout boxes (Chromium hides
 *  it with content-visibility), yet it cannot take focus; only its own summary can. */
function insideClosedDetails(el: Element) {
  for (let details = el.parentElement?.closest("details"); details; details = details.parentElement?.closest("details")) {
    if (!details.open && !details.querySelector(":scope > summary")?.contains(el)) return true;
  }
  return false;
}

/** The controls Tab can actually reach inside a dialog, in document order. */
export function dialogFocusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)].filter(el => el.getClientRects().length > 0 && !el.closest("[inert]") && el.getAttribute("tabindex") !== "-1"
    && !insideClosedDetails(el) && (typeof el.checkVisibility !== "function" || el.checkVisibility()));
}

/** Keep focus inside a dialog and restore it without refocusing on every edit. */
export function useDialogKeyboard(ref: RefObject<HTMLElement | null>, onClose: () => void, busy = false, open = true) {
  const latest = useRef({ onClose, busy }); latest.current = { onClose, busy };
  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => dialogFocusables(root);
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
  }, [ref, open]);
}
