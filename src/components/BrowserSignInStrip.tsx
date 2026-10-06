// Sign-in handover in Ask: Bud opened the work browser on a site's sign-in
// page and waits while the person signs in there. Done and Stop go to the
// server, which decides; the strip only shows its state.
import { LogIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";

export type BrowserSignInState = "waiting" | "wrong_account" | "signed_in" | "stopped" | "timed_out";
export interface BrowserSignInView { id: string; site: string; origin: string; state: BrowserSignInState; message: string }
const STATES: readonly BrowserSignInState[] = ["waiting", "wrong_account", "signed_in", "stopped", "timed_out"];
const str = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** A malformed reply is an error, never a strip. */
export function parseBrowserSignIns(value: unknown): BrowserSignInView[] {
  const rows = (value as { handovers?: unknown } | null)?.handovers;
  if (!Array.isArray(rows)) throw new Error("Bud sent sign-in details this app cannot read.");
  return rows.map(raw => {
    const row = (raw ?? {}) as Record<string, unknown>;
    if (!str(row.id, 64) || !str(row.site, 260) || !str(row.origin, 260) || !STATES.includes(row.state as BrowserSignInState) || !str(row.message, 500)) throw new Error("Bud sent sign-in details this app cannot read.");
    return { id: row.id, site: row.site, origin: row.origin, state: row.state as BrowserSignInState, message: row.message };
  });
}

const open = (state: BrowserSignInState) => state === "waiting" || state === "wrong_account";

export function BrowserSignInStrip({ handover, busy = false, error, onDone, onStop }: {
  handover: BrowserSignInView; busy?: boolean; error?: string | null; onDone: () => void; onStop: () => void;
}) {
  return (
    <section aria-label={`Sign in to ${handover.site}`} className={cn("w-full max-w-[48rem] rounded-lg border bg-sheet px-4 py-3", open(handover.state) ? "border-portal/40" : "border-line")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <LogIn size={14} aria-hidden="true" className="text-ink-muted" />
        <p role="status" className={cn("min-w-0 flex-1 text-[14px] leading-relaxed", handover.state === "wrong_account" ? "text-hold" : "text-ink")}>{handover.message}</p>
        {open(handover.state) ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={onDone} aria-label={`Done signing in to ${handover.site}`}
              className="pm-decision rounded bg-agency px-4 text-[14px] font-medium text-white transition-colors hover:bg-agency-hover disabled:opacity-50">Done</button>
            <button type="button" disabled={busy} onClick={onStop} aria-label={`Stop signing in to ${handover.site}`}
              className="pm-control rounded border border-line px-3.5 text-[14px] text-ink transition-colors hover:bg-selected disabled:opacity-50">Stop</button>
          </div>
        ) : null}
      </div>
      {error ? <p role="alert" className="mt-2 text-[13px] leading-relaxed text-danger">{error}</p> : null}
    </section>
  );
}

/** The thread's sign-in handovers: polled while Bud is working or a handover is open. */
export function useBrowserSignIns({ threadId, busy, enabled }: { threadId: string; busy: boolean; enabled: boolean }) {
  const [handovers, setHandovers] = useState<BrowserSignInView[]>([]);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++epoch.current;
    try {
      const next = parseBrowserSignIns(await api(`/api/browser/sign-in?threadId=${encodeURIComponent(threadId)}`, undefined, { timeoutMs: 10_000 }));
      if (request === epoch.current) setHandovers(next);
    } catch { if (request === epoch.current) setHandovers([]); }
  }, [threadId]);
  const watching = enabled && (busy || handovers.some(item => open(item.state)));
  useEffect(() => {
    if (!enabled) { setHandovers([]); return; }
    // One read in flight: the next poll waits for this one to settle, so a
    // slow reply is never made stale by the poll that follows it.
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!stopped && watching) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [enabled, watching, refresh]);
  const act = useCallback(async (id: string, action: "done" | "stop") => {
    if (acting) return;
    setActing(id); setError(null);
    try { await api(`/api/browser/sign-in/${id}/${action}`, { method: "POST", body: "{}" }, { timeoutMs: 10_000 }); }
    catch (cause) { setError({ id, text: typeof (cause as { status?: unknown })?.status === "number" ? (cause as Error).message : "RealBud could not confirm this. Check the sign-in again." }); }
    finally { setActing(null); void refresh(); }
  }, [acting, refresh]);
  return { handovers, acting, error, act, refresh };
}
