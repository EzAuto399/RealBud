import { lazy, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Sidebar } from "@/components/Sidebar";
const ChatView = lazy(() => import("@/components/ChatView").then((mod) => ({ default: mod.ChatView })));
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { RoutinesPage } from "@/components/RoutinesPage";
import { DeskPage } from "@/components/DeskPage";
import { YouPage } from "@/components/YouPage";
import { Onboarding } from "@/components/Onboarding";
import { firstRunDone } from "@/lib/first-run";
import { SHOW_DESK_EVENT } from "@/lib/notify-desktop";

function macDoorKeys(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac/i.test(uaData?.platform ?? navigator.platform);
}

function Shell() {
  const { state, dispatch } = useStore();
  const bud = state.bots.find((b) => b.id === "bud" || b.name === "Bud") ?? state.bots[0];

  useEffect(() => {
    const go = () => dispatch({ type: "showDesk" });
    window.addEventListener(SHOW_DESK_EVENT, go);
    return () => window.removeEventListener(SHOW_DESK_EVENT, go);
  }, [dispatch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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

  return (
    <div className="flex h-full flex-col">
      <UpdateBanner />
      {/* Store errors surface on every page, not just the view that failed. */}
      {state.error && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
          <div
            role="alert"
            className="animate-panel-in max-w-[520px] rounded-lg border border-danger/30 bg-sheet px-3.5 py-2.5 text-[13px] text-danger shadow-lg"
          >
            {state.error}
          </div>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <Sidebar />
        {/* Keyed on the view: each place rises in once on arrival. Pages already
            remount on switch (the ternary above), so no state contract changes. */}
        <div key={state.activeView} className="animate-view-in flex min-h-0 min-w-0 flex-1">
          {state.activeView === "desk" ? (
            <DeskPage />
          ) : state.activeView === "schedule" ? (
            <RoutinesPage />
          ) : state.activeView === "you" ? (
            <YouPage />
          ) : bud ? (
            <Suspense
              fallback={
                <main className="flex h-full min-w-0 flex-1 items-center justify-center bg-paper text-ink-muted">
                  <Loader2 size={20} className="animate-spin" />
                </main>
              }
            >
              <ChatView bot={bud} productAsk />
            </Suspense>
          ) : (
            <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
              <Loader2 size={20} className="animate-spin" />
              <div className="text-[14px]">{state.connected ? "Bud is starting…" : "Connecting…"}</div>
            </main>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [welcome, setWelcome] = useState(() => !firstRunDone());
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        {welcome ? <Onboarding onDone={() => setWelcome(false)} /> : <Shell />}
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
