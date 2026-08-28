import { useState } from "react";
import { Loader2 } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { RoutinesPage } from "@/components/RoutinesPage";
import { DeskPage } from "@/components/DeskPage";
import { YouPage } from "@/components/YouPage";
import { AskConnectSheet } from "@/components/AskConnectSheet";
import { Onboarding } from "@/components/Onboarding";
import { SetupJourney } from "@/components/SetupJourney";
import { ProactiveReminderBridge } from "@/components/ProactiveReminderBridge";
import {
  nextWorkerSetupOperation,
  onboardingComplete,
  setSetupJourneyPending,
  setupJourneyPending,
  workerVerified,
} from "@/lib/onboarding";

function Shell() {
  const { state, dispatch } = useStore();
  const [onboardingOpen, setOnboardingOpen] = useState(() => !onboardingComplete());
  const [setupJourneyOpen, setSetupJourneyOpen] = useState(
    () => onboardingComplete() && setupJourneyPending(),
  );
  const bud = state.bots.find((b) => b.id === "bud" || b.name === "Bud") ?? state.bots[0];
  const workerOperation = nextWorkerSetupOperation({
    worker: state.hermes,
    workerIsVerified: workerVerified(state.hermes),
  });
  const setupRequired = Boolean(state.hermes) && workerOperation !== "done";
  const openSetupJourney = () => {
    setSetupJourneyPending(true);
    setSetupJourneyOpen(true);
  };

  if (onboardingOpen) {
    return (
      <Onboarding
        onDone={() => {
          setOnboardingOpen(false);
          setSetupJourneyOpen(true);
        }}
      />
    );
  }

  if (setupJourneyOpen || setupRequired) {
    return (
      <div className="h-full bg-paper">
        {bud ? <ProactiveReminderBridge botId={bud.id} /> : null}
        <SetupJourney
          onClose={() => {
            if (nextWorkerSetupOperation({
              worker: state.hermes,
              workerIsVerified: workerVerified(state.hermes),
            }) !== "done") return;
            setSetupJourneyPending(false);
            setSetupJourneyOpen(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {bud ? <ProactiveReminderBridge botId={bud.id} /> : null}
      <UpdateBanner />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <div key={state.activeView} className="desk-door flex min-h-0 min-w-0 flex-1 flex-col">
          {state.activeView === "desk" ? (
            <DeskPage onOpenSetupJourney={openSetupJourney} />
          ) : state.activeView === "schedule" ? (
            <RoutinesPage />
          ) : state.activeView === "you" ? (
            <YouPage onOpenSetupJourney={openSetupJourney} />
          ) : bud ? (
            <ChatView bot={bud} productAsk onOpenSetupJourney={openSetupJourney} />
          ) : (
            <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
              <Loader2 size={20} className="animate-spin" />
              <div className="text-[14px]">{state.connected ? "Bud is starting…" : "Connecting…"}</div>
            </main>
          )}
        </div>
      </div>
      {state.askConnect ? (
        <AskConnectSheet
          request={state.askConnect}
          canBack={state.askConnectStack.length > 0}
          onBack={() => dispatch({ type: "popAskConnect" })}
          onClose={() => dispatch({ type: "closeAskConnect" })}
          onOpenSetupJourney={openSetupJourney}
        />
      ) : null}
    </div>
  );
}

export default function App() {
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
