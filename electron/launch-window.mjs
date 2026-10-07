// The launch window opens before the office service is decided.
//
// On a slow first start (98.5 s to the first window on a Windows VM) nothing
// appeared until startOrAdoptOfficeService() had finished, so opening RealBud
// looked like it had done nothing. The window now comes first, on the waiting
// page, and the same single start-or-adopt decision runs behind it. Pure, so the
// order is testable without Electron.

/**
 * Create the launch window, then start the office service decision.
 *
 * `start` runs exactly once, on the next microtask, so `createWindow` has always
 * returned first. The window is only given the pending decision to wait on; it
 * never starts or adopts a service itself.
 *
 * @template W
 * @param {{ createWindow: (decided: Promise<unknown>) => W, start: () => unknown }} options
 * @returns {{ win: W, decided: Promise<unknown> }}
 */
export function openWindowWhileServiceStarts({ createWindow, start }) {
  const decided = Promise.resolve().then(start);
  return { win: createWindow(decided), decided };
}

/**
 * Show `waitingUrl` in `win` now, and once `decided` settles — resolved or
 * rejected — hand the SAME window to `show` for the outcome (the desk, a
 * start-problem page or the bounded wait). A failure therefore replaces the
 * waiting page instead of opening a second window. The waiting page's own load
 * finishes first, so its load events are never mistaken for the desk's. A
 * window closed during the wait stays closed.
 *
 * @param {{ loadURL: (url: string) => unknown, isDestroyed: () => boolean }} win
 * @param {{ waitingUrl: string, decided: Promise<unknown>, show: () => void }} options
 */
export async function showWhenDecided(win, { waitingUrl, decided, show }) {
  const waitingShown = (async () => win.loadURL(waitingUrl))().catch(() => {});
  await Promise.resolve(decided).catch(() => {});
  await waitingShown;
  if (!win.isDestroyed()) show();
}
