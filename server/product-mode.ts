import { connectorAdminRoute, connectorRoute, CONNECTORS_API } from "../shared/mcp-connector.ts";
// Server-enforced RealBud product rules. Hidden UI is not enough.

export const CANONICAL_BUD_ID = "bud";
export const CANONICAL_BUD_NAME = "Bud";

// Long research and file-making jobs need room to finish. These remain hard
// ceilings, while the repeated-tool limit still stops an actual loop quickly.
export const PRODUCT_TURN_DEFAULTS = Object.freeze({
  maxMs: 15 * 60_000,
  maxTools: 96,
  maxRepeatedTool: 5,
});

/** Share of the call or time ceiling at which Bud is asked to wrap up with
 * what it has. A notice only; the ceilings above stay the hard stop. */
export const PRODUCT_TURN_WRAP_UP_FRACTION = 0.75;

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** The product turn ceilings with their env overrides (`OMB_PRODUCT_TURN_MAX_*`);
 * the server's watchdog and the ACP wrap-up notice both read these. */
export function productTurnLimits(env: Record<string, string | undefined> = process.env) {
  return {
    maxMs: positiveInt(env.OMB_PRODUCT_TURN_MAX_MS, PRODUCT_TURN_DEFAULTS.maxMs),
    maxTools: positiveInt(env.OMB_PRODUCT_TURN_MAX_TOOLS, PRODUCT_TURN_DEFAULTS.maxTools),
    maxRepeatedTool: positiveInt(env.OMB_PRODUCT_TURN_MAX_REPEATED_TOOL, PRODUCT_TURN_DEFAULTS.maxRepeatedTool),
  };
}

/** When to ask Bud to wrap up: after this many tool calls or milliseconds. */
export function productTurnWrapUp(env: Record<string, string | undefined> = process.env) {
  const limits = productTurnLimits(env);
  return {
    afterTools: Math.max(1, Math.floor(limits.maxTools * PRODUCT_TURN_WRAP_UP_FRACTION)),
    afterMs: Math.max(1, Math.floor(limits.maxMs * PRODUCT_TURN_WRAP_UP_FRACTION)),
  };
}

const DENIED = new Set([
  "POST /api/bots",
  "POST /api/groups",
  "GET /api/connectors/catalog",
  "GET /api/plugins",
]);

export function productDenied(method: string, path: string): string | null {
  const key = `${method} ${path}`;
  if (DENIED.has(key)) return "RealBud is one desk and one Bud thread. That route is not part of the product.";
  if (method === "POST" && /^\/api\/groups(\/|$)/.test(path)) {
    return "Rooms are not part of RealBud.";
  }
  // The office's added connectors (list, add, review, remove, connection and
  // OAuth callback, plus the /api/redbark aliases) are RealBud product routes.
  if (path === CONNECTORS_API || connectorRoute(path) || connectorAdminRoute(path)) return null;
  if (method === "POST" && /^\/api\/connectors\//.test(path)) {
    return "Connectors are not part of RealBud.";
  }
  if (method === "DELETE" && /^\/api\/connectors\//.test(path)) {
    return "Connectors are not part of RealBud.";
  }
  if (/^\/api\/bots\/[\w-]+\/computer(\/|$)/.test(path)) {
    return "Cloud computers are not part of RealBud. Portal work uses a bounded Desk session.";
  }
  if (method === "DELETE" && /^\/api\/bots\/[\w-]+$/.test(path)) {
    return "RealBud keeps its one Bud thread. Bud cannot be deleted.";
  }
  if (path === "/api/local-computer/screenshot" && method === "POST") {
    return "Raw computer screenshots are not available from Ask.";
  }
  return null;
}

export function isCanonicalBud(id: string): boolean {
  return id === CANONICAL_BUD_ID;
}

/** Product clients need the answer stream and the terminal completion event,
 * not provider reasoning, raw tool names, or runtime diagnostics. Permission
 * cards and settled messages are projected separately by the server. A tool
 * start is forwarded only so Ask can drop pre-tool narration from the live
 * bubble — the chip itself stays hidden in product UI. */
export function productRuntimeEventVisible(event: {
  type: string;
  streamKind?: string;
  itemType?: string;
}): boolean {
  if (event.type === "turn.completed") return true;
  if (event.type === "content.delta" && event.streamKind === "assistant_text") return true;
  if (event.type === "item.started" && event.itemType === "tool") return true;
  return false;
}
