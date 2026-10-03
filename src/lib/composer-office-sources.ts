import { officeSourceState, type ConnectedAppsStatus, type OfficeSourceState } from "@shared/office-sources";

/** Include recoverable connections and a sign-in before it appears in a status response. */
export function composerOfficeSourceSlugs(snapshot: ConnectedAppsStatus | null, pendingService: string | null) {
  return [...new Set([
    ...Object.keys(snapshot?.services ?? {}).filter(slug => {
      const service = snapshot!.services[slug];
      return service.connected || service.accounts.length > 0 || /init|pending|expir|revok|fail|error|unauth/i.test(service.status);
    }),
    ...(pendingService ? [pendingService] : []),
  ])];
}

export function composerOfficeSourceState(snapshot: ConnectedAppsStatus | null, slug: string, pendingService: string | null, error: string): OfficeSourceState {
  if (pendingService === slug) return "signing-in";
  if (error) return "degraded";
  const state = officeSourceState(snapshot, slug);
  if (state === "choose-account" && !snapshot?.services[slug]?.accounts.some(account => /^active$/i.test(account.status))) return "degraded";
  return state;
}

export const COMPOSER_SOURCE_LABELS: Record<OfficeSourceState, string> = {
  ready: "Available",
  unchecked: "Check access",
  "signing-in": "Finish sign-in in your browser",
  "choose-account": "Choose an account to continue",
  excluded: "Not available in Ask",
  degraded: "Needs attention",
  connect: "Not connected",
  setup: "Set up connection",
};
