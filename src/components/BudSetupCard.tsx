import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  Check,
  Cpu,
  Download,
  KeyRound,
  Loader2,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { fmtDateTime } from "@/lib/au";
import { BUD_SETUP_STEPS, budFacingCopy, budSetupJourney, type BudSetupStep } from "@/lib/bud-setup";
import { cn } from "@/lib/cn";
import type { MausMotion, MausState } from "@/lib/mascot";
import { api, useStore } from "@/state/store";
import { WORKER_PROVIDERS, workerProvider } from "@shared/worker-providers";
import { MausAvatar } from "./Avatar";

type BusyAction = "install" | "safeguards" | "model" | "verify" | "check" | "repair" | "uninstall";

type InstallStatus = {
  state: "idle" | "preflight" | "running" | "verifying" | "done" | "failed";
  error: string | null;
};

type ModelStatus = {
  provider: string | null;
  model: string | null;
  keyPresent: boolean;
  keyHint: string | null;
};

type ModelPickerOption = {
  id: string;
  name: string;
  releaseDate: string | null;
  recommended: boolean;
};

const CUSTOM_MODEL = "__custom_model__";

const ACTIVE_INSTALL_STATES = new Set<InstallStatus["state"]>(["preflight", "running", "verifying"]);

const STEP_META: Record<
  BudSetupStep,
  { title: string; icon: ComponentType<{ size?: number; className?: string }> }
> = {
  install: { title: "Bud on this Mac", icon: Download },
  safeguards: { title: "Property safeguards", icon: ShieldCheck },
  model: { title: "Model connection", icon: KeyRound },
  verify: { title: "Private readiness check", icon: Cpu },
};

const primaryButton =
  "pm-control inline-flex items-center justify-center gap-2 rounded bg-agency px-4 text-[14px] font-medium text-white transition-transform hover:bg-agency-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";
const secondaryButton =
  "pm-control inline-flex items-center justify-center gap-2 rounded border border-line bg-sheet px-3 text-[14px] text-ink transition-transform hover:bg-raised active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";
const fieldClass =
  "pm-control mt-1.5 w-full rounded border border-line bg-sheet px-3 text-[14px] text-ink placeholder:text-ink-muted focus:border-agency";

function providerLabel(providerId: string | null | undefined): string {
  const provider = workerProvider(providerId);
  if (!provider) return providerId ?? "Model";
  return provider.id === providerId ? provider.label : `${provider.label} (Bud's saved login)`;
}

function installProgressCopy(state: InstallStatus["state"]): string {
  if (state === "preflight") return "Checking this Mac";
  if (state === "verifying") return "Checking the installed worker";
  return "Installing Bud inside RealBud";
}

function BudCapabilities() {
  return (
    <ul className="grid gap-2 sm:grid-cols-3" aria-label="Bud capabilities">
      <li className="rounded border border-line bg-inset/55 px-3 py-2">
        <div className="text-[12.5px] font-medium text-ink">Make</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">Read, calculate, code, and draft in the private workroom.</div>
      </li>
      <li className="rounded border border-line bg-inset/55 px-3 py-2">
        <div className="text-[12.5px] font-medium text-ink">Research</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">Search public sources and inspect what you attach.</div>
      </li>
      <li className="rounded border border-line bg-inset/55 px-3 py-2">
        <div className="text-[12.5px] font-medium text-ink">Act</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">Prepare the next step; outside actions wait for you on Desk.</div>
      </li>
    </ul>
  );
}

export function BudSetupCard({ id = "you-worker" }: { id?: string }) {
  const { state, dispatch, refreshHermes } = useStore();
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; detail: string } | null>(null);
  const [install, setInstall] = useState<InstallStatus | null>(null);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [modelReadState, setModelReadState] = useState<"loading" | "loaded" | "error">("loading");
  const [lastTest, setLastTest] = useState<{ ok: boolean; detail: string; at: number } | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelPickerOption[]>([]);
  const [modelOptionsState, setModelOptionsState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [sheet, setSheet] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [providerId, setProviderId] = useState(WORKER_PROVIDERS[0].id);
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [checkTick, setCheckTick] = useState(0);
  const [checkingMs, setCheckingMs] = useState(0);
  const mounted = useRef(false);
  const pollGeneration = useRef(0);
  const modelOptionsGeneration = useRef(0);
  const confirmRemoveTimer = useRef<number | null>(null);
  const status = state.hermes;
  const providerChoices = useMemo(() => {
    const currentId = model?.provider;
    const current = workerProvider(currentId);
    if (!currentId || !current || current.id === currentId) return WORKER_PROVIDERS;
    return [{ ...current, id: currentId, label: `${current.label} (Bud's current login)` }, ...WORKER_PROVIDERS];
  }, [model?.provider]);
  const selectedProvider = workerProvider(providerId);
  const usesProfileLogin = Boolean(
    model?.provider === providerId &&
    model.keyPresent &&
    selectedProvider &&
    selectedProvider.id !== providerId,
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pollGeneration.current += 1;
      modelOptionsGeneration.current += 1;
      if (confirmRemoveTimer.current != null) window.clearTimeout(confirmRemoveTimer.current);
    };
  }, []);

  const loadModel = useCallback(async () => {
    setModelReadState("loading");
    try {
      const res = await api("/api/hermes/model");
      if (!mounted.current) return;
      setModel(res.model ?? null);
      setModelReadState("loaded");
    } catch {
      if (!mounted.current) return;
      setModelReadState("error");
    }
  }, []);

  const pollInstall = useCallback(async () => {
    const generation = ++pollGeneration.current;
    for (let attempt = 0; attempt < 660; attempt += 1) {
      if (!mounted.current || generation !== pollGeneration.current) return;
      try {
        const res = await api("/api/hermes/install/status");
        const job = (res.install ?? null) as InstallStatus | null;
        if (!mounted.current || generation !== pollGeneration.current) return;
        setInstall(job);
        if (!job || !ACTIVE_INSTALL_STATES.has(job.state)) {
          await refreshHermes();
          if (job?.state === "done") {
            setFeedback({ ok: true, detail: "Bud is installed. RealBud checked the expected build." });
          } else if (job?.state === "failed") {
            setError(budFacingCopy(job.error, "Bud could not be installed. Check the details and try again."));
          }
          return;
        }
      } catch (cause) {
        if (mounted.current && generation === pollGeneration.current) {
          setError(budFacingCopy(cause, "RealBud could not read the install state."));
        }
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
    if (mounted.current && generation === pollGeneration.current) {
      setError("Installation is still running. You can leave this page and check again later.");
    }
  }, [refreshHermes]);

  const refreshAll = useCallback(async () => {
    setCheckTick((tick) => tick + 1);
    setBusy("check");
    setError("");
    setFeedback(null);
    try {
      const [freshStatus, freshModel, installResult] = await Promise.all([
        api("/api/hermes"),
        api("/api/hermes/model"),
        api("/api/hermes/install/status"),
      ]);
      if (!mounted.current) return;
      dispatch({ type: "hermesStatus", status: freshStatus });
      setModel(freshModel.model ?? null);
      setModelReadState("loaded");
      const job = (installResult.install ?? null) as InstallStatus | null;
      setInstall(job);
      if (job && ACTIVE_INSTALL_STATES.has(job.state)) void pollInstall();
    } catch (cause) {
      if (mounted.current) {
        setError(budFacingCopy(cause, "RealBud could not check Bud."));
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [dispatch, pollInstall]);

  useEffect(() => {
    void loadModel();
    void api("/api/hermes/install/status")
      .then((res) => {
        if (!mounted.current) return;
        const job = (res.install ?? null) as InstallStatus | null;
        setInstall(job);
        if (job && ACTIVE_INSTALL_STATES.has(job.state)) void pollInstall();
      })
      .catch(() => {});
  }, [loadModel, pollInstall]);

  useEffect(() => {
    const shared = status?.lastPing ?? (status?.lastTest?.kind === "ping" ? status.lastTest : null);
    if (!shared) return;
    setLastTest({ ok: shared.ok, detail: shared.detail, at: shared.at });
  }, [status?.lastPing, status?.lastTest]);

  const loadModelOptions = useCallback(async (nextProvider: string, preferredModel = "") => {
    const generation = ++modelOptionsGeneration.current;
    setModelOptionsState("loading");
    try {
      const res = await api(`/api/hermes/models?provider=${encodeURIComponent(nextProvider)}`);
      if (!mounted.current || generation !== modelOptionsGeneration.current) return;
      const options: ModelPickerOption[] = Array.isArray(res.options)
        ? res.options.filter((option: unknown): option is ModelPickerOption => {
            if (!option || typeof option !== "object") return false;
            const row = option as Partial<ModelPickerOption>;
            return typeof row.id === "string" && typeof row.name === "string" && typeof row.recommended === "boolean";
          })
        : (Array.isArray(res.models) ? res.models : [])
            .filter((id: unknown): id is string => typeof id === "string")
            .map((id: string) => ({ id, name: id, releaseDate: null, recommended: false }));
      setModelOptions(options);
      setModelOptionsState("loaded");
      const preferred = preferredModel.trim();
      if (preferred) {
        setModelId(preferred);
        setModelChoice(options.some((option) => option.id === preferred) ? preferred : CUSTOM_MODEL);
        return;
      }
      const first = options[0]?.id ?? "";
      setModelId(first);
      setModelChoice(first || CUSTOM_MODEL);
    } catch {
      if (!mounted.current || generation !== modelOptionsGeneration.current) return;
      setModelOptions([]);
      setModelOptionsState("error");
      const preferred = preferredModel.trim();
      setModelId(preferred);
      setModelChoice(CUSTOM_MODEL);
    }
  }, []);

  const openModelSheet = useCallback(() => {
    if (!status?.cli.matchesPin || !status.pack.installed || !status.pack.approvalsManual || !status.pack.workroomReady) {
      setError("Finish the earlier setup item before connecting a model.");
      return;
    }
    const nextProvider = model?.provider && workerProvider(model.provider) ? model.provider : providerId;
    const savedModel = model?.model ?? "";
    setProviderId(nextProvider);
    setModelId(savedModel);
    setModelChoice(savedModel ? CUSTOM_MODEL : "");
    setApiKey("");
    setBaseUrl("");
    setError("");
    setFeedback(null);
    setSheet(true);
    void loadModelOptions(nextProvider, savedModel);
  }, [loadModelOptions, model, providerId, status]);

  const closeModelSheet = useCallback(() => {
    setSheet(false);
    setApiKey("");
    setBaseUrl("");
    if (location.hash === "#attach-model") {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
  }, []);

  useEffect(() => {
    const fromHash = () => {
      if (location.hash === "#attach-model") openModelSheet();
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    window.addEventListener("realbud:open-attach", openModelSheet);
    return () => {
      window.removeEventListener("hashchange", fromHash);
      window.removeEventListener("realbud:open-attach", openModelSheet);
    };
  }, [openModelSheet]);

  const modelAttached = Boolean(model?.model && model.keyPresent);
  const journey = useMemo(
    () =>
      budSetupJourney({
        statusLoaded: Boolean(status),
        workerInstalled: Boolean(status?.cli.installed),
        workerPinned: Boolean(status?.cli.matchesPin),
        safeguardsInstalled: Boolean(status?.pack.installed),
        approvalsManual: Boolean(status?.pack.approvalsManual),
        workroomReady: Boolean(status?.pack.workroomReady),
        modelChecked: modelReadState === "loaded",
        modelAttached,
        verified: Boolean(status?.ready),
      }),
    [modelAttached, modelReadState, status],
  );
  const installActive = Boolean(install && ACTIVE_INSTALL_STATES.has(install.state));
  const locked = busy !== null || installActive;

  useEffect(() => {
    if (journey.stage !== "checking") {
      setCheckingMs(0);
      return;
    }
    setCheckingMs(0);
    const started = Date.now();
    const id = window.setInterval(() => {
      if (!mounted.current) return;
      setCheckingMs(Date.now() - started);
    }, 250);
    return () => window.clearInterval(id);
  }, [journey.stage, checkTick]);
  const pinMismatch = Boolean(status?.cli.installed && !status.cli.matchesPin);
  const progress = journey.completed / journey.total;
  const timezone = state.desk?.book?.agency.timezone ?? state.desk?.timezone;

  const stepDetail = (step: BudSetupStep): string => {
    if (step === "install") {
      if (journey.stepState.install === "complete") return "Installed and checked against RealBud's supported build.";
      return pinMismatch ? "The installed worker needs the RealBud-supported update." : "Installs privately inside RealBud. No Terminal or second app.";
    }
    if (step === "safeguards") {
      if (journey.stepState.safeguards === "complete") return "Private workroom ready for files, research, calculations, and code. Consequential actions still ask you.";
      return "Adds Bud's private workroom and keeps every consequential action with you.";
    }
    if (step === "model") {
      if (modelAttached) {
        return `${providerLabel(model?.provider)} · ${model?.model}. Credential saved privately.`;
      }
      return modelReadState === "error" ? "RealBud could not read the saved model connection." : "Connect one provider key. The key stays in Bud's private storage.";
    }
    if (status?.ready && lastTest) return `Answered ${fmtDateTime(lastTest.at, timezone)}.`;
    if (lastTest && !lastTest.ok) return "The last check missed. Nothing on Desk was treated as live.";
    return "Asks one private question to prove Bud can answer before Desk relies on it.";
  };

  const clearConfirmRemove = () => {
    if (confirmRemoveTimer.current != null) {
      window.clearTimeout(confirmRemoveTimer.current);
      confirmRemoveTimer.current = null;
    }
    setConfirmRemove(false);
  };

  const runAction = async (action: Exclude<BusyAction, "model" | "check" | "uninstall">) => {
    clearConfirmRemove();
    setBusy(action);
    setError("");
    setFeedback(null);
    try {
      if (action === "install" || action === "repair") {
        const res = await api(action === "repair" ? "/api/hermes/repair" : "/api/hermes/install", { method: "POST", body: "{}" });
        const job = (res.install ?? null) as InstallStatus | null;
        setInstall(job);
        setBusy(null);
        await pollInstall();
        return;
      }
      if (action === "safeguards") {
        const fresh = await api("/api/hermes/apply-pack", { method: "POST", body: "{}" });
        dispatch({ type: "hermesStatus", status: fresh });
        setFeedback({ ok: true, detail: "Bud's private workroom is ready. Consequential actions still ask you." });
        return;
      }
      const result = await api("/api/hermes/test", { method: "POST", body: "{}" });
      const at = Date.now();
      const detail = budFacingCopy(result?.detail, "Bud did not return a check result.");
      setFeedback({ ok: Boolean(result?.ok), detail });
      setLastTest({ ok: Boolean(result?.ok), detail, at });
      await refreshHermes();
    } catch (cause) {
      setError(budFacingCopy(cause, "Bud could not finish that check."));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const requestRemove = async () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      if (confirmRemoveTimer.current != null) window.clearTimeout(confirmRemoveTimer.current);
      confirmRemoveTimer.current = window.setTimeout(() => {
        confirmRemoveTimer.current = null;
        if (mounted.current) setConfirmRemove(false);
      }, 5_000);
      return;
    }
    clearConfirmRemove();
    setBusy("uninstall");
    setError("");
    setFeedback(null);
    try {
      const fresh = await api("/api/hermes/uninstall", { method: "POST", body: "{}" });
      if (!mounted.current) return;
      dispatch({ type: "hermesStatus", status: fresh });
      setLastTest(null);
      setModel(null);
      await loadModel();
      await refreshHermes();
    } catch (cause) {
      if (mounted.current) setError(budFacingCopy(cause, "RealBud could not remove Bud."));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const saveModel = async () => {
    setBusy("model");
    setError("");
    setFeedback(null);
    try {
      const res = await api("/api/hermes/model", {
        method: "POST",
        body: JSON.stringify({ providerId, apiKey, model: modelId, baseUrl: baseUrl || undefined }),
      });
      setModel(res.model ?? null);
      setModelReadState("loaded");
      if (res.ping) {
        const at = Date.now();
        const detail = budFacingCopy(res.ping.detail, "Bud did not return a check result.");
        setFeedback({ ok: Boolean(res.ping.ok), detail });
        setLastTest({ ok: Boolean(res.ping.ok), detail, at });
      }
      closeModelSheet();
      await refreshHermes();
    } catch (cause) {
      setError(budFacingCopy(cause, "RealBud could not connect that model."));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const openAsk = () => {
    dispatch({ type: "toggleAppSettings", open: false });
    dispatch({ type: "showAsk" });
  };

  const hasFailure = Boolean(error || install?.state === "failed" || (lastTest && !lastTest.ok));
  const mascotState: MausState = installActive || busy ? "working" : hasFailure ? "alerting" : journey.stage === "ready" ? "happy" : journey.stage === "checking" ? "thinking" : "curious";
  const mascotMotion: MausMotion = feedback?.ok ? "success" : feedback && !feedback.ok ? "failure" : "none";
  const headline =
    journey.stage === "ready"
      ? "Bud is ready"
      : journey.stage === "checking"
        ? "Checking Bud"
        : journey.stage === "verify"
          ? "One check from ready"
          : "Bring Bud online";
  const statusCopy =
    journey.stage === "ready"
      ? "Ask uses this same private worker. Work that needs approval still lands on Desk."
      : journey.stage === "checking"
        ? "RealBud is reading the worker, safeguards, and model connection."
        : "Finish one item at a time. Desk keeps working on the sample book while you do.";

  return (
    <section id={id} className="shrink-0 overflow-hidden rounded-lg border border-line bg-sheet" aria-labelledby={`${id}-title`}>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="p-4 sm:p-5 lg:p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 id={`${id}-title`} className="text-[20px] font-semibold tracking-[-0.02em] text-ink">
                Bud
              </h2>
              <p className="mt-1 max-w-[42rem] text-[13.5px] leading-relaxed text-ink-secondary">
                Your private property worker, installed and operated by RealBud. The machinery stays here so Ask can stay simple.
              </p>
            </div>
            <span className={cn(
              "rounded-full border px-2.5 py-1 text-[11.5px] font-medium",
              journey.stage === "ready"
                ? "border-agency/25 bg-agency/10 text-agency"
                : hasFailure
                  ? "border-danger/25 bg-danger/10 text-danger"
                  : "border-hold/25 bg-hold/10 text-hold",
            )}>
              {journey.stage === "ready" ? "Ready" : hasFailure ? "Needs attention" : `${journey.completed} of ${journey.total} ready`}
            </span>
          </div>

          <div className="mt-4 h-1 overflow-hidden rounded-full bg-line/60 lg:mt-5" aria-hidden="true">
            <div
              className="h-full origin-left rounded-full bg-agency transition-transform duration-500 motion-reduce:transition-none"
              style={{ transform: `scaleX(${progress})` }}
            />
          </div>
          {journey.stage === "ready" && status?.pack.workroomReady ? (
            <div className="mt-4">
              <BudCapabilities />
            </div>
          ) : null}
          <div
            className="sr-only"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={journey.total}
            aria-valuenow={journey.completed}
          >
            {journey.completed} of {journey.total} setup items ready
          </div>

          <ol className="mt-4">
            {BUD_SETUP_STEPS.map((step, index) => {
              const meta = STEP_META[step];
              const Icon = meta.icon;
              const stepState = journey.stepState[step];
              return (
                <li
                  key={step}
                  data-state={stepState}
                  className={cn(
                    "bud-setup-step relative grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-x-3 px-2 py-2 lg:py-3",
                    stepState === "current" && "rounded bg-selected/55",
                  )}
                >
                  {index < BUD_SETUP_STEPS.length - 1 ? (
                    <span className="absolute left-[1.43rem] top-[2.4rem] h-[calc(100%-1.8rem)] border-l border-line" aria-hidden="true" />
                  ) : null}
                  <span
                    className={cn(
                      "relative flex size-7 items-center justify-center rounded-full border bg-sheet",
                      stepState === "complete"
                        ? "border-agency bg-agency text-white"
                        : stepState === "current"
                          ? "border-agency text-agency"
                          : "border-line text-ink-muted",
                    )}
                    aria-hidden="true"
                  >
                    {stepState === "complete" ? <Check size={14} strokeWidth={2} /> : <Icon size={14} />}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-ink">{meta.title}</div>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">{stepDetail(step)}</p>
                  </div>
                  <span className={cn(
                    "pt-0.5 text-[11.5px]",
                    stepState === "complete" ? "text-agency" : stepState === "current" ? "font-medium text-ink" : "text-ink-muted",
                  )}>
                    {stepState === "complete" ? "Ready" : stepState === "current" ? "Next" : "Later"}
                  </span>
                </li>
              );
            })}
          </ol>
          {journey.stage !== "ready" ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-[13px] font-medium text-ink">What Bud can do</summary>
              <div className="mt-2">
                <BudCapabilities />
              </div>
            </details>
          ) : null}
        </div>

        <aside className="hidden flex-col justify-between border-l border-line bg-inset/70 p-5 lg:flex" aria-live="polite">
          <div>
            <div className="flex min-h-32 items-center justify-center">
              <MausAvatar
                color="green"
                state={mascotState}
                motion={mascotMotion}
                motionKey={lastTest?.at ?? 0}
                size={118}
                label="Bud"
                trackPointer={false}
              />
            </div>
            {journey.stage === "checking" && checkingMs < 3_000 ? (
              <div className="mt-3 space-y-2" aria-busy="true">
                <div className="h-6 w-[10rem] animate-pulse rounded bg-raised motion-reduce:animate-none" />
                <div className="h-3 w-full animate-pulse rounded bg-raised motion-reduce:animate-none" />
                <div className="h-3 w-[80%] animate-pulse rounded bg-raised motion-reduce:animate-none" />
              </div>
            ) : (
              <>
                <h3 className="mt-3 text-[18px] font-semibold tracking-[-0.02em] text-ink">{headline}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{statusCopy}</p>
              </>
            )}
          </div>
          <div className="mt-5 text-[11.5px] leading-relaxed text-ink-muted">
            Runs quietly inside RealBud. No separate worker window. No automatic sends or payments.
          </div>
        </aside>
      </div>

      <div className="border-t border-line bg-sheet px-5 py-4 lg:px-6">
        {installActive && install ? (
          <div className="flex items-center gap-2 text-[13px] text-ink" role="status">
            <Loader2 size={15} className="animate-spin text-agency motion-reduce:animate-none" />
            <span>{installProgressCopy(install.state)}</span>
          </div>
        ) : null}

        {!installActive && journey.stage === "checking" ? (
          checkingMs < 3_000 ? (
            <div className="space-y-2" aria-busy="true">
              <span className="sr-only">Reading Bud's setup</span>
              <div className="h-5 w-[10rem] max-w-[60%] animate-pulse rounded bg-raised motion-reduce:animate-none" />
              <div className="h-3 w-[16rem] max-w-[80%] animate-pulse rounded bg-raised motion-reduce:animate-none" />
              <div className="h-3 w-[12rem] max-w-[70%] animate-pulse rounded bg-raised motion-reduce:animate-none" />
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[14px] font-medium text-ink">
                  {modelReadState === "error" ? "Bud's model connection could not be read" : "Reading the current setup"}
                </div>
                {checkingMs >= 8_000 ? (
                  <p className="mt-0.5 text-[12.5px] text-ink-muted">Check again if this does not settle in a moment.</p>
                ) : null}
              </div>
              {checkingMs >= 8_000 ? (
                <button type="button" onClick={() => void refreshAll()} disabled={locked} className={secondaryButton}>
                  {busy === "check" ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <RefreshCw size={14} />}
                  Check again
                </button>
              ) : null}
            </div>
          )
        ) : null}

        {!installActive && journey.stage === "install" ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[14px] font-medium text-ink">{pinMismatch ? "Update Bud" : "Install Bud"}</div>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">
                RealBud runs the supported installer here and checks the result before moving on.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void runAction("install")}
              disabled={locked || !status?.installCommand}
              className={primaryButton}
            >
              {busy === "install" ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <Download size={14} />}
              {pinMismatch ? "Update Bud" : "Install Bud"}
            </button>
            {!status?.installCommand ? (
              <p className="w-full text-[12.5px] text-hold">This platform stays in CSV mode because an in-app worker installer is not available.</p>
            ) : null}
          </div>
        ) : null}

        {!installActive && journey.stage === "safeguards" ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[14px] font-medium text-ink">Set up Bud's workroom</div>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">Enables files, research, calculations, and code in private storage. Risky commands still ask.</p>
            </div>
            <button type="button" onClick={() => void runAction("safeguards")} disabled={locked} className={primaryButton}>
              {busy === "safeguards" ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <ShieldCheck size={14} />}
              Set up workroom
            </button>
          </div>
        ) : null}

        {!installActive && journey.stage === "model" && !sheet ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[14px] font-medium text-ink">Connect Bud's model</div>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">Choose the provider your office already uses. RealBud stores the key only in Bud's private storage.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={openModelSheet} disabled={locked} className={primaryButton}>
                <KeyRound size={14} />
                Connect model
              </button>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => {
                  location.hash = "you-billing";
                }}
              >
                Use RealBud credits
              </button>
            </div>
          </div>
        ) : null}

        {!installActive && journey.stage === "verify" && !sheet ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[14px] font-medium text-ink">Check that Bud can answer</div>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">One private question proves the full connection. It does not read or change the book.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void runAction("verify")} disabled={locked} className={primaryButton}>
                {busy === "verify" ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <Cpu size={14} />}
                {busy === "verify" ? "Checking…" : "Run readiness check"}
              </button>
              <button type="button" onClick={openModelSheet} disabled={locked} className={secondaryButton}>
                Change model
              </button>
            </div>
          </div>
        ) : null}

        {!installActive && journey.stage === "ready" && !sheet ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[14px] font-medium text-ink">The same Bud is waiting in Ask</div>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">Ask for work or an answer. Anything consequential still becomes a Desk decision.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={openAsk} className={primaryButton}>
                <MessageSquare size={14} />
                Talk to Bud
              </button>
              <button type="button" onClick={openModelSheet} disabled={locked} className={secondaryButton}>
                Change model
              </button>
              <button type="button" onClick={() => void runAction("verify")} disabled={locked} className={secondaryButton}>
                {busy === "verify" ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <RefreshCw size={14} />}
                Check again
              </button>
            </div>
          </div>
        ) : null}

        {status?.cli.installed && (journey.stage === "ready" || hasFailure) && !sheet && !installActive ? (
          <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-line/70 pt-3">
            <button
              type="button"
              onClick={() => void runAction("repair")}
              disabled={locked}
              className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
            >
              {busy === "repair" ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> : null}
              Repair Bud
            </button>
            {journey.stage === "ready" ? (
              <button
                type="button"
                onClick={() => void requestRemove()}
                disabled={locked}
                className={cn(
                  "inline-flex items-center gap-1.5 text-[12px] underline-offset-2 hover:underline disabled:opacity-40",
                  confirmRemove ? "text-danger hover:text-danger" : "text-ink-muted hover:text-danger",
                )}
              >
                {busy === "uninstall" ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> : null}
                {confirmRemove ? "Confirm remove — your book stays" : "Remove Bud"}
              </button>
            ) : null}
          </div>
        ) : null}

        {feedback ? (
          <div
            role="status"
            className={cn(
              "mt-3 border px-3 py-2.5 text-[12.5px]",
              feedback.ok ? "border-agency/25 bg-agency/10 text-agency" : "border-danger/25 bg-danger/10 text-danger",
            )}
          >
            {feedback.detail}
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="mt-3 border border-danger/25 bg-danger/10 px-3 py-2.5 text-[12.5px] text-danger">
            {error}
          </div>
        ) : null}
      </div>

      {sheet ? (
        <form
          className="border-t border-line bg-inset/70 px-5 py-5 lg:px-6"
          aria-labelledby="bud-model-title"
          onSubmit={(event) => {
            event.preventDefault();
            void saveModel();
          }}
        >
          <div className="max-w-[52rem]">
            <h3 id="bud-model-title" className="text-[16px] font-semibold text-ink">Connect a model</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
              {usesProfileLogin
                ? "This keeps Bud's current private login. Only the model choice changes."
                : "The provider key is written directly to Bud's private storage. It never enters Ask, Desk, analytics, or logs."}
            </p>
            {model?.keyPresent && model.keyHint ? (
              <p className="mt-2 text-[12.5px] text-ink-muted">Key saved · ends …{model.keyHint}</p>
            ) : null}
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="text-[12.5px] font-medium text-ink">
                Provider
                <select
                  value={providerId}
                  onChange={(event) => {
                    const next = event.target.value;
                    setProviderId(next);
                    setModelId("");
                    setModelChoice("");
                    setApiKey("");
                    setBaseUrl("");
                    void loadModelOptions(next);
                  }}
                  className={fieldClass}
                >
                  {providerChoices.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.label}</option>
                  ))}
                </select>
              </label>
              <div>
                <label className="text-[12.5px] font-medium text-ink" htmlFor="bud-model-choice">
                  Model
                </label>
                <select
                  id="bud-model-choice"
                  value={modelChoice}
                  disabled={modelOptionsState === "loading"}
                  onChange={(event) => {
                    const next = event.target.value;
                    setModelChoice(next);
                    setModelId(next === CUSTOM_MODEL ? "" : next);
                  }}
                  className={fieldClass}
                >
                  <option value="" disabled>
                    {modelOptionsState === "loading" ? "Loading current models…" : "Choose a model"}
                  </option>
                  {modelOptions.some((option) => option.recommended) ? (
                    <optgroup label="Recommended for Bud">
                      {modelOptions.filter((option) => option.recommended).map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name === option.id ? option.id : `${option.name} — ${option.id}`}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {modelOptions.some((option) => !option.recommended) ? (
                    <optgroup label="Recently available to Bud">
                      {modelOptions.filter((option) => !option.recommended).map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name === option.id ? option.id : `${option.name} — ${option.id}`}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  <option value={CUSTOM_MODEL}>Custom model ID…</option>
                </select>
                <span className="mt-1.5 block text-[11.5px] font-normal text-ink-muted">
                  {modelOptionsState === "error"
                    ? "The model list could not load. Enter the provider model ID yourself."
                    : "Recent models come from Bud's installed catalogue."}
                </span>
              </div>
            </div>
            {modelChoice === CUSTOM_MODEL ? (
              <label className="mt-4 block text-[12.5px] font-medium text-ink">
                Custom model ID
                <input
                  type="text"
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  placeholder="provider-model-id"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className={fieldClass}
                />
                <span className="mt-1.5 block font-normal text-ink-muted">
                  Use the exact ID from your provider. RealBud checks it before marking Bud ready.
                </span>
              </label>
            ) : null}
            {usesProfileLogin ? (
              <div className="mt-4 border border-agency/20 bg-agency/5 px-3 py-2.5 text-[12.5px] text-ink" role="status">
                Using the saved {providerLabel(providerId)}. RealBud will not replace it or ask for a provider key.
              </div>
            ) : (
              <>
                <label className="mt-4 block text-[12.5px] font-medium text-ink">
                  Provider API key
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    autoComplete="new-password"
                    autoCapitalize="off"
                    spellCheck={false}
                    placeholder={model?.provider === providerId && model.keyPresent ? "Leave blank to keep the current key" : "Paste the provider key"}
                    className={fieldClass}
                  />
                  <span className="mt-1.5 block font-normal text-ink-muted">
                    {model?.provider === providerId && model.keyPresent
                      ? "A provider key is already saved. Leave this blank to keep it."
                      : `Required for ${providerLabel(providerId)}.`}
                  </span>
                </label>
                <details className="mt-4 text-[12.5px] text-ink-muted">
                  <summary className="cursor-pointer font-medium text-ink">Custom provider URL</summary>
                  <label className="mt-3 block">
                    Base URL
                    <input
                      type="url"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder="https://api.example.com/v1"
                      autoComplete="off"
                      spellCheck={false}
                      className={fieldClass}
                    />
                    <span className="mt-1.5 block">Leave this empty for the provider default.</span>
                  </label>
                </details>
              </>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={
                  locked ||
                  !modelId.trim() ||
                  (!apiKey.trim() && !(model?.provider === providerId && model.keyPresent))
                }
                className={primaryButton}
              >
                {busy === "model" ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <Check size={14} />}
                Connect and check
              </button>
              <button type="button" onClick={closeModelSheet} disabled={busy === "model"} className={secondaryButton}>
                Cancel
              </button>
            </div>
          </div>
        </form>
      ) : null}
    </section>
  );
}
