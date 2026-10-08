// The open app windows a person may give a task, from GET /api/desktop/windows.
// This list only lets the person choose; the server checks the chosen window
// again before every step (server/desktop-fence.ts).
import { parseDesktopWindows, type DesktopTarget } from "@shared/desktop-task";

export type DesktopWindowsState =
  | { status: "loading" }
  | { status: "ready"; windows: DesktopTarget[] }
  | { status: "unavailable" }
  | { status: "error" };

type Request = (path: string, init?: RequestInit, opts?: { timeoutMs?: number }) => Promise<unknown>;

/** A server without the route, or a computer where app tasks are off, reads "unavailable", never an error. A malformed list is an error. */
export async function loadDesktopWindows(request: Request): Promise<DesktopWindowsState> {
  try {
    return { status: "ready", windows: parseDesktopWindows(await request("/api/desktop/windows", undefined, { timeoutMs: 10_000 })).windows };
  } catch (cause) {
    const status = (cause as { status?: unknown } | null)?.status;
    return status === 404 || status === 501 || status === 503 ? { status: "unavailable" } : { status: "error" };
  }
}

/** "Mail — Inbox", or just the app's name when the window has no title. */
export const desktopWindowLabel = (window: Pick<DesktopTarget, "appName" | "title">) =>
  window.title.trim() ? `${window.appName} — ${window.title}` : window.appName;

/** What Start sends for an app window. The one place to change if the server's shape changes. */
export const desktopStartBody = (window: DesktopTarget) => ({ window: { pid: window.pid, windowId: window.windowId } });
