import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Cable, CheckCircle2, Loader2, Settings2, ShieldCheck, Sparkles, User, Wrench } from "lucide-react";

import { cn } from "@/lib/cn";
import { buildConnectionRoster, youConnectionsStatus } from "@/lib/connection-roster";
import type { DeskSnapshot } from "@/lib/desk";
import { api, useStore } from "@/state/store";
import {
  recoveryKeySaved,
  recordRecoveryKeySaved,
  WORKER_VERIFICATION_EVENT,
  WORKER_VERIFICATION_KEY,
  workerSetupStep,
  workerVerified,
} from "@/lib/onboarding";
import { AdvancedDiagnostics, RecoveryNotice } from "./pm";
import { Card } from "./SettingsPrimitives";
import { HermesHandsCard, ProfileFields } from "./SettingsModal";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { ConnectionsHub } from "./ConnectionsHub";
import { RealBudControls } from "./RealBudControls";
import { SupportEvidencePanel } from "./SupportEvidencePanel";
import { PilotDiscoveryPanel } from "./PilotDiscoveryPanel";
import { RecoveryUnlockPanel } from "./RecoveryUnlockPanel";
import type { SupportReport } from "@shared/contracts";

export function YouPage({ onOpenSetupJourney }: { onOpenSetupJourney?: () => void } = {}) {
  const { state, dispatch } = useStore();
  const [session, setSession] = useState<{
    product?: boolean;
    nonProduction?: boolean;
    release?: Pick<SupportReport, "app" | "evidence">;
  } | null>(null);
  const [, setVerificationVersion] = useState(0);
  const scrollPaneRef = useRef<HTMLDivElement>(null);

  const focusSetup = useCallback((id: string, behavior: ScrollBehavior = "smooth") => {
    const scrollPane = scrollPaneRef.current;
    const target = document.getElementById(id);
    if (!scrollPane || !target || !scrollPane.contains(target)) return;

    // scrollIntoView also scrolls the document in Chromium when a target sits
    // deep inside this pane. Keep the app shell fixed and move only You's
    // content owner so minimum-size windows cannot land on an empty viewport.
    if (window.scrollY !== 0) window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const paneRect = scrollPane.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const stickyNav = scrollPane.querySelector<HTMLElement>("[data-you-section-nav]");
    const topInset = (stickyNav?.offsetHeight ?? 0) + 12;
    const top = scrollPane.scrollTop + targetRect.top - paneRect.top - topInset;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    scrollPane.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? "auto" : behavior });
    target.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    void api("/api/session")
      .then((body) => setSession(body))
      .catch(() => setSession(null));
    void api("/api/desk")
      .then((snapshot) => dispatch({ type: "deskSnapshot", snapshot }))
      .catch(() => {});
  }, [dispatch]);

  useEffect(() => {
    const refresh = () => setVerificationVersion((version) => version + 1);
    const onStorage = (event: StorageEvent) => {
      if (event.key === WORKER_VERIFICATION_KEY) refresh();
    };
    window.addEventListener(WORKER_VERIFICATION_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(WORKER_VERIFICATION_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!state.youFocus) return;
    const targetId = {
      worker: "worker-setup",
      "desktop-reminders": "desktop-reminders-setup",
      connections: "connections-setup",
      agency: "agency-setup",
      "computer-use": "computer-use-setup",
      "composio-account": "composio-account-setup",
      recovery: "recovery-setup",
    }[state.youFocus];
    const keepTargetVisible = (behavior: ScrollBehavior) => {
      const scrollPane = scrollPaneRef.current;
      const target = document.getElementById(targetId);
      if (!scrollPane || !target || !scrollPane.contains(target)) return;
      const paneRect = scrollPane.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const stickyNav = scrollPane.querySelector<HTMLElement>("[data-you-section-nav]");
      const visibleTop = paneRect.top + (stickyNav?.offsetHeight ?? 0) + 12;
      if (targetRect.top < visibleTop || targetRect.bottom > paneRect.bottom - 12) {
        focusSetup(targetId, behavior);
      }
    };
    const frame = requestAnimationFrame(() => focusSetup(targetId));
    // Connection/source owners settle asynchronously. Two bounded rechecks keep
    // the requested row visible if content above it expands after the first
    // frame; they stop well before the PM could be working elsewhere.
    const settleSoon = window.setTimeout(() => keepTargetVisible("auto"), 180);
    const settleLate = window.setTimeout(() => keepTargetVisible("auto"), 650);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settleSoon);
      window.clearTimeout(settleLate);
    };
  }, [focusSetup, state.youFocus]);

  const desk = state.desk;
  const desktop = useDesktopCapabilities();
  const bud = state.bots.find((bot) => bot.id === "bud" || bot.name === "Bud") ?? state.bots[0];
  const desktopRemindersAvailable = Boolean(window.ogb?.notifyRoutine);
  const deskRecovery = Boolean(desk?.recovery?.active);
  const localRecovery = state.config?.localRecovery;
  const recoveryAttention = deskRecovery || Boolean(localRecovery?.active);
  const agency = desk?.book?.agency;
  const workerStep = workerSetupStep({
    worker: state.hermes,
    workerIsVerified: workerVerified(state.hermes),
  });
  const workerReady = workerStep.state === "done";
  const workerHandoff = state.youFocus === "worker" || state.youFocus == null;
  const setupHandoffOpened = useRef(false);

  useEffect(() => {
    if (state.youFocus !== "worker") {
      setupHandoffOpened.current = false;
      return;
    }
    if (workerReady || !onOpenSetupJourney || setupHandoffOpened.current) return;
    setupHandoffOpened.current = true;
    onOpenSetupJourney();
  }, [onOpenSetupJourney, state.youFocus, workerReady]);

  const essentialsReady = workerReady && desk?.mode === "live" && !recoveryAttention;
  const peek = state.youFocus;
  const openYouSection = (id: string) => {
    if (!essentialsReady && id === "worker-setup") {
      onOpenSetupJourney?.();
      return;
    }
    if (essentialsReady) {
      focusSetup(id);
      return;
    }
    const focus = {
      "general-setup": "agency",
      "worker-setup": "worker",
      "connections-setup": "connections",
      "recovery-setup": "recovery",
    }[id];
    if (focus) dispatch({ type: "showYou", focus });
  };
  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-app">
      <header className="px-5 pb-3 pt-4">
        <div className="flex items-center gap-2.5">
          <User size={21} className="text-accent" />
          <h1 className="pm-screen-title text-ink">You</h1>
        </div>
        <p className="mt-1 max-w-[40rem] text-[13px] text-ink-secondary">
          {essentialsReady
            ? "Agency, connections and recovery."
            : workerReady
              ? "Verify the live book with a current PMS export. The rest of You waits."
              : "Finish setup first. The rest of You waits."}
        </p>
      </header>
      <div ref={scrollPaneRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6">
        {session?.nonProduction && (
          <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-[13px] text-warning">
            Source-run key. This is not a production distribution. Agency data stays local.
          </div>
        )}
        {recoveryAttention && (
          <RecoveryNotice>
            {deskRecovery
              ? "Desk is in recovery. Writes, schedules and browser work are paused. The book was not replaced with Demo data."
              : "RealBud preserved local state that could not be verified. The affected work is read-only and worker actions are paused."}
          </RecoveryNotice>
        )}
        {state.setupReturnView === "ask" && (
          <section
            aria-labelledby="ask-setup-handoff-title"
            className={cn(
              "flex flex-wrap items-center gap-3 rounded border px-4 py-3",
              workerHandoff && !workerReady ? "border-hold/40 bg-hold/10" : "border-agency/40 bg-selected",
            )}
          >
            <div className={cn("flex size-9 shrink-0 items-center justify-center rounded", workerHandoff && !workerReady ? "bg-sheet text-hold" : "bg-agency text-white")}>
              {workerHandoff && !workerReady ? <User size={17} /> : <CheckCircle2 size={17} />}
            </div>
            <div className="min-w-[14rem] flex-1">
              <h2 id="ask-setup-handoff-title" className="text-[14px] font-semibold text-ink">
                {state.youFocus === "connections" || state.youFocus === "composio-account" || state.youFocus === "computer-use"
                  ? "Choose and verify the source here"
                  : state.youFocus === "desktop-reminders"
                    ? "Review desktop reminders here"
                    : workerReady ? "Bud is ready for Ask" : "Finish Bud's setup to continue Ask"}
              </h2>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">
                {state.youFocus === "connections" || state.youFocus === "composio-account" || state.youFocus === "computer-use"
                  ? "Bud can bring you to setup, but cannot receive credentials in chat or declare a source connected. Your Ask thread is still waiting."
                  : state.youFocus === "desktop-reminders"
                    ? "This local alert never contacts a tenant, owner or tradie. Your Ask thread is still waiting."
                    : workerReady ? "Your unfinished Ask draft is still waiting." : `${workerStep.detail} Your unfinished Ask draft is safe.`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => dispatch({ type: "showAsk" })}
              className={cn(
                "pm-control pm-tactile inline-flex items-center gap-2 rounded px-3 text-[12.5px] font-semibold",
                workerHandoff && !workerReady ? "border border-line bg-sheet text-ink hover:border-agency/60" : "bg-agency text-white hover:bg-agency-hover",
              )}
            >
              <ArrowLeft size={14} /> {workerHandoff && workerReady ? "Return to Ask" : "Back to Ask"}
            </button>
          </section>
        )}
        <YouSectionNav
          generalStatus={agency?.timezone ?? desk?.timezone ?? "Book loading"}
          workerStatus={workerReady ? "Ready" : "Setup needed"}
          connectionsStatus={youConnectionsStatus(buildConnectionRoster({
            deskMode: desk?.mode,
            deskRecovery: Boolean(desk?.recovery?.active),
            sourceLabels: desk?.sources,
            pocketTelegram: state.config?.pocket?.channels.telegram.state,
            pocketWhatsapp: state.config?.pocket?.channels.whatsappCloud.state,
            computerUseAvailable: desktop.capabilities.localComputer.available,
            remindersAvailable: desktopRemindersAvailable,
            remindersOn: Boolean(bud?.notifications),
          }))}
          recoveryStatus={recoveryAttention ? "Needs attention" : localRecovery?.issues.length ? "Restored · review" : "Protected"}
          recoveryActive={recoveryAttention}
          onOpen={openYouSection}
        />
        {desk && !essentialsReady ? (
          <section className="flex flex-wrap items-center gap-3 border border-agency/30 bg-selected/45 px-4 py-3" aria-labelledby="focused-setup-title">
            <div className="flex size-9 shrink-0 items-center justify-center rounded bg-sheet text-agency">
              <Sparkles size={17} aria-hidden="true" />
            </div>
            <div className="min-w-[15rem] flex-1">
              <h2 id="focused-setup-title" className="text-[14px] font-semibold text-ink">
                {recoveryAttention ? "Restore your desk" : workerReady ? "Verify the live book" : workerStep.title}
              </h2>
              <p className="mt-0.5 text-[12px] text-ink-muted">
                {recoveryAttention
                  ? "Recovery owns the next step."
                  : workerReady
                    ? "The practice book can already be on Desk. A current PMS export verifies live balances and opens the rest of You."
                    : "One guide. Then You opens fully."}
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenSetupJourney}
              disabled={!onOpenSetupJourney}
              className="pm-control pm-tactile rounded bg-agency px-4 text-[12.5px] font-semibold text-white hover:bg-agency-hover disabled:opacity-40"
            >
              {workerReady ? "Verify book" : "Prepare Bud"}
            </button>
          </section>
        ) : null}
        {(essentialsReady || peek === "agency" || peek === "computer-use") ? (
        <section id="general-setup" tabIndex={-1} className="scroll-m-28 space-y-4 outline-none">
          <div id="agency-setup" tabIndex={-1} className="scroll-m-28 outline-none">
            <AgencyCard desk={desk} />
          </div>
          {essentialsReady ? <PilotDiscoveryPanel /> : null}
          <Card title="Profile" subtitle="Shown in the sidebar. Saved as you go.">
            <ProfileFields />
          </Card>
          {essentialsReady ? (
          <RealBudControls
            bookTimezone={desk?.timezone ?? agency?.timezone ?? null}
            deskRevision={desk?.revision}
            timezonePaused={state.loops.some((loop) => Boolean(loop.timezonePaused))}
            worker={state.hermes}
            onOpenWorker={() => focusSetup("worker-setup")}
            onOpenComputerUse={() => focusSetup("computer-use-setup")}
          />
          ) : null}
        </section>
        ) : null}
        {essentialsReady ? (
        <section id="worker-setup" tabIndex={-1} className="scroll-m-28 outline-none">
          <HermesHandsCard />
        </section>
        ) : <div id="worker-setup" className="sr-only" />}
        {(essentialsReady || peek === "connections" || peek === "desktop-reminders" || peek === "composio-account" || peek === "computer-use") ? (
        <section id="connections-setup" tabIndex={-1} className="scroll-m-28 space-y-3 outline-none">
          <div>
            <h2 className="text-[14px] font-semibold text-ink">Connections</h2>
            <p className="mt-0.5 max-w-[46rem] text-[13px] leading-relaxed text-ink-muted">
              Name the PMS, inbox or portal this office already uses. Tell Ask, or connect here. Keys never go into chat.
            </p>
          </div>
          <ConnectionsHub
            deskRevision={desk?.revision}
            desktopRemindersAvailable={desktopRemindersAvailable}
            remindersOn={Boolean(bud?.notifications)}
            focus={peek}
            onToggleReminders={!bud
              ? undefined
              : () => dispatch({ type: "updateBot", botId: bud.id, patch: { notifications: !bud.notifications } })}
            onOpenDesk={() => dispatch({ type: "showDesk" })}
            onOpenAsk={() => dispatch({ type: "showAsk" })}
          />
        </section>
        ) : null}
        {(essentialsReady || peek === "recovery" || recoveryAttention) ? (
        <section id="recovery-setup" tabIndex={-1} className="scroll-m-28 space-y-4 outline-none">
          {localRecovery?.issues.length ? (
            <Card title="Local state" subtitle="RealBud never turns damaged persisted state into an empty first run.">
              <div className="space-y-2">
                {localRecovery.issues.map((issue, index) => (
                  <div key={`${issue.area}-${index}`} className="rounded border border-line bg-paper px-3 py-2">
                    <div className="text-[12.5px] font-semibold capitalize text-ink">{issue.area}</div>
                    <div className={cn("mt-0.5 text-[12px]", issue.action === "attention" ? "text-hold" : "text-ink-muted")}>{issue.detail}</div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
          <RecoveryKeyCard recoveryActive={deskRecovery} />
        </section>
        ) : <div id="recovery-setup" className="sr-only" />}
        {essentialsReady ? (
        <>
        <Card
          title="Sources"
          subtitle={
            desk
              ? `${desk.mode === "demo" ? "Demo book" : "Live book"} · revision ${desk.revision} · ${desk.timezone}`
              : "Open Desk once to load the book."
          }
        >
          <ul className="text-[13px] text-ink-secondary">
            {(desk?.sources ?? []).map((source) => (
              <li key={source.id}>
                {source.label} · {source.kind}
              </li>
            ))}
            {!desk?.sources?.length && <li>No sources yet.</li>}
          </ul>
        </Card>
        <Card title="Browser profile" subtitle="A dedicated signed-in browser profile. Passwords and cookies never enter settings, recipes, or Ask.">
          <div className="text-[13px] text-ink-secondary">
            Retention: {desk?.retentionDays ?? "not set"} days. Full captures stay off the event stream.
          </div>
          {recoveryAttention ? (
            <p className="mt-2 text-[13px] text-hold">Browser work is paused in recovery. Prepare is refused until you resume.</p>
          ) : (
            <p className="mt-2 text-[13px] text-ink-secondary">Handoffs stay case-scoped. You submit in the PMS.</p>
          )}
        </Card>
        <AdvancedDiagnostics>
          {state.hermes ? (
            <>
              <div>pin {state.hermes.pin.product} / {state.hermes.pin.tag}</div>
              <div>profile {state.hermes.pin.profile}</div>
              <div>pack {state.hermes.pack.installed ? "installed" : "missing"} · approvals {state.hermes.pack.approvalsManual ? "manual" : "not manual"}</div>
              {state.hermes.runtimeRecovery ? (
                <div>runtime recovery {state.hermes.runtimeRecovery.action} · previous {state.hermes.runtimeRecovery.previousAvailable ? "available" : "not retained"}</div>
              ) : null}
              {state.hermes.modelRecovery ? <div>model recovery {state.hermes.modelRecovery.action} · {state.hermes.modelRecovery.detail}</div> : null}
              <div>approvals stay manual · scheduling stays on RealBud's clock · both are managed by RealBud and not editable</div>
              <div>{state.hermes.detail}</div>
            </>
          ) : (
            <div>Engine status is not available yet.</div>
          )}
          <SupportEvidencePanel release={session?.release} />
        </AdvancedDiagnostics>
        </>
        ) : null}
      </div>
    </main>
  );
}

function YouSectionNav({
  generalStatus,
  workerStatus,
  connectionsStatus,
  recoveryStatus,
  recoveryActive,
  onOpen,
}: {
  generalStatus: string;
  workerStatus: string;
  connectionsStatus: string;
  recoveryStatus: string;
  recoveryActive: boolean;
  onOpen: (id: string) => void;
}) {
  const items = [
    { id: "general-setup", label: "General", status: generalStatus, icon: <Settings2 size={15} /> },
    { id: "worker-setup", label: "Bud setup", status: workerStatus, icon: <Wrench size={15} /> },
    { id: "connections-setup", label: "Connections", status: connectionsStatus, icon: <Cable size={15} /> },
    { id: "recovery-setup", label: "Recovery", status: recoveryStatus, icon: <ShieldCheck size={15} /> },
  ];

  return (
    <nav data-you-section-nav aria-label="You sections" className="sticky top-0 z-10 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-controls={item.id}
          onClick={() => onOpen(item.id)}
          className="pm-control pm-tactile min-w-0 bg-sheet px-3 py-2 text-left hover:bg-selected/50"
        >
          <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
            <span className={cn(item.id === "recovery-setup" && recoveryActive ? "text-hold" : "text-agency")}>{item.icon}</span>
            {item.label}
          </span>
          <span className={cn("mt-0.5 block truncate text-[12px]", item.id === "recovery-setup" && recoveryActive ? "text-hold" : "text-ink-muted")}>
            {item.status}
          </span>
        </button>
      ))}
    </nav>
  );
}

function AgencyCard({ desk }: { desk: DeskSnapshot | null }) {
  const { dispatch } = useStore();
  const agency = desk?.book?.agency;
  const [name, setName] = useState(agency?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setName(agency?.name ?? "");
  }, [agency?.name]);

  const save = async () => {
    if (!desk || busy || desk.recovery?.active) return;
    const nextName = name.trim();
    if (nextName.length > 120) {
      setMessage({ ok: false, text: "Keep the agency name to 120 characters or fewer." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const snapshot = await api("/api/desk/agency", {
        method: "PATCH",
        body: JSON.stringify({ name: nextName, expectedRevision: desk.revision }),
      });
      dispatch({ type: "deskSnapshot", snapshot });
      setMessage({ ok: true, text: nextName ? "Agency name saved." : "Agency name left optional." });
    } catch (cause) {
      setMessage({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
      try {
        const snapshot = await api("/api/desk");
        dispatch({ type: "deskSnapshot", snapshot });
      } catch {
        // Keep the actionable mutation error; the next Desk/You load retries.
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Agency"
      subtitle={agency ? `${agency.timezone} · AUD defaults` : "Open Desk once to load the local book."}
    >
      <label htmlFor="agency-name" className="block text-[12px] font-medium text-ink-secondary">
        Agency name <span className="font-normal text-ink-muted">(optional)</span>
      </label>
      <div className="mt-1 flex flex-wrap gap-2">
        <input
          id="agency-name"
          value={name}
          maxLength={120}
          disabled={!desk || Boolean(desk.recovery?.active) || busy}
          onChange={(event) => {
            setName(event.target.value);
            setMessage(null);
          }}
          className="min-h-10 min-w-[220px] flex-1 rounded border border-line bg-inset px-3 text-[14px] text-ink disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={!desk || Boolean(desk.recovery?.active) || busy || name.trim() === (agency?.name ?? "")}
          className="pm-tactile flex min-h-10 items-center gap-1.5 rounded bg-agency px-3 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : null}
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      <div className="mt-2 text-[12px] text-ink-secondary">
        Jurisdictions: {agency?.jurisdictions.length ? agency.jurisdictions.join(", ") : "not configured; supported pilot export required"}
      </div>
      {message ? <p role="status" className={cn("mt-2 text-[12.5px]", message.ok ? "text-agency" : "text-danger")}>{message.text}</p> : null}
    </Card>
  );
}

function RecoveryKeyCard({ recoveryActive }: { recoveryActive: boolean }) {
  const [hex, setHex] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(() => recoveryKeySaved());
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

  return (
    <Card
      title="Recovery key"
      subtitle="Your book is encrypted. This key is the only way to open it if the key file is ever lost. Save it somewhere safe."
    >
      {saved && !hex ? (
        <div className="text-[13px] text-ink-secondary">
          Saved ✓{" "}
          <button className="text-accent hover:underline" onClick={() => { setSaved(false); recordRecoveryKeySaved(false); }}>
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
                  onClick={() => { recordRecoveryKeySaved(true); setSaved(true); setHex(null); }}
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
      {recoveryActive ? <div className="mt-3"><RecoveryUnlockPanel compact /></div> : null}
      {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}
    </Card>
  );
}
