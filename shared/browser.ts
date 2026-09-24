/** A person-verified page carried into one explicit recovery attempt. */
export interface BrowserCheckpoint {
  browserId: string;
  tabId: number;
  origin: string;
  accountMarker: string;
}
export interface BrowserConnection {
  id: string;
  name: string;
  label: string;
  compatible: boolean;
}
export interface BrowserStatus {
  state: "not_installed" | "off" | "starting" | "extension_needed" | "choose_browser" | "ready" | "disconnected" | "needs_update" | "recovery_required";
  enabled: boolean;
  detail: string;
  browsers: BrowserConnection[];
  selectedBrowserId: string | null;
  active: boolean;
  checkedAt: number;
  version: string;
  port: number;
}
export const BROWSER_EXTENSION_LINKS = {
  chrome: "https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi",
  edge: "https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg",
} as const;
