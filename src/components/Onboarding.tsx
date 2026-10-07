import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ClipboardCheck,
  Loader2,
  Send,
  ShieldCheck,
} from "lucide-react";

import { identifyEmail, setEmailGateDone, track } from "@/lib/analytics";
import { isRecoveryWriteError } from "@/lib/api-error";
import { createFirstRunApi, officeContactNamed } from "@/lib/first-run";
import { SETUP_STEP_COUNT } from "@/lib/setup-sequence";
import type { YouRecoveryTarget } from "@/lib/you-navigation";
import type { OnboardingState } from '@shared/onboarding';
import { api, useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { ConnectOfficeView, useConnectOffice } from "./ConnectOffice";

const SAMPLE_PROFILE_NAME = "Sample PM";
// A busy Windows PC can stall the service for half a minute while Bud installs
// (Windows issues log #6), so each step waits a minute before offering Try again.
const FINISH_TIMEOUT_MS = 60_000;

function finishRequest(path: string, init?: RequestInit) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("RealBud's local service did not respond within a minute."));
      controller.abort();
    }, FINISH_TIMEOUT_MS);
  });
  return Promise.race([
    api(path, { ...init, signal: controller.signal }, { timeoutMs: FINISH_TIMEOUT_MS }),
    deadline,
  ]).finally(() => clearTimeout(timer));
}

type BusyState = "profile" | "finish" | "recovery" | "restore" | null;

// First run establishes the person, connects this computer to the office on
// realbud.app, and leads into the same Bud setup used in settings (step 3).
// Sample-only exploration remains available at every step.
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
  const pending = useRef(false);
  const connect = useConnectOffice(name.trim());
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
    if (busy !== null || pending.current) return;
    pending.current = true;
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
      pending.current = false;
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
    if (!name.trim() || busy !== null || pending.current) return;
    pending.current = true;
    setBusy("finish");
    setError("");
    setRecoveryBlocked(false);
    let enteredDesk = false;
    try {
      // Read afresh before writing: store hydration may still be pending, and
      // a restored book's existing contact must never be overwritten.
      const currentDesk = await finishRequest('/api/desk');
      if (typeof currentDesk?.book?.office?.pmUser !== 'string') throw new Error('Your saved office contact could not be checked. Try again before continuing.');
      if (!officeContactNamed(currentDesk)) {
        const snapshot = await finishRequest("/api/desk/agency", {
          method: "PATCH",
          body: JSON.stringify({ office: { pmUser: name.trim() } }),
        });
        dispatch({ type: "deskSnapshot", snapshot });
      }
      setSaved(await createFirstRunApi(finishRequest).save(saved, 'complete'));
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
      pending.current = false;
      if (!enteredDesk) setBusy(null);
    }
  };

  const openRecovery = async (target: YouRecoveryTarget = 'you-recovery') => {
    if (busy !== null || pending.current) return;
    pending.current = true;
    setBusy(target === 'you-private-backup' ? 'restore' : 'recovery');
    try {
      setSaved(await createFirstRunApi(api).save(saved, 'recovery'));
      location.hash = target;
      dispatch({ type: "showYou" });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your recovery choice could not be saved.');
    } finally { pending.current = false; setBusy(null); }
  };

  const back = async () => {
    if (busy !== null || pending.current) return;
    pending.current = true;
    setBusy('profile');
    try {
      setSaved(await createFirstRunApi(api).save(saved, 'profile'));
      setError(''); setRecoveryBlocked(false); setStep(0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your setup could not be saved.'); }
    finally { pending.current = false; setBusy(null); }
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
                <span>Set up this computer</span>
                {/* Connecting is step 1 of Get started's own numbered path on Desk; the name comes before it. */}
                <span>{step === 0 ? "Before you start" : `Step 1 of ${SETUP_STEP_COUNT}`}</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-line/60" aria-hidden="true">
                <div
                  className="h-full origin-left rounded-full bg-agency transition-transform duration-300 motion-reduce:transition-none"
                  style={{ transform: `scaleX(${step / SETUP_STEP_COUNT})` }}
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
                  <h1 className="text-[27px] font-semibold tracking-[-0.035em] text-ink">{connect.office ? "This computer is connected" : "Connect this computer to your office"}</h1>
                  <p className="mt-2 max-w-[29rem] text-[14px] leading-relaxed text-ink-secondary">
                    {connect.office
                      ? "Next, Bud sets itself up on this computer with your office’s AI access."
                      : "Paste the link code your office owner sent you."}
                  </p>
                </div>

                <div className="mt-4">
                  <ConnectOfficeView {...connect.view} />
                </div>

                <ul className="mt-4 space-y-1.5 border-t border-line pt-3" aria-label="You stay in charge">
                  <BoundaryRow icon={ClipboardCheck} title="Bud prepares. You decide." />
                  <BoundaryRow icon={ShieldCheck} title="No notices or trust money without a licensed person." />
                  <BoundaryRow icon={Send} title="Nothing is sent without your approval." />
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
                  ) : connect.office ? (
                    <button
                      type="button"
                      onClick={() => void finish("bud")}
                      disabled={busy !== null || !name.trim()}
                      className="pm-decision flex w-full items-center justify-center gap-2 rounded bg-agency px-4 text-[14px] font-medium text-white transition-transform hover:bg-agency-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy === "finish" ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" /> : <ArrowRight size={15} />}
                      Continue to Bud setup
                    </button>
                  ) : null}
                  {!recoveryBlocked && <button type="button" onClick={() => void finish("desk")} disabled={busy !== null || !name.trim()} className="pm-control mt-2 flex w-full items-center justify-center gap-2 rounded text-[13px] text-ink-secondary hover:bg-raised/60 hover:text-ink disabled:opacity-40"><BookOpen size={14} />Open the sample desk first</button>}
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
            <div className="mt-3 border-t border-line pt-3">
              <button
                type="button"
                onClick={() => void openRecovery('you-private-backup')}
                disabled={busy !== null}
                className="pm-control flex w-full items-center justify-center gap-2 rounded px-3 text-[12.5px] text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
              >
                {busy === 'restore' ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <ShieldCheck size={14} />}
                Restore a private backup
              </button>
              <p className="text-center text-[12px] leading-relaxed text-ink-muted">Choose an encrypted backup and review it before restoring.</p>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function BoundaryRow({ icon: Icon, title }: { icon: typeof ClipboardCheck; title: string }) {
  return (
    <li className="flex items-center gap-2.5 text-[12.5px] text-ink-secondary">
      <Icon size={14} className="shrink-0 text-agency" aria-hidden="true" />
      <span>{title}</span>
    </li>
  );
}
