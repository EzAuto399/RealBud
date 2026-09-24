// Server-enforced RealBud product mode. Hidden UI is not enough.
export const PRODUCT_MODE = process.env.OMB_TEST_FLEET === "1" ? false : true;
export const CANONICAL_BUD_ID = "bud";
export const CANONICAL_BUD_NAME = "Bud";
// Long research and file-making jobs need room to finish. These remain hard
// ceilings, while the repeated-tool limit still stops an actual loop quickly.
export const PRODUCT_TURN_DEFAULTS = Object.freeze({
    maxMs: 15 * 60_000,
    maxTools: 96,
    maxRepeatedTool: 5,
});
const DENIED = new Set([
    "POST /api/bots",
    "POST /api/groups",
    "GET /api/connectors/catalog",
    "GET /api/connectors",
    "GET /api/plugins",
]);
export function productDenied(method, path) {
    if (!PRODUCT_MODE)
        return null;
    const key = `${method} ${path}`;
    if (DENIED.has(key))
        return "RealBud is one desk and one Bud thread. That route is not part of the product.";
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
    if (method === "DELETE" && /^\/api\/bots\/[\w-]+$/.test(path)) {
        return "RealBud keeps its one Bud thread. Bud cannot be deleted.";
    }
    if (path === "/api/local-computer/screenshot" && method === "POST") {
        return "Raw computer screenshots are not available from Ask.";
    }
    return null;
}
export function isCanonicalBud(id) {
    return id === CANONICAL_BUD_ID;
}
/** Product clients need the answer stream and the terminal completion event,
 * not provider reasoning, raw tool names, or runtime diagnostics. Permission
 * cards and settled messages are projected separately by the server. A tool
 * start is forwarded only so Ask can drop pre-tool narration from the live
 * bubble — the chip itself stays hidden in product UI. */
export function productRuntimeEventVisible(event) {
    if (event.type === "turn.completed")
        return true;
    if (event.type === "content.delta" && event.streamKind === "assistant_text")
        return true;
    if (event.type === "item.started" && event.itemType === "tool")
        return true;
    return false;
}
