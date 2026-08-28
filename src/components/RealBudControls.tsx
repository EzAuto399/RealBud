import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Loader2, Monitor, RefreshCw, Settings2, ShieldCheck } from "lucide-react";

import type { ModelUsageSummary, WorkRoutingPlan, WorkRoutingPreference } from "@shared/contracts";
import { readAskWorkRoutingPlan } from "@shared/ask-actions";
import { cn } from "@/lib/cn";
import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { api, type HermesStatus } from "@/state/store";

type ControlSection = "general" | "usage" | "updates";

const CONTROL_SECTIONS: ReadonlyArray<{ id: ControlSection; label: string; icon: typeof Settings2 }> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "usage", label: "Usage & costs", icon: Activity },
  { id: "updates", label: "Updates", icon: RefreshCw },
];

const WORK_METHOD_OPTIONS: ReadonlyArray<{
  value: WorkRoutingPreference;
  label: string;
  detail: string;
  recommended?: boolean;
}> = [
  {
    value: "auto",
    label: "Automatic",
    detail: "Choose the lowest-risk ready method for each job and keep work local when that is enough.",
    recommended: true,
  },
  {
    value: "local-standard",
    label: "Steady on this Mac",
    detail: "Use one local lane. Independent browser work stays serial and uses the fewest device resources.",
  },
  {
    value: "local-accelerated",
    label: "Faster on this Mac",
    detail: "Use up to two independent local lanes only when this Mac, the adapter and separate accounts support it.",
  },
  {
    value: "cloud-accelerated",
    label: "Cloud when connected",
    detail: "Use approved remote lanes when ready; otherwise fall back to this Mac without dropping the work.",
  },
];

function StatePill({ tone = "neutral", children }: { tone?: "good" | "attention" | "neutral"; children: React.ReactNode }) {
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10.5px] font-medium",
      tone === "good"
        ? "border-agency/30 bg-selected text-agency"
        : tone === "attention"
          ? "border-hold/35 bg-hold/10 text-hold"
          : "border-line bg-paper text-ink-muted",
    )}>
      {children}
    </span>
  );
}

function ControlRow({
  icon,
  title,
  detail,
  status,
  tone,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  status: string;
  tone?: "good" | "attention" | "neutral";
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-wrap items-start gap-3 py-3.5 first:pt-0 last:pb-0">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded border border-line bg-paper text-agency">{icon}</span>
      <div className="min-w-[14rem] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-[13.5px] font-semibold text-ink">{title}</h4>
          <StatePill tone={tone}>{status}</StatePill>
        </div>
        <p className="mt-1 max-w-[46rem] text-[12px] leading-relaxed text-ink-muted">{detail}</p>
      </div>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="pm-control pm-tactile rounded border border-line bg-sheet px-3 text-[12px] font-semibold text-ink hover:border-agency/60 hover:bg-selected/45"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function WorkPreferenceControl({
  plan,
  value,
  saving = false,
  error = "",
  onChange,
}: {
  plan?: WorkRoutingPlan | null;
  value: WorkRoutingPreference;
  saving?: boolean;
  error?: string;
  onChange?: (value: WorkRoutingPreference) => void;
}) {
  const disabled = !plan || saving || !onChange;
  const status = saving
    ? "Saving"
    : error
      ? "Retry needed"
      : plan?.preferenceConfigured
        ? "Saved"
        : "Automatic default";
  return (
    <fieldset className="mt-4 border border-line bg-paper px-3.5 py-3" aria-describedby="work-method-detail work-method-boundary">
      <legend className="text-[13px] font-semibold text-ink">How Bud should run work</legend>
      <div className="mt-0.5 flex flex-wrap items-start justify-between gap-2">
        <p id="work-method-detail" className="max-w-[46rem] text-[11.5px] leading-relaxed text-ink-muted">
          Choose once; RealBud remembers it for future route plans. You can change it here at any time.
        </p>
        <StatePill tone={error ? "attention" : plan ? "good" : "neutral"}>{status}</StatePill>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {WORK_METHOD_OPTIONS.map((option) => {
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              className={cn(
                "flex min-w-0 gap-2.5 rounded border px-3 py-2.5 transition-colors",
                selected ? "border-agency/60 bg-selected/55" : "border-line bg-sheet",
                disabled ? "cursor-default opacity-65" : "cursor-pointer hover:border-agency/50 hover:bg-selected/30",
              )}
            >
              <input
                type="radio"
                name="realbud-work-preference"
                value={option.value}
                checked={selected}
                disabled={disabled}
                onChange={() => onChange?.(option.value)}
                className="mt-0.5 size-4 shrink-0 accent-agency"
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                  {option.label}
                  {option.recommended ? <span className="text-[10px] font-medium text-agency">Recommended</span> : null}
                </span>
                <span className="mt-0.5 block text-[10.75px] leading-relaxed text-ink-muted">{option.detail}</span>
              </span>
            </label>
          );
        })}
      </div>
      {error ? <p role="alert" className="mt-2 text-[11.5px] text-hold">{error}</p> : null}
      <p id="work-method-boundary" className="mt-2 text-[10.5px] leading-relaxed text-ink-muted">
        This preference never connects an account, reads a personal browser profile, enables a missing route, sends, pays or approves automatically.
      </p>
    </fieldset>
  );
}

export function GeneralControlPanel({
  bookTimezone,
  deviceTimezone,
  timezonePaused,
  workPlan,
  workPlanError,
  workPreference = "auto",
  workPreferenceSaving = false,
  workPreferenceError = "",
  onWorkPreferenceChange,
  onOpenComputerUse,
}: {
  bookTimezone: string | null;
  deviceTimezone: string;
  timezonePaused: boolean;
  workPlan?: WorkRoutingPlan | null;
  workPlanError?: string;
  workPreference?: WorkRoutingPreference;
  workPreferenceSaving?: boolean;
  workPreferenceError?: string;
  onWorkPreferenceChange?: (value: WorkRoutingPreference) => void;
  onOpenComputerUse: () => void;
}) {
  const clockMatched = Boolean(bookTimezone) && !timezonePaused && bookTimezone === deviceTimezone;
  const structured = workPlan?.lanes.find((item) => item.kind === "structured-batch");
  const browser = workPlan?.lanes.find((item) => item.kind === "scripted-browser" || item.kind === "isolated-browser" || item.kind === "remote-browser");
  const gated = Boolean(workPlan?.lanes.some((item) => item.itemCount > 0 && item.state === "gated"));
  const routeStatus = workPlanError
    ? "Check needed"
    : workPlan
      ? workPlan.selectedMode === "local-standard"
        ? "Local standard"
        : workPlan.selectedMode === "local-accelerated"
          ? "Local accelerated"
          : "Cloud accelerated"
      : "Checking";
  const routeDetail = workPlanError
    ? `${workPlanError} Existing Desk work is unchanged; local standard remains the safe fallback.`
    : workPlan
      ? [
          structured
            ? `${structured.itemCount} propert${structured.itemCount === 1 ? "y record is" : "y records are"} processed as ${structured.batchCount === 1 ? "one local batch" : `${structured.batchCount} local batches`}.`
            : "There is no portfolio batch waiting.",
          browser
            ? browser.state === "ready"
              ? `${browser.itemCount} browser record${browser.itemCount === 1 ? " uses" : "s use"} ${browser.concurrency} isolated lane${browser.concurrency === 1 ? "" : "s"}; one account always stays serial.`
              : `${browser.itemCount} browser record${browser.itemCount === 1 ? " is" : "s are"} held until its typed private-browser adapter is ready.`
            : null,
          workPlan.fallbackReasons[0] ?? null,
          workPlan.estimate.detail,
          "Cloud is optional; it can shorten independent work but never unlock a missing outcome.",
        ].filter(Boolean).join(" ")
      : "Reading the current book and available RealBud-owned routes. No personal browser or personal worker profile is inspected.";
  return (
    <section aria-labelledby="realbud-general-heading">
      <h3 id="realbud-general-heading" className="text-[15px] font-semibold text-ink">General</h3>
      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">The operating rules that apply to this one Bud and this local book.</p>
      <div className="mt-3 divide-y divide-line">
        <ControlRow
          icon={<Clock3 size={16} />}
          title="Operating timezone"
          status={timezonePaused ? "Schedule paused" : clockMatched ? "Auto-detected" : bookTimezone ? "Book clock" : "Loading"}
          tone={timezonePaused ? "attention" : bookTimezone ? "good" : "neutral"}
          detail={bookTimezone
            ? timezonePaused
              ? `The book uses ${bookTimezone}, but this device reports ${deviceTimezone}. Scheduled work stays paused until the host timezone is restored; RealBud will not reinterpret old clocks.`
              : `${bookTimezone}. Schedule uses the book clock and Australian local wall time; daylight-saving changes are resolved by the named timezone.`
            : `Waiting for Desk to report its clock. This device currently reports ${deviceTimezone}.`}
        />
        <ControlRow
          icon={<ShieldCheck size={16} />}
          title="Approval boundary"
          status="Manual Allow · locked"
          tone="good"
          detail="Bud may check admitted sources, prepare work and queue proposals. Every consequential change still needs the exact manual Allow; RealBud has no automatic-approval rule or unattended-send mode."
        />
        <ControlRow
          icon={<Monitor size={16} />}
          title="Local work routing"
          status={routeStatus}
          tone={workPlanError || gated ? "attention" : workPlan ? "good" : "neutral"}
          detail={routeDetail}
          action={{ label: "Open Connections", onClick: onOpenComputerUse }}
        />
      </div>
      <WorkPreferenceControl
        plan={workPlan}
        value={workPreference}
        saving={workPreferenceSaving}
        error={workPreferenceError}
        onChange={onWorkPreferenceChange}
      />
    </section>
  );
}

function tokenCount(value: number): string {
  return new Intl.NumberFormat("en-AU", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function localDate(value: number | null): string {
  if (!value) return "No model turn recorded";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function UsageControlPanel({
  usage,
  loading,
  error,
  onRefresh,
}: {
  usage: ModelUsageSummary | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  return (
    <section aria-labelledby="realbud-usage-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="realbud-usage-heading" className="text-[15px] font-semibold text-ink">Usage & costs</h3>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">A rolling seven-day local meter for Bud—not a provider invoice.</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="pm-control pm-tactile inline-flex items-center gap-1.5 rounded border border-line px-3 text-[12px] font-semibold text-ink hover:bg-selected/45 disabled:opacity-45"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : undefined} /> Refresh
        </button>
      </div>

      {loading && !usage ? (
        <div role="status" className="mt-4 flex items-center gap-2 border border-line bg-paper px-4 py-5 text-[12.5px] text-ink-muted">
          <Loader2 size={15} className="animate-spin" /> Loading the private usage meter…
        </div>
      ) : error && !usage ? (
        <div role="alert" className="mt-4 border border-hold/40 bg-hold/10 px-4 py-4 text-[12.5px] text-hold">
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle size={15} /> Usage unavailable</div>
          <p className="mt-1 text-ink-muted">{error}</p>
        </div>
      ) : usage ? (
        <>
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              { label: "Completed turns", value: String(usage.completedTurns), detail: `${usage.successfulTurns} completed · ${usage.failedTurns} failed` },
              { label: "Input tokens", value: usage.tokenReportedTurns ? tokenCount(usage.inputTokens) : "—", detail: `${usage.tokenReportedTurns}/${usage.completedTurns} turns reported tokens` },
              { label: "Output tokens", value: usage.tokenReportedTurns ? tokenCount(usage.outputTokens) : "—", detail: usage.lastModel ?? "No reported model yet" },
            ].map((item) => (
              <div key={item.label} className="border border-line bg-paper px-3.5 py-3">
                <div className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-ink-muted">{item.label}</div>
                <div className="mt-1 text-[20px] font-semibold tabular-nums text-ink">{item.value}</div>
                <div className="mt-0.5 min-h-7 break-words text-[10.5px] leading-snug text-ink-muted">{item.detail}</div>
              </div>
            ))}
          </div>

          <div className="mt-3 divide-y divide-line border border-line bg-paper px-4">
            <div className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div>
                <div className="text-[12.5px] font-semibold text-ink">Provider spend</div>
                <p className="mt-0.5 text-[11.5px] text-ink-muted">Provider billing and spending limits remain authoritative in the PM's provider account.</p>
              </div>
              <StatePill tone={usage.costUsd == null ? "neutral" : "good"}>
                {usage.costUsd == null ? "Not reported" : `$${usage.costUsd.toFixed(4)} USD reported`}
              </StatePill>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 py-3 text-[11.5px] text-ink-muted">
              <span>Last activity: {localDate(usage.lastUsedAt)}</span>
              <span>{usage.lastProvider ?? "No provider recorded"}</span>
            </div>
          </div>

          <p role={usage.storage === "attention" ? "alert" : "status"} className={cn(
            "mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed",
            usage.storage === "attention" ? "text-hold" : "text-ink-muted",
          )}>
            {usage.storage === "attention" ? <AlertTriangle size={13} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-agency" />}
            {usage.detail} RealBud never estimates missing spend or changes a provider limit.
          </p>
        </>
      ) : null}

      <div className="mt-4 border border-line bg-paper" aria-labelledby="realbud-cost-boundaries-heading">
        <div className="border-b border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id="realbud-cost-boundaries-heading" className="text-[13px] font-semibold text-ink">Cost boundaries</h4>
            <StatePill>Pricing not configured</StatePill>
          </div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">
            This build records truthful usage evidence; it has no checkout, subscription or RealBud usage charge.
          </p>
        </div>
        <div className="divide-y divide-line px-4">
          <div className="flex flex-wrap items-start justify-between gap-2 py-3">
            <div className="min-w-[14rem] flex-1">
              <div className="text-[12.5px] font-semibold text-ink">Your model provider</div>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">BYOK model use is billed by that provider. Its invoice and limits remain authoritative; RealBud never converts missing tokens into dollars.</p>
            </div>
            <StatePill tone="good">Provider-owned</StatePill>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-2 py-3">
            <div className="min-w-[14rem] flex-1">
              <div className="text-[12.5px] font-semibold text-ink">Local RealBud work</div>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">Book imports, deterministic checks and local routines are not represented as an opaque token bill in this build.</p>
            </div>
            <StatePill>No RealBud meter</StatePill>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-2 py-3">
            <div className="min-w-[14rem] flex-1">
              <div className="text-[12.5px] font-semibold text-ink">Optional cloud or browser acceleration</div>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">Not connected or charged in Demo. A future paid run must quote recognisable completed work—such as records checked or portal checks completed—and a cap before it starts.</p>
            </div>
            <StatePill>Not connected</StatePill>
          </div>
        </div>
      </div>
    </section>
  );
}

function appUpdateCopy(state: UpdaterState | null, available: boolean): { status: string; tone: "good" | "attention" | "neutral"; detail: string; action: string | null } {
  if (!available) return { status: "Installed app only", tone: "neutral", detail: "Source builds do not contact a release feed. The signed installed app owns update checks.", action: null };
  if (!state || state.status === "idle") return { status: "Ready to check", tone: "good", detail: "RealBud checks quietly and downloads only after you ask.", action: "Check for updates" };
  if (state.status === "checking") return { status: "Checking", tone: "neutral", detail: "Checking the signed release feed…", action: null };
  if (state.status === "available") return { status: `${state.version ?? "Update"} available`, tone: "attention", detail: "The update is available but has not been downloaded.", action: "Download" };
  if (state.status === "downloading") return { status: `Downloading ${Math.round(state.percent ?? 0)}%`, tone: "neutral", detail: "Download in progress. RealBud keeps the current version active.", action: null };
  if (state.status === "downloaded") return { status: `${state.version ?? "Update"} ready`, tone: "good", detail: "Restart when convenient to apply the downloaded signed update.", action: "Restart and install" };
  return { status: "Check needs attention", tone: "attention", detail: state.message ?? "The release feed could not be checked. Your current version stays active.", action: "Check again" };
}

export function UpdatesControlPanel({
  updaterAvailable,
  updaterState,
  worker,
  onAppUpdate,
  onOpenWorker,
}: {
  updaterAvailable: boolean;
  updaterState: UpdaterState | null;
  worker: HermesStatus | null;
  onAppUpdate: () => void;
  onOpenWorker: () => void;
}) {
  const app = appUpdateCopy(updaterState, updaterAvailable);
  const workerReady = Boolean(worker?.ready && worker.cli.matchesPin && worker.pack.approvalsManual);
  return (
    <section aria-labelledby="realbud-updates-heading">
      <h3 id="realbud-updates-heading" className="text-[15px] font-semibold text-ink">Updates</h3>
      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">RealBud and its private Bud runtime update independently; neither touches a personal Hermes installation.</p>
      <div className="mt-3 divide-y divide-line">
        <ControlRow
          icon={updaterState?.status === "checking" || updaterState?.status === "downloading" ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          title="RealBud app"
          status={app.status}
          tone={app.tone}
          detail={app.detail}
          action={app.action ? { label: app.action, onClick: onAppUpdate } : undefined}
        />
        <ControlRow
          icon={<ShieldCheck size={16} />}
          title="Bud worker"
          status={workerReady ? `Pinned ${worker?.pin.tag ?? "runtime"}` : "Needs attention"}
          tone={workerReady ? "good" : "attention"}
          detail={worker
            ? "Worker updates build and verify in the inactive private slot, switch atomically, and retain the previous runtime for rollback."
            : "Worker status has not loaded. Open Worker to check the private runtime without probing PATH or personal Hermes."}
          action={{ label: "Open Worker", onClick: onOpenWorker }}
        />
      </div>
    </section>
  );
}

export function RealBudControls({
  bookTimezone,
  deskRevision,
  timezonePaused,
  worker,
  onOpenWorker,
  onOpenComputerUse,
}: {
  bookTimezone: string | null;
  deskRevision?: number;
  timezonePaused: boolean;
  worker: HermesStatus | null;
  onOpenWorker: () => void;
  onOpenComputerUse: () => void;
}) {
  const [section, setSection] = useState<ControlSection>("general");
  const [usage, setUsage] = useState<ModelUsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState("");
  const [workPlan, setWorkPlan] = useState<WorkRoutingPlan | null>(null);
  const [workPlanError, setWorkPlanError] = useState("");
  const [workPreference, setWorkPreference] = useState<WorkRoutingPreference>("auto");
  const [workPreferenceSaving, setWorkPreferenceSaving] = useState(false);
  const [workPreferenceError, setWorkPreferenceError] = useState("");
  const usageBusy = useRef(false);
  const workPreferenceBusy = useRef(false);
  const workPlanRequest = useRef(0);
  const controlsMounted = useRef(true);
  const updaterState = useUpdaterState();
  const updater = window.ogb?.updater;
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown";

  const refreshUsage = useCallback(async () => {
    if (usageBusy.current) return;
    usageBusy.current = true;
    setUsageLoading(true);
    setUsageError("");
    try {
      const body = await api("/api/usage");
      setUsage(body.usage as ModelUsageSummary);
    } catch (cause) {
      setUsageError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      usageBusy.current = false;
      setUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

  const refreshWorkPlan = useCallback(async () => {
    const request = ++workPlanRequest.current;
    setWorkPlanError("");
    try {
      const body = await api("/api/work-routing");
      const plan = readAskWorkRoutingPlan(body.plan);
      if (!plan) {
        throw new Error("Local route status could not be read.");
      }
      if (!controlsMounted.current || request !== workPlanRequest.current || workPreferenceBusy.current) return;
      setWorkPlan(plan);
      setWorkPreference(plan.requestedMode);
    } catch (cause) {
      if (!controlsMounted.current || request !== workPlanRequest.current || workPreferenceBusy.current) return;
      setWorkPlan(null);
      setWorkPlanError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refreshWorkPlan();
    return () => { workPlanRequest.current += 1; };
  }, [deskRevision, refreshWorkPlan]);

  useEffect(() => {
    controlsMounted.current = true;
    return () => {
      controlsMounted.current = false;
      workPlanRequest.current += 1;
    };
  }, []);

  const saveWorkPreference = useCallback(async (preference: WorkRoutingPreference) => {
    if (!workPlan || workPreferenceBusy.current) return;
    const expectedPreference = workPlan.requestedMode;
    const expectedRevision = workPlan.preferenceRevision ?? 0;
    if (preference === expectedPreference && workPlan.preferenceConfigured) return;
    workPreferenceBusy.current = true;
    setWorkPreference(preference);
    setWorkPreferenceSaving(true);
    setWorkPreferenceError("");
    let failed = false;
    try {
      const body = await api("/api/work-routing/preference", {
        method: "PATCH",
        body: JSON.stringify({ preference, expectedPreference, expectedRevision }),
      });
      const plan = readAskWorkRoutingPlan(body.plan);
      if (!plan) {
        throw new Error("RealBud saved the choice but could not read the current route plan.");
      }
      if (!controlsMounted.current) return;
      setWorkPlan(plan);
      setWorkPreference(plan.requestedMode);
    } catch (cause) {
      failed = true;
      if (controlsMounted.current) {
        setWorkPreference(expectedPreference);
        setWorkPreferenceError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      workPreferenceBusy.current = false;
      if (controlsMounted.current) setWorkPreferenceSaving(false);
    }
    if (failed && controlsMounted.current) void refreshWorkPlan();
  }, [refreshWorkPlan, workPlan]);

  const runAppUpdate = () => {
    if (!updater) return;
    if (updaterState?.status === "available") void updater.download();
    else if (updaterState?.status === "downloaded") void updater.install();
    else void updater.check();
  };

  return (
    <section className="overflow-hidden border border-line bg-sheet" aria-labelledby="realbud-controls-heading">
      <div className="border-b border-line px-4 py-3.5">
        <h2 id="realbud-controls-heading" className="text-[15px] font-semibold text-ink">RealBud controls</h2>
        <p className="mt-0.5 max-w-[46rem] text-[12.5px] leading-relaxed text-ink-muted">Clock, fixed approval boundary, private usage and both update owners in one place.</p>
      </div>
      <div className="grid min-w-0 md:grid-cols-[10.5rem_minmax(0,1fr)]">
        <nav aria-label="RealBud control sections" className="flex gap-1 overflow-x-auto border-b border-line bg-paper p-2 md:flex-col md:border-b-0 md:border-r">
          {CONTROL_SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSection(id)}
              className={cn(
                "pm-control pm-tactile inline-flex shrink-0 items-center gap-2 rounded px-3 text-left text-[12.5px] font-medium md:w-full",
                section === id ? "bg-selected text-agency" : "text-ink-muted hover:bg-sheet hover:text-ink",
              )}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 px-4 py-4">
          {section === "general" ? (
            <GeneralControlPanel
              bookTimezone={bookTimezone}
              deviceTimezone={deviceTimezone}
              timezonePaused={timezonePaused}
              workPlan={workPlan}
              workPlanError={workPlanError}
              workPreference={workPreference}
              workPreferenceSaving={workPreferenceSaving}
              workPreferenceError={workPreferenceError}
              onWorkPreferenceChange={(preference) => void saveWorkPreference(preference)}
              onOpenComputerUse={onOpenComputerUse}
            />
          ) : section === "usage" ? (
            <UsageControlPanel usage={usage} loading={usageLoading} error={usageError} onRefresh={() => void refreshUsage()} />
          ) : (
            <UpdatesControlPanel
              updaterAvailable={Boolean(updater)}
              updaterState={updaterState}
              worker={worker}
              onAppUpdate={runAppUpdate}
              onOpenWorker={onOpenWorker}
            />
          )}
        </div>
      </div>
    </section>
  );
}
