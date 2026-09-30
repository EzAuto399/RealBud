import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowRight, CircleAlert, Loader2, ShieldCheck } from "lucide-react";
import { autoRestoreBudPin, autoRunBudReadiness } from "@/lib/boot-heal";
import { budAutoSetupView, budAvailability, budFacingCopy, budReadinessFailure, parseBudStatus } from "@/lib/bud-setup";
import { budReadinessCheck } from "@/lib/bud-readiness";
import { useServiceAdminAccess } from "@/lib/use-service-admin-access";
import { useBudStatusMonitor } from "@/lib/bud-status-monitor";
import { api, useStore } from "@/state/store";

export function AskReadiness({ onSetup }: { onSetup: () => void }) {
  const { state, dispatch } = useStore();
  const canAdminister = useServiceAdminAccess(state.serviceAdmin ?? state.config?.serviceAdmin);
  const refreshStatus = useCallback(async (isCurrent: () => boolean) => {
    const status = parseBudStatus(await api("/api/hermes", undefined, { timeoutMs: 15_000 }));
    if (isCurrent()) dispatch({ type: "hermesStatus", status });
  }, [dispatch]);
  const statusRead = useBudStatusMonitor({ enabled: state.connected, onRefresh: refreshStatus });
  const checking = useSyncExternalStore(budReadinessCheck.subscribe, budReadinessCheck.isRunning, budReadinessCheck.isRunning);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const mounted = useRef(false);
  const pinRestoreStarted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const availability = budAvailability(state.hermes, state.connected, Boolean(state.desk?.recovery?.active), { canAdminister });
  // Automatic setup after an approved office link: progress, no action needed.
  const automatic = Boolean(budAutoSetupView(state.hermes)?.working) && !statusRead.error;
  const failure = error || (automatic ? null : budReadinessFailure(state.hermes));
  const pinDrift = Boolean(
    state.hermes?.cli.installed && !(state.hermes.cli.compatible ?? state.hermes.cli.matchesPin) && !state.hermes.restartRequired,
  );
  // An install error describes the worker it failed on. Once the worker's
  // install facts change (installed elsewhere, restarted), that error is stale.
  const workerKey = [
    state.hermes?.cli.installed, state.hermes?.cli.compatible ?? state.hermes?.cli.matchesPin,
    state.hermes?.restartRequired, state.hermes?.bootstrapPending,
  ].join("|");
  const lastWorkerKey = useRef(workerKey);
  useEffect(() => {
    if (lastWorkerKey.current === workerKey) return;
    lastWorkerKey.current = workerKey;
    setError("");
  }, [workerKey]);

  const applyResult = (ok: boolean, detail: unknown) => {
    if (!mounted.current) return;
    if (ok) setError("");
    else setError(budFacingCopy(detail, "The check did not finish. Try again or open Bud settings."));
  };

  const check = async () => {
    if (!canAdminister || !availability.canVerify || budReadinessCheck.isRunning()) return;
    setError("");
    try {
      const result = await budReadinessCheck.run();
      dispatch({ type: "hermesStatus", status: result.status });
      applyResult(result.ok, result.detail);
    } catch (cause) {
      applyResult(false, cause);
    }
  };

  // Boot: restore a drifted worker pin once, then run hands check when only that remains.
  useEffect(() => {
    if (!canAdminister || !state.connected || statusRead.error || state.desk?.recovery?.active || !pinDrift || pinRestoreStarted.current) return;
    pinRestoreStarted.current = true;
    setRestoring(true);
    void autoRestoreBudPin({ status: state.hermes }).then(async (result) => {
      if (!mounted.current) return;
      if (!result.ran) {
        setRestoring(false);
        return;
      }
      if (result.ok === false) {
        setRestoring(false);
        applyResult(false, result.detail);
        return;
      }
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        if (!mounted.current) return;
        try {
          const body = await api("/api/hermes/install/status");
          const job = body?.install as { state?: string; error?: string | null } | undefined;
          if (job?.state === "done") {
            const status = await api("/api/hermes");
            dispatch({ type: "hermesStatus", status });
            setRestoring(false);
            setError("");
            return;
          }
          if (job?.state === "failed") {
            setRestoring(false);
            applyResult(false, job.error || result.detail);
            return;
          }
        } catch {
          /* keep waiting */
        }
      }
      setRestoring(false);
      applyResult(false, "Bud restore is still running — open Bud settings to watch progress.");
    });
  }, [canAdminister, dispatch, pinDrift, state.connected, state.desk?.recovery?.active, state.hermes, statusRead.error]);

  useEffect(() => {
    if (!canAdminister || !availability.canVerify || checking || pinDrift || restoring || statusRead.error) return;
    void autoRunBudReadiness({
      status: state.hermes,
      connected: state.connected,
      recovering: Boolean(state.desk?.recovery?.active),
      onStatus: (status) => dispatch({ type: "hermesStatus", status }),
    }).then((result) => {
      if (!result.ran) return;
      applyResult(result.ok === true, result.detail);
    });
  }, [availability.canVerify, canAdminister, checking, dispatch, pinDrift, restoring, state.connected, state.desk?.recovery?.active, state.hermes, statusRead.error]);

  if (availability.ready && !checking && !restoring && !statusRead.error) return null;
  const activeCheck = checking || restoring;
  return (
    <div className="ask-readiness" data-checking={activeCheck || undefined} data-error={Boolean(failure || statusRead.error) || undefined}>
      <div className="ask-readiness-icon" aria-hidden>
        {activeCheck || automatic ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" /> : failure || statusRead.error ? <CircleAlert size={18} /> : <ShieldCheck size={18} />}
      </div>
      <div className="min-w-0 flex-1" role="status">
        <p className="font-semibold text-ink">
          {restoring ? "Restoring Bud’s supported build…"
            : checking ? "Checking Bud’s connection…"
            : statusRead.error ? "Status unavailable"
            : failure ? "Connection needs another look" : availability.label}
        </p>
        <p className="mt-0.5 text-ink-muted">
          {restoring ? "Restoring the version supported by RealBud. Keep this computer awake; your draft is kept."
            : checking ? "You can keep drafting. Your work will start when you choose."
            : statusRead.error ? "Could not refresh Bud’s status. Your draft is kept; status will retry automatically."
            : failure || availability.detail}
        </p>
      </div>
      <div className="ask-readiness-actions">
        {statusRead.error && !activeCheck ? (
          <button type="button" disabled={statusRead.pending || !state.connected} onClick={() => { void statusRead.refresh(); }} className="ask-button ask-button-primary">
            {statusRead.pending ? "Checking…" : "Check again"}
          </button>
        ) : availability.canVerify && canAdminister && !activeCheck ? (
          <button type="button" onClick={() => void check()} className="ask-button ask-button-primary">
            {failure ? "Try check again" : "Run readiness check"}<ArrowRight size={14} aria-hidden />
          </button>
        ) : availability.action && !activeCheck ? (
          <button type="button" onClick={onSetup} className="ask-button ask-button-primary">
            {availability.action}<ArrowRight size={14} aria-hidden />
          </button>
        ) : null}
        {failure && canAdminister ? <button type="button" onClick={onSetup} className="ask-text-button">Bud status</button> : null}
      </div>
    </div>
  );
}
