import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { readWebsiteLinkState, type WebsiteLinkRead } from "./setup-sequence";

const LINK_CHANGED = "realbud-website-link-changed";

/** This computer's office link for presentation only: `undefined` until read,
 * `unavailable` on a failed or malformed read. Re-reads when a setup surface
 * changes the link and when the local service reconnects. Never an authority check. */
export function useOfficeLinkRead(enabled: boolean): WebsiteLinkRead {
  const [link, setLink] = useState<WebsiteLinkRead>(undefined);
  useEffect(() => {
    if (!enabled) { setLink(undefined); return; }
    let alive = true;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      void api("/api/office-link", undefined, { timeoutMs: 15_000 })
        .then((body: unknown) => readWebsiteLinkState(body), () => "unavailable" as const)
        .then(next => { if (alive && current === generation) setLink(next); });
    };
    load();
    window.addEventListener(LINK_CHANGED, load);
    return () => { alive = false; window.removeEventListener(LINK_CHANGED, load); };
  }, [enabled]);
  return link;
}
