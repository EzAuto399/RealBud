import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, KeyRound, Loader2 } from "lucide-react";

import { COMPOSIO_SIGN_IN_URL, isRejectedOfficeKey, mapOfficeSourceError } from "@/lib/ask-connect";
import { openHttpsUrl } from "@/lib/open-https";
import { api, useStore, type ConfigStatus } from "@/state/store";

export function ComposioSignInPanel({
  toolLabel,
  composioSlug,
  keyFieldId = "composio-connect-key",
  variant = "full",
  keyRejected = false,
  onToolConnected,
  onKeyRejected,
  onKeyVerified,
}: {
  toolLabel?: string;
  composioSlug?: string | null;
  keyFieldId?: string;
  variant?: "full" | "account" | "named";
  keyRejected?: boolean;
  onToolConnected?: (connected: boolean | null) => void;
  onKeyRejected?: (rejected: boolean) => void;
  onKeyVerified?: (verified: boolean) => void;
}) {
  const { state, dispatch } = useStore();
  const composioLinked = Boolean(state.config?.composio.configured);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"link" | "connect" | "check" | null>(null);
  const [error, setError] = useState("");
  const [toolConnected, setToolConnected] = useState<boolean | null>(null);
  const clearing = composioLinked && !key.trim();
  const showAccount = variant === "full" || variant === "account";
  const showNamed = (variant === "full" || variant === "named") && composioLinked && Boolean(composioSlug && toolLabel);
  const keyCollapsed = variant === "named" && composioLinked && !keyRejected;
  const onToolConnectedRef = useRef(onToolConnected);
  const onKeyRejectedRef = useRef(onKeyRejected);
  const onKeyVerifiedRef = useRef(onKeyVerified);
  onToolConnectedRef.current = onToolConnected;
  onKeyRejectedRef.current = onKeyRejected;
  onKeyVerifiedRef.current = onKeyVerified;

  const remember = (connected: boolean | null) => {
    setToolConnected(connected);
    onToolConnectedRef.current?.(connected);
  };

  const reportKey = (status: "accepted" | "rejected" | "unknown") => {
    if (status === "rejected") {
      onKeyRejectedRef.current?.(true);
      onKeyVerifiedRef.current?.(false);
      return;
    }
    if (status === "accepted") {
      onKeyRejectedRef.current?.(false);
      onKeyVerifiedRef.current?.(true);
      return;
    }
    onKeyRejectedRef.current?.(false);
    onKeyVerifiedRef.current?.(false);
  };

  const refreshTool = async (linked = composioLinked) => {
    if (!composioSlug || !linked) {
      remember(null);
      return;
    }
    try {
      const body = await api(`/api/office-sources?services=${composioSlug}`);
      remember(Boolean(body.services?.[composioSlug]?.connected));
      reportKey("accepted");
      setError("");
    } catch (cause) {
      remember(null);
      const raw = cause instanceof Error ? cause.message : String(cause);
      if (isRejectedOfficeKey(raw)) reportKey("rejected");
      else reportKey("accepted");
      throw cause;
    }
  };

  useEffect(() => {
    let alive = true;
    if (!composioSlug || !composioLinked) {
      remember(null);
      if (!composioLinked) reportKey("unknown");
      return;
    }
    void refreshTool()
      .catch((cause) => {
        if (!alive) return;
        const raw = cause instanceof Error ? cause.message : String(cause);
        setError(mapOfficeSourceError(raw));
      });
    return () => {
      alive = false;
    };
  }, [composioSlug, composioLinked]);

  const fail = (cause: unknown) => {
    const raw = cause instanceof Error ? cause.message : String(cause);
    setError(mapOfficeSourceError(raw));
    if (isRejectedOfficeKey(raw)) reportKey("rejected");
  };

  const openComposioLogin = () => {
    if (!openHttpsUrl(COMPOSIO_SIGN_IN_URL)) {
      setError("Could not open Composio. RealBud stayed here.");
    }
  };

  const saveKey = () => {
    if (busy || (!key.trim() && !composioLinked)) return;
    setBusy("link");
    setError("");
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ composio: { key: key.trim() } }),
    })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setKey("");
        reportKey("unknown");
        if (composioSlug && status.composio?.configured) return refreshTool(true);
      })
      .catch(fail)
      .finally(() => setBusy(null));
  };

  const signInTool = () => {
    if (!composioSlug || busy || !composioLinked) return;
    setBusy("connect");
    setError("");
    api(`/api/office-sources/${composioSlug}/authorize`, { method: "POST" })
      .then(({ url }) => {
        if (typeof url !== "string" || !openHttpsUrl(url)) {
          throw new Error(`Could not open a login page for ${toolLabel ?? "this source"}. RealBud stayed here.`);
        }
        let tries = 0;
        const timer = window.setInterval(() => {
          void refreshTool()
            .then(() => {
              if (++tries >= 6) window.clearInterval(timer);
            })
            .catch(() => {
              if (++tries >= 6) window.clearInterval(timer);
            });
        }, 5_000);
      })
      .catch(fail)
      .finally(() => setBusy(null));
  };

  const accountCopy = keyRejected
    ? "Sign in to your Composio account, then paste a current key below."
    : composioLinked
      ? "A Connect key is on this device. Confirm it, then sign in the named read."
      : "Sign in to your own Composio account. RealBud stays here.";

  const keyCopy = keyRejected
    ? "Paste a current Connect key. It stays on this device."
    : composioLinked
      ? "A key is already on this device. Paste another to replace it, or unlink."
      : "Paste a Connect key if you already have one. The key stays on this device.";

  const keyField = (
    <div className="space-y-2">
      <label className="block text-[12px] font-medium text-ink" htmlFor={keyFieldId}>
        Connect key
      </label>
      <p className="text-[12px] leading-relaxed text-ink-muted">{keyCopy}</p>
      <div className="flex flex-wrap gap-2">
        <span className="relative min-w-[12rem] flex-1">
          <KeyRound size={14} className="pointer-events-none absolute left-3 top-3 text-ink-muted" />
          <input
            id={keyFieldId}
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value.slice(0, 200))}
            onKeyDown={(event) => event.key === "Enter" && saveKey()}
            placeholder={composioLinked ? "••••••••  (paste to replace)" : "ck_…"}
            autoComplete="off"
            className="pm-control w-full rounded border border-line bg-inset py-2 pl-9 pr-3 text-[13px] text-ink focus:border-agency"
          />
        </span>
        <button
          type="button"
          disabled={busy !== null || (!key.trim() && !composioLinked)}
          onClick={saveKey}
          className="pm-control pm-tactile inline-flex min-h-10 items-center gap-1.5 rounded border border-line px-3 text-[12.5px] font-semibold text-ink hover:border-agency/55 disabled:opacity-50"
        >
          {busy === "link" ? <Loader2 size={13} className="animate-spin" /> : null}
          {clearing ? "Unlink" : composioLinked ? "Replace key" : "Link key"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      {error ? <p className="text-[12px] text-danger" role="alert">{error}</p> : null}

      {showAccount ? (
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-ink">Login</p>
          <p className="text-[12px] leading-relaxed text-ink-muted">{accountCopy}</p>
          <button
            type="button"
            onClick={openComposioLogin}
            className="pm-control pm-tactile inline-flex min-h-10 items-center gap-1.5 rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover"
          >
            <ExternalLink size={14} aria-hidden="true" /> Sign in to Composio
          </button>
        </div>
      ) : null}

      {showNamed ? (
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-ink">{toolLabel}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={signInTool}
              className="pm-control pm-tactile inline-flex min-h-10 items-center gap-1.5 rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover disabled:opacity-50"
            >
              {busy === "connect" ? <Loader2 size={13} className="animate-spin" /> : toolConnected ? <Check size={14} /> : <ExternalLink size={14} />}
              {toolConnected ? `Sign in to ${toolLabel} again` : `Sign in to ${toolLabel}`}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setBusy("check");
                void refreshTool().catch(fail).finally(() => setBusy(null));
              }}
              className="pm-control pm-tactile inline-flex min-h-10 items-center rounded border border-line px-3 text-[12.5px] font-semibold text-ink hover:border-agency/55 disabled:opacity-50"
            >
              {busy === "check" ? <Loader2 size={13} className="animate-spin" /> : null}
              Check again
            </button>
          </div>
          {toolConnected ? (
            <p className="text-[12px] leading-relaxed text-ink-muted">
              {toolLabel} is signed in through the linked Composio account. Ask still cannot send.
            </p>
          ) : null}
        </div>
      ) : null}

      {keyCollapsed ? (
        <details className="border-t border-line pt-3">
          <summary className="cursor-pointer text-[12px] font-medium text-ink">Replace Connect key</summary>
          <div className="mt-2">{keyField}</div>
        </details>
      ) : (
        <div className={showAccount || showNamed ? "border-t border-line pt-3" : undefined}>{keyField}</div>
      )}
    </div>
  );
}
