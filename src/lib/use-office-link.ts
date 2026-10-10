import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { NO_OFFICE_FACTS, readOfficeLinkFacts, type OfficeLinkFacts, type WebsiteLinkRead } from "./setup-sequence";

const LINK_CHANGED = "realbud-website-link-changed";

/** This computer's office link for presentation only. `link` is `undefined`
 * until read and `unavailable` on a failed or malformed read; `revoked` (the
 * website no longer accepts this computer) is distinct from never linked and
 * from an inactive office. Never an authority check. */
export type OfficeLinkView = Omit<OfficeLinkFacts, "link"> & { link: WebsiteLinkRead };

const UNREAD: OfficeLinkView = { ...NO_OFFICE_FACTS, link: undefined };
const FAILED: OfficeLinkView = { ...NO_OFFICE_FACTS, link: "unavailable" };

// One shared read for every surface: concurrent mounts reuse the read in flight.
let current = UNREAD;
let generation = 0;
let inFlight = false;
const listeners = new Set<() => void>();

function load() {
  const request = ++generation;
  inFlight = true;
  void api("/api/office-link", undefined, { timeoutMs: 15_000 })
    // A fresh object per failure, so a retry that fails again still re-renders.
    .then((body: unknown): OfficeLinkView => readOfficeLinkFacts(body), () => ({ ...FAILED }))
    .then(next => {
      if (request !== generation) return;
      inFlight = false;
      current = next;
      for (const listener of listeners) listener();
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // A setup surface changed the link: read again at once, even over a read in flight.
  if (listeners.size === 1) window.addEventListener(LINK_CHANGED, load);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener(LINK_CHANGED, load);
  };
}

/** The shared office-link read. Re-reads when a setup surface changes the
 * link and when the local service reconnects (`enabled` turns true). */
export function useOfficeLinkView(enabled: boolean): OfficeLinkView {
  const view = useSyncExternalStore(subscribe, () => current, () => current);
  useEffect(() => { if (enabled && !inFlight) load(); }, [enabled]);
  return enabled ? view : UNREAD;
}

/** As `useOfficeLinkView`, link state only. */
export function useOfficeLinkRead(enabled: boolean): WebsiteLinkRead {
  return useOfficeLinkView(enabled).link;
}

/** As `useOfficeLinkRead`, plus whether the website says the office account is
 * inactive (linked, nothing removed, check-ins paused until it is active again). */
export function useOfficeLinkStatus(enabled: boolean): { link: WebsiteLinkRead; officeInactive: boolean } {
  const { link, officeInactive } = useOfficeLinkView(enabled);
  return { link, officeInactive };
}
