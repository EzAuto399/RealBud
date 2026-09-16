import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, useStore } from "@/state/store";
import type { ServiceAdminLogin, ServiceAdminStatus } from "../../shared/service-admin";
import { clearServiceAdminSession, refreshServiceAdminSession, serviceAdminHeaders, SERVICE_ADMIN_CHANGED, setServiceAdminSession } from "@/lib/service-admin-session";
import { useServiceAdminAccess } from "@/lib/use-service-admin-access";
import { Card } from "./SettingsPrimitives";

/** Service administration is independent of company ownership and staff login. */
export function CareUnlockCard() {
  const { state, dispatch } = useStore();
  const administration = state.serviceAdmin ?? state.config?.serviceAdmin;
  const allowed = useServiceAdminAccess(administration);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const generation = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(() => {
    const current = ++generation.current;
    const requestToken = serviceAdminHeaders()["x-realbud-service-admin"] ?? null;
    void api("/api/service-admin/status", undefined, { timeoutMs: 10_000 })
      .then((status: ServiceAdminStatus) => { if (current === generation.current && refreshServiceAdminSession(status, requestToken)) dispatch({ type: "serviceAdminStatus", status }); })
      .catch(() => { if (current === generation.current) { clearServiceAdminSession(); setError("Administrator status could not be checked. Settings are locked; reconnect and sign in again."); } });
  }, [dispatch]);
  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener(SERVICE_ADMIN_CHANGED, refresh);
    return () => { mounted.current = false; generation.current++; window.clearInterval(timer); window.removeEventListener(SERVICE_ADMIN_CHANGED, refresh); };
  }, [refresh]);

  const unlock = () => {
    if (busy || !secret.trim()) return;
    setBusy(true);
    setError("");
    api("/api/service-admin/login", { method: "POST", body: JSON.stringify({ password: secret }) }, { timeoutMs: 15_000 })
      .then((login: ServiceAdminLogin) => {
        if (!mounted.current) {
          void api("/api/service-admin/logout", { method: "POST", headers: { "x-realbud-service-admin": login.token }, body: "{}" }, { timeoutMs: 10_000 }).catch(() => {});
          return;
        }
        setServiceAdminSession(login);
        dispatch({ type: "serviceAdminStatus", status: login.status });
        setSecret("");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => { setSecret(""); setBusy(false); });
  };

  const lock = () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const headers = serviceAdminHeaders();
    clearServiceAdminSession();
    setSecret("");
    api("/api/service-admin/logout", { method: "POST", headers, body: "{}" }, { timeoutMs: 15_000 })
      .then((result: { status: ServiceAdminStatus }) => dispatch({ type: "serviceAdminStatus", status: result.status }))
      .catch(() => setError("This window is locked. The service could not confirm sign-out; any server session will expire automatically."))
      .finally(() => {
        clearServiceAdminSession(); setSecret(""); setBusy(false);
        if (administration) dispatch({ type: "serviceAdminStatus", status: { ...administration, authenticated: false, expiresAt: null } });
      });
  };

  if (!administration) return null;

  return (
    <Card title="Administrator access" subtitle="RealBud support manages service credentials, providers and runtime settings.">
      {!administration.managed ? <p className="text-sm text-ink-secondary">This development checkout is not enrolled as a managed service. Customer installations require separate administrator access.</p> : !allowed ? (
        <>
          <p role="status" className="text-[13px] leading-relaxed text-ink-secondary">
            Use the administrator password for this computer. Joining a company does not share administrator access. Your work accounts stay available under Apps.
          </p>
          {administration.configured ? (
            <form className="mt-3 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); unlock(); }}>
              <input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder="Administrator password"
                aria-label="Administrator password"
                autoComplete="current-password"
                maxLength={512}
                className="min-w-[12rem] flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline"
              />
              <button
                type="submit"
                disabled={busy || !secret.trim()}
                className="pm-control inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-sheet px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                Sign in
              </button>
            </form>
          ) : (
            <p className="mt-2 text-[12.5px] text-hold">
              {administration.configurationError ? "Administrator setup needs repair. Contact RealBud support; service settings remain locked." : "Administrator access has not been provisioned for this installation. Contact RealBud support to finish service setup."}
            </p>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-[13px] text-ink-secondary">Administrator access is active in this window. It locks after five minutes without a settings change and expires within fifteen minutes.</p>
          <button
            type="button"
            onClick={lock}
            disabled={busy}
            className="pm-control rounded-lg border border-line bg-sheet px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised disabled:opacity-50"
          >
            {busy ? "Locking…" : "Lock service settings"}
          </button>
        </div>
      )}
      {error ? <p role="alert" className="mt-2 text-[12.5px] text-danger">{error}</p> : null}
    </Card>
  );
}
