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
import { Onboarding } from "@/components/Onboarding";
import { firstRunDone } from "@/lib/first-run";

function Shell() {
  const { state } = useStore();
  const bud = state.bots.find((b) => b.id === "bud" || b.name === "Bud") ?? state.bots[0];

  return (
    <div className="flex h-full flex-col">
      <UpdateBanner />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar />
        {state.activeView === "desk" ? (
          <DeskPage />
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
