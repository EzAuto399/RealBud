import { useEffect, useState } from "react";
import { Building2, Loader2 } from "lucide-react";
import { identifyEmail, setEmailGateDone, track } from "@/lib/analytics";
import { withViewTransition } from "@/lib/motion";
import { setSetupJourneyPending } from "@/lib/onboarding";
import { api, useStore } from "@/state/store";

// First-run is one screen. Name, then the required setup wizard.
// Policy copy lives beside Allow, not here.

export function Onboarding({ onDone }: { onDone: (openSetup: boolean) => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const canContinue = name.trim().length > 0 && emailOk;

  useEffect(() => {
    const profile = state.config?.profile;
    if (!profile) return;
    setName((current) => current || profile.name || "");
    setEmail((current) => current || profile.email || "");
  }, [state.config?.profile]);

  useEffect(() => {
    track("onboarding_step", { step: 0 });
  }, []);

  const saveAndStart = async () => {
    if (!canContinue || busy) return;
    setBusy(true);
    setError("");
    if (email.trim()) identifyEmail(email.trim().toLowerCase());
    try {
      const config = await api("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase() }),
      });
      dispatch({ type: "configStatus", config });
      track("onboarding_completed", { engines_available: -1, mic: "n/a" });
      setEmailGateDone("submitted");
      setSetupJourneyPending(true);
      withViewTransition(() => {
        dispatch({ type: "showDesk" });
        onDone(true);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-paper p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        className="animate-pop-in w-full max-w-[420px] rounded-lg border border-line bg-sheet p-6 shadow-[0_18px_60px_rgb(37_35_31/0.12)]"
      >
        <div className="realbud-mark flex size-12 items-center justify-center rounded-lg border border-agency/15 bg-selected">
          <Building2 size={26} className="text-accent" aria-hidden="true" />
        </div>
        <h1 id="onboarding-title" className="pm-screen-title mt-4 text-ink">Welcome to RealBud</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-secondary">
          RealBud will prepare Bud on this computer, then you connect your model and API key. Nothing is sent or paid.
        </p>
        <form
          className="mt-5"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAndStart();
          }}
        >
          <label htmlFor="onboarding-name" className="block text-[12px] font-medium text-ink-secondary">
            Your name
          </label>
          <input
            id="onboarding-name"
            autoFocus
            required
            type="text"
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            className="mt-1 w-full rounded border border-line bg-inset px-3 py-2.5 text-[15px] text-ink focus:border-agency"
          />
          <label htmlFor="onboarding-email" className="mt-3 block text-[12px] font-medium text-ink-secondary">
            Office email <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <input
            id="onboarding-email"
            type="email"
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            aria-invalid={!emailOk}
            aria-describedby={!emailOk ? "onboarding-email-error" : undefined}
            className="mt-1 w-full rounded border border-line bg-inset px-3 py-2.5 text-[15px] text-ink focus:border-agency"
          />
          {!emailOk ? (
            <p id="onboarding-email-error" className="mt-1 text-[12px] text-danger">Enter a complete email address or leave it blank.</p>
          ) : null}
          {error ? <p role="alert" className="mt-3 border border-danger/25 bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</p> : null}
          <button
            type="submit"
            disabled={!canContinue || busy}
            className="pm-tactile mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded bg-agency py-2.5 text-[15px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : null}
            {busy ? "Saving..." : "Get started"}
          </button>
        </form>
      </div>
    </div>
  );
}
