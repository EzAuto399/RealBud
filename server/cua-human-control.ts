import type { LoginBinding } from "./human-handoffs.ts";
export async function cuaHumanControl(action: "release" | "verify" | "restore", binding?: LoginBinding, requestId?: string) {
  const endpoint = process.env.REALBUD_CUA_CONTROL_URL;
  const token = process.env.REALBUD_CUA_CONTROL_TOKEN;
  if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) || !token) throw new Error("The private desktop host is unavailable. Open this work in the RealBud desktop app.");
  const response = await fetch(`${endpoint}/${action}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ binding, requestId }), signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error("The private desktop host needs recovery.");
  const result = await response.json() as { released?: boolean; verified?: boolean; restored?: boolean };
  if (action === "release" && result.released !== true) throw new Error("Desktop release is unconfirmed.");
  if (action === "restore" && result.restored !== true) throw new Error("Desktop restart is unconfirmed.");
  return result;
}
