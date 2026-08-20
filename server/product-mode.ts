// Server-enforced RealBud product mode. Hidden UI is not enough.

export const PRODUCT_MODE = process.env.OMB_TEST_FLEET === "1" ? false : true;

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
  if (/^\/api\/bots\/[\w-]+\/computer(\/|$)/.test(path)) {
    return "Cloud computers are not part of RealBud. Portal work uses a bounded Desk session.";
  }
  if (path === "/api/local-computer/screenshot" && method === "POST") {
    return "Raw computer screenshots are not available from Ask.";
  }
  return null;
}

export function isCanonicalBud(id: string): boolean {
  return id === CANONICAL_BUD_ID;
}
