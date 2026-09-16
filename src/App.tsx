import { openDeskTasks } from "@/lib/desk-view-state";
import { HumanHandoffPanel } from "@/components/HumanHandoffPanel";
import { hasPropertyEdits } from "@/lib/property-edits";
import { youHashTarget } from "@/lib/you-navigation";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { RoutinesPage } from "@/components/RoutinesPage";
import { DeskPage } from "@/components/DeskPage";
import type { CaseEdit } from "@/components/desk/DeskCase";
import { YouPage } from "@/components/YouPage";
import { Onboarding } from "@/components/Onboarding";
import { firstRunDone } from "@/lib/first-run";
import { doorHashToWrite, viewFromHash, type DeskView } from "@/lib/app-route";
import { SHOW_DESK_EVENT } from "@/lib/notify-desktop";
import { WorkspaceSetup } from "@/components/WorkspaceSetup";
import { WORKSPACE_SETUP_EVENT, isWorkspaceSetupTarget, type WorkspaceSetupTarget } from "@/lib/workspace-setup";
import { ActionNotice } from "@/components/ActionNotice";

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
      if (!hasPropertyEdits() && deskCaseEdits.current.size === 0) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const { state, dispatch } = useStore();
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
      if (youHashTarget(window.location.hash)) {
        // Keep the deep-link hash; do not let the door mirror rewrite it to `#/you`.
        guidedByHash.current = true;
        dispatch({ type: "showYou" });
        return;
      }
      // Door routes (`#/desk`, `#/ask`, …). Checked after the You deep links so
      // their existing root-level scheme keeps working unchanged.
      const routed = viewFromHash(window.location.hash);
      if (routed) { guidedByHash.current = true; dispatch(VIEW_ACTIONS[routed]); }
    };
    openSettings();
    // pushState (door mirror) does not fire hashchange; Back/Forward fire popstate.
    window.addEventListener("hashchange", openSettings);
    window.addEventListener("popstate", openSettings);
    return () => {
      window.removeEventListener("hashchange", openSettings);
      window.removeEventListener("popstate", openSettings);
    };
  }, [dispatch]);

  // Mirror the active door into the address bar so a refresh, Back and a deep
  // link all land where the operator was. A change that came *from* the hash is
  // not written back, which is what stops the two from fighting.
  useEffect(() => {
    if (guidedByHash.current) { guidedByHash.current = false; return; }
    const next = doorHashToWrite(window.location.hash, state.activeView);
    if (next) window.history.pushState(null, "", next);
  }, [state.activeView]);

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
        <div key={state.activeView} className="animate-view-in flex min-h-0 min-w-0 flex-1">
          {state.activeView === "desk" ? (
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
        </div>
      </div>
      {setup && <WorkspaceSetup target={setup} error={state.error} onDismissError={() => dispatch({ type: "error", message: null })} origin={state.activeView === "desk" ? "Desk" : state.activeView === "schedule" ? "Schedule" : state.activeView === "you" ? "You" : "Ask"} onTarget={setSetup} onClose={() => setSetup(null)} onAsk={() => { setSetup(null); dispatch({ type: "showAsk" }); }} onSchedule={() => { setSetup(null); dispatch({ type: "showRoutines" }); }} />}
    </div>
  );
}

export default function App() {
  const [initialSetup, setInitialSetup] = useState<WorkspaceSetupTarget | null>(null);
  const [welcome, setWelcome] = useState(() => !firstRunDone());
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        {welcome ? <Onboarding onDone={(target) => { setInitialSetup(target ?? null); setWelcome(false); }} /> : <Shell initialSetup={initialSetup} />}
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
