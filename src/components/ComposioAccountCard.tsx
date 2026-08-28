import { useState } from "react";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";

import { COMPOSIO_SIGN_IN_URL } from "@/lib/ask-connect";
import { openHttpsUrl } from "@/lib/open-https";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { VerifiedConnectionCard } from "./VerifiedConnectionCard";

export function ComposioAccountCard() {
  const { state, dispatch } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const configured = Boolean(state.config?.composio.configured);
  const clearing = configured && !value.trim();

  const save = () => {
    if (saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError("");
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ composio: { key: value.trim() } }),
    })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setValue("");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(false));
  };

  const signIn = () => {
    if (!openHttpsUrl(COMPOSIO_SIGN_IN_URL)) {
      setError("Could not open Composio. RealBud stayed here.");
    }
  };

  return (
    <section id="composio-account-setup" tabIndex={-1} className="scroll-m-28 space-y-2 outline-none">
      <VerifiedConnectionCard
        icon={<KeyRound size={18} />}
        title="Your Composio account"
        description="Sign in to your own Composio account first. Then paste the Connect key so Bud can use restricted, named reads later. Ask never receives the key, and this is not a tool marketplace."
        meta="Human-owned link · this device only · no send or pay tools"
        state={configured ? "ready" : "off"}
        status={configured ? "Linked" : "Not linked"}
      />
      <div className="space-y-3 border border-line bg-sheet px-4 py-3">
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-ink">Sign in to Composio</p>
          <p className="text-[12px] leading-relaxed text-ink-muted">
            Use your own account. RealBud stays here.
          </p>
          <button
            type="button"
            onClick={signIn}
            className="pm-control pm-tactile inline-flex min-h-10 items-center gap-1.5 rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover"
          >
            <ExternalLink size={14} aria-hidden="true" /> Sign in to Composio
          </button>
        </div>
        <div>
          <label htmlFor="composio-connect-key" className="text-[12px] font-medium text-ink">
            Then paste the Connect key
          </label>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <input
              id="composio-connect-key"
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value.slice(0, 200))}
              onKeyDown={(event) => event.key === "Enter" && save()}
              placeholder={configured ? "••••••••  (paste to replace)" : "ck_…"}
              autoComplete="off"
              className="pm-control min-w-[14rem] flex-1 rounded border border-line bg-inset px-3 text-[13px] text-ink placeholder:text-ink-muted focus:border-agency"
            />
            <button
              type="button"
              disabled={saving || (!value.trim() && !configured)}
              onClick={save}
              className="pm-control pm-tactile rounded border border-line px-3 text-[12.5px] font-semibold text-ink hover:border-agency/55 disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : clearing ? "Unlink" : "Link account"}
            </button>
          </div>
        </div>
        {error ? <p className="text-[12px] text-danger" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}
