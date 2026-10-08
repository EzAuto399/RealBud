// Desktop task target: the one app window a desktop task may work in, as the
// person chose it from the open-window list. Dependency-free: the server
// checks it against the live window list before every step
// (server/desktop-fence.ts); the app shows the list from GET /api/desktop/windows.

export interface DesktopTarget {
  /** The app's name as the system shows it, e.g. "Mail". */
  appName: string;
  /** Reverse-DNS bundle id, e.g. "com.apple.mail". A changed id means another app. */
  bundleId: string;
  pid: number;
  windowId: number;
  /** The window title when chosen; it may be empty. */
  title: string;
}

/** `GET /api/desktop/windows`. */
export interface DesktopWindowsResponse {
  windows: DesktopTarget[];
}

export const DESKTOP_TARGET_KEYS = ["appName", "bundleId", "pid", "windowId", "title"] as const;
export const DESKTOP_WINDOWS_MAX = 200;

const INVALID = "This app window is incomplete or damaged. Choose the window again.";
const invalid = (): never => { throw new Error(INVALID); };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}
const text = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" && value.trim().length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const bundleId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(value);
const positive = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;

/** Validates one window. Unknown keys, unbounded strings and unsafe ids are refused. */
export function parseDesktopTarget(value: unknown): DesktopTarget {
  const row = exact(value, DESKTOP_TARGET_KEYS);
  if (!text(row.appName, 1, 200) || !bundleId(row.bundleId) || !positive(row.pid, 0x7fffffff) ||
    !positive(row.windowId, 0xffffffff) || !text(row.title, 0, 500)) invalid();
  return { appName: row.appName as string, bundleId: row.bundleId as string, pid: row.pid as number, windowId: row.windowId as number, title: row.title as string };
}

export function parseDesktopWindows(value: unknown): DesktopWindowsResponse {
  const row = exact(value, ["windows"]);
  if (!Array.isArray(row.windows) || row.windows.length > DESKTOP_WINDOWS_MAX) invalid();
  const windows = (row.windows as unknown[]).map(parseDesktopTarget);
  if (new Set(windows.map(window => window.windowId)).size !== windows.length) invalid();
  return { windows };
}
