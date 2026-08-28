import { flushSync } from "react-dom";

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Run a React update inside a same-document view transition when the
 * browser allows it. Reduced-motion and missing API fall back to a plain
 * update. flushSync is required so the new tree is captured in this frame. */
export function withViewTransition(update: () => void): void {
  if (
    prefersReducedMotion() ||
    typeof document === "undefined" ||
    typeof document.startViewTransition !== "function"
  ) {
    update();
    return;
  }
  document.startViewTransition(() => {
    flushSync(update);
  });
}

/** Delay for a named stagger (Recheck land, suggestion cards). */
export function staggerMs(index: number, step = 40, cap = 700): number {
  if (index <= 0) return 0;
  return Math.min(index * step, cap);
}
