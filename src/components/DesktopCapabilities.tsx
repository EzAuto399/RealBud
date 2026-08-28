import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  initialDesktopCapabilities,
  loadDesktopCapabilities,
  rememberDesktopCapabilities,
} from "@/lib/desktop";

type DesktopState = {
  capabilities: DesktopCapabilities;
  ready: boolean;
  refresh: () => Promise<DesktopCapabilities>;
  replace: (capabilities: DesktopCapabilities) => void;
};

const DesktopContext = createContext<DesktopState>({
  capabilities: initialDesktopCapabilities(),
  ready: typeof window === "undefined" || !window.ogb,
  refresh: async () => initialDesktopCapabilities(),
  replace: () => {},
});

export function DesktopCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [capabilities, setCapabilities] = useState<DesktopCapabilities>(() => initialDesktopCapabilities());
  const [ready, setReady] = useState(() => typeof window === "undefined" || !window.ogb);

  const replace = useCallback((next: DesktopCapabilities) => {
    rememberDesktopCapabilities(next);
    setCapabilities(next);
    setReady(true);
  }, []);

  const refresh = useCallback(async () => {
    const next = await loadDesktopCapabilities({ refresh: true });
    replace(next);
    return next;
  }, [replace]);

  useEffect(() => {
    let alive = true;
    void loadDesktopCapabilities().then((next) => {
      if (alive) replace(next);
    });
    const onFocus = () => {
      if (alive) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, replace]);

  const value = useMemo(() => ({ capabilities, ready, refresh, replace }), [capabilities, ready, refresh, replace]);
  return <DesktopContext.Provider value={value}>{children}</DesktopContext.Provider>;
}

export function useDesktopCapabilities(): DesktopState {
  return useContext(DesktopContext);
}
