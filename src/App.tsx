import { useServiceAdminAccess } from "@/lib/use-service-admin-access";
import { useBudStatusMonitor } from "@/lib/bud-status-monitor";
import { openDeskArea, openDeskTasks } from "@/lib/desk-view-state";
import { HumanHandoffPanel } from "@/components/HumanHandoffPanel";
import { hasPropertyEdits } from "@/lib/property-edits";
import { hasUnsavedMailReviews } from "@/lib/mail-review-drafts";
import { hasUnsavedOfficeDrafts } from "@/lib/office-draft-journal";
import { hasUnsavedDepartmentConfigurationDrafts } from '@/lib/department-configuration-draft-journal';
import { hasUnpersistedBillDrafts } from "@/lib/bill-review-drafts";
import { scrollYouTarget, youHashTarget } from "@/lib/you-navigation";
import { NAVIGATION_CANCELLED } from "@/lib/navigation-guard";
import { lazy, useCallback, useEffect, useRef, useState } from "react";
import { WorkspaceScreen } from "@/components/WorkspaceScreen";
import { Loader2 } from "lucide-react";
import { api, StoreProvider, useStore } from "@/state/store";
import { DesktopShell, WindowsTitlebar } from "@/components/shell/DesktopShell";
import { MausAvatar } from "@/components/Avatar";
import { ShellPalette } from "@/components/shell/ShellPalette";

import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";


import type { CaseEdit } from "@/components/desk/DeskCase";


import { firstRunDone, readSavedSetup } from "@/lib/first-run";
import type { OnboardingState } from '@shared/onboarding';
import { doorHashToWrite, viewFromHash, workspaceViewFromHash, workspaceViewHash, type DeskView } from "@/lib/app-route";
import { WorkspaceTabsProvider, useWorkspaceTabs } from '@/lib/workspace-tabs';


import { SHOW_DESK_EVENT, shownArea } from "@/lib/notify-desktop";

import { WORKSPACE_SETUP_EVENT, isWorkspaceSetupTarget, type WorkspaceSetupTarget } from "@/lib/workspace-setup";
import { ActionNotice } from "@/components/ActionNotice";
import { DESIGN_PREVIEW_REASON } from "@/lib/design-preview";
import { budFirstSetupCover, budSetupSheetDone, continueRecovery, leaveLinkGate, linkGateLeft, officeLinkGate, parseBudStatus, resumeSavedRecovery } from "@/lib/bud-setup";
import { useOfficeLinkView } from "@/lib/use-office-link";

const ChatView = lazy(() => import('@/components/ChatView').then(module => ({ default: module.ChatView })));
const RoutinesPage = lazy(() => import('@/components/RoutinesPage').then(module => ({ default: module.RoutinesPage })));
const loadDeskPage = () => import('@/components/DeskPage');
const DeskPage = lazy(() => loadDeskPage().then(module => ({ default: module.DeskPage })));
const YouPage = lazy(() => import('@/components/YouPage').then(module => ({ default: module.YouPage })));
const Onboarding = lazy(() => import('@/components/Onboarding').then(module => ({ default: module.Onboarding })));
const WorkspaceTabsManager = lazy(() => import('@/components/WorkspaceTabsManager').then(module => ({ default: module.WorkspaceTabsManager })));
const WorkspaceSavedView = lazy(() => import('@/components/WorkspaceSavedView').then(module => ({ default: module.WorkspaceSavedView })));
const WorkspaceSetup = lazy(() => import('@/components/WorkspaceSetup').then(module => ({ default: module.WorkspaceSetup })));
const BudSetupScreen = lazy(() => import('@/components/BudSetupScreen').then(module => ({ default: module.BudSetupScreen })));
const LinkOfficeScreen = lazy(() => import('@/components/LinkOfficeScreen').then(module => ({ default: module.LinkOfficeScreen })));

function macDoorKeys(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac/i.test(uaData?.platform ?? navigator.platform);
}

const VIEW_ACTIONS = {
  desk: { type: "showDesk" },
  ask: { type: "showAsk" },
  schedule: { type: "showRoutines" },
  you: { type: "showYou" },
} as const satisfies Record<DeskView, { type: string }>;

/** `recoveryStarted`: first run saved a recovery choice, so the office-link screen offers Continue recovery. */
function Shell({ initialSetup = null, recoveryStarted = false }: { initialSetup?: WorkspaceSetupTarget | null; recoveryStarted?: boolean }) {
  // Keep unfinished wording in memory across navigation; never write it to disk.
  const deskCaseEdits = useRef(new Map<string, CaseEdit>());
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!hasPropertyEdits() && !hasUnpersistedBillDrafts() && !hasUnsavedMailReviews() && !hasUnsavedOfficeDrafts() && !hasUnsavedDepartmentConfigurationDrafts() && deskCaseEdits.current.size === 0) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const { state, dispatch } = useStore();
  const canAdminister = useServiceAdminAccess(state.serviceAdmin ?? state.config?.serviceAdmin);
  const refreshBudStatus = useCallback(async (isCurrent: () => boolean) => {
    const status = parseBudStatus(await api("/api/hermes", undefined, { timeoutMs: 15_000 }));
    if (isCurrent()) dispatch({ type: "hermesStatus", status });
  }, [dispatch]);
  // Until Bud's first setup finishes, every screen keeps its status fresh, so the
  // setup screen appears as soon as setup starts (Desk has no status view of its own).
  const budStatusRead = useBudStatusMonitor({ enabled: state.connected && !state.hermes?.readyOnce, onRefresh: refreshBudStatus });
  const workspaceTabs = useWorkspaceTabs();
  const savedView = workspaceTabs.data?.state?.tabs.find(tab => tab.id === state.workspaceTabId && tab.visible);
  const [setup, setSetup] = useState<WorkspaceSetupTarget | null>(initialSetup);
  // First run's "Continue to Bud setup" opened Bud status: it closes by itself once Bud is ready.
  const setupFromFlow = useRef(initialSetup === "bud");
  // Capture before inert and the lazy loading dialog move focus away. The
  // concrete sheet cannot recover an opener from an unmounted fallback.
  const setupOpener = useRef<{ element: HTMLElement; view: string } | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const target: unknown = (event as CustomEvent).detail;
      if (isWorkspaceSetupTarget(target)) {
        if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('[role="dialog"]')) {
          setupOpener.current = { element: document.activeElement, view: state.activeView };
        }
        // The person opened it: theirs to close.
        setupFromFlow.current = false;
        setSetup(target);
      }
    };
    window.addEventListener(WORKSPACE_SETUP_EVENT, open);
    return () => window.removeEventListener(WORKSPACE_SETUP_EVENT, open);
  }, [state.activeView]);
  useEffect(() => {
    if (setup || !setupOpener.current) return;
    const previous = setupOpener.current;
    setupOpener.current = null;
    if (previous.view === state.activeView && previous.element.isConnected && !previous.element.closest("[inert]") && previous.element.getClientRects().length) {
      previous.element.focus();
    }
  }, [setup, state.activeView]);
  const openServiceAdministration = () => {
    setSetup(null);
    dispatch({ type: "showYou" });
    if (window.location.hash !== "#you-service-admin") window.location.hash = "#you-service-admin";
    else requestAnimationFrame(() => scrollYouTarget("you-service-admin"));
  };
  const previousView = useRef(state.activeView);
  /** Set while a navigation came from the address bar, so the mirror effect below
   *  does not immediately write the same value back into history. */
  const guidedByHash = useRef(false);
  useEffect(() => {
    if (previousView.current !== state.activeView) setSetup(null);
    previousView.current = state.activeView;
  }, [state.activeView]);
  const bud = state.bots.find((b) => b.id === "bud" || b.name === "Bud") ?? state.bots[0];
  // Once someone leaves a stopped setup, a later retry never pulls them back.
  const [leftSetup, setLeftSetup] = useState(false);
  const recovering = Boolean(state.desk?.recovery?.active);
  // The office link comes first; once linked, Bud's own setup cover takes over.
  // A computer last read as not linked keeps the screen while the service reconnects.
  const officeLink = useOfficeLinkView(state.connected, { keepLastRead: true });
  // Desk is home: fetch its code while the service answers. The browser keeps a chunk that failed
  // during an outage failed until reload, and the link gate no longer renders Desk first.
  useEffect(() => { if (state.connected) void loadDeskPage().catch(() => {}); }, [state.connected]);
  const [leftLinkGate, setLeftLinkGate] = useState(linkGateLeft);
  const linkGate = officeLinkGate(officeLink, { connected: state.connected, bookRead: state.desk !== null, recovering, preview: Boolean(DESIGN_PREVIEW_REASON), left: leftLinkGate });
  // A check that never answers hands over to the link screen's Try again and recovery.
  const [linkCheckStuck, setLinkCheckStuck] = useState(false);
  const linkCheckGaveUp = useCallback(() => setLinkCheckStuck(true), []);
  useEffect(() => { if (linkGate !== "checking") setLinkCheckStuck(false); }, [linkGate]);
  const deskRead = useRef(state.desk); deskRead.current = state.desk;
  // The screen re-reads the link itself; a book read that never answered is asked again here,
  // and a newer snapshot that arrived meanwhile is never replaced.
  const retryLinkGate = useCallback(() => {
    setLinkCheckStuck(false);
    if (deskRead.current) return;
    void api("/api/desk", undefined, { timeoutMs: 15_000 }).then(snapshot => { if (!deskRead.current) dispatch({ type: "deskSnapshot", snapshot }); }, () => {});
  }, [dispatch]);
  // Recovery is the one way past the office-link screen, for this app session; a staged restore keeps its backup target.
  const openRecoveryPastLinkGate = useCallback(() => { continueRecovery(location); setLeftLinkGate(true); }, []);
  const setupCover = budFirstSetupCover(state.hermes, { connected: state.connected, statusError: Boolean(budStatusRead.error), recovering });
  const settingUp = Boolean(setupCover) && !leftSetup;
  const setupSheetDone = budSetupSheetDone(state.hermes, { connected: state.connected, recovering, openedBySetup: setupFromFlow.current });
  useEffect(() => {
    // Once the person moves to another section or closes it, the sheet is theirs.
    if (setup !== "bud") { setupFromFlow.current = false; return; }
    if (settingUp || !setupSheetDone) return;
    // Everything is Ready: land on Desk, where Get started shows the next step.
    setupFromFlow.current = false;
    setSetup(null);
  }, [setup, settingUp, setupSheetDone]);

  useEffect(() => {
    const openSettings = () => {
      const saved = workspaceViewFromHash(window.location.hash);
      if (saved) { guidedByHash.current = true; dispatch({ type: 'showWorkspaceTab', ...(saved.id ? { id: saved.id } : {}) }); return; }
      if (youHashTarget(window.location.hash)) {
        // Keep the deep-link hash; do not let the door mirror rewrite it to `#/you`.
        // A section jump within You does not change activeView, so no mirror
        // effect will consume a new flag. Do not suppress the next door click.
        guidedByHash.current = previousView.current !== 'you';
        dispatch({ type: "showYou" });
        return;
      }
      // Door routes (`#/desk`, `#/ask`, …). Checked after the You deep links so
      // their existing root-level scheme keeps working unchanged.
      const routed = viewFromHash(window.location.hash);
      // Cancelling Back can restore this route before its queued hashchange.
      // That second event must not suppress the next ordinary door change.
      if (routed === previousView.current) { guidedByHash.current = false; return; }
      if (routed) { guidedByHash.current = true; dispatch(VIEW_ACTIONS[routed]); }
    };
    openSettings();
    // pushState (door mirror) does not fire hashchange; Back/Forward fire popstate.
    window.addEventListener("hashchange", openSettings);
    window.addEventListener("popstate", openSettings);
    const cancelNavigation = () => { guidedByHash.current = false; };
    window.addEventListener(NAVIGATION_CANCELLED, cancelNavigation);
    return () => {
      window.removeEventListener("hashchange", openSettings);
      window.removeEventListener("popstate", openSettings);
      window.removeEventListener(NAVIGATION_CANCELLED, cancelNavigation);
    };
  }, [dispatch]);

  // Mirror the active door into the address bar so a refresh, Back and a deep
  // link all land where the operator was. A change that came *from* the hash is
  // not written back, which is what stops the two from fighting.
  useEffect(() => {
    if (guidedByHash.current) { guidedByHash.current = false; return; }
    const next = state.activeView === 'workspace' ? workspaceViewHash(state.workspaceTabId) : doorHashToWrite(window.location.hash, state.activeView);
    if (next && next !== window.location.hash) window.history.pushState(null, "", next);
  }, [state.activeView, state.workspaceTabId]);

  useEffect(() => {
    // A notice names the place it is about: its work area, Schedule, or (none) Tasks.
    const go = (event: Event) => {
      const area = shownArea(event);
      if (area === "schedule") { dispatch({ type: "showRoutines" }); return; }
      if (area) openDeskArea(area); else openDeskTasks();
      dispatch({ type: "showDesk" });
    };
    window.addEventListener(SHOW_DESK_EVENT, go);
    return () => window.removeEventListener(SHOW_DESK_EVENT, go);
  }, [dispatch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (event.shiftKey || event.altKey) return;
      const wantsMeta = macDoorKeys();
      if (wantsMeta ? !event.metaKey : !event.ctrlKey) return;
      if (event.key === "1") {
        event.preventDefault();
        dispatch({ type: "showDesk" });
        return;
      }
      if (event.key === "2") {
        event.preventDefault();
        dispatch({ type: "showAsk" });
        return;
      }
      if (event.key === "3") {
        event.preventDefault();
        dispatch({ type: "showRoutines" });
        return;
      }
      if (event.key === "4") {
        event.preventDefault();
        dispatch({ type: "showYou" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  // Heal pending readiness as soon as the local service and Bud status are known.
  useEffect(() => {
    if (!state.connected || !state.hermes) return;
    let current = true;
    void (async () => {
      const { autoAttemptBookRecovery, autoRunBudReadiness } = await import("@/lib/boot-heal");
      if (state.desk?.recovery?.active) {
        await autoAttemptBookRecovery({
          recovering: true,
          onSnapshot: (snapshot) => dispatch({ type: "deskSnapshot", snapshot: snapshot as never }),
        });
      }
      if (!current || !canAdminister || budStatusRead.error) return;
      await autoRunBudReadiness({
        status: state.hermes,
        connected: state.connected,
        recovering: Boolean(state.desk?.recovery?.active),
        onStatus: (status) => dispatch({ type: "hermesStatus", status }),
      });
    })();
    return () => { current = false; };
  }, [canAdminister, budStatusRead.error, dispatch, state.connected, state.desk?.recovery?.active, state.hermes]);

  return (
    <div className="workspace-surface flex h-full flex-col">
      {DESIGN_PREVIEW_REASON && <div role="status" className="relative z-40 shrink-0 border-b border-agency/25 bg-agency-soft px-4 py-2 text-center text-[12px] leading-5 text-ink"><strong>Design preview · example data.</strong> Run real work from the RealBud app.</div>}
      <UpdateBanner />
      <HumanHandoffPanel />
      {/* Store errors surface on every page, not just the view that failed. */}
      {state.error && !setup && (
        <div className="workspace-notice fixed inset-x-0 z-[70] flex justify-center px-4">
          <ActionNotice message={state.error} onDismiss={() => dispatch({ type: "error", message: null })} />
        </div>
      )}
      {linkGate === "checking" && !linkCheckStuck ? <OfficeLinkChecking onStuck={linkCheckGaveUp} />
      : linkGate ? <WorkspaceScreen key="office-link" label="office link"><LinkOfficeScreen gate={linkGate === "checking" ? "unavailable" : linkGate} onRetry={retryLinkGate} onOpenRecovery={openRecoveryPastLinkGate} onContinueRecovery={recoveryStarted ? openRecoveryPastLinkGate : undefined} /></WorkspaceScreen>
      : settingUp ? <WorkspaceScreen key="bud-setup" label="Bud setup"><BudSetupScreen running={setupCover === "running"} onLeave={() => setLeftSetup(true)} /></WorkspaceScreen> : <>
      <DesktopShell inert={Boolean(setup)}>
        {/* Keyed on the view: each place rises in once on arrival. Pages already
            remount on switch (the ternary above), so no state contract changes. */}
        <div key={`${state.activeView}:${state.activeView === 'workspace' ? state.workspaceTabId ?? 'manage' : ''}`} className="animate-view-in flex min-h-0 min-w-0 flex-1">
          <WorkspaceScreen label={state.activeView === 'workspace' ? savedView?.label ?? 'saved views' : state.activeView === 'schedule' ? 'Schedule' : state.activeView === 'you' ? 'Workspace' : state.activeView === 'desk' ? 'Desk' : 'Work'}>
          {state.activeView === 'workspace' ? (
            state.workspaceTabId === null ? <WorkspaceTabsManager /> : savedView ? <WorkspaceSavedView key={`${savedView.id}:${savedView.view.kind}:${savedView.view.filter}`} tab={savedView} /> : <main className="h-full min-w-0 flex-1 overflow-y-auto bg-paper p-6"><h1 className="text-2xl font-semibold">{workspaceTabs.loading ? 'Loading saved view…' : 'This saved view is unavailable'}</h1><p role={workspaceTabs.error ? 'alert' : 'status'} className="mt-3 text-[14px] text-ink-secondary">{workspaceTabs.error || (workspaceTabs.loading ? 'Checking this private workspace.' : 'It may have been hidden or removed. Your records remain in their original workspace.')}</p><button className="mt-4 min-h-11 rounded border border-line bg-sheet px-3 py-2" onClick={() => dispatch({ type: 'showWorkspaceTab' })}>Manage views</button></main>
          ) : state.activeView === "desk" ? (
            <DeskPage caseEdits={deskCaseEdits.current} />
          ) : state.activeView === "schedule" ? (
            <RoutinesPage />
          ) : state.activeView === "you" ? (
            <YouPage />
          ) : bud ? (
            <ChatView bot={bud} productAsk />
          ) : (
            <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
              <Loader2 size={20} className="animate-spin" />
              <div className="text-[14px]">{state.connected ? "Bud is starting…" : "Connecting…"}</div>
            </main>
          )}
          </WorkspaceScreen>
        </div>
      </DesktopShell>
      {!setup && <ShellPalette />}
      {setup && <WorkspaceScreen key="setup" label="setup" onClose={() => setSetup(null)}><WorkspaceSetup target={setup} error={state.error} onDismissError={() => dispatch({ type: "error", message: null })} origin={state.activeView === "desk" ? "Desk" : state.activeView === "schedule" ? "Schedule" : state.activeView === "you" ? "Workspace" : "Work"} onTarget={setSetup} onServiceAdministration={openServiceAdministration} onClose={() => setSetup(null)} onAsk={() => { setSetup(null); dispatch({ type: "showAsk" }); }} onSchedule={() => { setSetup(null); dispatch({ type: "showRoutines" }); }} /></WorkspaceScreen>}
      </>}
    </div>
  );
}

/** The office-link screen's frame while the link and the book are read. It
 * lives in the main bundle so a linked computer's launch never loads the link
 * screen. Silent for a second; a check that never answers hands over to the
 * link screen's Try again and recovery. */
function OfficeLinkChecking({ onStuck }: { onStuck: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const show = window.setTimeout(() => setShown(true), 1_000);
    const stuck = window.setTimeout(onStuck, 20_000);
    return () => { window.clearTimeout(show); window.clearTimeout(stuck); };
  }, [onStuck]);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-paper">
      <WindowsTitlebar />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <main className="mx-auto flex min-h-full w-full max-w-[34rem] flex-col items-center justify-center gap-4 py-8">
          <MausAvatar color="green" state="idle" size={72} label="Bud" trackPointer={false} />
          <p role="status" className="min-h-5 text-center text-sm text-ink-secondary">{shown ? "Checking this computer’s office link…" : ""}</p>
        </main>
      </div>
    </div>
  );
}

function FirstRunGate() {
  const [initialSetup, setInitialSetup] = useState<WorkspaceSetupTarget | null>(null);
  const [saved, setSaved] = useState<OnboardingState | null>(null);
  const [entered, setEntered] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void readSavedSetup(api).then(next => {
      if (!active) return;
      // A saved recovery choice reopens recovery; the office-link screen offers Continue recovery.
      resumeSavedRecovery(next.stage, location);
      setSaved(next);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Your saved setup could not be checked.'); });
    return () => { active = false; };
  }, [attempt]);
  if (entered || firstRunDone(saved) || saved?.stage === 'recovery') return <Shell initialSetup={initialSetup} recoveryStarted={saved?.stage === 'recovery'} />;
  if (!saved) return <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-paper p-6" role={error ? 'alert' : 'status'}>
    <p>{error || 'Checking your saved setup…'}</p>
    {error && <><button className="pm-control" onClick={() => setAttempt(value => value + 1)}>Try again</button><button className="pm-control" onClick={() => { location.hash = 'you-recovery'; leaveLinkGate(); setEntered(true); }}>Open recovery</button></>}
  </main>;
  return <WorkspaceScreen label="welcome"><Onboarding initialState={saved} onDone={(target) => { setInitialSetup(target ?? null); setEntered(true); }} /></WorkspaceScreen>;
}

export default function App() {
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <WorkspaceTabsProvider><FirstRunGate /></WorkspaceTabsProvider>
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
