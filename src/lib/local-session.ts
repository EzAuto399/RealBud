// Ordinary loopback application session; never service-admin authority.
// The token never comes over HTTP. The desktop window asks Electron main over
// IPC (main reads the service's private file). A plain browser tab (development,
// QA) uses a token its owner pasted, kept only in this tab's session storage.
export const LOCAL_SESSION_REQUIRED_EVENT = "realbud-local-session-required";
export const BROWSER_SESSION_KEY = "realbud.localSession";
const valid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{48}$/.test(value);

let sessionToken = "";
let desktopRead: Promise<string> | null = null;

function desktopBridge(): (() => Promise<string>) | undefined {
  return typeof window !== "undefined" && typeof window.ogb?.getLocalSession === "function" ? window.ogb.getLocalSession : undefined;
}

function storedToken(): string {
  try {
    const value = window.sessionStorage.getItem(BROWSER_SESSION_KEY);
    return valid(value) ? value : "";
  } catch { return ""; }
}

function required(): Error {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOCAL_SESSION_REQUIRED_EVENT));
  return Object.assign(new Error("Connect this tab to the RealBud office service first."), { code: "local_session_required" });
}

/** Whether a plain browser tab already holds an owner-supplied token. */
export function hasBrowserSession(): boolean {
  return !!desktopBridge() || !!sessionToken || (typeof window !== "undefined" && !!storedToken());
}

/** An owner action in a plain browser tab; never sent anywhere but this service. */
export function setBrowserSessionToken(value: string): void {
  if (!valid(value)) throw Object.assign(new Error("That is not a RealBud connection token."), { code: "local_session_invalid" });
  sessionToken = value;
  try { window.sessionStorage.setItem(BROWSER_SESSION_KEY, value); } catch { /* memory only */ }
}

/** The service refused the token it was given even after a refresh. The desktop
 * asks main again next time; a browser tab must be reconnected by its owner. */
export function rejectLocalSession(): void {
  sessionToken = "";
  if (!desktopBridge()) try { window.sessionStorage.removeItem(BROWSER_SESSION_KEY); } catch { /* already gone */ }
  required();
}

export async function ensureSession(force = false): Promise<string> {
  if (sessionToken && !force) return sessionToken;
  const bridge = desktopBridge();
  if (!bridge) {
    // A browser tab cannot mint a token; `force` reuses the owner's one until
    // the service rejects it (rejectLocalSession).
    sessionToken = sessionToken || (typeof window !== "undefined" ? storedToken() : "");
    if (sessionToken) return sessionToken;
    throw required();
  }
  sessionToken = "";
  desktopRead ??= bridge().then(token => {
    if (!valid(token)) throw new Error("session refused");
    sessionToken = token;
    return token;
  }).finally(() => { desktopRead = null; });
  return desktopRead;
}

/** Binary-capable local fetch. Retry only an explicit pre-dispatch handshake
 * rejection, never a provider/entitlement error or an uncertain result. */
export async function localSessionFetch(path: string, init: RequestInit): Promise<Response> {
  if (!path.startsWith("/api/") || path.includes("\\") || path.includes("..")) throw new Error("Local API path required.");
  const request = async (force = false) => {
    const token = await ensureSession(force);
    init.signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    headers.set("x-realbud-session", token);
    return fetch(path, { ...init, headers });
  };
  const sessionRefused = async (response: Response) => response.status === 401 && (await response.clone().json().catch(() => ({}))).error === "session required";
  let response = await request();
  if (await sessionRefused(response)) {
    response = await request(true);
    if (await sessionRefused(response)) rejectLocalSession();
  }
  return response;
}
