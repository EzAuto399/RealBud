import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ClipboardCheck,
  Loader2,
  ShieldCheck,
} from "lucide-react";

import { identifyEmail, setEmailGateDone, track } from "@/lib/analytics";
import { isRecoveryWriteError } from "@/lib/api-error";
import { createFirstRunApi, officeContactNamed } from "@/lib/first-run";
import type { OnboardingState } from '@shared/onboarding';
import { api, useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";

const SAMPLE_PROFILE_NAME = "Sample PM";

type BusyState = "profile" | "finish" | null;

// First run establishes the person and leads directly into the same Bud
// setup used in settings. Sample-only exploration remains available.
export function Onboarding({ initialState, onDone }: { initialState: OnboardingState; onDone: (setup?: "bud") => void }) {
  const { state, dispatch } = useStore();
  const [saved, setSaved] = useState(initialState);
  const [step, setStep] = useState<0 | 1>(initialState.stage === 'office-rules' ? 1 : 0);
  const [name, setName] = useState(
    state.config?.profile?.name || "",
  );
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  const [busy, setBusy] = useState<BusyState>(null);
  const [error, setError] = useState("");
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const edited = useRef(false);
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const canContinue = name.trim().length > 0 && emailOk && busy === null;

  useEffect(() => {
    if (edited.current) return;
    setName(state.config?.profile?.name || "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.email, state.config?.profile?.name, step]);

  useEffect(() => {
    track("onboarding_step", { step });
  }, [step]);

  const advanceProfile = async (normalizedName: string, normalizedEmail: string) => {
    if (busy !== null) return;
    setBusy("profile");
    setError("");
    setRecoveryBlocked(false);
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ profile: { name: normalizedName, email: normalizedEmail } }),
      });
      dispatch({ type: "configStatus", config });
      if (normalizedEmail) identifyEmail(normalizedEmail);
      setSaved(await createFirstRunApi(api).save(saved, 'office-rules'));
      setName(normalizedName);
      setEmail(normalizedEmail);
      setStep(1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "RealBud could not save your profile.");
    } finally {
      setBusy(null);
    }
  };

  const saveProfile = () => canContinue ? advanceProfile(name.trim(), email.trim().toLowerCase()) : undefined;

  const enterWorkspace = (emailStatus: "submitted" | "skipped", destination: "desk" | "bud") => {
    setEmailGateDone(emailStatus);
    if (destination === "bud") {
      history.replaceState(null, "", location.pathname + location.search);
      dispatch({ type: "showAsk" });
    } else {
      dispatch({ type: "showDesk" });
    }
    onDone(destination === "bud" ? "bud" : undefined);
  };

  const exploreSampleDesk = async () => {
    track("onboarding_sample_desk");
    await advanceProfile(name.trim() || SAMPLE_PROFILE_NAME, emailOk ? email.trim().toLowerCase() : '');
  };

  const finish = async (destination: "desk" | "bud") => {
    if (!name.trim() || busy !== null) return;
    setBusy("finish");
    setError("");
    setRecoveryBlocked(false);
    let enteredDesk = false;
    try {
      // Read afresh before writing: store hydration may still be pending, and
      // a restored book's existing contact must never be overwritten.
      const currentDesk = await api('/api/desk');
      if (typeof currentDesk?.book?.office?.pmUser !== 'string') throw new Error('Your saved office contact could not be checked. Try again before continuing.');
      if (!officeContactNamed(currentDesk)) {
        const snapshot = await api("/api/desk/agency", {
          method: "PATCH",
          body: JSON.stringify({ office: { pmUser: name.trim() } }),
        });
        dispatch({ type: "deskSnapshot", snapshot });
      }
      setSaved(await createFirstRunApi(api).save(saved, 'complete'));
      track("onboarding_completed", { engines_available: -1, mic: "n/a" });
      enteredDesk = true;
      enterWorkspace(email.trim() ? "submitted" : "skipped", destination);
    } catch (cause) {
      if (isRecoveryWriteError(cause)) {
        setRecoveryBlocked(true);
        setError("A protected book is already on this computer. Open recovery to unlock it or preserve it before starting again.");
      } else {
        setError(cause instanceof Error ? cause.message : "RealBud could not save your office setup.");
      }
    } finally {
      if (!enteredDesk) setBusy(null);
    }
  };

  const openRecovery = async () => {
    setBusy('finish');
    try {
      setSaved(await createFirstRunApi(api).save(saved, 'recovery'));
      location.hash = "you-recovery";
      dispatch({ type: "showYou" });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your recovery choice could not be saved.');
    } finally { setBusy(null); }
  };

  const back = async () => {
    setBusy('profile');
    try {
      setSaved(await createFirstRunApi(api).save(saved, 'profile'));
      setError(''); setRecoveryBlocked(false); setStep(0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your setup could not be saved.'); }
    finally { setBusy(null); }
  };

  const fieldClass =
    "pm-decision mt-1.5 w-full rounded border border-line bg-sheet px-3.5 text-[15px] text-ink placeholder:text-ink-muted focus:border-agency";

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-paper p-2 sm:p-3">
      <main className="flex min-h-full items-center justify-center">
        <div className="grid w-full max-w-[900px] overflow-hidden rounded-xl border border-line bg-sheet shadow-[0_24px_70px_rgba(37,35,31,0.14)] md:grid-cols-[0.8fr_1.2fr]">
          <aside className="relative flex min-h-[140px] flex-col justify-between overflow-hidden border-b border-line bg-selected/65 p-4 sm:p-5 md:min-h-[440px] md:border-b-0 md:border-r">
            <div className="relative z-10">
              <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-agency">RealBud</div>
              <p className="mt-2 max-w-[19rem] text-[13px] leading-relaxed text-ink-secondary">
                A calm working desk for the morning, with Bud nearby when you need another pair of hands.
              </p>
            </div>
            <div className="relative z-10 flex items-center justify-center py-1 md:py-2">
              <MausAvatar
                color="green"
                state={step === 0 ? "happy" : "curious"}
                motion={step === 0 ? "arrive" : "success"}
                motionKey={step}
                size={step === 0 ? 138 : 126}
                label="Bud"
                trackPointer={false}
              />
            </div>
            <div className="relative z-10 hidden text-[12px] leading-relaxed text-ink-muted md:block">
              Local-first by default. Nothing is sent, paid, or issued without the office.
            </div>
            <div className="absolute -bottom-24 -right-20 size-72 rounded-full border border-agency/10 bg-agency/5" aria-hidden="true" />
          </aside>

          <section className="flex min-h-[360px] flex-col p-4 sm:p-5 md:min-h-[440px]">
            <header>
              <div className="flex items-center justify-between gap-4 text-[11.5px] text-ink-muted">
                <span>Set up your desk</span>
                <span>{step + 1} of 2</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-line/60" aria-hidden="true">
                <div
                  className="h-full origin-left rounded-full bg-agency transition-transform duration-300 motion-reduce:transition-none"
                  style={{ transform: `scaleX(${step === 0 ? 0.5 : 1})` }}
                />
              </div>
            </header>

            {step === 0 ? (
              <form
                className="flex flex-1 animate-panel-in flex-col motion-reduce:animate-none"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveProfile();
                }}
              >
                <div className="mt-4">
                  <h1 className="text-[27px] font-semibold tracking-[-0.035em] text-ink">Make the desk yours</h1>
                  <p className="mt-2 max-w-[28rem] text-[14px] leading-relaxed text-ink-secondary">
                    See the morning clearly, ask Bud for help, and keep every real-world decision with your office.
                  </p>
                </div>

                <div className="mt-4 space-y-3">
                  <label htmlFor="onboarding-name" className="block text-[12.5px] font-medium text-ink">
                    Your name
                    <input
                      id="onboarding-name"
                      autoFocus
                      type="text"
                      value={name}
                      onChange={(event) => {
                        edited.current = true;
                        setName(event.target.value);
                        setError("");
                      }}
                      autoComplete="name"
                      placeholder="What should Bud call you?"
                      className={fieldClass}
                    />
                  </label>
                  <label htmlFor="onboarding-email" className="block text-[12.5px] font-medium text-ink">
                    Office email <span className="font-normal text-ink-muted">optional</span>
                    <input
                      id="onboarding-email"
                      type="email"
                      value={email}
                      onChange={(event) => {
                        edited.current = true;
                        setEmail(event.target.value);
                        setError("");
                      }}
                      autoComplete="email"
                      placeholder="you@office.com.au"
                      aria-invalid={!emailOk ? true : undefined}
                      className={fieldClass}
                    />
                    {!emailOk ? (
                      <span className="mt-1.5 block font-normal text-danger">Enter a complete email address, or leave it blank.</span>
                    ) : (
                      <span className="mt-1.5 block font-normal text-ink-muted">Stored with your private RealBud settings.</span>
                    )}
                  </label>
                </div>

                <div className="mt-auto pt-4">
                  {error ? <div role="alert" className="mb-3 text-[12.5px] text-danger">{error}</div> : null}
                  <button
                    type="submit"
                    disabled={!canContinue}
                    className="pm-decision flex w-full items-center justify-center gap-2 rounded bg-agency px-4 text-[14px] font-medium text-white transition-transform hover:bg-agency-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy === "profile" ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" /> : <ArrowRight size={15} />}
                    Continue
                  </button>
                  <button
                    type="button"
                    onClick={() => void exploreSampleDesk()}
                    disabled={busy !== null}
                    className="pm-control mt-2 w-full rounded text-[13px] text-ink-secondary hover:bg-raised/60 hover:text-ink disabled:opacity-40"
                  >
                    Explore the sample desk
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex flex-1 animate-panel-in flex-col motion-reduce:animate-none">
                <div className="mt-4">
                  <div className="flex size-9 items-center justify-center rounded-full bg-agency text-white" aria-hidden="true">
                    <Check size={17} />
                  </div>
                  <h1 className="mt-3 text-[27px] font-semibold tracking-[-0.035em] text-ink">You stay in charge</h1>
                  <p className="mt-2 max-w-[29rem] text-[14px] leading-relaxed text-ink-secondary">
                    Bud helps with the work around a decision. The decision itself stays visible and yours.
                  </p>
                </div>

                <ul className="mt-3 divide-y divide-line border-y border-line">
                  <BoundaryRow
                    icon={ClipboardCheck}
                    title="Bud prepares. You decide."
                    detail="Drafts and flags wait on Desk. You copy approved wording into the PMS."
                  />
                  <BoundaryRow
                    icon={ShieldCheck}
                    title="No notices. No trust money."
                    detail="Statutory work and payments stop with a licensed person."
                  />
                  <BoundaryRow
                    icon={BookOpen}
                    title="Start with a sample book."
                    detail="Learn the rhythm safely, then connect a named office from You."
                  />
                </ul>

                <div className="mt-auto pt-4">
                  {error ? (
                    <div role="alert" className="mb-3 border border-danger/25 bg-danger/10 px-3 py-2.5 text-[12.5px] text-danger">
                      {error} Your setup is still here. Try again.
                    </div>
                  ) : null}
                  {recoveryBlocked ? (
                    <button
                      type="button"
                      onClick={() => void openRecovery()}
                      disabled={busy !== null}
                      className="pm-decision flex w-full items-center justify-center gap-2 rounded bg-agency px-4 text-[14px] font-medium text-white transition-transform hover:bg-agency-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ShieldCheck size={15} />
                      Open recovery
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void finish("bud")}
                      disabled={busy !== null || !name.trim()}
                      className="pm-decision flex w-full items-center justify-center gap-2 rounded bg-agency px-4 text-[14px] font-medium text-white transition-transform hover:bg-agency-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy === "finish" ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" /> : <BookOpen size={15} />}
                      Continue to Bud setup
                    </button>
                  )}
                  {!recoveryBlocked && <button type="button" onClick={() => void finish("desk")} disabled={busy !== null || !name.trim()} className="pm-control mt-2 w-full rounded text-[13px] text-ink-secondary hover:bg-raised/60 disabled:opacity-40">Open the sample desk first</button>}
                  <button
                    type="button"
                    onClick={() => void back()}
                    disabled={busy !== null}
                    className="pm-control mt-2 flex w-full items-center justify-center gap-2 rounded text-[13px] text-ink-secondary hover:bg-raised/60 hover:text-ink disabled:opacity-40"
                  >
                    <ArrowLeft size={14} />
                    Back
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function BoundaryRow({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof ClipboardCheck;
  title: string;
  detail: string;
}) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 py-2">
      <span className="flex size-8 items-center justify-center rounded-full bg-selected text-agency" aria-hidden="true">
        <Icon size={15} />
      </span>
      <div>
        <div className="text-[13.5px] font-medium text-ink">{title}</div>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">{detail}</p>
      </div>
    </li>
  );
}
