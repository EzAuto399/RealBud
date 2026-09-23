import { openDeskTasks } from "@/lib/desk-view-state";
import { HumanHandoffPanel } from "@/components/HumanHandoffPanel";
import { hasPropertyEdits } from "@/lib/property-edits";
import { hasUnpersistedBillDrafts } from "@/lib/bill-review-drafts";
import { youHashTarget } from "@/lib/you-navigation";
import { NAVIGATION_CANCELLED } from "@/lib/navigation-guard";
import { lazy, useEffect, useRef, useState } from "react";
import { WorkspaceScreen } from "@/components/WorkspaceScreen";
import { Loader2 } from "lucide-react";
import { api, StoreProvider, useStore } from "@/state/store";
import { Sidebar } from "@/components/Sidebar";

import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";


import type { CaseEdit } from "@/components/desk/DeskCase";


import { createFirstRunApi, firstRunDone } from "@/lib/first-run";
import type { OnboardingState } from '@shared/onboarding';
import { doorHashToWrite, viewFromHash, workspaceViewFromHash, workspaceViewHash, type DeskView } from "@/lib/app-route";
import { WorkspaceTabsProvider, useWorkspaceTabs } from '@/lib/workspace-tabs';


import { SHOW_DESK_EVENT } from "@/lib/notify-desktop";

import { WORKSPACE_SETUP_EVENT, isWorkspaceSetupTarget, type WorkspaceSetupTarget } from "@/lib/workspace-setup";
import { ActionNotice } from "@/components/ActionNotice";

const ChatView = lazy(() => import('@/components/ChatView').then(module => ({ default: module.ChatView })));
const RoutinesPage = lazy(() => import('@/components/RoutinesPage').then(module => ({ default: module.RoutinesPage })));
const DeskPage = lazy(() => import('@/components/DeskPage').then(module => ({ default: module.DeskPage })));
const YouPage = lazy(() => import('@/components/YouPage').then(module => ({ default: module.YouPage })));
const Onboarding = lazy(() => import('@/components/Onboarding').then(module => ({ default: module.Onboarding })));
const WorkspaceTabsManager = lazy(() => import('@/components/WorkspaceTabsManager').then(module => ({ default: module.WorkspaceTabsManager })));
const WorkspaceSavedView = lazy(() => import('@/components/WorkspaceSavedView').then(module => ({ default: module.WorkspaceSavedView })));
const WorkspaceSetup = lazy(() => import('@/components/WorkspaceSetup').then(module => ({ default: module.WorkspaceSetup })));

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

function Shell({ initialSetup = null }: { initialSetup?: WorkspaceSetupTarget | null }) {
  // Keep unfinished wording in memory across navigation; never write it to disk.
  const deskCaseEdits = useRef(new Map<string, CaseEdit>());
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!hasPropertyEdits() && !hasUnpersistedBillDrafts() && deskCaseEdits.current.size === 0) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const { state, dispatch } = useStore();
  const workspaceTabs = useWorkspaceTabs();
  const savedView = workspaceTabs.data?.state?.tabs.find(tab => tab.id === state.workspaceTabId && tab.visible);
  const [setup, setSetup] = useState<WorkspaceSetupTarget | null>(initialSetup);
  useEffect(() => {
    const open = (event: Event) => {
      const target: unknown = (event as CustomEvent).detail;
      if (isWorkspaceSetupTarget(target)) setSetup(target);
    };
    window.addEventListener(WORKSPACE_SETUP_EVENT, open);
    return () => window.removeEventListener(WORKSPACE_SETUP_EVENT, open);
  }, []);
  const previousView = useRef(state.activeView);
  /** Set while a navigation came from the address bar, so the mirror effect below
   *  does not immediately write the same value back into history. */
  const guidedByHash = useRef(false);
  useEffect(() => {
    if (previousView.current !== state.activeView) setSetup(null);
    previousView.current = state.activeView;
  }, [state.activeView]);
  const bud = state.bots.find((b) => b.id === "bud" || b.name === "Bud") ?? state.bots[0];

  useEffect(() => {
    const openSettings = () => {
      const saved = workspaceViewFromHash(window.location.hash);
      if (saved) { guidedByHash.current = true; dispatch({ type: 'showWorkspaceTab', ...(saved.id ? { id: saved.id } : {}) }); return; }
      if (youHashTarget(window.location.hash)) {
        // Keep the deep-link hash; do not let the door mirror rewrite it to `#/you`.
        guidedByHash.current = true;
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
    const go = () => { openDeskTasks(); dispatch({ type: "showDesk" }); };
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
    void (async () => {
      const { autoAttemptBookRecovery, autoRunBudReadiness } = await import("@/lib/boot-heal");
      if (state.desk?.recovery?.active) {
        await autoAttemptBookRecovery({
          recovering: true,
          onSnapshot: (snapshot) => dispatch({ type: "deskSnapshot", snapshot: snapshot as never }),
        });
      }
      await autoRunBudReadiness({
        status: state.hermes,
        connected: state.connected,
        recovering: Boolean(state.desk?.recovery?.active),
        onStatus: (status) => dispatch({ type: "hermesStatus", status }),
      });
    })();
  }, [dispatch, state.connected, state.desk?.recovery?.active, state.hermes]);

  return (
    <div className="workspace-surface flex h-full flex-col">
      <UpdateBanner />
      <HumanHandoffPanel />
      {/* Store errors surface on every page, not just the view that failed. */}
      {state.error && !setup && (
        <div className="workspace-notice fixed inset-x-0 z-[70] flex justify-center px-4">
          <ActionNotice message={state.error} onDismiss={() => dispatch({ type: "error", message: null })} />
        </div>
      )}
      <div inert={Boolean(setup)} className="rb-app-shell relative flex min-h-0 flex-1">
        <Sidebar />
        {/* Keyed on the view: each place rises in once on arrival. Pages already
            remount on switch (the ternary above), so no state contract changes. */}
        <div key={`${state.activeView}:${state.activeView === 'workspace' ? state.workspaceTabId ?? 'manage' : ''}`} className="animate-view-in flex min-h-0 min-w-0 flex-1">
          <WorkspaceScreen label={state.activeView === 'workspace' ? savedView?.label ?? 'saved views' : state.activeView === 'schedule' ? 'Schedule' : state.activeView === 'you' ? 'You' : state.activeView === 'desk' ? 'Desk' : 'Ask'}>
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
      </div>
      {setup && <WorkspaceScreen key="setup" label="setup" onClose={() => setSetup(null)}><WorkspaceSetup target={setup} error={state.error} onDismissError={() => dispatch({ type: "error", message: null })} origin={state.activeView === "desk" ? "Desk" : state.activeView === "schedule" ? "Schedule" : state.activeView === "you" ? "You" : "Ask"} onTarget={setSetup} onClose={() => setSetup(null)} onAsk={() => { setSetup(null); dispatch({ type: "showAsk" }); }} onSchedule={() => { setSetup(null); dispatch({ type: "showRoutines" }); }} /></WorkspaceScreen>}
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
    void createFirstRunApi(api).read().then(next => {
      if (!active) return;
      if (next.stage === 'recovery') location.hash = 'you-recovery';
      setSaved(next);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Your saved setup could not be checked.'); });
    return () => { active = false; };
  }, [attempt]);
  if (entered || firstRunDone(saved) || saved?.stage === 'recovery') return <Shell initialSetup={initialSetup} />;
  if (!saved) return <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-paper p-6" role={error ? 'alert' : 'status'}>
    <p>{error || 'Checking your saved setup…'}</p>
    {error && <><button className="pm-control" onClick={() => setAttempt(value => value + 1)}>Try again</button><button className="pm-control" onClick={() => { location.hash = 'you-recovery'; setEntered(true); }}>Open recovery</button></>}
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
