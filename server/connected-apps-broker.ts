// RealBud owns this boundary; upstream tool annotations and worker permission
// modes cannot authorize an external action. Credentials never reach the worker.
import { managedService } from "./managed-service.ts";
import { ServiceEntitlementError } from "./service-entitlement.ts";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readMcpRpcResponse } from "./composio.ts";
import { redactSecrets, redactSecretsInText } from "./redact.ts";
import { connectedAppOperations, validAppToolName, validAppToolSlug, type ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { classifyAppToolCall, combineAppToolPolicies, MAIL_SENDS } from "../shared/app-tool-policy.ts";
import { managedMailboxAccess } from "./managed-connectors.ts";

const DISCOVERY = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"]);
const BLOCKED = new Set(["COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL"]);
/** The project-key Gmail reader (gmail-readonly mode) only; the managed service uses the full mailbox policy. */
const GMAIL_READ_ONLY = new Set(["GMAIL_GET_PROFILE", "GMAIL_LIST_THREADS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"]);
export const CONNECTED_APP_APPROVAL = "bud_connected_app_action";
type Call = { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
type Policy = "read" | "review" | "blocked";

export function connectedAppPolicy(call: Call, options: { managed?: boolean } = {}): Policy {
  if (!validAppToolName(call.name) || (call.arguments !== undefined &&
    (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)))) return "blocked";
  if (BLOCKED.has(call.name)) return "blocked";
  if (DISCOVERY.has(call.name)) return "read";
  if (call.name === "COMPOSIO_MANAGE_CONNECTIONS") {
    const rows = call.arguments?.toolkits;
    return Array.isArray(rows) && rows.length > 0 && rows.length <= 50 && rows.every(row =>
      row && typeof row === "object" && !Array.isArray(row) && row.action === "list" && validAppToolSlug(row.name)) ? "read" : "blocked";
  }
  if (call.name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const rows = call.arguments?.tools;
    if (!Array.isArray(rows) || !rows.length || rows.length > 50 || rows.some(row =>
      !row || typeof row !== "object" || !validAppToolSlug(row.tool_slug) ||
      row.tool_slug.startsWith("COMPOSIO_") || !row.arguments || typeof row.arguments !== "object" || Array.isArray(row.arguments))) return "blocked";
    // Behind the managed gateway a batch is as strict as its strictest member;
    // one blocked slug blocks it all, and a message is sent only on its own
    // card. A direct connection reviews every batch.
    if (!options.managed) return "review";
    if (rows.some(row => MAIL_SENDS.has(row.tool_slug))) return "blocked";
    return combineAppToolPolicies(rows.map(row => namespacedPolicy(row.tool_slug, row.arguments)));
  }
  // A direct connection keeps the original line: unknown tools, read-looking
  // names and readOnlyHint=true are not authority; everything is reviewed.
  if (!options.managed) return "review";
  // Mailbox tools follow the owner's exact slug lists (reads, drafts and
  // labels run; sends and Trash are reviewed per message; permanent delete,
  // filters, forwarding and settings are blocked). Any other app's tool is
  // classified by name: reads run, writes and unknowns are reviewed per
  // instance, destructive, bulk and administrative operations are blocked. A
  // tool's own readOnlyHint is not authority.
  return namespacedPolicy(call.name, call.arguments);
}
/** Composio tool slugs are `APP_VERB_OBJECT`; only that shape is classified.
 * Any other name (a consumer server's own tool) keeps the old default: review. */
const NAMESPACED = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;
const namespacedPolicy = (name: string, args?: unknown): Policy => NAMESPACED.test(name) ? classifyAppToolCall(name, args ?? {}) : "review";

/** Product-selected sources bind execution, including calls hidden in a batch. */
export function allowedOfficeAppCall(call: Call, allowedApps?: string[]): boolean {
  if (!allowedApps) return true; // Non-product adapters retain their explicit contract.
  if (DISCOVERY.has(call.name)) return allowedApps.length > 0;
  const allowed = (slug: unknown) => typeof slug === "string" && allowedApps.some(app => slug.toLowerCase().startsWith(`${app.toLowerCase()}_`));
  if (call.name === "COMPOSIO_MANAGE_CONNECTIONS") {
    const rows = call.arguments?.toolkits;
    return Array.isArray(rows) && rows.every(row => row?.action === "list" && allowedApps.includes(row.name));
  }
  if (call.name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const rows = call.arguments?.tools;
    return Array.isArray(rows) && rows.length > 0 && rows.every(row => allowed(row?.tool_slug));
  }
  return allowed(call.name);
}

export interface ConnectedAppsBroker {
  descriptor: { type: "http"; name: string; url: string; headers: { name: string; value: string }[] };
  cancelPending(): void;
  close(): void;
}

/** Internal adapter only: functions and credentials never enter worker config. */
export interface ConnectedAppsLocalTransport {
  request(method: string, params: unknown, signal: AbortSignal): Promise<Record<string, unknown>>;
}

const liveBrokers = new Set<ConnectedAppsBroker>();
let revocationGeneration = 0;
export const connectedAppsBrokerGeneration = (): number => revocationGeneration;
/** Revoke only connected-app capabilities; unrelated model work stays alive. */
export function revokeConnectedAppsBrokers(): void {
  revocationGeneration++;
  for (const broker of [...liveBrokers]) broker.close();
}

export async function startConnectedAppsBroker(options: {
  threadId: string;
  key: string;
  url?: string;
  headers?: Record<string, string>;
  isActive(): boolean;
  approve(summary: string, signal: AbortSignal): Promise<boolean>;
  operations?: ConnectedAppOperationStore;
  localTransport?: ConnectedAppsLocalTransport;
  /** Server-selected account shown on read approvals, never a caller argument. */
  readOnlyAccountId?: string;
  allowedApps?: string[];
  /** Upstream is the office's managed connection service (tools classified). */
  managed?: boolean;
  /** How long a reviewed draft send waits for mail calls already in flight on its mailbox. */
  mailDrainMs?: number;
}): Promise<ConnectedAppsBroker> {
  const generationAtStart = revocationGeneration;
  if (!options.key.trim()) throw new Error("Set up Bud's Connected apps key first.");
  const token = randomBytes(32).toString("hex");
  // Project Gmail uses its server-owned adapter exclusively. Its project key
  // must never be sent to a consumer MCP endpoint, even if a URL was retained.
  const upstream = options.localTransport ? null : options.url || null;
  if (!options.localTransport && !upstream) throw new Error("Connected apps need a Platform session endpoint.");
  if (upstream) {
    const target = new URL(upstream);
    if (upstream.length > 2048 || target.username || target.password || target.hash ||
      (target.protocol !== "https:" && !(target.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(target.hostname)))) throw new Error("Connected apps need a secure endpoint without embedded credentials.");
  }
  const upstreamAuth = options.headers && Object.keys(options.headers).length
    ? Object.fromEntries(Object.entries(options.headers).map(([name, value]) => [name.toLowerCase(), String(value)]))
    : { "x-api-key": options.key };
  let closed = false;
  let session: string | null = null;
  // The worker's own handshake, replayed if the gateway expires the session.
  let initializeParams: unknown = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Bud connected apps", version: "1.0.0" } };
  let refreshing: Promise<boolean> | null = null;
  let refreshCount = 0;
  let mailReadCount = 0;
  // Every Ask thread on this desktop reaches the same connected mailbox through
  // the same upstream identity, so mail calls are counted and held per
  // (upstream, credential, provider), across brokers.
  const mailIdentity = createHash("sha256").update(JSON.stringify([options.url ?? "", upstreamAuth])).digest("hex");
  let cachedBytes = 0;
  const operations = options.operations ?? connectedAppOperations;
  const controllers = new Set<AbortController>();
  // A duplicate transport request shares its original result, including denials
  // and uncertain outcomes. A changed body cannot reuse an old approval.
  const requests = new Map<string, { body: string; response: Promise<unknown> }>();
  const errorResult = (text: string) => ({ content: [{ type: "text", text }], isError: true });
  /** Open a fresh upstream session: initialize, then notifications/initialized.
   * Concurrent refusals share one refresh; a session already replaced since the
   * refused request is reused rather than opening another. */
  const refreshSession = (stale: string | null, protocolVersion: string | undefined, signal: AbortSignal): Promise<boolean> => {
    if (session !== stale) return Promise.resolve(Boolean(session));
    refreshing ??= (async () => {
      try {
        session = null;
        const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...upstreamAuth };
        if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
        const rpcId = `bud-session-refresh-${++refreshCount}`;
        const initialized = await fetch(upstream!, { method: "POST", headers, redirect: "error", signal,
          body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "initialize", params: initializeParams }) });
        const fresh = initialized.headers.get("mcp-session-id");
        if (!initialized.ok || !fresh) { await initialized.body?.cancel().catch(() => {}); return false; }
        await readMcpRpcResponse(initialized, rpcId, signal);
        const notified = await fetch(upstream!, { method: "POST", headers: { ...headers, "mcp-session-id": fresh }, redirect: "error", signal,
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
        await notified.body?.cancel().catch(() => {});
        if (!notified.ok) return false;
        session = fresh;
        return true;
      } catch { return false; } finally { refreshing = null; }
    })();
    return refreshing;
  };
  /** A broker-internal read through the same managed session, used only to
   * show the person what a reviewed send will actually deliver. No receipt:
   * it reads, and its result never reaches the worker. */
  const upstreamRead = async (name: string, args: Record<string, unknown>, protocolVersion: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const rpcId = `bud-mail-review-${++mailReadCount}`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } });
    const post = () => {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...upstreamAuth, ...(session ? { "mcp-session-id": session } : {}) };
      if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
      return fetch(upstream!, { method: "POST", headers, body, redirect: "error", signal });
    };
    const used = session;
    let response = await post();
    if (response.status === 409 && await gatewayErrorCode(response) === "connector_session_expired" && await refreshSession(used, protocolVersion, signal)) response = await post();
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("The mail service did not answer the review read."); }
    if (response.headers.has("mcp-session-id")) session = response.headers.get("mcp-session-id");
    return await readMcpRpcResponse(response, rpcId, signal);
  };
  const server = createServer((req, res) => {
    void (async () => {
      if (closed || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
      if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(405).end(); return; }
      const timer = setTimeout(() => req.destroy(), 10_000); timer.unref();
      req.setEncoding("utf8");
      let body = "";
      try {
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 32_000) { res.writeHead(413).end(); return; }
        }
      } finally { clearTimeout(timer); }
      let msg: any;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") { res.writeHead(400).end(); return; }
      const id = msg.id;
      if (id === undefined) { res.writeHead(202).end(); return; }
      if ((typeof id !== "number" && typeof id !== "string") || String(id).length > 100) { res.writeHead(400).end(); return; }
      const reply = (result: unknown) => {
        if (!res.destroyed) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      const requestKey = `${typeof id}:${id}`;
      const prior = requests.get(requestKey);
      if (prior) {
        if (prior.body !== body) { reply(errorResult("This request changed. Bud must prepare a new action for review.")); return; }
        reply(await prior.response); return;
      }
      if (requests.size >= 512 || controllers.size >= 4) { reply(errorResult("Bud's connected-app session is busy or full. Start a fresh task before continuing.")); return; }
      const controller = new AbortController();
      controllers.add(controller);
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", disconnected);
      const run = async () => {
        let operationId: string | undefined;
        let dispatchBody = body;
        const releases: Array<() => void> = [];
        let dispatched = false;
        let receiptSaveFailed = false;
        const finish = (status: "succeeded" | "failed" | "unknown", partial = false) => {
          if (!operationId) return;
          try { operations.finish(operationId, status, partial); }
          catch { receiptSaveFailed = true; throw new Error("App receipt needs recovery."); }
        };
        try {
          if (!options.isActive()) return errorResult("Bud is no longer working on this request. Nothing new was started.");
          if (!["initialize", "tools/list", "tools/call", "ping"].includes(msg.method)) return errorResult("This connected-app capability is not available in Bud.");
          if (msg.method === "tools/call") {
            managedService.assertCapability("connected-tools");
            const call = msg.params as Call;
            if (!call || !validAppToolName(call.name) ||
              (call.arguments !== undefined && (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)))) return errorResult("Bud received an invalid app action.");
            const strictEnvelope = Boolean(options.localTransport || options.managed);
            if (strictEnvelope && (Object.keys(call).some(key => !["name", "arguments", "_meta"].includes(key)) ||
              (call._meta !== undefined && (!call._meta || typeof call._meta !== "object" || Array.isArray(call._meta))))) return errorResult("Bud received an invalid app action envelope.");
            // Keep Hermes' protocol metadata at this boundary: the managed
            // gateway receives only the reviewed name and arguments, on every attempt.
            if (options.managed && !options.localTransport) dispatchBody = JSON.stringify({ ...msg, params: { name: call.name, arguments: call.arguments } });
            if (!allowedOfficeAppCall(call, options.allowedApps)) return errorResult("This source is off or unavailable in Ask. Open Add to choose office sources before starting a new request.");
            const policy = options.localTransport
              ? (GMAIL_READ_ONLY.has(call.name) ? "review" : "blocked")
              : connectedAppPolicy(call, { managed: options.managed === true });
            if (policy === "blocked") return errorResult(options.localTransport
              ? "This Gmail review allows only GMAIL_GET_PROFILE, GMAIL_LIST_THREADS and GMAIL_FETCH_MESSAGE_BY_THREAD_ID. Sending, drafts, account changes and other app tools are unavailable."
              : "This operation is outside Bud's connected-app boundary. Use direct app tools to prepare reviewable work. Ask Bud to connect an app separately.");
            // A shared office mailbox without the owner's full-access grant is held
            // to the three bounded reads by the gateway; say so before any card.
            if (options.managed && !options.localTransport && managedMailboxAccess(options.key) === "read_only" && gmailBeyondReads(call)) return errorResult(SHARED_MAILBOX_READ_ONLY);
            const mailKeys = mailProviders(call).map(provider => `${mailIdentity}:${provider}`);
            if (mailKeys.some(key => mailbox(key).hold)) return errorResult(MAIL_HELD);
            const reviewProtocol = typeof req.headers["mcp-protocol-version"] === "string" ? req.headers["mcp-protocol-version"] : undefined;
            const reviewRead = (name: string, args: Record<string, unknown>) =>
              upstreamRead(name, args, reviewProtocol, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
            /** Set for a saved-draft send: re-reads the draft for the final comparison. */
            let recheckDraft: (() => Promise<string>) | undefined;
            let recheckDraftDigest: string | undefined;
            const receipt = { threadId: options.threadId, toolName: call.name, toolSlugs: call.name === "COMPOSIO_MULTI_EXECUTE_TOOL"
              ? (call.arguments!.tools as { tool_slug: string }[]).map(row => row.tool_slug) : [] };
            if (policy === "review") {
              const context = options.localTransport
                ? `Gmail read-only review. Account: ${options.readOnlyAccountId || "the account selected in Connected apps"}. At most 10 threads from the last 7 days; only thread IDs returned in this task can be read. No sends, drafts, or mailbox changes. This approval applies once to this request only.\n\n`
                : "Bud wants to use a connected app. Review the exact operation and account or recipient below. This approval applies once to this request only.\n\n";
              let summary = (context + JSON.stringify(redactSecrets(call), null, 2)).replaceAll(options.key, "[private app key]");
              if (options.managed && !options.localTransport && MAIL_SENDS.has(call.name)) {
                // A message is approved only as the person will see it sent:
                // every recipient, the subject, the body and the attachments.
                const review = await prepareMailReview(call, reviewRead).catch(() => null);
                if (!review || typeof review === "string") return errorResult(typeof review === "string" ? review : MAIL_UNREADABLE);
                if (review.card.includes(options.key) || redactSecretsInText(review.card) !== review.card) return errorResult("This message contains what looks like a password, key or token, so Bud will not send it. Remove it and prepare the message again.");
                summary = review.card;
                if (review.recheck) { recheckDraft = review.recheck; recheckDraftDigest = review.digest; }
              }
              if (!await options.approve(summary, controller.signal)) {
                operations.deny(receipt);
                return errorResult("You did not approve this connected-app action. Nothing was sent or changed by this call. Do not retry without a new user request.");
              }
            }
            if (controller.signal.aborted || closed || !options.isActive()) {
              operations.deny(receipt);
              return errorResult("Bud stopped this action before it started.");
            }
            if (mailKeys.some(key => mailbox(key).hold)) { operations.deny(receipt); return errorResult(MAIL_HELD); }
            if (recheckDraft) {
              // The saved draft must still be exactly the message the person
              // approved. Hold the mailbox for every thread from here until the
              // send settles, let mail calls already in flight finish, then read
              // the draft one last time.
              for (const key of mailKeys) releases.push(holdMailbox(key));
              const busy = await drainMailboxes(mailKeys, options.mailDrainMs ?? 10_000, controller.signal);
              if (busy) { operations.deny(receipt); return errorResult("Another mail action on this mailbox is still running, so this draft was not sent. Try again in a moment."); }
              const now = await recheckDraft().catch(() => null);
              if (!now || now !== recheckDraftDigest) { operations.deny(receipt); return errorResult("The saved draft changed or could not be read again after you reviewed it, so it was not sent. Ask Bud to show it again before sending."); }
              if (controller.signal.aborted || closed || !options.isActive()) { operations.deny(receipt); return errorResult("Bud stopped this action before it started."); }
            } else {
              // Counted from here (no await before dispatch) until it settles,
              // so a draft send waits for it before its final read.
              for (const key of mailKeys) releases.push(countMailCall(key));
            }
            // Approval may remain open past expiry or a grant change. A
            // person approving the action cannot extend service authority.
            managedService.assertCapability("connected-tools");
            // The durable receipt must exist before any tool is dispatched.
            operationId = operations.start(receipt).id;
          }
          // Recheck after waiting for a person: a cancelled/stale turn cannot act.
          if (controller.signal.aborted || closed || !options.isActive()) return errorResult("Bud stopped this action before it started.");
          dispatched = true;
          const upstreamSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
          let result: Record<string, unknown>;
          let headers: Record<string, string> = {};
          if (options.localTransport) {
            // Hermes' MCP SDK attaches protocol metadata. The internal adapter
            // receives the exact reviewed tool arguments, without that envelope.
            const params = msg.method === "tools/call" ? { name: msg.params.name, arguments: msg.params.arguments } : msg.params;
            result = await options.localTransport.request(msg.method, params, upstreamSignal);
          } else {
            const protocolVersion = typeof req.headers["mcp-protocol-version"] === "string" ? req.headers["mcp-protocol-version"] : undefined;
            const post = async () => {
              headers = {
                "content-type": "application/json", accept: "application/json, text/event-stream",
                ...upstreamAuth,
                ...(session ? { "mcp-session-id": session } : {}),
              };
              if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
              return fetch(upstream!, { method: "POST", headers, body: dispatchBody, redirect: "error", signal: upstreamSignal });
            };
            if (msg.method === "initialize") initializeParams = msg.params;
            const sessionUsed = session;
            let upstreamResponse = await post();
            // The managed gateway expires a session when the device's binding
            // changes (e.g. after reconnecting Gmail). It raises this code at
            // session lookup, before any adapter or tool is dispatched, so the
            // same reviewed call is re-sent once on a fresh session under the
            // same receipt. `connector_binding_changed` can be raised after an
            // upstream call started and is never retried.
            if (options.managed && upstreamResponse.status === 409 && msg.method !== "initialize" &&
              await gatewayErrorCode(upstreamResponse) === "connector_session_expired" &&
              await refreshSession(sessionUsed, protocolVersion, upstreamSignal)) upstreamResponse = await post();
            if (!upstreamResponse.ok) {
              await upstreamResponse.body?.cancel().catch(() => {});
              finish("unknown");
              return errorResult("Bud couldn't reach the connected app just now. Check the app before asking again; Bud won't repeat this operation on its own.");
            }
            if (upstreamResponse.headers.has("mcp-session-id")) session = upstreamResponse.headers.get("mcp-session-id");
            result = await readMcpRpcResponse(upstreamResponse, id, upstreamSignal);
          }
          if (operationId) {
            const outcome = connectedAppResultStatus(result);
            finish(outcome.status, outcome.partial);
            if (outcome.status !== "succeeded") result.isError = true;
          }
          if (msg.method === "initialize") {
            // Only tools are brokered; no upstream sampling, prompts or resources.
            result.capabilities = { tools: {} };
            result.serverInfo = { name: "Bud connected apps", version: "1.0.0" };
            // Complete the upstream handshake without permitting arbitrary notifications.
            if (upstream) {
              const initialized = await fetch(upstream, { method: "POST", headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) },
                body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), redirect: "error",
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
              await initialized.body?.cancel().catch(() => {});
              if (!initialized.ok) return errorResult("Bud could not finish connecting to the app service.");
            }
          }
          // A provider may echo request headers in an error payload. The worker
          // must never receive the upstream credential, even through a result.
          return JSON.parse(JSON.stringify(redactSecrets(result)).replaceAll(JSON.stringify(options.key).slice(1, -1), "[private app key]"));
        } catch (error) {
          if (error instanceof ServiceEntitlementError && !dispatched) {
            return errorResult(`${error.message} Nothing was sent or changed by this call. Contact RealBud support before retrying.`);
          }
          if (receiptSaveFailed) return errorResult("Bud could not save the app outcome. The operation may have happened. App actions are paused for recovery; check the app before trying again.");
          if (operationId && dispatched) {
            try { finish("unknown"); }
            catch { return errorResult("Bud could not save the app outcome. The operation may have happened. App actions are paused for recovery; check the app before trying again."); }
          }
          if (msg.method === "tools/call" && !dispatched) return errorResult("Bud could not record this app operation. It was not sent. Check connected-app history and disk access before continuing.");
          return errorResult("Bud's app connection was interrupted. The outcome may be unknown; check the app before trying this action again. No automatic retry was made.");
        } finally { for (const release of releases) release(); controllers.delete(controller); res.off("close", disconnected); }
      };
      const response = run();
      requests.set(requestKey, { body, response });
      const result = await response;
      const size = Buffer.byteLength(JSON.stringify(result));
      if (cachedBytes + size > 8_000_000) {
        // Keep a tombstone rather than evicting the identity and replaying work.
        requests.set(requestKey, { body, response: Promise.resolve(errorResult("This request already finished. Its response is no longer cached. Check the connected app before continuing; do not repeat the action.")) });
      } else cachedBytes += size;
      reply(result);
    })().catch(() => { if (!res.destroyed && !res.headersSent) res.writeHead(400).end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  if (generationAtStart !== revocationGeneration) {
    server.closeAllConnections(); server.close();
    throw new Error("Bud's app connection was revoked during setup.");
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bud could not open its app connection.");
  const cancelPending = () => { for (const controller of controllers) controller.abort(); };
  const broker: ConnectedAppsBroker = {
    descriptor: { type: "http", name: "connected-apps", url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: "authorization", value: `Bearer ${token}` }] },
    cancelPending,
    close() { if (closed) return; closed = true; cancelPending(); server.closeAllConnections(); server.close(); requests.clear(); liveBrokers.delete(broker); },
  };
  liveBrokers.add(broker);
  return broker;
}

/** Reads at most 2 KB of a refused gateway reply for its `{ error }` code.
 * The body is always released; anything unexpected yields no code. */
async function gatewayErrorCode(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  let text = "";
  try {
    const decoder = new TextDecoder();
    while (text.length < 2048) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    if (text.length >= 2048) return undefined;
    const code = (JSON.parse(text) as { error?: unknown })?.error;
    return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
  } catch { return undefined; }
  finally { await reader.cancel().catch(() => {}); }
}

/** Inspect protocol/provider status envelopes, never retain their payloads.
 * A successful tool receipt describes the service response, not proof of an
 * external business outcome such as delivery or a completed payment. */
export function connectedAppResultStatus(result: unknown): { status: "succeeded" | "failed" | "unknown"; partial: boolean } {
  let failures = 0, successes = 0, nodes = 0, bounded = true;
  const inspect = (value: unknown, depth = 0): void => {
    if (++nodes > 512 || depth > 12) { bounded = false; return; }
    if (Array.isArray(value)) { for (const row of value) { if (!bounded) break; inspect(row, depth + 1); } return; }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const before = failures + successes;
    for (const key of ["data", "result", "response", "structuredContent"]) if (row[key] && typeof row[key] === "object") inspect(row[key], depth + 1);
    if (row.results && typeof row.results === "object") inspect(Array.isArray(row.results) ? row.results : Object.values(row.results), depth + 1);
    if (Array.isArray(row.content)) for (const block of row.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        try { inspect(JSON.parse(block.text), depth + 1); } catch { /* ordinary tool text */ }
      }
    }
    if (Array.isArray(row.content) && row.content.length > 1) {
      // Some MCP servers split one JSON envelope across text blocks.
      const combined = row.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
      try { inspect(JSON.parse(combined), depth + 1); } catch { /* independent or ordinary text blocks */ }
    }
    if (row.isError === true || row.successful === false || row.success === false ||
      (row.error !== undefined && row.error !== null && row.error !== false && row.error !== "")) failures++;
    else if (before === failures + successes && (row.successful === true || row.success === true)) successes++;
  };
  inspect(result);
  if (failures) return { status: "failed", partial: successes > 0 };
  const payload = result as { content?: unknown; structuredContent?: unknown } | null;
  const content = Array.isArray(payload?.content) && payload.content.some(block => block && typeof block.type === "string" &&
    (block.type !== "text" || (typeof block.text === "string" && block.text.trim())));
  const structured = payload?.structuredContent && typeof payload.structuredContent === "object" && Object.keys(payload.structuredContent).length > 0;
  if (!bounded || (!content && !structured && !successes)) return { status: "unknown", partial: false };
  return { status: "succeeded", partial: false };
}

// ── Mail review cards ──
// Owner decision 2026-10-02: a send, reply or forward runs only after the
// person approves that exact message with its recipients, subject, body and
// attachments shown. Values are JSON-quoted so a subject or address cannot
// draw a fake line, every body line is prefixed so the body cannot either,
// and invisible direction or line-separator characters are spelled out.

const MAIL_HELD = "Bud is sending a reviewed message from this mailbox. Wait for it to finish, then try this mail action again.";
const MAIL_UNREADABLE = "Bud could not show the full message for review, so nothing was sent. Send it with GMAIL_SEND_EMAIL or OUTLOOK_SEND_EMAIL (or GMAIL_REPLY_TO_THREAD) and spell out every recipient, the subject and the body.";
const MAIL_PREFIX = /^(GMAIL|OUTLOOK)_/;
const SHARED_MAILBOX_READ_ONLY = "This is the office's shared Gmail, and the office owner has not turned on full access, so Bud can only read recent mail there. Nothing was drafted, changed or sent. Ask the office owner to turn on full access for shared Gmail in the RealBud account settings.";
/** A Gmail tool, directly or in a batch, other than the three bounded reads. */
const gmailBeyondReads = (call: Call): boolean => (call.name === "COMPOSIO_MULTI_EXECUTE_TOOL" && Array.isArray(call.arguments?.tools)
  ? (call.arguments.tools as Array<{ tool_slug?: unknown }>).map(row => row?.tool_slug) : [call.name])
  .some(name => typeof name === "string" && name.startsWith("GMAIL_") && !GMAIL_READ_ONLY.has(name));
/** The mail providers a call reaches, including through a batch. */
const mailProviders = (call: Call): string[] => {
  const names = call.name === "COMPOSIO_MULTI_EXECUTE_TOOL" && Array.isArray(call.arguments?.tools)
    ? (call.arguments.tools as Array<{ tool_slug?: unknown }>).map(row => row?.tool_slug) : [call.name];
  return [...new Set(names.filter((name): name is string => typeof name === "string" && MAIL_PREFIX.test(name)).map(name => name.slice(0, name.indexOf("_"))))];
};

/** Module-wide: every broker on this desktop shares one count per mailbox. */
const mailboxes = new Map<string, { inflight: number; hold: symbol | null; drained: Set<() => void> }>();
const mailbox = (key: string) => {
  let entry = mailboxes.get(key);
  if (!entry) { entry = { inflight: 0, hold: null, drained: new Set() }; mailboxes.set(key, entry); }
  return entry;
};
const forget = (key: string) => { const entry = mailboxes.get(key); if (entry && !entry.inflight && !entry.hold && !entry.drained.size) mailboxes.delete(key); };
/** Count one dispatched mail call until it settles; returns its release. */
function countMailCall(key: string): () => void {
  const entry = mailbox(key);
  entry.inflight++;
  let released = false;
  return () => {
    if (released) return; released = true;
    entry.inflight--;
    if (!entry.inflight) for (const wake of [...entry.drained]) wake();
    forget(key);
  };
}
/** Hold a mailbox for one send; every broker refuses mail calls until release. */
function holdMailbox(key: string): () => void {
  const entry = mailbox(key), hold = Symbol("mail send");
  entry.hold = hold;
  return () => { if (entry.hold === hold) entry.hold = null; forget(key); };
}
/** Wait (bounded) for in-flight mail calls to settle; true when some are still running. */
async function drainMailboxes(keys: string[], ms: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (const key of keys) {
    const entry = mailbox(key);
    while (entry.inflight && !signal.aborted && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); entry.drained.delete(done); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now())); timer.unref?.();
        entry.drained.add(done); signal.addEventListener("abort", done, { once: true });
      });
    }
  }
  return signal.aborted || keys.some(key => mailbox(key).inflight > 0);
}

type MailRead = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
interface MailAttachment { name: string; type?: string; size?: number; id?: string }
interface MailView {
  to: string[]; cc: string[]; bcc: string[]; from?: string; subject?: string;
  plain?: string; html?: string; attachments: MailAttachment[];
  /** Provider version (Gmail draft message id, Outlook changeKey): part of the recheck, never shown. */
  version?: string;
}
type Obj = Record<string, any>;
const obj = (value: unknown): value is Obj => Boolean(value && typeof value === "object" && !Array.isArray(value));
function bad(): never { throw new Error("unreadable mail field"); }
const text = (value: unknown, max = 200_000): string | undefined => value === undefined || value === null ? undefined : typeof value === "string" && value.length <= max ? value : bad();
const list = (value: unknown): string[] => value === undefined || value === null || value === "" ? [] : typeof value === "string" ? [value]
  : Array.isArray(value) && value.length <= 500 && value.every(item => typeof item === "string") ? value as string[] : bad();
const size = (value: unknown): number | undefined => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
/** Composio file inputs are an object, a list of objects or a path; their names and types are shown. */
const attachmentInputs = (value: unknown): MailAttachment[] => {
  if (value === undefined || value === null) return [];
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length > 100) bad();
  return rows.map(row => typeof row === "string" ? { name: row } : obj(row) && typeof (row.name ?? row.filename ?? row.s3key) === "string"
    ? { name: String(row.name ?? row.filename ?? row.s3key), ...(typeof row.mimetype === "string" ? { type: row.mimetype } : {}), ...(typeof row.s3key === "string" ? { id: row.s3key } : {}) } : bad());
};
const bodyOf = (value: unknown, html: boolean): Pick<MailView, "plain" | "html"> => html ? { html: text(value) ?? "" } : { plain: text(value) ?? "" };

/** The explicit message a send tool carries in its own arguments. */
function explicitView(name: string, a: Obj): { view: MailView; notes: string[] } {
  const notes: string[] = [];
  if (name === "GMAIL_SEND_EMAIL" || name === "GMAIL_REPLY_TO_THREAD") {
    if (name === "GMAIL_REPLY_TO_THREAD") notes.push(`Replies in Gmail thread ${JSON.stringify(text(a.thread_id) ?? "")}; the subject follows that thread.`);
    return { notes, view: { to: [...list(a.recipient_email ?? a.to), ...list(a.extra_recipients)], cc: list(a.cc), bcc: list(a.bcc), from: text(a.from_email),
      subject: text(a.subject), ...bodyOf(name === "GMAIL_SEND_EMAIL" ? a.body : a.message_body, a.is_html === true), attachments: attachmentInputs(a.attachment) } };
  }
  if (name === "GMAIL_FORWARD_MESSAGE" || name === "OUTLOOK_FORWARD_MESSAGE") {
    notes.push(`Forwards ${name.startsWith("GMAIL") ? "Gmail" : "Outlook"} message ${JSON.stringify(text(a.message_id) ?? "")} as it is: its original text and all of its original attachments go to these recipients, after the message below.`);
    return { notes, view: name === "GMAIL_FORWARD_MESSAGE"
      ? { to: list(a.recipients), cc: list(a.cc), bcc: list(a.bcc), plain: text(a.additional_text) ?? "", attachments: [] }
      : { to: list(a.to_recipients), cc: [], bcc: [], plain: text(a.comment) ?? "", attachments: [] } };
  }
  if (name === "OUTLOOK_SEND_EMAIL") {
    return { notes, view: { to: list(a.to).flatMap(row => row.split(",").map(item => item.trim()).filter(Boolean)), cc: list(a.cc_emails), bcc: list(a.bcc_emails),
      from: text(a.from_address), subject: text(a.subject), ...bodyOf(a.body, a.is_html === true), attachments: attachmentInputs(a.attachment) } };
  }
  return bad();
}

/** Composio returns a tool's data as structured content or as JSON text. */
function resultData(result: Record<string, unknown>): Obj {
  if (result.isError === true) bad();
  const structured = result.structuredContent;
  const first = Array.isArray(result.content) ? (result.content as unknown[])[0] : undefined;
  const data = obj(structured) ? structured : obj(first) && first.type === "text" && typeof first.text === "string" ? JSON.parse(first.text) : bad();
  return obj(data) ? data : bad();
}
/** The provider object, directly or under one `data`/`response_data` wrapper, whose `id` is the one asked for. */
const identified = (data: Obj, id: string): Obj => [data, data.data, data.response_data].find(item => obj(item) && item.id === id) ?? bad();

/**
 * A Gmail API message (`format=full`). Every part must be one the card can
 * show: a multipart container, an inline text/plain or text/html body, or a
 * named attachment. An unnamed non-text part, or a text body held back as an
 * attachment ID, cannot be shown, so the message is refused. Gmail issues a
 * fresh attachment ID on every read, so attachments are compared by part,
 * name, type and size; an edited draft also gets a new message id.
 */
function gmailMessage(message: unknown): MailView {
  if (!obj(message) || typeof message.id !== "string" || !obj(message.payload) || !Array.isArray(message.payload.headers) || message.payload.headers.length > 300) bad();
  const header = (key: string) => {
    const rows = (message as Obj).payload.headers.filter((row: unknown) => obj(row) && typeof row.name === "string" && row.name.toLowerCase() === key);
    return rows.map((row: Obj) => text(row.value, 20_000) ?? "");
  };
  const plain: string[] = [], html: string[] = [], attachments: MailAttachment[] = [];
  let parts = 0;
  const visit = (part: unknown, depth: number) => {
    if (!obj(part) || ++parts > 300 || depth > 10 || typeof part.mimeType !== "string") bad();
    const type = part.mimeType.toLowerCase();
    if (type.startsWith("multipart/")) { if (!Array.isArray(part.parts)) bad(); for (const child of part.parts) visit(child, depth + 1); return; }
    if (typeof part.filename === "string" && part.filename) {
      attachments.push({ name: part.filename, type, ...(size(part.body?.size) !== undefined ? { size: part.body.size } : {}), ...(typeof part.partId === "string" ? { id: `part ${part.partId}` } : {}) });
      return;
    }
    if (type !== "text/plain" && type !== "text/html") bad();
    if (!obj(part.body) || part.body.attachmentId !== undefined) bad();
    if (part.body.data === undefined && !part.body.size) return;
    if (typeof part.body.data !== "string" || part.body.data.length > 400_000 || !/^[A-Za-z0-9_-]*={0,2}$/.test(part.body.data)) bad();
    (type === "text/plain" ? plain : html).push(Buffer.from(part.body.data, "base64url").toString("utf8"));
  };
  visit(message.payload, 0);
  return { to: header("to"), cc: header("cc"), bcc: header("bcc"), from: header("from")[0], subject: header("subject")[0],
    ...(plain.length || !html.length ? { plain: plain.join("\n") } : {}), ...(html.length ? { html: html.join("\n") } : {}), attachments, version: message.id };
}
const graphAddresses = (value: unknown): string[] => value === undefined || value === null ? [] : Array.isArray(value) && value.length <= 500
  ? value.map(row => obj(row) && obj(row.emailAddress) && typeof row.emailAddress.address === "string"
    ? (typeof row.emailAddress.name === "string" && row.emailAddress.name && row.emailAddress.name !== row.emailAddress.address ? `${row.emailAddress.name} <${row.emailAddress.address}>` : row.emailAddress.address) : bad())
  : bad();
/** A Microsoft Graph message, with its attachments listed when it has any. */
async function outlookMessage(read: MailRead, id: string, draft: boolean): Promise<MailView & { replyTo: string[] }> {
  const message = identified(resultData(await read("OUTLOOK_GET_MESSAGE", { message_id: id })), id);
  if (draft && message.isDraft !== true) bad();
  if (!obj(message.body) || typeof message.hasAttachments !== "boolean") bad();
  let attachments: MailAttachment[] = [];
  if (message.hasAttachments) {
    const listed = resultData(await read("OUTLOOK_LIST_OUTLOOK_ATTACHMENTS", { message_id: id }));
    const rows = [listed.value, listed.attachments, listed.data?.value, listed.data?.attachments].find(Array.isArray) ?? bad();
    attachments = (rows as unknown[]).map(row => obj(row) && typeof row.name === "string" && typeof row.id === "string"
      ? { name: row.name, id: row.id, ...(typeof row.contentType === "string" ? { type: row.contentType } : {}), ...(size(row.size) !== undefined ? { size: row.size } : {}) } : bad());
    if (!attachments.length) bad();
  }
  const html = String(message.body.contentType).toLowerCase() === "html";
  const version = [message.changeKey, message.lastModifiedDateTime].filter(item => typeof item === "string").join(" ");
  return { to: graphAddresses(message.toRecipients), cc: graphAddresses(message.ccRecipients), bcc: graphAddresses(message.bccRecipients),
    from: graphAddresses(message.from ? [message.from] : [])[0], replyTo: graphAddresses(message.replyTo), subject: text(message.subject) ?? "",
    ...bodyOf(message.body.content, html), attachments, ...(version ? { version } : {}) };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
/** The text a mail reader shows for an HTML body: blocks become lines, links keep their target in brackets. */
export function mailHtmlText(html: string, links = true): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, d, q, u, inner) => links ? `${inner} [${d ?? q ?? u}]` : inner)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote|section|article|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (entity, code: string) => {
      if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? entity;
      const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/[ \t\u00a0]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
const sameWords = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
/** Direction overrides, invisible marks and line separators are spelled out; so are other controls except newline and tab. */
export const visibleMailText = (value: string): string => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g,
  char => `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`);

/** Saved drafts and Outlook replies name their recipients only by reference:
 * those are read through the same session before the card is shown. */
async function prepareMailReview(call: Call, read: MailRead): Promise<{ card: string; digest?: string; recheck?: () => Promise<string> } | string> {
  const a: Obj = call.arguments ?? {};
  const mailbox = a.user_id ?? a.userId;
  if (mailbox !== undefined && mailbox !== "me") return "Bud sends only from the connected account's own mailbox (user_id \"me\"). Nothing was sent.";
  let view: MailView, notes: string[] = [], action: string;
  let recheck: (() => Promise<string>) | undefined;
  if (call.name === "GMAIL_SEND_DRAFT" || call.name === "OUTLOOK_SEND_DRAFT") {
    const id = call.name === "GMAIL_SEND_DRAFT" ? a.draft_id : a.message_id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_=+/-]{1,512}$/.test(id) || Object.keys(a).some(key => !["draft_id", "message_id", "user_id"].includes(key))) return MAIL_UNREADABLE;
    const load = async (): Promise<MailView> => call.name === "GMAIL_SEND_DRAFT"
      ? gmailMessage(identified(resultData(await read("GMAIL_GET_DRAFT", { draft_id: id, format: "full" })), id).message)
      : outlookMessage(read, id, true).then(({ replyTo: _replyTo, ...rest }) => rest);
    view = await load();
    recheck = async () => JSON.stringify(await load());
    action = `Send saved draft ${JSON.stringify(id)} exactly as it is now`;
    notes.push("This is the draft as Bud read it just now. If it changes before sending, Bud will not send it.");
  } else if (call.name === "OUTLOOK_REPLY_EMAIL") {
    const id = text(a.message_id, 512);
    if (!id) return MAIL_UNREADABLE;
    const original = await outlookMessage(read, id, false);
    view = { to: original.replyTo.length ? original.replyTo : original.from ? [original.from] : [], cc: list(a.cc_emails), bcc: list(a.bcc_emails),
      subject: `RE: ${original.subject ?? ""}`, ...bodyOf(a.comment, a.is_html === true), attachments: attachmentInputs(a.attachment) };
    notes.push(`Replies to the sender of Outlook message ${JSON.stringify(id)}${original.from ? ` (${JSON.stringify(original.from)})` : ""}; Outlook quotes that message below the reply.`);
    action = "Reply";
  } else {
    ({ view, notes } = explicitView(call.name, a));
    action = call.name.endsWith("FORWARD_MESSAGE") ? "Forward" : call.name === "GMAIL_REPLY_TO_THREAD" ? "Reply" : "Send a new email";
  }
  if (!view.to.length && !view.cc.length && !view.bcc.length) return "This message names no recipient Bud can show, so nothing was sent. Spell out every recipient (to, cc and bcc) and prepare it again.";
  const quote = (items: string[]) => items.length ? items.map(item => JSON.stringify(item)).join(", ") : "none";
  const sections: Array<[string, string]> = [];
  if (view.html !== undefined) {
    const rendered = mailHtmlText(view.html);
    if (view.plain !== undefined && sameWords(view.plain, mailHtmlText(view.html, false))) sections.push(["Message (the plain-text and HTML versions say the same)", view.plain]);
    else {
      if (view.plain !== undefined) sections.push(["Plain-text version (some mail apps show this one; it differs from the HTML version)", view.plain]);
      sections.push(["HTML version as text (links in brackets)", rendered]);
    }
    sections.push(["HTML source", view.html]);
  } else sections.push(["Message (plain text)", view.plain ?? ""]);
  const shown = (attachment: MailAttachment) => JSON.stringify(attachment.name) +
    (attachment.type || attachment.size !== undefined ? ` (${[attachment.type, attachment.size !== undefined ? `${attachment.size} bytes` : undefined].filter(Boolean).join(", ")})` : "");
  const card = [
    "Bud wants to send an email from the connected mailbox. Check every recipient, the subject, the message and the attachments. This approval sends this one message once.",
    "",
    `Action: ${action} (${call.name})`,
    `From: ${view.from ? JSON.stringify(view.from) : "the connected account"}`,
    `To: ${quote(view.to)}`,
    `Cc: ${quote(view.cc)}`,
    `Bcc: ${quote(view.bcc)}`,
    `Subject: ${view.subject === undefined ? "none" : JSON.stringify(view.subject)}`,
    `Attachments: ${view.attachments.length ? view.attachments.map(shown).join(", ") : "none"}`,
    ...notes,
    ...sections.flatMap(([title, body]) => {
      const lines = body.replace(/\r\n?/g, "\n").split("\n");
      return [`${title}, ${body.length} characters, every line shown:`, ...lines.map(line => `| ${line}`)];
    }),
    "",
    "Exact request:",
    JSON.stringify(call, null, 2),
  ].join("\n");
  return recheck ? { card: visibleMailText(card), digest: JSON.stringify(view), recheck } : { card: visibleMailText(card) };
}
