// Server-enforced RealBud product mode. Hidden UI is not enough.

// The packaged appliance is always RealBud, even if a hostile or stale shell
// environment happens to contain a development-fleet flag. The legacy test
// fleet remains available only to an explicitly non-packaged source process.
export const PRODUCT_MODE = process.env.REALBUD_PACKAGED === "1" || process.env.OMB_TEST_FLEET !== "1";

export const CANONICAL_BUD_ID = "bud";
export const CANONICAL_BUD_NAME = "Bud";

const DENIED = new Set([
  "POST /api/bots",
  "POST /api/groups",
  "GET /api/connectors/catalog",
  "GET /api/connectors",
  "GET /api/plugins",
]);

export function productDenied(method: string, path: string): string | null {
  if (!PRODUCT_MODE) return null;
  const key = `${method} ${path}`;
  if (DENIED.has(key)) return "RealBud is one desk and one Bud thread. That route is not part of the product.";
  if (method === "POST" && /^\/api\/groups(\/|$)/.test(path)) {
    return "Rooms are not part of RealBud.";
  }
  if (method === "POST" && /^\/api\/connectors\//.test(path)) {
    return "Connectors are not part of RealBud.";
  }
  if (method === "DELETE" && /^\/api\/connectors\//.test(path)) {
    return "Connectors are not part of RealBud.";
  }
  if (method === "PATCH" && path === "/api/work-routing/preference") return null;
  if (method !== "GET" && /^\/api\/(execution-adapters|work-routing|pilot-discovery)(\/|$)/.test(path)) {
    return "RealBud work methods are code-owned and read-only. Ask cannot add, change, or activate raw execution authority.";
  }
  if (method === "POST" && /^\/api\/instances\/[\w.-]+\/setup$/.test(path)) {
    return "RealBud installs and configures Bud only through You. Generic engine setup is not part of the product.";
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
  if (/^\/api\/local-computer(\/|$)/.test(path)) {
    return "The local-computer playground is not part of RealBud. Portal work uses a bounded Desk session.";
  }
  return null;
}

export function isCanonicalBud(id: string): boolean {
  return id === CANONICAL_BUD_ID;
}
