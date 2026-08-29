import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { identifyEmail, setEmailGateDone, track } from "@/lib/analytics";
import { markFirstRunDone } from "@/lib/first-run";
import { useStore } from "@/state/store";

// First-run for a newly licensed PM. Desk is the product. Engines, mic,
// and plugins stay out of this walkthrough.

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { dispatch } = useStore();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const canContinue = name.trim().length > 0 && emailOk;

  const saveProfile = () => {
    if (email.trim()) identifyEmail(email.trim().toLowerCase());
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    }).catch(() => {});
    setStep(1);
  };

  useEffect(() => {
    track("onboarding_step", { step });
  }, [step]);

  const finish = () => {
    track("onboarding_completed", { engines_available: -1, mic: "n/a" });
    setEmailGateDone("submitted");
    markFirstRunDone();
    dispatch({ type: "showDesk" });
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app">
      <div className="flex w-[460px] flex-col rounded-lg border border-line bg-sheet p-8">
        {step === 0 && (
          <div className="flex flex-col items-center">
            <div className="flex size-[72px] items-center justify-center rounded-2xl bg-accent/10">
              <Building2 size={32} className="text-accent" />
            </div>
            <h1 className="pm-screen-title mt-4 text-ink">Welcome to RealBud</h1>
            <p className="mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary">
              A desk for property managers. It drafts the morning work. You send from the PMS.
              It never issues a notice or moves trust money.
            </p>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="mt-5 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canContinue && saveProfile()}
              placeholder="Office email (optional)"
              className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <button
              onClick={saveProfile}
              disabled={!canContinue}
              className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40"
            >
              Continue
            </button>
            <button
              onClick={() => {
                track("email_skipped");
                setStep(1);
              }}
              className="mt-3 text-[12px] text-ink-secondary hover:text-ink"
            >
              Skip for now
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col">
            <h1 className="text-[18px] font-semibold text-ink">How this desk works</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">Three rules. They do not change.</p>
            <ol className="mt-4 space-y-2.5">
              <li className="rounded-xl bg-card px-3.5 py-3 text-[13.5px] leading-relaxed text-ink">
                <span className="font-medium">1. Draft only.</span>
                <span className="text-ink-secondary"> Courtesy wording and flags wait for you. Copy them into the PMS yourself.</span>
              </li>
              <li className="rounded-xl bg-card px-3.5 py-3 text-[13.5px] leading-relaxed text-ink">
                <span className="font-medium">2. No notices. No trust.</span>
                <span className="text-ink-secondary"> Past the courtesy window, RealBud escalates to a licensed person. It will not draft or send a statutory notice, or pay from rent.</span>
              </li>
              <li className="rounded-xl bg-card px-3.5 py-3 text-[13.5px] leading-relaxed text-ink">
                <span className="font-medium">3. Today is a training book.</span>
                <span className="text-ink-secondary"> Six sample ACT addresses. Recheck lands each as checked. Inbox stays disconnected until a named office connects mail.</span>
              </li>
            </ol>
            <button onClick={finish} className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white">
              Open today&rsquo;s desk
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
