import { officeSourceState, OFFICE_SOURCE_LABELS } from "@shared/office-sources";
import type { ConnectedAppsMode } from "@/components/GmailReadOnlySetup";
import {
  EMAIL_APPS,
  activeConnectedAccounts,
  type ConnectedAppsStatus,
  type EmailApp,
  canPrepareConnectedEmail,
  selectedConnectedAccount,
} from "@/lib/connected-apps";

export type OfficeMailRowState =
  | "signing-in"
  | "degraded"
  | "excluded"
  | "loading"
  | "error"
  | "setup"
  | "choose-account"
  | "connect"
  | "reconnect"
  | "connected"
  | "preview";

export interface OfficeMailRow {
  app: EmailApp;
  label: string;
  state: OfficeMailRowState;
  detail: string;
  accountId: string;
}

/** Which mail apps the Composer panel may show. */
export function officeToolkitMailApps(mode: ConnectedAppsMode): EmailApp[] {
  return mode === "gmail-readonly" ? ["gmail"] : ["gmail", "outlook"];
}

export function officeMailRow(
  app: EmailApp,
  snapshot: ConnectedAppsStatus | null,
  opts: { loading?: boolean; loadError?: string; mode: ConnectedAppsMode },
): OfficeMailRow {
  const label = EMAIL_APPS.find((row) => row.slug === app)!.label;
  if (opts.loading) return { app, label, state: "loading", detail: "Checking…", accountId: "" };
  if (opts.loadError) return { app, label, state: "error", detail: "Couldn’t refresh — try again", accountId: "" };
  if (!snapshot?.configured) {
    return { app, label, state: "setup", detail: "Add key here", accountId: "" };
  }
  if (app === "outlook" && opts.mode === "consumer") {
    const service = snapshot.services.outlook;
    if (!service?.connected) {
      return { app, label, state: "preview", detail: "Connect (preview)", accountId: "" };
    }
  }
  const status = officeSourceState(snapshot, app);
  if (status === "degraded" || status === "excluded" || status === "signing-in") return { app, label, state: status, detail: OFFICE_SOURCE_LABELS[status], accountId: "" };
  const service = snapshot.services[app];
  if (snapshot.error || (service && !service.connected && /expir|revok|fail|error|unauth/i.test(service.status))) {
    return { app, label, state: "reconnect", detail: "Reconnect", accountId: "" };
  }
  if (service?.accountSelectionRequired || (service && selectedConnectedAccount(service) === null && service.connected)) {
    return { app, label, state: "choose-account", detail: "Choose account", accountId: "" };
  }
  const account = selectedConnectedAccount(service);
  if (account && canPrepareConnectedEmail(snapshot, app, account.id)) {
    return {
      app,
      label,
      state: "connected",
      detail: account.label ? account.label : "Connected",
      accountId: account.id,
    };
  }
  if (service?.connected && account) {
    return { app, label, state: "degraded", detail: "App access needs a refresh", accountId: "" };
  }
  if (service?.connected) {
    return { app, label, state: "choose-account", detail: "Choose account", accountId: "" };
  }
  return { app, label, state: "connect", detail: "Connect", accountId: "" };
}

export function officeToolkitRows(
  snapshot: ConnectedAppsStatus | null,
  opts: { loading?: boolean; loadError?: string; mode: ConnectedAppsMode },
): OfficeMailRow[] {
  return officeToolkitMailApps(opts.mode).map((app) => officeMailRow(app, snapshot, opts));
}

export function officeToolkitAccounts(snapshot: ConnectedAppsStatus | null, app: EmailApp) {
  return activeConnectedAccounts(snapshot?.services[app]);
}
