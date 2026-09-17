// Ordinary loopback application handshake; never service-admin authority.
let sessionToken = "";
export async function ensureSession(force = false): Promise<string> {
  if (sessionToken && !force) return sessionToken;
  sessionToken = "";
  const response = await fetch("/api/session");
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.token !== "string" || !body.token) throw new Error(body.error ?? "session refused");
  sessionToken = body.token;
  return sessionToken;
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
  let response = await request();
  if (response.status === 401 && (await response.clone().json().catch(() => ({}))).error === "session required") response = await request(true);
  return response;
}
