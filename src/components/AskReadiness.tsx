import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowRight, CircleAlert, Loader2, ShieldCheck } from "lucide-react";
import { autoRestoreBudPin, autoRunBudReadiness } from "@/lib/boot-heal";
import { budAvailability, budFacingCopy } from "@/lib/bud-setup";
import { budReadinessCheck } from "@/lib/bud-readiness";
import { api, useStore } from "@/state/store";

export function AskReadiness({ onSetup }: { onSetup: () => void }) {
  const { state, dispatch } = useStore();
  const checking = useSyncExternalStore(budReadinessCheck.subscribe, budReadinessCheck.isRunning);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const mounted = useRef(false);
  const pinRestoreStarted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const availability = budAvailability(state.hermes, state.connected, Boolean(state.desk?.recovery?.active));
  const pinDrift = Boolean(
    state.hermes?.cli.installed && !(state.hermes.cli.compatible ?? state.hermes.cli.matchesPin),
  );

  const applyResult = (ok: boolean, detail: unknown) => {
    if (!mounted.current) return;
    if (ok) setError("");
    else setError(budFacingCopy(detail, "The check did not finish. Try again or open Bud settings."));
  };

  const check = async () => {
    if (!availability.canVerify || budReadinessCheck.isRunning()) return;
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
    if (!pinDrift || pinRestoreStarted.current) return;
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
  }, [dispatch, pinDrift, state.hermes]);

  useEffect(() => {
    if (!availability.canVerify || checking || pinDrift || restoring) return;
    void autoRunBudReadiness({
      status: state.hermes,
      connected: state.connected,
      recovering: Boolean(state.desk?.recovery?.active),
      onStatus: (status) => dispatch({ type: "hermesStatus", status }),
    }).then((result) => {
      if (!result.ran) return;
      applyResult(result.ok === true, result.detail);
    });
  }, [availability.canVerify, checking, dispatch, pinDrift, restoring, state.connected, state.desk?.recovery?.active, state.hermes]);

  if (availability.ready && !checking && !restoring) return null;
  return (
    <div className="ask-readiness" data-checking={checking || restoring || undefined} data-error={Boolean(error) || undefined}>
      <div className="ask-readiness-icon" aria-hidden>
        {checking || restoring ? <Loader2 size={18} className="animate-spin" /> : error ? <CircleAlert size={18} /> : <ShieldCheck size={18} />}
      </div>
      <div className="min-w-0 flex-1" role="status">
        <p className="font-semibold text-ink">
          {restoring
            ? "Restoring Bud’s supported build…"
            : checking
              ? "Checking Bud’s connection…"
              : error
                ? "Connection needs another look"
                : availability.canVerify
                  ? "Checking Bud’s connection…"
                  : availability.label}
        </p>
        <p className="mt-0.5 text-ink-muted">
          {restoring
            ? "Bud’s worker moved past the build RealBud supports. Re-pinning automatically — keep this computer awake."
            : checking
              ? "You can keep drafting. Your work will start when you choose."
              : error
                || (availability.canVerify
                  ? "Confirming Bud can respond — you can keep drafting."
                  : availability.detail)}
        </p>
      </div>
      <div className="ask-readiness-actions">
        {availability.action && !availability.canVerify && !restoring ? (
          <button type="button" disabled={checking} onClick={onSetup} className="ask-button ask-button-primary">
            {availability.action}
            <ArrowRight size={14} aria-hidden />
          </button>
        ) : null}
        {availability.canVerify && error ? (
          <button type="button" disabled={checking} onClick={() => void check()} className="ask-button ask-button-primary">
            {checking ? "Checking…" : "Try check again"}
            {!checking && <ArrowRight size={14} aria-hidden />}
          </button>
        ) : null}
        {error ? (
          <button type="button" onClick={onSetup} className="ask-text-button">Bud settings</button>
        ) : null}
      </div>
    </div>
  );
}
