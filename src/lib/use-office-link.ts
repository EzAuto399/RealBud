import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { readWebsiteLinkState, type WebsiteLinkRead } from "./setup-sequence";

const LINK_CHANGED = "realbud-website-link-changed";

/** This computer's office link for presentation only: `undefined` until read,
 * `unavailable` on a failed or malformed read. Re-reads when a setup surface
 * changes the link and when the local service reconnects. Never an authority check. */
export function useOfficeLinkRead(enabled: boolean): WebsiteLinkRead {
  return useOfficeLinkStatus(enabled).link;
}

/** As `useOfficeLinkRead`, plus whether the website says the office account is
 * inactive (linked, nothing removed, check-ins paused until it is active again). */
export function useOfficeLinkStatus(enabled: boolean): { link: WebsiteLinkRead; officeInactive: boolean } {
  const [link, setLink] = useState<{ link: WebsiteLinkRead; officeInactive: boolean }>({ link: undefined, officeInactive: false });
  useEffect(() => {
    if (!enabled) { setLink({ link: undefined, officeInactive: false }); return; }
    let alive = true;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      void api("/api/office-link", undefined, { timeoutMs: 15_000 })
        .then((body: unknown) => ({ link: readWebsiteLinkState(body), officeInactive: (body as { officeInactive?: unknown } | null)?.officeInactive === true }),
          () => ({ link: "unavailable" as const, officeInactive: false }))
        .then(next => { if (alive && current === generation) setLink(next); });
    };
    load();
    window.addEventListener(LINK_CHANGED, load);
    return () => { alive = false; window.removeEventListener(LINK_CHANGED, load); };
  }, [enabled]);
  return link;
}
