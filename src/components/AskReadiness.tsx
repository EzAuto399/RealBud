import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowRight, CircleAlert, Loader2, ShieldCheck } from "lucide-react";
import { autoRunBudReadiness } from "@/lib/boot-heal";
import { budAvailability, budFacingCopy } from "@/lib/bud-setup";
import { budReadinessCheck } from "@/lib/bud-readiness";
import { useStore } from "@/state/store";

export function AskReadiness({ onSetup }: { onSetup: () => void }) {
  const { state, dispatch } = useStore();
  const checking = useSyncExternalStore(budReadinessCheck.subscribe, budReadinessCheck.isRunning);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const availability = budAvailability(state.hermes, state.connected, Boolean(state.desk?.recovery?.active));

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

  // Boot: run the private hands check as soon as only that step remains.
  useEffect(() => {
    if (!availability.canVerify || checking) return;
    void autoRunBudReadiness({
      status: state.hermes,
      connected: state.connected,
      recovering: Boolean(state.desk?.recovery?.active),
      onStatus: (status) => dispatch({ type: "hermesStatus", status }),
    }).then((result) => {
      if (!result.ran) return;
      applyResult(result.ok === true, result.detail);
    });
  }, [availability.canVerify, checking, dispatch, state.connected, state.desk?.recovery?.active, state.hermes]);

  if (availability.ready && !checking) return null;
  return (
    <div className="ask-readiness" data-checking={checking || undefined} data-error={Boolean(error) || undefined}>
      <div className="ask-readiness-icon" aria-hidden>
        {checking ? <Loader2 size={18} className="animate-spin" /> : error ? <CircleAlert size={18} /> : <ShieldCheck size={18} />}
      </div>
      <div className="min-w-0 flex-1" role="status">
        <p className="font-semibold text-ink">
          {checking
            ? "Checking Bud’s connection…"
            : error
              ? "Connection needs another look"
              : availability.canVerify
                ? "Checking Bud’s connection…"
                : availability.label}
        </p>
        <p className="mt-0.5 text-ink-muted">
          {checking
            ? "You can keep drafting. Your work will start when you choose."
            : error
              || (availability.canVerify
                ? "Confirming Bud can respond — you can keep drafting."
                : availability.detail)}
        </p>
      </div>
      <div className="ask-readiness-actions">
        {availability.action && !availability.canVerify ? (
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
