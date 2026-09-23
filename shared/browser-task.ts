// Browser task grant: what one task may do in the person's own signed-in
// browser. The request authorises the task's routine steps; consequential
// actions (pay, sign, send, notice, delete, account change) are always asked
// once, per instance, with the verified facts. Dependency-free: the server
// builds and enforces grants (server/browser-authority.ts), the app may show them.

export const BROWSER_TASK_GRANT_VERSION = 1 as const;
export const BROWSER_TASK_GRANT_PURPOSE = "browser-task-grant" as const;
export const BROWSER_TASK_ROUTES = ["ask", "job", "schedule", "recovery"] as const;
export const BROWSER_ACTION_CLASSES = ["read", "navigate", "fill", "click", "download", "upload", "keys", "submit"] as const;
export const BROWSER_CONSEQUENTIAL_KINDS = ["pay", "sign", "send", "notice", "delete", "account-change"] as const;
/** Not configurable: every consequential action is approved once, per instance. */
export const BROWSER_CONSEQUENTIAL_POLICY = "ask-each" as const;

export type BrowserTaskRoute = (typeof BROWSER_TASK_ROUTES)[number];
export type BrowserActionClass = (typeof BROWSER_ACTION_CLASSES)[number];
export type BrowserConsequentialKind = (typeof BROWSER_CONSEQUENTIAL_KINDS)[number];

/** A file the person gave this task to upload. The name is its id: RealBud
 * resolves it inside the task's private folder, so the model never supplies a path. */
export interface BrowserTaskUpload {
  name: string;
  sha256: string;
}

export interface BrowserTaskGrant {
  version: typeof BROWSER_TASK_GRANT_VERSION;
  purpose: typeof BROWSER_TASK_GRANT_PURPOSE;
  id: string;
  runId: string;
  route: BrowserTaskRoute;
  /** The person's request that authorises this task, and its sha256. */
  request: { text: string; sha256: string };
  /** Exact HTTPS sites (host or https origin) the task may use. */
  sites: string[];
  /** The selected browser and the visible account label, when verified. */
  browser: { id: string | null; accountMarker: string | null };
  actions: BrowserActionClass[];
  consequential: typeof BROWSER_CONSEQUENTIAL_POLICY;
  uploads: BrowserTaskUpload[];
  /** Epoch milliseconds; null means the grant ends with its run. */
  expiresAt: number | null;
  /** Maximum dispatched browser actions; null means the run's own limits apply. */
  budget: number | null;
}

/** Saved jobs without an explicit grant keep exactly their earlier behaviour:
 * any portal capability reads, opens and clicks on the job's site (every
 * click still asks), prefill fills ordinary fields, and Submit is its own
 * opt-in. Download, upload and key presses were never available to them. */
export function legacyBrowserActions(capabilities: readonly string[]): BrowserActionClass[] {
  const portal = ["portal-read", "portal-prefill", "portal-submit"].some(capability => capabilities.includes(capability));
  if (!portal) return [];
  const actions: BrowserActionClass[] = ["read", "navigate", "click"];
  if (capabilities.includes("portal-prefill")) actions.push("fill");
  if (capabilities.includes("portal-submit")) actions.push("submit");
  return actions;
}

const INVALID = "This browser task permission is incomplete or damaged. Start the task again from your request.";
const invalid = (): never => { throw new Error(INVALID); };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const label = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const requestText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;
/** One plain file name that is the same on every platform: no folders, drive
 * or stream separators, wildcard characters, or trailing dot or space. */
export function browserTaskUploadName(value: unknown): value is string {
  return label(value, 255) && !/[\\/:*?"<>|]/.test(value) && value.trim() === value && !/^\.+$/.test(value) && !value.endsWith(".");
}

/** An exact HTTPS site: a bare host or an https origin, no path, port or credentials. */
export function browserTaskSite(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 260 || /\s/.test(value)) return false;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && url.hostname.includes(".") &&
      (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash &&
      (value.includes("://") ? url.origin === value.replace(/\/$/, "") : url.hostname === value.toLowerCase());
  } catch { return false; }
}

function unique<T extends string>(values: unknown, allowed: readonly T[], max: number): T[] {
  if (!Array.isArray(values) || values.length > max) invalid();
  const seen = new Set<string>();
  for (const value of values as unknown[]) {
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value) || seen.has(value)) invalid();
    seen.add(value as string);
  }
  return [...(values as T[])];
}

/** Validates a stored or transmitted grant. Unknown keys, versions and a
 * consequential policy other than `ask-each` are rejected. */
export function parseBrowserTaskGrant(value: unknown): BrowserTaskGrant {
  const row = exact(value, ["version", "purpose", "id", "runId", "route", "request", "sites", "browser", "actions", "consequential", "uploads", "expiresAt", "budget"]);
  if (row.version !== BROWSER_TASK_GRANT_VERSION || row.purpose !== BROWSER_TASK_GRANT_PURPOSE) invalid();
  if (!identifier(row.id) || !identifier(row.runId)) invalid();
  if (typeof row.route !== "string" || !(BROWSER_TASK_ROUTES as readonly string[]).includes(row.route)) invalid();
  const request = exact(row.request, ["text", "sha256"]);
  if (!requestText(request.text) || !sha256(request.sha256)) invalid();
  // An empty list is valid and reaches nothing; it never widens to "any site".
  if (!Array.isArray(row.sites) || row.sites.length > 20 || !row.sites.every(browserTaskSite) ||
    new Set(row.sites).size !== row.sites.length) invalid();
  const browser = exact(row.browser, ["id", "accountMarker"]);
  if ((browser.id !== null && !label(browser.id, 200)) || (browser.accountMarker !== null && !label(browser.accountMarker, 200))) invalid();
  const actions = unique(row.actions, BROWSER_ACTION_CLASSES, BROWSER_ACTION_CLASSES.length);
  if (row.consequential !== BROWSER_CONSEQUENTIAL_POLICY) invalid();
  if (!Array.isArray(row.uploads) || row.uploads.length > 20) invalid();
  const uploads = (row.uploads as unknown[]).map(item => {
    const upload = exact(item, ["name", "sha256"]);
    if (!browserTaskUploadName(upload.name) || !sha256(upload.sha256)) invalid();
    return { name: upload.name as string, sha256: upload.sha256 as string };
  });
  // The name is the file's id; two files with one name would be ambiguous.
  if (new Set(uploads.map(upload => upload.name.toLowerCase())).size !== uploads.length) invalid();
  if (row.expiresAt !== null && !timestamp(row.expiresAt)) invalid();
  if (row.budget !== null && !(Number.isSafeInteger(row.budget) && Number(row.budget) >= 1 && Number(row.budget) <= 10_000)) invalid();
  return {
    version: BROWSER_TASK_GRANT_VERSION,
    purpose: BROWSER_TASK_GRANT_PURPOSE,
    id: row.id as string,
    runId: row.runId as string,
    route: row.route as BrowserTaskRoute,
    request: { text: request.text as string, sha256: request.sha256 as string },
    sites: [...(row.sites as string[])],
    browser: { id: browser.id as string | null, accountMarker: browser.accountMarker as string | null },
    actions,
    consequential: BROWSER_CONSEQUENTIAL_POLICY,
    uploads,
    expiresAt: row.expiresAt as number | null,
    budget: row.budget as number | null,
  };
}
