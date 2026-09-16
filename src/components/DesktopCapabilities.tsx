import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { initialDesktopCapabilities, loadDesktopCapabilities } from "@/lib/desktop";

type DesktopState = {
  capabilities: DesktopCapabilities;
  ready: boolean;
};

const DesktopContext = createContext<DesktopState>({
  capabilities: initialDesktopCapabilities(),
  ready: !window.ogb,
});

export function DesktopCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopState>(() => ({
    capabilities: initialDesktopCapabilities(),
    ready: !window.ogb,
  }));

  useEffect(() => {
    let alive = true;
    void loadDesktopCapabilities().then(async (capabilities) => {
      if (!alive) return;
      setState({ capabilities, ready: true });
      // Warm the mic prompt once at boot when dictation ships with this build,
      // so Hold to speak does not fail with a banner on first use.
      if (capabilities.dictation.available) {
        const { warmMicrophoneAccess } = await import("@/lib/boot-heal");
        if (alive) void warmMicrophoneAccess();
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  return <DesktopContext.Provider value={state}>{children}</DesktopContext.Provider>;
}

export function useDesktopCapabilities(): DesktopState {
  return useContext(DesktopContext);
}
