import { useEffect, useState } from "react";

/** Tracks a CSS media query so layout decisions (compact window, reduced
 * motion) live in one place instead of ad-hoc `window.matchMedia` reads. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Below this height the Desk header (title, tools, brief, go-live) would
 * leave the case and its wording under the fold. Electron's floor is 600px. */
export const COMPACT_WINDOW_QUERY = "(max-height: 759px)";
