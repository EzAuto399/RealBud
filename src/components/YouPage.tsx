import { useCallback, useEffect, useState } from "react";
import { Loader2, User } from "lucide-react";

import { cn } from "@/lib/cn";
import { fmtDateTime, relativeAgo } from "@/lib/au";
import { activityLabel, activityResult, type ActivityEntry } from "@/lib/computer-activity";
import { sourceKindLabel } from "@/lib/hands-label";
import { morningBrief } from "@/lib/morning-brief";
import {
  AWAITING_REVIEW_COPY,
  latestSessionFor,
  nextRecipeStatus,
  recipeNeedsPlanApproval,
  recipeSitesLine,
  recipeStatusChip,
  sessionSummaryLine,
} from "@/lib/portal-job";
import { sourceCheckCopy } from "@/lib/source-check";
import {
  channelStatusLine,
  readChannels,
  type ChannelPlatform,
  type ChannelStatus,
  type ChannelsState,
} from "@/lib/telegram-channel";
import type { PortalSession, Recipe } from "@/lib/desk";
import { readLawWatch, type LawWatch } from "@/lib/law-watch";
import { api, useStore } from "@/state/store";
import { AdvancedDiagnostics, RecoveryNotice } from "./pm";
import { BudSetupCard } from "./BudSetupCard";
import { Card } from "./SettingsPrimitives";
import { ProfileFields } from "./SettingsModal";
import { GoLiveCard } from "./desk/GoLiveCard";
import { MorningBrief } from "./desk/MorningBrief";
import { LawWatchCard } from "./you/LawWatchCard";
import { OfficeCard } from "./you/OfficeCard";

export function YouPage() {
  const { state, dispatch, refreshHermes } = useStore();
  const [session, setSession] = useState<{ product?: boolean; nonProduction?: boolean } | null>(null);
  const [deskError, setDeskError] = useState("");
  const [agencyError, setAgencyError] = useState("");
  const [rules, setRules] = useState<Array<{ id: string; key: string; label: string }> | null>(null);
  const [rulesError, setRulesError] = useState("");
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [sessions, setSessions] = useState<PortalSession[]>([]);
  const [jobsError, setJobsError] = useState("");
  const [channels, setChannels] = useState<ChannelsState | null>(null);
  const [channelsError, setChannelsError] = useState("");
  const [lawWatch, setLawWatch] = useState<LawWatch | null>(null);
  const [lawWatchError, setLawWatchError] = useState("");

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
    if (location.hash !== "#you-worker" && location.hash !== "#attach-model") return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById("you-worker");
      const scroller = document.querySelector<HTMLElement>("[data-you-scroll]");
      if (!target || !scroller) return;
      const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({
        top,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const desk = state.desk;
  const hermes = state.hermes;
  const recovery = desk?.recovery?.active;
  const agency = desk?.book?.agency;
  const timezone = agency?.timezone || desk?.timezone || "Australia/Sydney";

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-paper">
      <header className="px-5 pb-3 pt-4">
        <div className="flex items-center gap-2.5">
          <User size={21} className="text-agency" />
          <h1 className="pm-screen-title text-ink">You</h1>
        </div>
        <p className="mt-1 max-w-[40rem] text-[12.5px] text-ink-secondary">
          This office, when the book was last checked, and recovery. Engine internals stay under Advanced diagnostics.
        </p>
      </header>
      <div data-you-scroll className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6">
        {session?.nonProduction && (
          <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-[13px] text-warning">
            Source-run key. This is not a production distribution. Agency data stays local.
          </div>
        )}
        {recovery && (
          <RecoveryNotice>
            Desk is in recovery. Writes, schedules and browser work are paused. The book was not replaced with Demo data.
          </RecoveryNotice>
        )}
        {desk ? (
          <OfficeCard
            agencyName={agency?.name ?? ""}
            timezone={timezone}
            jurisdictions={agency?.jurisdictions ?? []}
            office={desk.book?.office}
            profileName={state.config?.profile?.name}
            onSave={(input) =>
              api("/api/desk/agency", {
                method: "PATCH",
                body: JSON.stringify({ name: input.name, jurisdictions: input.jurisdictions, office: input.office }),
              }).then((snapshot) => dispatch({ type: "deskSnapshot", snapshot }))
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
        {desk ? (
          <MorningBrief
            brief={morningBrief(desk)}
            timezone={timezone}
            onOpenAddress={() => dispatch({ type: "showDesk" })}
            interactive
          />
        ) : null}
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
              void api("/api/desk/agency", { method: "PATCH", body: JSON.stringify({ name }) })
                .then((snapshot) => {
                  dispatch({ type: "deskSnapshot", snapshot });
                  setAgencyError("");
                })
                .catch((cause: unknown) => setAgencyError(cause instanceof Error ? cause.message : String(cause)));
            }}
          />
        ) : null}
        {agencyError ? <div className="text-[12.5px] text-danger">{agencyError}</div> : null}
        <Card title="Profile" subtitle="Shown in the sidebar. Saved as you go.">
          <ProfileFields />
        </Card>
        <BudSetupCard />
        <Card title="Bud's rules" subtitle="Standing permissions. Always allow on an approval card saves one here.">
          {rulesError ? <p className="text-[12.5px] text-danger">{rulesError}</p> : null}
          {!rulesError && rules && rules.length === 0 ? (
            <p className="text-[13px] text-ink-secondary">
              No standing rules. When Bud asks for a permission, Always allow saves one here.
            </p>
          ) : null}
          {!rulesError && rules && rules.length > 0 ? (
            <ul className="text-[13px] text-ink">
              {rules.map((rule) => (
                <li key={rule.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1">
                  <span>
                    {rule.label}{" "}
                    <span className="font-mono text-[11px] text-ink-muted">{rule.key}</span>
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
        <BudJobsCard
          recipes={recipes}
          sessions={sessions}
          error={jobsError}
          onRecipes={setRecipes}
          onSessions={setSessions}
          onError={setJobsError}
        />
        <ChannelsCard channels={channels} error={channelsError} onChannels={setChannels} />
        <RecoveryKeyCard recoveryActive={Boolean(recovery)} />
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
              <div>approvals stay manual · scheduling stays on RealBud's clock · both are managed by RealBud and not editable</div>
              <div>{hermes.detail}</div>
            </>
          ) : (
            <div>Engine status is not available yet.</div>
          )}
        </AdvancedDiagnostics>
      </div>
    </main>
  );
}

function BudJobsCard({
  recipes,
  sessions,
  error,
  onRecipes,
  onSessions,
  onError,
}: {
  recipes: Recipe[] | null;
  sessions: PortalSession[];
  error: string;
  onRecipes: (recipes: Recipe[]) => void;
  onSessions: (update: (prev: PortalSession[]) => PortalSession[]) => void;
  onError: (message: string) => void;
}) {
  const [runningId, setRunningId] = useState<string | null>(null);
  const [distillId, setDistillId] = useState<string | null>(null);
  const [distillNote, setDistillNote] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);

  useEffect(() => {
    void api("/api/computer-history")
      .then((body) => setActivity(Array.isArray(body.entries) ? body.entries.slice(0, 10) : []))
      .catch(() => setActivity([]));
  }, []);

  const fail = (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause));

  const runShadow = (id: string) => {
    setRunningId(id);
    onError("");
    void api(`/api/recipes/${id}/run`, { method: "POST" })
      .then((body: { session?: PortalSession }) => {
        if (!body.session) throw new Error("Bud could not start that check.");
        const next = body.session;
        onSessions((prev) => [next, ...prev.filter((session) => session.id !== next.id)]);
      })
      .catch(fail)
      .finally(() => setRunningId(null));
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
    <Card title="Bud's jobs" subtitle="Taught in Ask. First runs are shadow runs — Bud narrates and clicks nothing.">
      {error ? <p className="text-[12.5px] text-danger">{error}</p> : null}
      {!error && recipes && recipes.length === 0 ? (
        <p className="text-[13px] text-ink-secondary">
          No jobs yet. Teach Bud one in Ask — he narrates it first and clicks nothing.
        </p>
      ) : null}
      {!error && recipes && recipes.length > 0 ? (
        <ul className="text-[13px] text-ink">
          {recipes.map((recipe) => {
            const chip = recipeStatusChip(recipe.status);
            const session = latestSessionFor(sessions, recipe.id);
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
                      disabled={runningId === recipe.id}
                      className="inline-flex items-center gap-1 text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
                      onClick={() => runShadow(recipe.id)}
                    >
                      {runningId === recipe.id ? (
                        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
                      ) : null}
                      Run a shadow check
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
                  {" · "}
                  {recipeSitesLine(recipe.allowedOrigins)}
                </p>
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

const CHANNEL_CARDS: Record<
  ChannelPlatform,
  { name: string; explainer: string; tokenLabel: string; connectLabel: string }
> = {
  telegram: {
    name: "Telegram",
    explainer:
      "Create a bot with @BotFather in Telegram, paste its token here, then message the bot once from your phone to pair.",
    tokenLabel: "Bot token from @BotFather",
    connectLabel: "Connect Telegram",
  },
  discord: {
    name: "Discord",
    explainer:
      "In the Discord developer portal, create an application → Bot → copy its token and enable Message Content Intent. Paste it here, then DM the bot once to pair.",
    tokenLabel: "Bot token from the Discord developer portal",
    connectLabel: "Connect Discord",
  },
};

function ChannelsCard({
  channels,
  error,
  onChannels,
}: {
  channels: ChannelsState | null;
  error: string;
  onChannels: (channels: ChannelsState) => void;
}) {
  return (
    <Card
      title="Channels"
      subtitle="Message Bud from your phone or server. Answers come from the same worker and the same book."
    >
      {error ? <p className="text-[12.5px] text-danger">{error}</p> : null}
      {!error && channels ? (
        <div className="flex flex-col">
          <ChannelCard platform="telegram" status={channels.telegram} onChannels={onChannels} />
          <ChannelCard platform="discord" status={channels.discord} onChannels={onChannels} />
        </div>
      ) : null}
    </Card>
  );
}

function ChannelCard({
  platform,
  status,
  onChannels,
}: {
  platform: ChannelPlatform;
  status: ChannelStatus;
  onChannels: (channels: ChannelsState) => void;
}) {
  const copy = CHANNEL_CARDS[platform];
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [actionError, setActionError] = useState("");

  const fail = (cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause));

  const connect = () => {
    const botToken = token.trim();
    if (!botToken || busy) return;
    setBusy("connect");
    setActionError("");
    void api(`/api/channels/${platform}`, { method: "POST", body: JSON.stringify({ botToken }) })
      .then((body) => {
        setToken("");
        onChannels(readChannels(body));
      })
      .catch(fail)
      .finally(() => setBusy(null));
  };

  const disconnect = () => {
    if (busy) return;
    setBusy("disconnect");
    setActionError("");
    void api(`/api/channels/${platform}`, { method: "DELETE" })
      .then((body) => onChannels(readChannels(body)))
      .catch(fail)
      .finally(() => setBusy(null));
  };

  return (
    <section className="border-t border-line py-4 first:border-t-0 first:pt-0 last:pb-0" aria-label={copy.name}>
      <h3 className="text-[13px] font-medium text-ink">{copy.name}</h3>
      {!status.connected ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <p className="mt-1 text-[13px] text-ink-secondary">{copy.explainer}</p>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={copy.tokenLabel}
            aria-label={copy.tokenLabel}
            className="pm-control mt-3 w-full rounded border border-line bg-sheet px-3 text-[14px] text-ink placeholder:text-ink-muted focus:border-agency focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy !== null || !token.trim()}
            className="pm-control mt-3 inline-flex items-center justify-center gap-2 rounded bg-agency px-4 text-[14px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
          >
            {busy === "connect" ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : null}
            {copy.connectLabel}
          </button>
        </form>
      ) : (
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-[13px] text-ink">
              <span className="size-1.5 shrink-0 rounded-full bg-agency" aria-hidden />
              @{status.botUsername}
            </div>
            <p className="mt-1 text-[12px] text-ink-muted">{channelStatusLine(platform, status)}</p>
          </div>
          <button
            type="button"
            disabled={busy !== null}
            className="text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
            onClick={disconnect}
          >
            Disconnect
          </button>
        </div>
      )}
      {actionError ? <p className="mt-2 text-[12.5px] text-danger">{actionError}</p> : null}
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
