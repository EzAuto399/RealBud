export type ProductView = "desk" | "ask" | "schedule" | "you";

export const ACTIVE_VIEW_SESSION_KEY = "realbud.active-view.v1";

interface ActiveViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserSessionStorage(): ActiveViewStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function isProductView(value: unknown): value is ProductView {
  return value === "desk" || value === "ask" || value === "schedule" || value === "you";
}

/**
 * Keep a PM on the same product surface through an in-window refresh or local
 * server bounce. Session storage deliberately expires with the window, so a
 * genuinely new RealBud session still starts on Desk.
 */
export function readActiveView(storage: ActiveViewStorage | undefined = browserSessionStorage()): ProductView {
  if (!storage) return "desk";
  try {
    const value = storage.getItem(ACTIVE_VIEW_SESSION_KEY);
    return isProductView(value) ? value : "desk";
  } catch {
    return "desk";
  }
}

export function writeActiveView(
  view: ProductView,
  storage: ActiveViewStorage | undefined = browserSessionStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(ACTIVE_VIEW_SESSION_KEY, view);
  } catch {
    // Navigation must remain usable if storage is blocked or unavailable.
  }
}
