/** Observe connection health only. Never retry a sign-in, write, or job. */
export function monitorCompanyStatus(options: {
  check: () => Promise<boolean | undefined>;
  visible: () => boolean;
  events: Pick<Window, "addEventListener" | "removeEventListener">;
  visibilityEvents: Pick<Document, "addEventListener" | "removeEventListener">;
}) {
  let stopped = false;
  let running = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped) return;
    const delay = failures ? [5_000, 15_000, 30_000, 60_000][Math.min(failures - 1, 3)] : 30_000;
    timer = setTimeout(() => { void check(); }, delay);
  };
  const check = async () => {
    if (stopped || running) return;
    clearTimeout(timer);
    if (!options.visible()) { schedule(); return; }
    running = true;
    try {
      const healthy = await options.check();
      if (healthy !== undefined) failures = healthy ? 0 : failures + 1;
    } catch { failures++; }
    finally { running = false; schedule(); }
  };
  const wake = () => { if (options.visible()) void check(); };
  options.events.addEventListener("online", wake);
  options.events.addEventListener("focus", wake);
  options.visibilityEvents.addEventListener("visibilitychange", wake);
  schedule();
  return () => {
    stopped = true; clearTimeout(timer);
    options.events.removeEventListener("online", wake);
    options.events.removeEventListener("focus", wake);
    options.visibilityEvents.removeEventListener("visibilitychange", wake);
  };
}
