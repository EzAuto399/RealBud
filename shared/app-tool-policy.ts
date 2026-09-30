/**
 * One classification of a connected-app tool, shared by the desktop broker and
 * the managed gateway so both boundaries hold the same line:
 *
 * - `read`: a bounded read. The desktop lets it run without a card; the gateway
 *   forwards it.
 * - `review`: anything that writes, sends, pays, changes or is unknown. The
 *   desktop shows the person Bud's Allow card first (per instance, exact
 *   payload); the gateway forwards only what the desktop dispatched.
 * - `blocked`: destructive, bulk or administrative. Refused at both boundaries;
 *   no approval can admit it.
 *
 * The class comes from the tool's name, read as whole `_`-separated tokens
 * (so `BANK` is not `BAN` and `LIST_ALL_CHANNELS` is a list), and, when the
 * provider supplies them, MCP-style annotations. Annotations can only make a
 * tool stricter: a `readOnlyHint` never turns a write-looking name into a read,
 * and a `destructiveHint` blocks a tool whatever its name says. Unknown stays
 * `review`. Gmail is not classified here: it keeps its fixed three-tool
 * read-only allowlist in the adapters that own it. This is used only behind
 * the managed gateway; a direct connection keeps the older review-everything default.
 */
export type AppToolPolicy = "read" | "review" | "blocked";

export interface AppToolAnnotations {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
}

export const APP_TOOL_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;

/** A tool reads only when its verb is one of these… */
const READ_VERBS = new Set([
  "GET", "LIST", "FETCH", "SEARCH", "FIND", "RETRIEVE", "READ", "DESCRIBE", "LOOKUP", "CHECK", "COUNT", "VIEW", "SHOW",
  "PREVIEW", "EXPORT", "DOWNLOAD", "INSPECT", "BROWSE", "ENUMERATE", "WHOAMI",
]);
/** …and no later token says it also changes something (`GET_OR_CREATE`, `LIST_AND_SEND`, `RUN_QUERY`). */
const WRITE_TOKENS = new Set([
  "CREATE", "UPDATE", "SET", "ADD", "SEND", "MARK", "MOVE", "REPLACE", "RUN", "EXECUTE", "OR", "AND", "QUERY", "WRITE", "PUT", "POST",
  "PATCH", "EDIT", "MODIFY", "UPSERT", "INSERT", "APPEND", "SAVE", "SUBMIT", "UPLOAD", "IMPORT", "TRIGGER", "START", "STOP", "CANCEL",
  "ARCHIVE", "RESTORE", "ASSIGN", "INVITE", "SHARE", "PUBLISH", "SCHEDULE", "GENERATE", "REGISTER", "SUBSCRIBE", "ENABLE", "DISABLE",
  "RENAME", "COPY", "REPLY", "FORWARD", "MERGE", "SYNC", "REFRESH", "ACCEPT", "REJECT", "PAY", "TRANSFER", "CHARGE", "REFUND", "APPROVE",
]);
/** A token that destroys, acts in bulk or administers blocks the tool outright. */
const BLOCKED_TOKENS = new Set([
  "DELETE", "REMOVE", "PURGE", "DESTROY", "WIPE", "ERASE", "TRUNCATE", "DROP", "PERMANENT", "PERMANENTLY", "BULK", "EMPTY",
  "REVOKE", "GRANT", "ADMIN", "PERMISSION", "PERMISSIONS", "ROLE", "ROLES", "OWNERSHIP", "ROTATE", "REGENERATE", "DEACTIVATE",
  "SUSPEND", "BAN", "UNINSTALL", "CLEAR", "RESET", "TERMINATE", "VOID", "FACTORY", "PASSWORD", "TOKEN", "TOKENS", "WEBHOOK", "WEBHOOKS",
]);

/**
 * Classify one tool by its Composio slug (`GITHUB_LIST_ISSUES`) and optional
 * annotations. `app` is the toolkit slug the tool must belong to; a name under
 * another app's namespace is `blocked` so a session cannot borrow a namespace.
 */
export function classifyAppTool(name: unknown, options: { app?: string; annotations?: AppToolAnnotations | null } = {}): AppToolPolicy {
  if (typeof name !== "string" || !APP_TOOL_NAME.test(name)) return "blocked";
  if (name.startsWith("COMPOSIO_")) return "blocked";
  let rest = name;
  if (options.app !== undefined) {
    const prefix = `${options.app.toUpperCase().replaceAll("-", "_")}_`;
    if (!name.startsWith(prefix) || name.length === prefix.length) return "blocked";
    rest = name.slice(prefix.length);
  } else {
    const cut = name.indexOf("_");
    if (cut <= 0 || cut === name.length - 1) return "blocked";
    rest = name.slice(cut + 1);
  }
  const annotations = options.annotations ?? undefined;
  if (annotations?.destructiveHint === true) return "blocked";
  const tokens = rest.split("_").filter(Boolean);
  if (!tokens.length || tokens.some(token => BLOCKED_TOKENS.has(token))) return "blocked";
  // `BATCH_GET` is a read; `BATCH_UPDATE` a write; `BATCH_DELETE` was blocked above.
  const verb = tokens[0] === "BATCH" ? tokens[1] : tokens[0];
  const reads = verb !== undefined && READ_VERBS.has(verb) && !tokens.some(token => WRITE_TOKENS.has(token));
  return reads && annotations?.readOnlyHint !== false ? "read" : "review";
}

/** The strictest class wins across a batch; an empty batch is nothing to allow. */
export function combineAppToolPolicies(policies: readonly AppToolPolicy[]): AppToolPolicy {
  if (!policies.length) return "blocked";
  if (policies.includes("blocked")) return "blocked";
  return policies.every(policy => policy === "read") ? "read" : "review";
}
