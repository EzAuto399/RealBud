import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, User } from "lucide-react";

import { cn } from "@/lib/cn";
import { fmtDateTime, relativeAgo } from "@/lib/au";
import { activityLabel, activityResult, type ActivityEntry } from "@/lib/computer-activity";
import { sourceKindLabel } from "@/lib/hands-label";
import { morningBrief } from "@/lib/morning-brief";
import {
  AWAITING_REVIEW_COPY,
  isPortalSiteRule,
  latestSessionFor,
  nextRecipeStatus,
  PORTAL_JOB_PATH_COPY,
  portalRuleLabel,
  recipeNeedsPlanApproval,
  recipeSitesLine,
  recipeStatusChip,
  sessionSummaryLine,
} from "@/lib/portal-job";
import { sourceCheckCopy } from "@/lib/source-check";
import { attendedRunLabel, jobRunStatusChip, jobRunSummaryLine, latestAttendedFor, queuedAttended, runningAttended, safeJobRunDetail } from "@/lib/job-run";
import { PortalJobActions } from "./schedule/PortalJobActions";
import {
  CHANNEL_PLATFORM_LABEL,
  LIVE_CHANNEL_PLATFORMS,
  channelRowChip,
  channelStatusLine,
  readChannels,
  type ChannelPlatform,
  type ChannelStatus,
  type ChannelsState,
} from "@/lib/telegram-channel";
import { recipeClockRunnable, type JobRun, type PortalSession, type Recipe } from "@/lib/desk";
import { readLawWatch, type LawWatch } from "@/lib/law-watch";
import { api, useStore, type HermesStatus } from "@/state/store";
import { AdvancedDiagnostics, RecoveryNotice, StatusLabel, type StatusTone } from "./pm";
import { BudSetupCard } from "./BudSetupCard";
import { ApiKeyRow } from "./ApiKeys";
import { Card } from "./SettingsPrimitives";
import { ProfileFields } from "./SettingsModal";
import { GoLiveCard } from "./desk/GoLiveCard";
import { MorningBrief } from "./desk/MorningBrief";
import { LawWatchCard } from "./you/LawWatchCard";
import { OfficeCard } from "./you/OfficeCard";
import { BillingCard } from "./BillingCard";

function YouLoadLines({ label }: { label: string }) {
  return (
    <div className="space-y-2" role="status" aria-label={label}>
      <div className="h-3 w-[75%] max-w-[16rem] animate-pulse rounded bg-raised motion-reduce:animate-none" />
      <div className="h-3 w-[50%] max-w-[10rem] animate-pulse rounded bg-raised motion-reduce:animate-none" />
    </div>
  );
}

function configVersion(config: unknown): string | undefined {
  if (!config || typeof config !== "object" || !("version" in config)) return undefined;
  const version = (config as { version?: unknown }).version;
  return typeof version === "string" && version.trim() ? version : undefined;
}

function workerDiagnosticsText(hermes: HermesStatus | null | undefined, version?: string): string {
  const lines: string[] = [];
  if (version) lines.push(`version ${version}`);
  if (!hermes) {
    if (!lines.length) lines.push("worker status unavailable");
    return lines.join("\n");
  }
  lines.push(
    `worker ${hermes.cli.installed ? "installed" : "not installed"} · ${hermes.cli.matchesPin ? "matches supported build" : "does not match supported build"}`,
  );
  lines.push(
    `pack ${hermes.pack.installed ? "installed" : "missing"} · approvals ${hermes.pack.approvalsManual ? "manual" : "not manual"} · workroom ${hermes.pack.workroomReady ? "ready" : "needs repair"}`,
  );
  lines.push(`ready ${hermes.ready ? "yes" : "no"}`);
  if (hermes.detail) lines.push(hermes.detail);
  if (hermes.lastPing) lines.push(`lastPing ${fmtDateTime(hermes.lastPing.at)} · ${hermes.lastPing.ok ? "ok" : "miss"}`);
  if (hermes.lastTest) lines.push(`lastTest ${fmtDateTime(hermes.lastTest.at)} · ${hermes.lastTest.ok ? "ok" : "miss"}`);
  if (hermes.homeDir) lines.push(`data dir ${hermes.homeDir}`);
  if (hermes.profileDir) lines.push(`profile dir ${hermes.profileDir}`);
  return lines.join("\n");
}

function youHashTarget(hash: string): "you-worker" | "you-recovery" | "you-jobs" | "you-billing" | null {
  if (hash === "#you-worker" || hash === "#attach-model") return "you-worker";
  if (hash === "#you-billing") return "you-billing";
  if (hash === "#you-recovery") return "you-recovery";
  if (hash === "#you-jobs") return "you-jobs";
  return null;
}

export function YouPage() {
  const { state, dispatch, refreshHermes } = useStore();
  const [session, setSession] = useState<{ product?: boolean; nonProduction?: boolean } | null>(null);
  const [deskError, setDeskError] = useState("");
  const [agencyError, setAgencyError] = useState("");
  const [rules, setRules] = useState<Array<{
    id: string;
    key: string;
    label: string;
    surface?: string;
    origin?: string;
  }> | null>(null);
  const [rulesError, setRulesError] = useState("");
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [sessions, setSessions] = useState<PortalSession[]>([]);
  const [jobRuns, setJobRuns] = useState<JobRun[]>([]);
  const [jobsError, setJobsError] = useState("");
  const [channels, setChannels] = useState<ChannelsState | null>(null);
  const [channelsError, setChannelsError] = useState("");
  const [lawWatch, setLawWatch] = useState<LawWatch | null>(null);
  const [lawWatchError, setLawWatchError] = useState("");
  const [announce, setAnnounce] = useState("");
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const announceTimer = useRef<number | null>(null);

  const loadDesk = useCallback(() => {
    setDeskError("");
    void api("/api/desk")
      .then((snapshot) => dispatch({ type: "deskSnapshot", snapshot }))
      .catch((cause: unknown) => setDeskError(cause instanceof Error ? cause.message : String(cause)));
  }, [dispatch]);

  const loadRules = useCallback(() => {
    setRulesError("");
    void api("/api/rules")
      .then((body) => setRules(Array.isArray(body.rules) ? body.rules : []))
      .catch((cause: unknown) => setRulesError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const loadJobs = useCallback(() => {
    setJobsError("");
    void Promise.all([api("/api/recipes"), api("/api/portal-sessions"), api("/api/job-runs?limit=100")])
      .then(([recipesBody, sessionsBody, runsBody]) => {
        setRecipes(Array.isArray(recipesBody.recipes) ? recipesBody.recipes : []);
        setSessions(Array.isArray(sessionsBody.sessions) ? sessionsBody.sessions : []);
        setJobRuns(Array.isArray(runsBody.runs) ? runsBody.runs : []);
      })
      .catch((cause: unknown) => setJobsError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const loadChannels = useCallback(() => {
    setChannelsError("");
    void api("/api/channels")
      .then((body) => setChannels(readChannels(body)))
      .catch((cause: unknown) => setChannelsError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const loadLawWatch = useCallback(() => {
    setLawWatchError("");
    void api("/api/law-watch")
      .then((body) => setLawWatch(readLawWatch(body)))
      .catch((cause: unknown) => setLawWatchError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => {
    void api("/api/session")
      .then((body) => setSession(body))
      .catch(() => setSession(null));
    loadDesk();
    loadRules();
    loadJobs();
    loadChannels();
    loadLawWatch();
    void refreshHermes();
  }, [dispatch, loadChannels, loadDesk, loadJobs, loadLawWatch, loadRules, refreshHermes]);

  useEffect(() => {
    let frame = 0;
    const scrollToId = (id: string) => {
      const target = document.getElementById(id);
      const scroller = document.querySelector<HTMLElement>("[data-you-scroll]");
      if (!target || !scroller) return;
      const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({
        top,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    };
    const run = () => {
      const id = youHashTarget(location.hash);
      if (!id) return;
      // Both live inside the Advanced disclosure; open it before measuring.
      const insideAdvanced = id === "you-recovery" || id === "you-jobs";
      if (insideAdvanced && advancedRef.current) advancedRef.current.open = true;
      frame = window.requestAnimationFrame(() => {
        if (insideAdvanced) {
          frame = window.requestAnimationFrame(() => scrollToId(id));
          return;
        }
        scrollToId(id);
      });
    };
    run();
    window.addEventListener("hashchange", run);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", run);
    };
  }, []);

  useEffect(
    () => () => {
      if (announceTimer.current != null) window.clearTimeout(announceTimer.current);
    },
    [],
  );

  const desk = state.desk;
  const hermes = state.hermes;
  const recovery = desk?.recovery?.active;
  const agency = desk?.book?.agency;
  const timezone = agency?.timezone || desk?.timezone || "Australia/Sydney";
  const workerFirst = Boolean(hermes && !hermes.ready);

  const copyDiagnostics = () => {
    const text = workerDiagnosticsText(hermes, configVersion(state.config));
    void navigator.clipboard.writeText(text).then(
      () => {
        setAnnounce("Diagnostics copied");
        setDiagnosticsCopied(true);
        if (announceTimer.current != null) window.clearTimeout(announceTimer.current);
        announceTimer.current = window.setTimeout(() => {
          announceTimer.current = null;
          setDiagnosticsCopied(false);
        }, 2000);
      },
      () => {
        setAnnounce("Could not copy. Try again.");
      },
    );
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-paper">
      <header className="px-5 pb-3 pt-4">
        <div className="flex items-center gap-2.5">
          <User size={21} className="text-agency" />
          <h1 className="pm-screen-title text-ink">You</h1>
        </div>
        <p className="mt-1 max-w-[40rem] text-[12.5px] text-ink-secondary">
          This office, Bud, go-live, and phone. Jobs, rules, and engine internals sit under Advanced.
        </p>
      </header>
      <div data-you-scroll className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6">
        {session?.nonProduction && (
          <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-[13px] text-warning">
            Source-run key. This is not a production distribution. Agency data stays local.
          </div>
        )}
        <div className="sr-only" aria-live="polite">
          {announce}
        </div>
        {recovery && (
          <RecoveryNotice>
            Desk is in recovery. Writes, schedules and browser work are paused. The book was not replaced with Demo data.
          </RecoveryNotice>
        )}
        {workerFirst ? <BudSetupCard /> : null}
        {desk ? (
          <OfficeCard
            agencyName={agency?.name ?? ""}
            timezone={timezone}
            jurisdictions={agency?.jurisdictions ?? []}
            office={desk.book?.office}
            profileName={state.config?.profile?.name}
            onSave={(input) =>
              api(
                "/api/desk/agency",
                {
                  method: "PATCH",
                  body: JSON.stringify({ name: input.name, jurisdictions: input.jurisdictions, office: input.office }),
                },
                { timeoutMs: 15_000 },
              ).then((snapshot) => dispatch({ type: "deskSnapshot", snapshot }))
            }
          />
        ) : deskError ? (
          <Card title="This office">
            <p className="text-[12.5px] text-danger">{deskError}</p>
            <button
              type="button"
              onClick={loadDesk}
              className="mt-3 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised"
            >
              Retry
            </button>
          </Card>
        ) : (
          <Card title="This office" subtitle="Open Desk once to load the book." />
        )}
        {workerFirst ? null : <BudSetupCard />}
        <BillingCard />
        <Card
          title="Connected apps"
          subtitle="Save the private broker key once. Then tell Bud “connect Notion” or another app; Bud opens the provider sign-in directly."
        >
          <ApiKeyRow section="composio" />
          <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
            App passwords and provider tokens stay with the provider. Never paste them into Ask.
          </p>
        </Card>
        {desk ? (
          <GoLiveCard
            mode={desk.mode}
            agencyName={agency?.name ?? ""}
            workerReady={Boolean(hermes?.ready)}
            compact={desk.lastRunAt != null}
            onConnectExport={() => dispatch({ type: "showDesk", book: true })}
            attachWorkerLabel="Set up Bud"
            onAttachWorker={() => {
              const target = document.getElementById("you-worker");
              const scroller = document.querySelector<HTMLElement>("[data-you-scroll]");
              if (!target || !scroller) return;
              const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
              scroller.scrollTo({
                top,
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
              });
            }}
            onSaveAgency={(name) => {
              void api("/api/desk/agency", { method: "PATCH", body: JSON.stringify({ name }) }, { timeoutMs: 15_000 })
                .then((snapshot) => {
                  dispatch({ type: "deskSnapshot", snapshot });
                  setAgencyError("");
                })
                .catch((cause: unknown) => setAgencyError(cause instanceof Error ? cause.message : String(cause)));
            }}
          />
        ) : null}
        {agencyError ? <div className="text-[12.5px] text-danger">{agencyError}</div> : null}
        <div id="you-phone">
          <ChannelsCard channels={channels} error={channelsError} onChannels={setChannels} onRetry={loadChannels} />
        </div>
        <Card title="Profile" subtitle="Shown in the sidebar. Saved as you go.">
          <ProfileFields />
        </Card>
        {desk ? (
          <MorningBrief
            brief={morningBrief(desk)}
            timezone={timezone}
            onOpenAddress={() => dispatch({ type: "showDesk" })}
            interactive
          />
        ) : null}
        <details ref={advancedRef} className="rounded-lg border border-line bg-sheet open:pb-0">
          <summary className="cursor-pointer px-4 py-3 text-[14px] font-medium text-ink">
            Advanced — jobs, rules, recovery
          </summary>
          <div className="flex flex-col gap-4 border-t border-line px-4 py-4">
            <Card title="Bud's rules" subtitle="Previously saved standing permissions. New approvals can stay scoped to one task.">
              {rulesError ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[12.5px] text-danger">{rulesError}</p>
                  <button type="button" onClick={loadRules} className="text-[12px] text-agency hover:underline">
                    Retry
                  </button>
                </div>
              ) : null}
              {!rulesError && rules == null ? <YouLoadLines label="Loading rules" /> : null}
              {!rulesError && rules && rules.length === 0 ? (
                <p className="text-[13px] text-ink-secondary">
                  No standing rules. Allow for this task reduces repeat prompts for one run; 'Always allow reading on a site' saves a rule for that site only.
                </p>
              ) : null}
              {!rulesError && rules && rules.length > 0 ? (
                <ul className="text-[13px] text-ink">
                  {rules.map((rule) => (
                    <li key={rule.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1">
                      <span className="flex flex-wrap items-baseline gap-2">
                        {portalRuleLabel(rule)}
                        {isPortalSiteRule(rule) ? <StatusLabel tone="agency">Site rule</StatusLabel> : (
                          <span className="font-mono text-[11px] text-ink-muted">{rule.key}</span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                        onClick={() => {
                          void api(`/api/rules/${rule.id}`, { method: "DELETE" })
                            .then(() => loadRules())
                            .catch((cause: unknown) =>
                              setRulesError(cause instanceof Error ? cause.message : String(cause)),
                            );
                        }}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
            <LawWatchCard watch={lawWatch} error={lawWatchError} onWatch={setLawWatch} onError={setLawWatchError} />
            <div id="you-jobs">
              <BudJobsCard
                recipes={recipes}
                sessions={sessions}
                runs={jobRuns}
                error={jobsError}
                onRecipes={setRecipes}
                onSessions={setSessions}
                onRuns={setJobRuns}
                onError={setJobsError}
              />
            </div>
            <div id="you-recovery">
              <RecoveryKeyCard recoveryActive={Boolean(recovery)} />
            </div>
            <Card
              title="Sources"
              subtitle={
                desk
                  ? `${desk.mode === "demo" ? "Demo book" : "Live book"} · ${desk.timezone}`
                  : "Open Desk once to load the book."
              }
            >
              <ul className="text-[13px] text-ink-secondary">
                {(desk?.sources ?? []).map((source) => (
                  <li key={source.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1">
                    <span>
                      {source.label} · {sourceKindLabel(source.kind)}
                    </span>
                    <span className="text-[12px] text-ink-muted">
                      {sourceCheckCopy(source, hermes?.lastTest ?? null, (at) => fmtDateTime(at, timezone))}
                    </span>
                  </li>
                ))}
                {!desk?.sources?.length && <li>No sources yet.</li>}
              </ul>
            </Card>
            <Card title="Browser profile" subtitle="Dedicated ~/.realbud/chrome-profile. You sign in. Passwords and cookies never enter config, recipes, or Ask.">
              <div className="text-[13px] text-ink-secondary">
                Retention: {desk?.retentionDays ?? "not set"} days. Full captures stay off the event stream.
              </div>
              {recovery ? (
                <p className="mt-2 text-[13px] text-hold">Browser work is paused in recovery. Prepare is refused until you resume.</p>
              ) : (
                <p className="mt-2 text-[13px] text-ink-secondary">Handoffs stay case-scoped. You submit in the PMS.</p>
              )}
            </Card>
            <AdvancedDiagnostics>
              {hermes ? (
                <>
                  <div>pin {hermes.pin.product} / {hermes.pin.tag}</div>
                  <div>profile {hermes.pin.profile}</div>
                  <div>pack {hermes.pack.installed ? "installed" : "missing"} · workroom {hermes.pack.workroomReady ? "ready" : "needs repair"} · approvals {hermes.pack.approvalsManual ? "manual" : "not manual"}</div>
                  <div>private-workroom edits run automatically · sensitive and consequential steps still ask · scheduling stays on RealBud's clock</div>
                  <div>{hermes.detail}</div>
                </>
              ) : (
                <div>Engine status is not available yet.</div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2 font-sans">
                <button
                  type="button"
                  onClick={copyDiagnostics}
                  className="pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-raised"
                >
                  Copy diagnostics
                </button>
                {diagnosticsCopied ? <span className="text-[12px] text-agency">Copied</span> : null}
              </div>
            </AdvancedDiagnostics>
          </div>
        </details>
      </div>
    </main>
  );
}

function BudJobsCard({
  recipes,
  sessions,
  runs,
  error,
  onRecipes,
  onSessions,
  onRuns,
  onError,
}: {
  recipes: Recipe[] | null;
  sessions: PortalSession[];
  runs: JobRun[];
  error: string;
  onRecipes: (recipes: Recipe[]) => void;
  onSessions: (update: (prev: PortalSession[]) => PortalSession[]) => void;
  onRuns: (update: (prev: JobRun[]) => JobRun[]) => void;
  onError: (message: string) => void;
}) {
  const { dispatch } = useStore();
  const [runningId, setRunningId] = useState<string | null>(null);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [distillId, setDistillId] = useState<string | null>(null);
  const [distillNote, setDistillNote] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);

  useEffect(() => {
    void api("/api/computer-history")
      .then((body) => setActivity(Array.isArray(body.entries) ? body.entries.slice(0, 10) : []))
      .catch(() => setActivity([]));
  }, []);

  const attendedLive = Boolean(runningAttended(runs));
  useEffect(() => {
    if (!attendedLive) return;
    const id = window.setInterval(() => {
      void api("/api/job-runs?limit=100")
        .then((body: { runs?: JobRun[] }) => {
          if (Array.isArray(body.runs)) onRuns(() => body.runs!);
        })
        .catch(() => {});
    }, 3_000);
    return () => window.clearInterval(id);
  }, [attendedLive, onRuns]);

  const fail = (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause));

  const runShadow = (id: string) => {
    setRunningId(id);
    onError("");
    void api(`/api/recipes/${id}/run`, { method: "POST" })
      .then((body: { session?: PortalSession; run?: JobRun }) => {
        if (!body.session) throw new Error("Bud could not start that check.");
        const next = body.session;
        onSessions((prev) => [next, ...prev.filter((session) => session.id !== next.id)]);
        if (body.run) onRuns((prev) => [body.run!, ...prev.filter((run) => run.id !== body.run!.id)]);
      })
      .catch(fail)
      .finally(() => setRunningId(null));
  };

  const prepareNow = (id: string) => {
    setPreparingId(id);
    onError("");
    void api(`/api/recipes/${id}/prepare`, { method: "POST" })
      .then((body: { run?: JobRun }) => {
        if (!body.run) throw new Error("Bud did not return a job receipt.");
        const next = body.run;
        onRuns((prev) => [next, ...prev.filter((run) => run.id !== next.id)]);
      })
      .catch(fail)
      .finally(() => setPreparingId(null));
  };

  const patchStatus = (id: string, status: Recipe["status"]) => {
    onError("");
    void api(`/api/recipes/${id}`, { method: "PATCH", body: JSON.stringify({ status }) })
      .then((body) => onRecipes(Array.isArray(body.recipes) ? body.recipes : []))
      .catch(fail);
  };

  const approvePlan = (id: string) => {
    onError("");
    void api(`/api/recipes/${id}`, { method: "PATCH", body: JSON.stringify({ planApproved: true }) })
      .then((body) => onRecipes(Array.isArray(body.recipes) ? body.recipes : []))
      .catch(fail);
  };

  const remove = (id: string) => {
    onError("");
    void api(`/api/recipes/${id}`, { method: "DELETE" })
      .then((body) => onRecipes(Array.isArray(body.recipes) ? body.recipes : []))
      .catch(fail);
  };

  const tighten = (id: string) => {
    setDistillId(id);
    setDistillNote((notes) => {
      const next = { ...notes };
      delete next[id];
      return next;
    });
    void api(`/api/recipes/${id}/distill`, { method: "POST" })
      .then((body: { recipe?: Recipe }) => {
        if (!body.recipe) throw new Error("Bud could not tighten those steps.");
        if (recipes) {
          onRecipes(recipes.map((recipe) => (recipe.id === body.recipe!.id ? body.recipe! : recipe)));
        }
        setDistillNote((notes) => ({ ...notes, [id]: { ok: true, text: "Steps tightened from the last run" } }));
      })
      .catch((cause: unknown) => {
        setDistillNote((notes) => ({
          ...notes,
          [id]: { ok: false, text: cause instanceof Error ? cause.message : String(cause) },
        }));
      })
      .finally(() => setDistillId(null));
  };

  return (
    <Card title="Bud's jobs" subtitle="Built in Schedule from a plain-language outcome. First runs stay bounded and receipt-backed.">
      {error ? <p className="text-[12.5px] text-danger">{error}</p> : null}
      {!error && recipes == null ? <YouLoadLines label="Loading jobs" /> : null}
      {!error && recipes && recipes.length === 0 ? (
        <p className="text-[13px] text-ink-secondary">
          {PORTAL_JOB_PATH_COPY}
        </p>
      ) : null}
      {!error && recipes && recipes.length > 0 ? (
        <ul className="text-[13px] text-ink">
          {recipes.map((recipe) => {
            const chip = recipeStatusChip(recipe.status);
            const session = latestSessionFor(sessions, recipe.id);
            const latestRun = runs.find((run) => run.jobId === recipe.id);
            const runChip = latestRun ? jobRunStatusChip(latestRun.status) : null;
            const latestAttended = queuedAttended(runs, recipe.id) ?? latestAttendedFor(runs, recipe.id);
            const attendedChip = latestAttended ? attendedRunLabel(latestAttended) : null;
            const nextStatus = nextRecipeStatus(recipe.status);
            const needsPlan = recipeNeedsPlanApproval(recipe);
            const canPrepare = recipeClockRunnable(recipe);
            return (
              <li key={recipe.id} className="border-t border-line py-3 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="flex flex-wrap items-baseline gap-2">
                    {recipe.title}
                    <span className={cn("rounded px-2 py-0.5 text-[11px]", chip.className)}>{chip.label}</span>
                    {needsPlan ? (
                      <span className="rounded px-2 py-0.5 text-[11px] bg-hold/10 text-hold">Plan needs approval</span>
                    ) : null}
                    {attendedChip ? <StatusLabel tone={attendedChip.tone}>{attendedChip.label}</StatusLabel> : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-3">
                    {needsPlan ? (
                      <button
                        type="button"
                        className="pm-control rounded border border-line px-2 py-0.5 text-[12px] font-medium text-ink hover:bg-raised"
                        onClick={() => approvePlan(recipe.id)}
                      >
                        Approve plan
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={runningId === recipe.id}
                      className="inline-flex items-center gap-1 text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
                      onClick={() => runShadow(recipe.id)}
                    >
                      {runningId === recipe.id ? (
                        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
                      ) : null}
                      Rehearse (nothing is browsed)
                    </button>
                    {canPrepare ? (
                      <button
                        type="button"
                        disabled={preparingId === recipe.id}
                        className="inline-flex items-center gap-1 text-[12px] font-medium text-agency underline-offset-2 hover:underline disabled:opacity-40"
                        onClick={() => prepareNow(recipe.id)}
                      >
                        {preparingId === recipe.id ? (
                          <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
                        ) : null}
                        Prepare now
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={distillId === recipe.id}
                      className="inline-flex items-center gap-1 text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
                      onClick={() => tighten(recipe.id)}
                    >
                      {distillId === recipe.id ? (
                        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
                      ) : null}
                      Tighten steps
                    </button>
                    <button
                      type="button"
                      className="text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                      onClick={() => patchStatus(recipe.id, nextStatus)}
                    >
                      {recipe.status === "active" ? "Pause" : "Activate"}
                    </button>
                    <button
                      type="button"
                      className="text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                      onClick={() => remove(recipe.id)}
                    >
                      Delete
                    </button>
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-ink-muted">
                  {recipe.steps.length} {recipe.steps.length === 1 ? "step" : "steps"}
                </p>
                <PortalJobActions
                  recipe={recipe}
                  runs={runs}
                  onRecipe={(next) => {
                    if (recipes) {
                      onRecipes(recipes.map((item) => (item.id === next.id ? next : item)));
                    }
                  }}
                  onRun={(run) => onRuns((prev) => [run, ...prev.filter((item) => item.id !== run.id)])}
                  onShowAsk={() => dispatch({ type: "showAsk" })}
                />
                {distillNote[recipe.id] ? (
                  <p className={cn("mt-1 text-[12px]", distillNote[recipe.id].ok ? "text-ink-secondary" : "text-danger")}>
                    {distillNote[recipe.id].text}
                  </p>
                ) : null}
                {session ? (
                  <div className="mt-2">
                    <details>
                      <summary className="cursor-pointer text-[12px] text-ink-secondary">
                        {sessionSummaryLine(session)}
                      </summary>
                      {session.detail ? <p className="mt-1 text-[12px] text-ink-muted">{session.detail}</p> : null}
                      <ul className="mt-1 space-y-1 text-[12px] text-ink-muted">
                        {session.evidence.map((item, index) => (
                          <li key={`${item.at}-${index}`}>
                            {fmtDateTime(item.at)} · {item.note}
                          </li>
                        ))}
                      </ul>
                    </details>
                    {session.state === "awaiting-review" ? (
                      <p className="mt-1 text-[12px] text-hold">
                        {recipeSitesLine(session.allowedOrigins)}. {AWAITING_REVIEW_COPY}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {latestRun && runChip ? (
                  <details className="mt-2 rounded-lg border border-hairline/40 bg-inset/30 px-3 py-2">
                    <summary className="cursor-pointer text-[12px] text-ink-secondary">
                      Latest receipt · {jobRunSummaryLine(latestRun)} · {runChip.label}
                    </summary>
                    <p className="mt-1 text-[12px] text-ink-muted">{safeJobRunDetail(latestRun.detail)}</p>
                    {latestRun.status === "awaiting-approval" ? (
                      <p className="mt-1 text-[12px] font-medium text-hold">
                        Held for you. Nothing was sent, submitted, or paid.
                      </p>
                    ) : null}
                    {latestRun.approvalRequests.length ? (
                      <ul className="mt-1 list-disc space-y-1 pl-5 text-[12px] text-hold">
                        {latestRun.approvalRequests.map((request, index) => (
                          <li key={`${index}-${request}`}>{request}</li>
                        ))}
                      </ul>
                    ) : null}
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <details className="mt-3">
        <summary className="cursor-pointer text-[12px] text-ink-secondary">Recent activity</summary>
        {activity && activity.length === 0 ? (
          <p className="mt-1 text-[12px] text-ink-muted">Nothing recorded yet. Ask turns and tools show up here.</p>
        ) : null}
        {activity && activity.length > 0 ? (
          <ul className="mt-1 space-y-1 text-[12px] text-ink-muted">
            {activity.map((entry) => (
              <li key={entry.id}>
                {activityLabel(entry.kind, entry.name)} · {activityResult(entry.ok)} · {relativeAgo(entry.at)}
              </li>
            ))}
          </ul>
        ) : null}
      </details>
    </Card>
  );
}

const CHANNEL_SETUP: Record<
  ChannelPlatform,
  { explainer: string; tokenLabel: string; connectLabel: string; appTokenLabel?: string }
> = {
  telegram: {
    explainer: "Paste a BotFather token, then message the bot once to pair.",
    tokenLabel: "Bot token from @BotFather",
    connectLabel: "Connect",
  },
  discord: {
    explainer: "Paste a Discord bot token (Message Content Intent on), then DM once to pair.",
    tokenLabel: "Bot token from the Discord developer portal",
    connectLabel: "Connect",
  },
  slack: {
    explainer:
      "Paste a Slack bot token (xoxb). Optional app-level token (xapp) turns on Socket Mode; otherwise RealBud polls.",
    tokenLabel: "Bot token (xoxb-…)",
    appTokenLabel: "App-level token (xapp-…) — optional",
    connectLabel: "Connect",
  },
};

const LATER_CHANNELS: Array<{ name: string; reason: string }> = [
  { name: "WhatsApp", reason: "Needs a named office and a public relay — local Mac has no ingress alone." },
  { name: "Microsoft Teams", reason: "Bot Framework wiring comes after Slack proves itself." },
  { name: "SMS", reason: "Needs a provider account (Twilio or similar) — not local-first yet." },
];

function ChannelsCard({
  channels,
  error,
  onChannels,
  onRetry,
}: {
  channels: ChannelsState | null;
  error: string;
  onChannels: (channels: ChannelsState) => void;
  onRetry?: () => void;
}) {
  const [expanded, setExpanded] = useState<ChannelPlatform | null>(null);

  return (
    <Card title="Phone" subtitle="Allow courtesy wording from your phone. Notices stay on Desk.">
      <p className="mb-2 text-[12px] text-ink-muted">
        Same Bud, same book. Pocket stays off until this office is named.
      </p>
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[12.5px] text-danger">{error}</p>
          {onRetry ? (
            <button type="button" onClick={onRetry} className="text-[12px] text-agency hover:underline">
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {!error && channels == null ? <YouLoadLines label="Loading phone" /> : null}
      {!error && channels ? (
        <div className="flex flex-col">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">Available</p>
          <ul className="divide-y divide-line border-y border-line">
            {LIVE_CHANNEL_PLATFORMS.map((platform) => (
              <li key={platform}>
                <ChannelRow
                  platform={platform}
                  status={channels[platform]}
                  expanded={expanded === platform}
                  onExpand={() => setExpanded((cur) => (cur === platform ? null : platform))}
                  onChannels={onChannels}
                />
              </li>
            ))}
          </ul>
          <p className="mb-1 mt-3 text-[11px] font-medium uppercase tracking-wide text-ink-muted">Later</p>
          <ul className="divide-y divide-line border-y border-line">
            {LATER_CHANNELS.map((row) => (
              <li key={row.name} className="flex items-baseline justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px] text-ink-muted">{row.name}</div>
                  <p className="mt-0.5 text-[11.5px] text-ink-muted">{row.reason}</p>
                </div>
                <StatusLabel tone="muted">Later</StatusLabel>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function channelTone(status: ChannelStatus): StatusTone {
  if (!status.connected) return "muted";
  if (!status.paired) return "hold";
  return "agency";
}

function ChannelRow({
  platform,
  status,
  expanded,
  onExpand,
  onChannels,
}: {
  platform: ChannelPlatform;
  status: ChannelStatus;
  expanded: boolean;
  onExpand: () => void;
  onChannels: (channels: ChannelsState) => void;
}) {
  const copy = CHANNEL_SETUP[platform];
  const [token, setToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [actionError, setActionError] = useState("");

  const fail = (cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause));

  const connect = () => {
    const botToken = token.trim();
    if (!botToken || busy) return;
    setBusy("connect");
    setActionError("");
    const body: { botToken: string; appToken?: string } = { botToken };
    if (platform === "slack" && appToken.trim()) body.appToken = appToken.trim();
    void api(`/api/channels/${platform}`, { method: "POST", body: JSON.stringify(body) }, { timeoutMs: 15_000 })
      .then((payload) => {
        setToken("");
        setAppToken("");
        onChannels(readChannels(payload));
        onExpand();
      })
      .catch(fail)
      .finally(() => setBusy(null));
  };

  const disconnect = () => {
    if (busy) return;
    setBusy("disconnect");
    setActionError("");
    void api(`/api/channels/${platform}`, { method: "DELETE" }, { timeoutMs: 15_000 })
      .then((payload) => onChannels(readChannels(payload)))
      .catch(fail)
      .finally(() => setBusy(null));
  };

  return (
    <section className="py-2.5" aria-label={CHANNEL_PLATFORM_LABEL[platform]}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-ink">{CHANNEL_PLATFORM_LABEL[platform]}</span>
          <StatusLabel tone={channelTone(status)}>{channelRowChip(status)}</StatusLabel>
        </div>
        {status.connected ? (
          <button
            type="button"
            disabled={busy !== null}
            className="text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
            onClick={disconnect}
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onExpand}
            className="text-[12px] font-medium text-agency hover:underline"
          >
            {expanded ? "Hide" : "Connect"}
          </button>
        )}
      </div>
      {status.connected ? (
        <p className="mt-1 text-[12px] text-ink-muted">
          @{status.botUsername} · {channelStatusLine(platform, status)}
        </p>
      ) : null}
      {!status.connected && expanded ? (
        <form
          className="mt-2 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <p className="text-[12px] text-ink-muted">{copy.explainer}</p>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={copy.tokenLabel}
            aria-label={copy.tokenLabel}
            className="pm-control w-full rounded border border-line bg-sheet px-3 text-[13px] text-ink placeholder:text-ink-muted focus:border-agency"
          />
          {copy.appTokenLabel ? (
            <input
              type="password"
              value={appToken}
              onChange={(event) => setAppToken(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={copy.appTokenLabel}
              aria-label={copy.appTokenLabel}
              className="pm-control w-full rounded border border-line bg-sheet px-3 text-[13px] text-ink placeholder:text-ink-muted focus:border-agency"
            />
          ) : null}
          <button
            type="submit"
            disabled={busy !== null || !token.trim()}
            className="pm-control inline-flex items-center justify-center gap-2 rounded bg-agency px-3.5 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
          >
            {busy === "connect" ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : null}
            {copy.connectLabel}
          </button>
        </form>
      ) : null}
      {actionError ? <p className="mt-1.5 text-[12px] text-danger">{actionError}</p> : null}
    </section>
  );
}

function RecoveryKeyCard({ recoveryActive }: { recoveryActive: boolean }) {
  const { dispatch } = useStore();
  const [hex, setHex] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(() => localStorage.getItem("realbud.recovery-key-saved") === "1");
  const [unlockKey, setUnlockKey] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockMsg, setUnlockMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [startAgainOpen, setStartAgainOpen] = useState(false);
  const [startAgainConfirm, setStartAgainConfirm] = useState("");
  const [startAgainBusy, setStartAgainBusy] = useState(false);
  const [startAgainMsg, setStartAgainMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");

  const reveal = async () => {
    setError("");
    try {
      const res = await api("/api/desk/recovery-key");
      setHex(res.hex ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const unlock = async () => {
    setUnlockBusy(true);
    setUnlockMsg(null);
    setError("");
    try {
      const res = await api("/api/desk/recovery/unlock", { method: "POST", body: JSON.stringify({ key: unlockKey }) });
      const snapshot = await api("/api/desk");
      dispatch({ type: "deskSnapshot", snapshot });
      setUnlockMsg({ ok: true, text: res.message ?? "Book restored." });
    } catch (cause) {
      setUnlockMsg({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setUnlockBusy(false);
    }
  };

  const startAgain = async () => {
    setStartAgainBusy(true);
    setStartAgainMsg(null);
    setError("");
    try {
      const res = await api("/api/desk/recovery/start-again", {
        method: "POST",
        body: JSON.stringify({ confirmation: startAgainConfirm }),
      });
      setStartAgainMsg({ ok: true, text: res.message ?? "Locked book preserved. Restart RealBud to begin again." });
    } catch (cause) {
      setStartAgainMsg({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setStartAgainBusy(false);
    }
  };

  return (
    <Card
      title="Recovery key"
      subtitle="Your book is encrypted. This key is the only way to open it if the key file is ever lost. Save it somewhere safe."
    >
      {saved && !hex ? (
        <div className="text-[13px] text-ink-secondary">
          Saved ✓{" "}
          <button className="text-accent hover:underline" onClick={() => { setSaved(false); localStorage.removeItem("realbud.recovery-key-saved"); }}>
            Show it again
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {hex ? (
            <>
              <code className="break-all rounded-lg border border-line bg-sheet px-3 py-2 font-mono text-[12px] text-ink">{hex}</code>
              <div className="flex gap-2">
                <button
                  onClick={() => { void navigator.clipboard.writeText(hex); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised"
                >
                  {copied ? "Copied" : "Copy key"}
                </button>
                <button
                  onClick={() => { localStorage.setItem("realbud.recovery-key-saved", "1"); setSaved(true); setHex(null); }}
                  className="rounded-lg bg-agency px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110"
                >
                  I've saved it
                </button>
              </div>
            </>
          ) : (
            <button onClick={() => void reveal()} className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised">
              Reveal recovery key
            </button>
          )}
        </div>
      )}
      {recoveryActive && (
        <div className="mt-3 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2.5">
          <div className="text-[13px] font-medium text-ink">Book locked</div>
          <p className="mt-0.5 text-[12px] text-ink-muted">Paste your recovery key to restore the quarantined book. RealBud restarts afterwards.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={unlockKey}
              onChange={(e) => setUnlockKey(e.target.value)}
              placeholder="64-character recovery key"
              aria-label="Recovery key"
              className="min-w-[16rem] flex-1 rounded-lg border border-hairline/40 bg-panel px-2 py-1.5 font-mono text-[12px] text-ink"
            />
            <button
              onClick={() => void unlock()}
              disabled={unlockBusy || unlockKey.trim().length === 0}
              className="rounded-lg bg-agency px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-40"
            >
              {unlockBusy ? "Unlocking…" : "Unlock book"}
            </button>
          </div>
          {unlockMsg && (
            <div className={cn("mt-2 text-[12.5px]", unlockMsg.ok ? "text-success" : "text-danger")}>{unlockMsg.text}</div>
          )}
          <div className="mt-3 border-t border-warning/20 pt-3">
            <button
              type="button"
              disabled={unlockBusy || startAgainBusy}
              onClick={() => setStartAgainOpen((value) => !value)}
              className="text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
            >
              I don&apos;t have the recovery key
            </button>
            {startAgainOpen ? (
              <div className="mt-2 rounded-lg border border-danger/25 bg-danger/5 p-3">
                <p className="text-[12px] text-ink-secondary">
                  Start a new book only if this one cannot be recovered. The locked encrypted files stay preserved on this Mac; RealBud will not delete or overwrite them.
                </p>
                <label className="mt-2 block text-[12px] text-ink-muted">
                  Type START AGAIN to confirm
                  <input
                    value={startAgainConfirm}
                    onChange={(event) => setStartAgainConfirm(event.target.value)}
                    disabled={startAgainBusy}
                    className="mt-1 w-full rounded-lg border border-danger/30 bg-panel px-2 py-1.5 font-mono text-[12px] text-ink disabled:opacity-50"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void startAgain()}
                  disabled={startAgainBusy || startAgainConfirm !== "START AGAIN"}
                  className="mt-2 rounded-lg bg-danger px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-40"
                >
                  {startAgainBusy ? "Preserving locked book…" : "Preserve locked book and start again"}
                </button>
                {startAgainMsg ? (
                  <div className={cn("mt-2 text-[12.5px]", startAgainMsg.ok ? "text-success" : "text-danger")}>{startAgainMsg.text}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
      {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}
    </Card>
  );
}
