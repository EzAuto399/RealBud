import { WebsiteLinkCard } from "./you/WebsiteLinkCard";
import { AiUsageCard } from "./you/AiUsageCard";
import { RemoteApproversCard } from "./you/RemoteApproversCard";
import { RemoteWorkCard } from "./you/RemoteWorkCard";
import { WebsiteRequestsCard } from "./you/WebsiteRequestsCard";
import { BrowserCard } from "./you/BrowserCard";
import { usePhoneConnections } from "@/lib/phone-connections";
import { useServiceAdminAccess } from "@/lib/use-service-admin-access";
import { useWorkspaceScroll } from "@/lib/workspace-view-state";
import { ChannelMark } from "./ChannelMark";
import { CopyButton } from "./CopyButton";
import { scrollYouTarget, youHashTarget } from "@/lib/you-navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, User } from "lucide-react";

import { cn } from "@/lib/cn";
import { fmtDateTime, relativeAgo } from "@/lib/au";
import { activityLabel, activityResult, type ActivityEntry } from "@/lib/computer-activity";
import { sourceKindLabel } from "@/lib/hands-label";
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
import { attendedRunLabel, jobRunStatusChip, jobRunSummaryLine, safeJobRunDetail } from "@/lib/job-run";
import { PortalJobActions } from "./schedule/PortalJobActions";
import { WorkflowPacksCard } from "./schedule/WorkflowPacksCard";
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
import { type JobRun, type PortalSession, type Recipe } from "@/lib/desk";
import { readLawWatch, type LawWatch } from "@/lib/law-watch";
import { api, useStore, type HermesStatus } from "@/state/store";
import { AdvancedDiagnostics, RecoveryNotice, StatusLabel, type StatusTone } from "./pm";
import { BudSetupCard } from "./BudSetupCard";
import { MemoryReviewPanel } from './MemoryReviewPanel';
import { ConnectedAppsCard } from "./ConnectedAppsCard";
import { ServiceAdministration } from "./ServiceAdministration";
import { ServiceStatusCard } from "./ServiceStatusCard";
import { CompanySetupCard } from "./CompanySetupCard";
import { Card } from "./SettingsPrimitives";
import { ProfileFields } from "./SettingsModal";
import { GoLiveCard } from "./desk/GoLiveCard";
import { coerceOffice } from "../../shared/office";
import { LawWatchCard } from "./you/LawWatchCard";
import { OfficeCard } from "./you/OfficeCard";
import { UnattendedWorkCard } from "./you/UnattendedWorkCard";
import { SupportCard } from "./you/SupportCard";
import { PrivateWorkspaceBackup } from "./PrivateWorkspaceBackup";

function YouLoadLines({ label }: { label: string }) {
  return (
    <div className="space-y-2" role="status" aria-label={label}>
      <div className="h-3 w-[75%] max-w-[16rem] animate-pulse rounded bg-raised motion-reduce:animate-none" />
      <div className="h-3 w-[50%] max-w-[10rem] animate-pulse rounded bg-raised motion-reduce:animate-none" />
    </div>
  );
}

const YOU_JUMP_LINKS = [
  { id: "you-worker", label: "Bud" },
  { id: "you-office", label: "Office" },
  { id: "you-browser", label: "Browser" },
  { id: "you-connected-apps", label: "Apps" },
  { id: "you-phone", label: "Phone" },
  { id: "you-profile", label: "Profile" },
  { id: "you-advanced", label: "Advanced" },
  { id: "you-service-admin", label: "Service" },
] as const;

function YouJumpNav() {
  return (
    <nav
      aria-label="Jump to a settings group"
      className="sticky top-0 z-20 -mx-5 mb-1 border-b border-line bg-paper/95 px-5 py-2 backdrop-blur-sm"
    >
      <ul className="flex flex-wrap gap-1.5">
        {YOU_JUMP_LINKS.map((link) => (
          <li key={link.id}>
            <button
              type="button"
              className="pm-control rounded border border-transparent px-2.5 py-1 text-[12.5px] font-medium text-ink-secondary hover:border-line hover:bg-sheet hover:text-ink"
              onClick={() => {
                const hash = link.id === "you-worker" ? "you-worker" : link.id;
                if (location.hash.replace(/^#/, "") === hash) scrollYouTarget(link.id);
                else location.hash = hash;
              }}
            >
              {link.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function YouGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={label}>
      <h2 className="px-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">{label}</h2>
      {children}
    </section>
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
    `worker ${hermes.cli.installed ? "installed" : "not installed"} · ${(hermes.cli.compatible ?? hermes.cli.matchesPin) ? "matches supported build" : "does not match supported build"}`,
  );
  lines.push(
    `pack ${hermes.pack.installed ? "installed" : "missing"} · approvals ${hermes.pack.approvalsManual ? "manual" : "not manual"} · workroom ${hermes.pack.workroomReady ? "ready" : "needs repair"}`,
  );
  lines.push(`ready ${hermes.ready ? "yes" : "no"}`);
  if (hermes.detail) lines.push(hermes.detail);
  if (hermes.lastPing) lines.push(`lastPing ${fmtDateTime(hermes.lastPing.at)} · ${hermes.lastPing.ok ? "ok" : "miss"}`);
  if (hermes.lastTest) lines.push(`lastTest ${fmtDateTime(hermes.lastTest.at)} · ${hermes.lastTest.ok ? "ok" : "miss"}`);
  if (hermes.homeDir) lines.push(`data dir ${hermes.homeDir}`);
  if (hermes.profileDir) lines.push(`${hermes.handsLabel ?? "Bud's hands"} · ${hermes.profileDir}`);
  return lines.join("\n");
}

export function YouPage({ section }: { section?: "phone" | "office" } = {}) {
  const { state, dispatch, refreshHermes } = useStore();
  const scrollRef = useWorkspaceScroll("you", !section);
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
  const [jobsError, setJobsError] = useState("");
  const { channels, error: channelsError, update: setChannels, refresh: loadChannels } = usePhoneConnections(section !== "office" && state.connected);
  const [lawWatch, setLawWatch] = useState<LawWatch | null>(null);
  const [lawWatchError, setLawWatchError] = useState("");
  const [announce, setAnnounce] = useState("");
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
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
    void Promise.all([api("/api/recipes"), api("/api/portal-sessions")])
      .then(([recipesBody, sessionsBody]) => {
        setRecipes(Array.isArray(recipesBody.recipes) ? recipesBody.recipes : []);
        setSessions(Array.isArray(sessionsBody.sessions) ? sessionsBody.sessions : []);
      })
      .catch((cause: unknown) => setJobsError(cause instanceof Error ? cause.message : String(cause)));
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
    if (section !== "phone") loadDesk();
    if (!section) { loadRules(); loadJobs(); loadLawWatch(); void refreshHermes(); }
  }, [dispatch, loadChannels, loadDesk, loadJobs, loadLawWatch, loadRules, refreshHermes, section]);

  useEffect(() => {
    if (section) return;
    let frame = 0;
    const run = () => {
      const id = youHashTarget(location.hash);
      if (!id) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => scrollYouTarget(id));
    };
    run();
    window.addEventListener("hashchange", run);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", run);
    };
  }, [section]);

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
  // The book's zone is a recorded fact or it is absent. A fixture zone shown as
  // the book's setting would invent configuration, so the display gets null and
  // says so. Formatting still needs a real zone: times below use this computer's
  // zone explicitly, which the office card names rather than passing off as the
  // book's own.
  const bookTimezone = agency?.timezone || desk?.timezone || null;
  const timezone = bookTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const budReady = Boolean(hermes?.ready);

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

  const officeSection = (
    <details open={section === "office" || undefined} id={section ? undefined : "you-office"} className="settings-section">
      <summary>
        <span>This office</span>
        <span className="settings-section-hint">
          {deskError
            ? "Could not load · open to retry"
            : desk?.demo
              ? "Agency basics · optional setup details"
              : agency?.name || "Agency and property settings"}
        </span>
      </summary>
      <div className="settings-section-body">
        {desk ? (
          <OfficeCard
            agencyName={agency?.name ?? ""}
            timezone={bookTimezone}
            jurisdictions={agency?.jurisdictions ?? []}
            office={desk.book?.office}
            revision={desk.revision}
            profileName={state.config?.profile?.name}
            onReload={() => api("/api/desk", undefined, { timeoutMs: 15_000 }).then(snapshot => dispatch({ type: "deskSnapshot", snapshot }))}
            onSave={(input) =>
              api(
                "/api/desk/agency",
                {
                  method: "PATCH",
                  body: JSON.stringify({ name: input.name, jurisdictions: input.jurisdictions, office: input.office, expectedRevision: input.expectedRevision }),
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
        <CompanySetupCard />
        <section id={section ? undefined : "you-website"} tabIndex={-1} aria-label="Website account">
          <WebsiteLinkCard />
        </section>
        <AiUsageCard />
        <WebsiteRequestsCard />
        <RemoteApproversCard />
        <RemoteWorkCard />
      </div>
    </details>
  );

  const goLiveSection = desk ? (
    <GoLiveCard
      mode={desk.mode}
      agencyName={agency?.name ?? ""}
      workerReady={budReady}
      compact
      jurisdictions={agency?.jurisdictions ?? []}
      office={desk.book?.office ? coerceOffice(desk.book.office) : undefined}
      onConnectExport={() => dispatch({ type: "showDesk", book: true })}
      attachWorkerLabel="Set up Bud"
      onAttachWorker={() => scrollYouTarget("you-worker")}
      onSaveAgency={(name) => {
        void api("/api/desk/agency", { method: "PATCH", body: JSON.stringify({ name }) }, { timeoutMs: 15_000 })
          .then((snapshot) => {
            dispatch({ type: "deskSnapshot", snapshot });
            setAgencyError("");
          })
          .catch((cause: unknown) => setAgencyError(cause instanceof Error ? cause.message : String(cause)));
      }}
    />
  ) : null;

  const appsSection = (
    <details id="you-connected-apps" className="settings-section">
      <summary>
        <span>Connected apps</span>
        <span className="settings-section-hint">Optional · bring email and files into a task</span>
      </summary>
      <div className="settings-section-body">
        <ConnectedAppsCard />
      </div>
    </details>
  );

  const phoneSection = (
    <details id="you-phone" className="settings-section">
      <summary>
        <span>Bud on your phone</span>
        <span className="settings-section-hint">
          {channelsError ? "Connection status unavailable · open to retry" : "Optional · connect a messaging app"}
        </span>
      </summary>
      <div className="settings-section-body">
        <ChannelsCard channels={channels} error={channelsError} onChannels={setChannels} onRetry={loadChannels} />
      </div>
    </details>
  );

  const profileSection = (
    <details id="you-profile" className="settings-section">
      <summary>
        <span>Your profile</span>
        <span className="settings-section-hint">Name and office email</span>
      </summary>
      <div className="settings-section-body">
        <Card title="Profile" subtitle="Shown in the sidebar. Saved as you go.">
          <ProfileFields />
        </Card>
      </div>
    </details>
  );

  const advancedSection = (
    <details id="you-advanced" className="settings-section">
      <summary>
        <span>Advanced</span>
        <span className="settings-section-hint">Jobs, rules, recovery, and diagnostics</span>
      </summary>
      <div className="settings-section-body flex flex-col gap-4">
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
        <div id="you-packs">
          <WorkflowPacksCard
            onInstalled={() => {
              void api("/api/recipes")
                .then((body) => setRecipes(Array.isArray(body.recipes) ? body.recipes : []))
                .catch(() => {});
            }}
          />
        </div>
        <div id="you-jobs">
          <BudJobsCard
            recipes={recipes}
            sessions={sessions}
            runs={state.jobRuns}
            error={jobsError}
            onRecipes={setRecipes}
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
        <Card title="Keeping your records" subtitle="Saved jobs, shared office records and your private workspace have different recovery needs.">
          <p className="text-sm text-ink-secondary">Export saved jobs to keep a copy of their plans. An office backup covers shared office records; neither includes your private book, files or conversations.</p>
          <p className="mt-2 text-sm text-ink-secondary">Automatic deletion after a set number of days is not enabled. Use the private business backup below for the included records, and retain source documents separately.</p>
          <button type="button" className="mt-3 min-h-11 rounded border border-line px-3 py-2 text-sm hover:bg-selected" onClick={() => scrollYouTarget("you-packs")}>Open saved-job import and export</button>
        </Card>
        <div id="you-private-backup" tabIndex={-1}>
          <PrivateWorkspaceBackup />
        </div>
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
  );

  if (section === "phone") return <ChannelsCard channels={channels} error={channelsError} onChannels={setChannels} onRetry={loadChannels} />;
  if (section === "office") return officeSection;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-paper">
      <header className="px-5 pb-3 pt-4">
        <div className="flex items-center gap-2.5">
          <User size={21} className="text-agency" />
          <h1 className="pm-screen-title text-ink">You</h1>
        </div>
        <p className="mt-1 max-w-[40rem] text-[12.5px] text-ink-secondary">
          Jump to a group below, or scroll. Set up only what you need for the work ahead.
        </p>
      </header>
      <div ref={scrollRef} data-you-scroll className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 pb-6">
        <YouJumpNav />
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

        <YouGroup label={budReady ? "Office" : "Bud setup"}>
          {budReady ? (
            <>
              {officeSection}
              {goLiveSection}
              {agencyError ? <div className="text-[12.5px] text-danger">{agencyError}</div> : null}
              <BudSetupCard />
            </>
          ) : (
            <>
              <BudSetupCard />
              {officeSection}
              {goLiveSection}
              {agencyError ? <div className="text-[12.5px] text-danger">{agencyError}</div> : null}
            </>
          )}
        </YouGroup>

        <YouGroup label="Bud memory">
          <MemoryReviewPanel />
        </YouGroup>

        <YouGroup label="Connections">
          <BrowserCard />
          {appsSection}
          {phoneSection}
        </YouGroup>

        <YouGroup label="Account">
          {profileSection}
          <ServiceStatusCard />
          <SupportCard />
          <UnattendedWorkCard />
        </YouGroup>

        <YouGroup label="More">
          {advancedSection}
          <ServiceAdministration>
            <ChannelsCard administration channels={channels} error={channelsError} onChannels={setChannels} onRetry={loadChannels} />
          </ServiceAdministration>
        </YouGroup>
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
  onError,
}: {
  recipes: Recipe[] | null;
  sessions: PortalSession[];
  runs: JobRun[];
  error: string;
  onRecipes: (recipes: Recipe[]) => void;
  onError: (message: string) => void;
}) {
  const { dispatch } = useStore();
  const [distillId, setDistillId] = useState<string | null>(null);
  const [distillNote, setDistillNote] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);

  useEffect(() => {
    void api("/api/computer-history")
      .then((body) => setActivity(Array.isArray(body.entries) ? body.entries.slice(0, 10) : []))
      .catch(() => setActivity([]));
  }, []);

  const fail = (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause));
  const expectedRevision = (id: string) => recipes?.find((recipe) => recipe.id === id)?.revision ?? -1;

  const patchStatus = (id: string, status: Recipe["status"]) => {
    onError("");
    void api(`/api/recipes/${id}`, { method: "PATCH", body: JSON.stringify({ status, expectedRevision: expectedRevision(id) }) })
      .then((body) => onRecipes(Array.isArray(body.recipes) ? body.recipes : []))
      .catch(fail);
  };

  const approvePlan = (id: string) => {
    onError("");
    void api(`/api/recipes/${id}`, { method: "PATCH", body: JSON.stringify({ planApproved: true, expectedRevision: expectedRevision(id) }) })
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
    <Card title="Bud's jobs" subtitle="Create, edit, rehearse, and schedule jobs in Schedule. These advanced controls remain available for diagnostics.">
      <button type="button" onClick={() => dispatch({ type: "showRoutines" })} className="pm-control mb-3 rounded border border-line px-3 text-[13px] text-ink hover:bg-selected">Open Schedule</button>
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
            const runChip = latestRun ? attendedRunLabel(latestRun) ?? jobRunStatusChip(latestRun.status) : null;
            const nextStatus = nextRecipeStatus(recipe.status);
            const needsPlan = recipeNeedsPlanApproval(recipe);
            return (
              <li key={recipe.id} className="border-t border-line py-3 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="flex flex-wrap items-baseline gap-2">
                    {recipe.title}
                    <span className={cn("rounded px-2 py-0.5 text-[11px]", chip.className)}>{chip.label}</span>
                    {needsPlan ? (
                      <span className="rounded px-2 py-0.5 text-[11px] bg-hold/10 text-hold">Plan needs approval</span>
                    ) : null}
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
                      className="pm-control rounded border border-line px-3 text-[12px] font-medium text-agency hover:bg-selected"
                      onClick={() => {
                        location.hash = `job-${recipe.id}`;
                        dispatch({ type: "showRoutines" });
                      }}
                    >
                      Review or run in Schedule
                    </button>
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
                  onRun={(run) => dispatch({ type: "jobRun", run })}
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
    explainer: "Connect your bot, then generate a pairing code here and send it privately to the bot.",
    tokenLabel: "Bot token from @BotFather",
    connectLabel: "Connect",
  },
  discord: {
    explainer: "Connect your Discord bot (Message Content Intent on), then pair using a code from this computer.",
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
  { name: "WhatsApp", reason: "Not available to connect yet." },
  { name: "Microsoft Teams", reason: "Not available to connect yet." },
  { name: "SMS", reason: "Not available to connect yet." },
];

function ChannelsCard({
  channels,
  error,
  onChannels,
  onRetry,
  administration = false,
}: {
  channels: ChannelsState | null;
  error: string;
  onChannels: (channels: ChannelsState) => void;
  onRetry?: () => void;
  administration?: boolean;
}) {
  const [expanded, setExpanded] = useState<ChannelPlatform | null>(null);

  return (
    <Card title="Continue on your phone" subtitle="The same Bud conversation, wherever you pick it up.">
      <p className="mb-2 text-[12px] text-ink-muted">
        Send a task from your messaging app and pick it up in Ask. Keep this computer awake with RealBud open.
      </p>
      <details className="mb-3 text-[12px] text-ink-muted"><summary className="pm-control cursor-pointer">Using Bud from your phone</summary><p>Send /continue for the latest saved reply or /status for progress. Files and full review controls are available on this computer.</p></details>
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
                  administration={administration}
                  platform={platform}
                  status={channels[platform]}
                  expanded={expanded === platform}
                  onExpand={() => setExpanded((cur) => (cur === platform ? null : platform))}
                  onChannels={onChannels}
                />
              </li>
            ))}
          </ul>
          <details className="mt-3"><summary className="cursor-pointer text-[12px] text-ink-muted">Other messaging apps · not available yet</summary>
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
          </ul></details>
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
  administration,
}: {
  platform: ChannelPlatform;
  status: ChannelStatus;
  expanded: boolean;
  onExpand: () => void;
  onChannels: (channels: ChannelsState) => void;
  administration: boolean;
}) {
  const { state } = useStore();
  const allowed = useServiceAdminAccess(state.serviceAdmin ?? state.config?.serviceAdmin) && administration;
  const copy = CHANNEL_SETUP[platform];
  const [token, setToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [busy, setBusy] = useState<"connect" | "disconnect" | "pair" | null>(null);
  const [actionError, setActionError] = useState("");
  const [pairing, setPairing] = useState<{ command: string; expiresAt: number } | null>(null);
  useEffect(() => { if (!status.connected || status.paired) setPairing(null); }, [status]);
  useEffect(() => { if (!pairing) return; const timer = setTimeout(() => setPairing(null), Math.max(0, pairing.expiresAt - Date.now())); return () => clearTimeout(timer); }, [pairing]);


  const fail = (cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause));

  const connect = () => {
    const botToken = token.trim();
    if (!allowed || !botToken || busy) return;
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

  const pair = async () => {
    if (busy) return;
    setBusy("pair"); setActionError(""); setPairing(null);
    try {
      const result = await api(`/api/channels/${platform}/pair`, { method: "POST" });
      if (typeof result.command !== "string" || typeof result.expiresAt !== "number") throw new Error("Pairing code unavailable. Try again.");
      setPairing({ command: result.command, expiresAt: result.expiresAt });
    } catch (error) { fail(error); }
    finally { setBusy(null); }
  };

  const disconnect = () => {
    if (!allowed || busy) return;
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
          <ChannelMark channel={CHANNEL_PLATFORM_LABEL[platform] as "Telegram" | "Discord" | "Slack"} /><span className="text-[13px] font-medium text-ink">{CHANNEL_PLATFORM_LABEL[platform]}</span>
          <StatusLabel tone={channelTone(status)}>{channelRowChip(status)}</StatusLabel>
        </div>
        {!allowed ? <span className="text-[12px] text-ink-muted">{status.connected ? "Service configured" : "Administrator setup needed"}</span> : status.connected ? (
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
      {status.connected && !status.paired ? <div className="mt-3 space-y-2">
        <button type="button" onClick={() => void pair()} disabled={busy !== null} className="pm-control rounded border border-line px-3 text-[13px] text-agency disabled:opacity-40">{busy === "pair" ? "Creating code…" : pairing ? "Create a new pairing code" : "Create pairing code"}</button>
        {pairing ? <div className="rounded border border-line bg-sheet p-3" role="status">
          <p className="text-[12px] text-ink-muted">Send this privately to @{status.botUsername} from your phone. Expires in 10 minutes. Only someone with this code can pair.</p>
          <code className="my-2 block select-all break-all text-[14px]">{pairing.command}</code>
          <CopyButton text={pairing.command} label="Copy pairing command" />
        </div> : null}
      </div> : null}
      {allowed && !status.connected && expanded ? (
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
          <p className="mt-0.5 text-[12px] text-ink-muted">Paste your recovery key only if automatic restore did not open the book.</p>
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
                  Start a new book only if this one cannot be recovered. The locked encrypted files stay preserved in this workspace; RealBud will not delete or overwrite them.
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
