// App settings: who you are, and the pinned Hermes worker. Voice, local VM,
// and third-party key shop stay out of the licensee window.
import { useEffect, useRef, useState } from "react";
import { Hand, Loader2, RefreshCw, User, X } from "lucide-react";
import {
  WORKER_PROVIDERS,
  workerProvider,
  type WorkerModelRecommendation,
} from "@shared/worker-providers";
import { api, useStore, type AppSettingsSection } from "@/state/store";
import { useUpdaterState } from "@/lib/updater";
import { Card } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import {
  nextWorkerSetupOperation,
  recordWorkerVerification,
  workerVerified,
  WORKER_VERIFICATION_EVENT,
} from "@/lib/onboarding";
import { presentStoredWorkerModel } from "@/lib/worker-model-presentation";

const SECTIONS: Array<{ id: AppSettingsSection; label: string; icon: typeof User }> = [
  { id: "general", label: "You", icon: User },
  { id: "connections", label: "Hands", icon: Hand },
];

/** Name + email, persisted through the narrow profile boundary on blur. */
export function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const requestVersion = useRef(0);
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = async () => {
    const normalized = { name: name.trim(), email: email.trim().toLowerCase() };
    if (!normalized.name) {
      setSaveState("error");
      setSaveError("Enter your name.");
      return;
    }
    if (normalized.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(normalized.email)) {
      setSaveState("error");
      setSaveError("Enter a valid office email or leave it blank.");
      return;
    }
    if (
      normalized.name === (state.config?.profile?.name ?? "") &&
      normalized.email === (state.config?.profile?.email ?? "")
    ) {
      setSaveState("idle");
      setSaveError("");
      return;
    }
    const version = ++requestVersion.current;
    setSaveState("saving");
    setSaveError("");
    try {
      const config = await api("/api/profile", {
        method: "PATCH",
        body: JSON.stringify(normalized),
      });
      if (version !== requestVersion.current) return;
      dispatch({ type: "configStatus", config });
      setSaveState("saved");
    } catch (cause) {
      if (version !== requestVersion.current) return;
      setSaveState("error");
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input
        value={name}
        maxLength={120}
        aria-invalid={saveState === "error" && !name.trim()}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => void save()}
        placeholder="Your name"
        className={inputClass}
      />
      <input
        type="email"
        value={email}
        maxLength={254}
        aria-invalid={saveState === "error" && Boolean(email.trim())}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={() => void save()}
        placeholder="you@example.com"
        className={inputClass}
      />
      <p aria-live="polite" className={cn("min-h-4 text-[11px]", saveState === "error" ? "text-danger" : "text-ink-muted")}>
        {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved." : saveError}
      </p>
    </div>
  );
}

function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    s?.status === "checking"
      ? "Checking…"
      : s?.status === "available"
        ? `${s.version} available`
        : s?.status === "downloading"
          ? `Downloading ${Math.round(s.percent ?? 0)}%`
          : s?.status === "downloaded"
            ? `${s.version} ready. Restart to apply`
            : s?.status === "error"
              ? `Check failed: ${s.message ?? "unknown error"}`
              : "You're on the latest version we know of.";
  return (
    <Card title="Updates" subtitle={label}>
      <button
        onClick={() => {
          if (s?.status === "available") return void updater.download();
          if (s?.status === "downloaded") return void updater.install();
          void updater.check();
        }}
        disabled={s?.status === "checking" || s?.status === "downloading"}
        className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
      >
        {s?.status === "available"
          ? "Download"
          : s?.status === "downloaded"
            ? "Restart and install"
            : "Check for updates"}
      </button>
    </Card>
  );
}

/** The worker is the product's hands — headless, pinned, driven entirely by
 * RealBud. Install, update, and model attach happen in here: the user never
 * sees a terminal and never runs the hermes CLI. A hands miss holds Desk. */
export function HermesHandsCard({
  autoOpenModel = false,
  presentation = "settings",
  onOpenPortfolio,
}: {
  autoOpenModel?: boolean;
  presentation?: "settings" | "journey";
  onOpenPortfolio?: () => void;
} = {}) {
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const { state, dispatch } = useStore();
  const [busy, setBusy] = useState<null | "prepare" | "install" | "pack" | "model" | "test" | "check">(null);
  const [error, setError] = useState("");
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const [install, setInstall] = useState<{
    state: string;
    lines: string[];
    error: string | null;
    rollback: "available" | "restored" | null;
  } | null>(null);
  const [model, setModel] = useState<{ provider: string | null; model: string | null; keyPresent: boolean; keyHint: string | null } | null>(null);
  const [lastTest, setLastTest] = useState<{ ok: boolean; detail: string; at: number } | null>(null);
  const [showBaseUrl, setShowBaseUrl] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [sheet, setSheet] = useState(false);
  const [providerId, setProviderId] = useState<string>(WORKER_PROVIDERS[0].id);
  const [key, setKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [customModel, setCustomModel] = useState(false);
  const autoOpenedModel = useRef(false);
  const autoPrepared = useRef(false);
  const status = state.hermes;

  const publishVerification = (workerStatus: typeof status, ok: boolean) => {
    recordWorkerVerification(workerStatus, ok);
    window.dispatchEvent(new Event(WORKER_VERIFICATION_EVENT));
  };

  const refreshWorker = async () => {
    const fresh = await api("/api/hermes");
    dispatch({ type: "hermesStatus", status: fresh });
    setModel(fresh.model ?? null);
    return fresh;
  };

  const loadModel = async () => {
    try {
      const res = await api("/api/hermes/model");
      setModel(res.model ?? null);
    } catch { /* card still shows worker rows */ }
  };

  useEffect(() => {
    void loadModel();
  }, []);

  useEffect(() => {
    if (!sheet) return;
    let current = true;
    setModelOptions([]);
    void api(`/api/hermes/models?provider=${encodeURIComponent(providerId)}`)
      .then((result) => {
        if (current) setModelOptions(result.models ?? []);
      })
      .catch(() => {
        if (current) setModelOptions([]);
      });
    return () => {
      current = false;
    };
  }, [providerId, sheet]);

  const pollInstall = async () => {
    // A private install may legitimately take several minutes on a fresh Mac,
    // but the renderer must never poll forever. The server owns the job, so a
    // timed-out screen can be left safely and the same setup action resumes it.
    const maxPollAttempts = 15 * 60;
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      const res = await api("/api/hermes/install/status");
      const job = res.install;
      if (!job) throw new Error("RealBud could not read Bud's setup progress. Try again.");
      setInstall({
        state: job.state,
        lines: (job.lines ?? []).slice(-3),
        error: job.error ?? null,
        rollback: job.rollback ?? null,
      });
      if (["done", "failed", "idle"].includes(job.state)) {
        await refreshWorker();
        if (job.state === "done") {
          setTest({
            ok: true,
            detail: job.rollback === "available"
              ? "Bud's private setup was updated safely. RealBud kept the previous runtime for recovery."
              : "Bud's private setup is prepared on this computer.",
          });
        }
        if (job.state === "failed") {
          throw new Error(job.error ?? "Bud's private setup did not finish. Try again.");
        }
        return job;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("Bud is still preparing in the background. You can leave this page and choose Prepare Bud again to resume checking it.");
  };

  const installOrResume = async () => {
    const current = await api("/api/hermes/install/status");
    const active = current.install && !["idle", "done", "failed"].includes(current.install.state);
    if (!active) await api("/api/hermes/install", { method: "POST", body: "{}" });
    const finished = await pollInstall();
    if (finished.state !== "done") throw new Error("Bud's private setup did not finish. Try again.");
    return refreshWorker();
  };

  const testBud = async () => {
    const result = await api("/api/hermes/test", { method: "POST", body: "{}" });
    setTest(result);
    setLastTest({ ok: Boolean(result?.ok), detail: String(result?.detail ?? ""), at: Date.now() });
    const fresh = await refreshWorker();
    publishVerification(fresh, Boolean(result?.ok));
    if (!result?.ok) throw new Error(result?.detail ?? "Bud did not answer the live check. Your existing setup was kept.");
    return fresh;
  };

  const act = async (key: "install" | "pack" | "test" | "check") => {
    setBusy(key);
    setError("");
    setTest(null);
    try {
      if (key === "install") {
        let fresh = await installOrResume();
        if (!fresh.pack?.installed || !fresh.pack?.approvalsManual) {
          fresh = await api("/api/hermes/apply-pack", { method: "POST", body: "{}" });
          dispatch({ type: "hermesStatus", status: fresh });
          setModel(fresh.model ?? null);
        }
        setTest({ ok: true, detail: "Bud's private setup and safety rules are prepared." });
        return;
      } else if (key === "test") {
        await testBud();
        return;
      } else if (key === "pack") {
        const fresh = await api("/api/hermes/apply-pack", { method: "POST", body: "{}" });
        dispatch({ type: "hermesStatus", status: fresh });
        setModel(fresh.model ?? null);
        setTest({ ok: true, detail: "Bud's safety setup was repaired." });
        return;
      }
      await refreshWorker();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveModel = async () => {
    setBusy("model");
    setError("");
    try {
      const res = await api("/api/hermes/model", {
        method: "POST",
        body: JSON.stringify({ providerId, apiKey: key, model: modelId, baseUrl: baseUrl || undefined }),
      });
      if (res.ping) {
        setTest(res.ping);
        setLastTest({ ok: Boolean(res.ping?.ok), detail: String(res.ping?.detail ?? ""), at: Date.now() });
      }
      if (res.ok === false) throw new Error(res.error ?? "could not attach the model");
      setModel(res.model ?? null);
      const fresh = await refreshWorker();
      publishVerification(fresh, true);
      setSheet(false);
      setKey("");
      setModelId("");
      setBaseUrl("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const Row = ({ label, ok, text }: { label: string; ok: boolean; text: string }) => (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <span className="text-ink-secondary">{label}</span>
      <span className={cn("min-w-0 truncate text-right", ok ? "text-ink" : "text-warning")}>{text}</span>
    </div>
  );

  const pinMismatch = Boolean(status?.cli.installed && !status?.cli.matchesPin);
  const runtimeActionLabel = !status?.cli.installed ? "Prepare private runtime" : pinMismatch ? "Update private runtime" : "Reinstall private runtime";
  const selectedProvider = workerProvider(providerId) ?? WORKER_PROVIDERS[0];
  const recommendedIds = new Set(selectedProvider.recommendedModels.map((choice) => choice.id));
  const modelChoices: WorkerModelRecommendation[] = [
    ...selectedProvider.recommendedModels,
    ...modelOptions
      .filter((id) => !recommendedIds.has(id))
      .map((id) => ({ id, label: id, note: "Available from Bud's worker" })),
  ].slice(0, 12);
  const displayedModel = model ?? status?.model ?? null;
  const modelPresentation = presentStoredWorkerModel(displayedModel);

  const openModelSheet = (sourceModel = model) => {
    const currentProvider = sourceModel?.provider && workerProvider(sourceModel.provider) ? sourceModel.provider : WORKER_PROVIDERS[0].id;
    const provider = workerProvider(currentProvider) ?? WORKER_PROVIDERS[0];
    const currentModel = sourceModel?.provider === currentProvider ? (sourceModel.model ?? "") : "";
    setProviderId(currentProvider);
    setModelId(currentModel || provider.exampleModel);
    setCustomModel(Boolean(currentModel && !provider.recommendedModels.some((choice) => choice.id === currentModel)));
    setKey("");
    setBaseUrl("");
    setShowBaseUrl(false);
    setError("");
    setSheet(true);
  };

  const setupOperation = nextWorkerSetupOperation({
    worker: status,
    workerIsVerified: workerVerified(status),
  });
  const setupActionLabel = setupOperation === "install" || setupOperation === "pack"
    ? "Prepare Bud"
    : setupOperation === "model"
      ? "Connect a model"
      : setupOperation === "test"
        ? "Check Bud"
        : null;
  const setupSubtitle = setupOperation === "checking"
    ? "Checking this computer…"
    : setupOperation === "install" || setupOperation === "pack"
      ? "One guided step prepares Bud privately inside RealBud."
      : setupOperation === "model"
        ? "Bud is prepared. Connect the model you want to use."
        : setupOperation === "test"
          ? "The model is saved. One short live check finishes setup."
          : "Bud is ready for Ask and selected-file intake.";
  const journeyTitle = setupOperation === "checking"
    ? "Checking Bud"
    : setupOperation === "install" || setupOperation === "pack"
      ? "Prepare Bud"
      : setupOperation === "model"
        ? "Connect a model"
        : setupOperation === "test"
          ? "Finish Bud's check"
          : "Bud is ready";

  const continueSetup = async () => {
    if (busy !== null) return;
    setBusy("prepare");
    setError("");
    setTest(null);
    try {
      let current = await refreshWorker();
      // The loop is deliberately bounded. A single PM action may finish only
      // the code-owned private preparation and live check; credential entry
      // always stops at the secure model form.
      for (let step = 0; step < 5; step += 1) {
        const next = nextWorkerSetupOperation({
          worker: current,
          workerIsVerified: workerVerified(current),
        });
        if (next === "checking") {
          current = await refreshWorker();
          continue;
        }
        if (next === "install") {
          current = await installOrResume();
          continue;
        }
        if (next === "pack") {
          current = await api("/api/hermes/apply-pack", { method: "POST", body: "{}" });
          dispatch({ type: "hermesStatus", status: current });
          setModel(current.model ?? null);
          continue;
        }
        if (next === "model") {
          setModel(current.model ?? null);
          openModelSheet(current.model ?? null);
          setTest({ ok: true, detail: "Bud's private setup is ready. Connect the model you want Bud to use next." });
          return;
        }
        if (next === "test") {
          await testBud();
          return;
        }
        setTest({ ok: true, detail: "Bud is ready. Bring in the portfolio when you are ready." });
        return;
      }
      throw new Error("RealBud could not finish Bud's setup safely. Check the details below and try again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!autoOpenModel) {
      autoOpenedModel.current = false;
      return;
    }
    if (autoOpenedModel.current || setupOperation !== "model" || sheet || busy !== null) return;
    autoOpenedModel.current = true;
    openModelSheet(displayedModel);
  }, [autoOpenModel, busy, displayedModel, setupOperation, sheet]);

  useEffect(() => {
    if (presentation !== "journey" || autoPrepared.current || busy !== null || !status) return;
    if (setupOperation !== "install" && setupOperation !== "pack" && setupOperation !== "test") return;
    autoPrepared.current = true;
    void continueSetup();
  }, [busy, presentation, setupOperation, status]);

  const setupContent = (
      <div className="flex flex-col gap-3">
        {presentation === "journey" ? (
          <p className="max-w-[34rem] text-[14px] leading-relaxed text-ink-secondary">{setupSubtitle}</p>
        ) : (
          <div className="flex items-start justify-between gap-3 border border-line bg-paper px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ink">{journeyTitle}</div>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{setupSubtitle}</p>
            </div>
            <span className={cn(
              "shrink-0 rounded px-2 py-1 text-[10.5px] font-medium",
              setupOperation === "done" ? "bg-selected text-agency" : "bg-inset text-ink-muted",
            )}>
              {setupOperation === "done" ? "Ready" : "Current"}
            </span>
          </div>
        )}
        {status?.runtimeRecovery && status.runtimeRecovery.action !== "none" && (
          <div className={cn(
            "rounded-lg border px-3 py-2 text-[12.5px]",
            status.runtimeRecovery.action === "attention" || status.runtimeRecovery.action === "quarantined-staging"
              ? "border-warning/30 bg-warning/10 text-warning"
              : "border-success/25 bg-success/10 text-success",
          )}>
            {status.runtimeRecovery.detail}
          </div>
        )}
        {install && !["idle", "done", "failed"].includes(install.state) && (
          <div className="rounded border border-line bg-inset px-3 py-2.5 text-[12px] text-ink-secondary" role="status" aria-live="polite">
            <div className="flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" />
              Preparing Bud privately...
            </div>
            <div className="mt-1 text-[11px] opacity-70">This can take a few minutes. Stay here — RealBud downloads and links Bud privately, then asks for your model and key.</div>
          </div>
        )}
        {test && (
          <div className={cn("rounded-lg border px-3 py-2 text-[12.5px]", test.ok ? "border-success/25 bg-success/10 text-success" : "border-danger/25 bg-danger/10 text-danger")}>
            {test.detail}
          </div>
        )}
        {error && <div className="border border-danger/25 bg-danger/10 px-3 py-2 text-[12.5px] text-danger" role="alert">{error}</div>}
        <div className="flex flex-wrap items-center gap-2">
          {setupActionLabel && !sheet ? (
            <button
              onClick={() => void continueSetup()}
              disabled={busy !== null || (install !== null && !["done", "failed", "idle"].includes(install.state))}
              className="pm-control pm-tactile flex items-center gap-1.5 rounded bg-agency px-4 text-[13px] font-semibold text-white hover:bg-agency-hover disabled:opacity-40"
            >
              {busy === "prepare" ? <Loader2 size={13} className="animate-spin" /> : <Hand size={13} />}
              {busy === "prepare" ? "Working..." : setupActionLabel}
            </button>
          ) : setupOperation === "done" ? (
            <button
              type="button"
              onClick={onOpenPortfolio ?? (() => dispatch({ type: "showAsk" }))}
              className="pm-control pm-tactile rounded bg-agency px-4 text-[13px] font-semibold text-white hover:bg-agency-hover"
            >
              Verify book
            </button>
          ) : setupOperation === "checking" ? (
            <span className="flex items-center gap-2 text-[12.5px] text-ink-muted" role="status"><Loader2 size={13} className="animate-spin" /> Checking Bud...</span>
          ) : null}
          {presentation === "settings" ? (
            <span className="text-[11.5px] text-ink-muted">Nothing is sent, paid or connected during setup.</span>
          ) : null}
        </div>
        {sheet && (
          <div className="mt-2 flex flex-col gap-4 rounded border border-line bg-paper p-4">
            <fieldset>
              <legend className="text-[12px] font-semibold text-ink">Provider</legend>
              <div className="mt-2 grid grid-cols-2 gap-2 min-[720px]:grid-cols-3">
                {WORKER_PROVIDERS.map((provider) => {
                  const selected = provider.id === providerId;
                  return (
                    <label
                      key={provider.id}
                      className={cn(
                        "pm-control pm-tactile min-w-0 cursor-pointer rounded border px-3 py-2 text-left focus-within:outline focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-agency",
                        selected
                          ? "border-agency bg-selected text-ink"
                          : "border-line bg-sheet text-ink hover:border-agency/60 hover:bg-raised/60",
                      )}
                    >
                      <input
                        type="radio"
                        name="worker-provider"
                        value={provider.id}
                        checked={selected}
                        onChange={() => {
                          const nextModel = provider.id === model?.provider && model.model
                            ? model.model
                            : provider.exampleModel;
                          setProviderId(provider.id);
                          setModelOptions([]);
                          setModelId(nextModel);
                          setCustomModel(!provider.recommendedModels.some((choice) => choice.id === nextModel));
                          setKey("");
                        }}
                        className="sr-only"
                      />
                      <span className="block truncate text-[12.5px] font-semibold">{provider.label}</span>
                      <span className="block truncate text-[11px] text-ink-muted">{provider.family}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <label className="text-[12px] font-semibold text-ink">
              API key{" "}
              {model?.provider === providerId && model?.keyPresent && (
                <span className="font-normal text-ink-muted">
                  (current key stored securely; leave blank to keep)
                </span>
              )}
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                placeholder={model?.provider === providerId && model?.keyPresent ? "keep current" : "paste the provider key"}
                className="pm-control mt-2 w-full rounded border border-line bg-sheet px-3 text-[13px] font-normal text-ink placeholder:text-ink-muted focus:border-agency"
              />
            </label>
            <button
              type="button"
              onClick={() => setShowBaseUrl((v) => !v)}
              className="self-start text-[11.5px] text-ink-secondary hover:text-ink"
            >
              {showBaseUrl ? "− Hide base URL" : "+ Base URL (advanced)"}
            </button>
            {showBaseUrl && (
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1 (leave empty for the provider default)"
                className="pm-control w-full rounded border border-line bg-sheet px-3 font-mono text-[12px] text-ink placeholder:text-ink-muted focus:border-agency"
              />
            )}
            <fieldset>
              <legend className="text-[12px] font-semibold text-ink">Model</legend>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                Choose a current compatible model, or enter another ID supplied by {selectedProvider.label}.
              </p>
              <div className="mt-2 grid grid-cols-1 gap-2 min-[720px]:grid-cols-2">
                {modelChoices.map((choice) => {
                  const selected = !customModel && modelId === choice.id;
                  return (
                    <label
                      key={choice.id}
                      className={cn(
                        "pm-control pm-tactile min-w-0 cursor-pointer rounded border px-3 py-2 text-left focus-within:outline focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-agency",
                        selected
                          ? "border-agency bg-agency text-white"
                          : "border-line bg-sheet text-ink hover:border-agency/60 hover:bg-raised/60",
                      )}
                    >
                      <input
                        type="radio"
                        name={`worker-model-${providerId}`}
                        value={choice.id}
                        checked={selected}
                        onChange={() => {
                          setCustomModel(false);
                          setModelId(choice.id);
                        }}
                        className="sr-only"
                      />
                      <span className="block truncate text-[12.5px] font-semibold">{choice.label}</span>
                      <span className={cn("block truncate text-[11px]", selected ? "text-white/80" : "text-ink-muted")}>{choice.note}</span>
                    </label>
                  );
                })}
                <label
                  className={cn(
                    "pm-control pm-tactile min-w-0 cursor-pointer rounded border px-3 py-2 text-left focus-within:outline focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-agency",
                    customModel
                      ? "border-agency bg-selected text-ink"
                      : "border-line bg-sheet text-ink hover:border-agency/60 hover:bg-raised/60",
                  )}
                >
                  <input
                    type="radio"
                    name={`worker-model-${providerId}`}
                    value="__custom__"
                    checked={customModel}
                    onChange={() => {
                      if (!customModel) setModelId("");
                      setCustomModel(true);
                    }}
                    className="sr-only"
                  />
                  <span className="block text-[12.5px] font-semibold">Other model ID</span>
                  <span className="block text-[11px] text-ink-muted">For a provider model not listed here</span>
                </label>
              </div>
              {customModel && (
                <label className="mt-2 block text-[11.5px] font-medium text-ink-muted">
                  Model ID
                  <input
                    type="text"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    placeholder={selectedProvider.exampleModel}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="pm-control mt-1 w-full rounded border border-line bg-sheet px-3 font-mono text-[12px] text-ink placeholder:text-ink-muted focus:border-agency"
                  />
                </label>
              )}
            </fieldset>
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <button
                onClick={() => void saveModel()}
                disabled={busy !== null || !modelId.trim() || (!key.trim() && !(model?.provider === providerId && model?.keyPresent))}
                className="pm-control pm-tactile rounded bg-agency px-4 text-[12.5px] font-semibold text-white hover:bg-agency-hover disabled:opacity-40"
              >
                {busy === "model" ? <Loader2 size={12} className="animate-spin" /> : "Save & test"}
              </button>
              <button
                onClick={() => setSheet(false)}
                className="pm-control pm-tactile rounded px-3 text-[12.5px] font-medium text-ink-muted hover:bg-raised hover:text-ink"
              >
                Cancel
              </button>
              <span className="ml-auto text-[11px] text-ink-muted">Key stays encrypted on this device and is used only for Bud's selected model.</span>
            </div>
          </div>
        )}
        {presentation === "settings" ? <details className="border-t border-line pt-2">
          <summary className="cursor-pointer text-[11.5px] font-medium text-ink-muted hover:text-ink">Technical details and repair</summary>
          <div className="mt-3 flex flex-col gap-2 border border-line bg-paper p-3">
            <Row
              label="Private runtime"
              ok={Boolean(status?.cli.matchesPin)}
              text={
                status?.cli.installed
                  ? status.cli.matchesPin
                    ? `v${status.pin.product}, verified`
                    : `update required, expected v${status.pin.product}`
                  : "not prepared"
              }
            />
            <Row
              label="Safety setup"
              ok={Boolean(status?.pack.installed && status?.pack.approvalsManual)}
              text={status?.pack.installed && status?.pack.approvalsManual ? "verified, manual approval locked" : "repair required"}
            />
            <Row label="Model" ok={modelPresentation.ready} text={modelPresentation.text} />
            {lastTest ? (
              <Row
                label="Last live check"
                ok={lastTest.ok}
                text={`${lastTest.ok ? "answered" : "failed"}, ${new Date(lastTest.at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}`}
              />
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-line pt-2">
              <button
                type="button"
                onClick={() => void act("install")}
                disabled={busy !== null}
                className="pm-control pm-tactile rounded border border-line bg-sheet px-3 text-[11.5px] font-medium text-ink hover:border-agency/60 disabled:opacity-40"
              >
                {busy === "install" ? <Loader2 size={12} className="animate-spin" /> : null}
                {runtimeActionLabel}
              </button>
              <button
                type="button"
                onClick={() => void act("pack")}
                disabled={busy !== null || !status?.cli.matchesPin}
                className="pm-control pm-tactile rounded border border-line bg-sheet px-3 text-[11.5px] font-medium text-ink hover:border-agency/60 disabled:opacity-40"
              >
                Repair safety setup
              </button>
              <button
                type="button"
                onClick={() => openModelSheet()}
                disabled={busy !== null || !status?.ready}
                className="pm-control pm-tactile rounded border border-line bg-sheet px-3 text-[11.5px] font-medium text-ink hover:border-agency/60 disabled:opacity-40"
              >
                {displayedModel?.model ? "Change model" : "Connect model"}
              </button>
              <button
                type="button"
                onClick={() => void act("test")}
                disabled={busy !== null || !status?.ready || !modelPresentation.ready}
                className="pm-control pm-tactile rounded border border-line bg-sheet px-3 text-[11.5px] font-medium text-ink hover:border-agency/60 disabled:opacity-40"
              >
                Run live check
              </button>
              <button
                type="button"
                onClick={() => void act("check")}
                disabled={busy !== null}
                className="pm-control pm-tactile inline-flex items-center gap-1.5 rounded px-3 text-[11.5px] font-medium text-ink-muted hover:bg-raised hover:text-ink disabled:opacity-40"
              >
                {busy === "check" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                Refresh status
              </button>
            </div>
          </div>
        </details> : null}
        {presentation === "settings" ? <p className="text-[12px] leading-relaxed text-ink-secondary/80">
          RealBud owns this setup from start to finish. No terminal or separate helper app is required.
        </p> : null}
      </div>
  );

  if (presentation === "journey") return setupContent;

  return (
    <Card title="Bud setup">
      {setupContent}
    </Card>
  );
}
export function SettingsModal() {
  const { state, dispatch } = useStore();
  const section = state.appSettingsSection;
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="flex h-[560px] w-full max-w-[860px] overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none"
      >
        {/* section nav */}
        <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r border-hairline/40 p-3">
          <div id="app-settings-title" className="px-2 pb-2 pt-1 text-[15px] font-semibold text-ink">
            Settings
          </div>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px]",
                section === id ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-[15px] font-semibold text-ink">
              {SECTIONS.find((s) => s.id === section)?.label}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label="Close settings"
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {section === "general" && (
              <>
                <Card title="Profile" subtitle="Shown in the sidebar. Saved as you go.">
                  <ProfileFields />
                </Card>
                <UpdatesRow />
              </>
            )}

            {section === "connections" && <HermesHandsCard />}
          </div>
        </div>
      </div>
    </div>
  );
}
