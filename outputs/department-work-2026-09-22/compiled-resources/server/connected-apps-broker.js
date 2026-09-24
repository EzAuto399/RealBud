// RealBud owns this boundary; upstream tool annotations and worker permission
// modes cannot authorize an external action. Credentials never reach the worker.
import { managedService } from "./managed-service.js";
import { ServiceEntitlementError } from "./service-entitlement.js";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readMcpRpcResponse } from "./composio.js";
import { redactSecrets } from "./redact.js";
import { connectedAppOperations, validAppToolName, validAppToolSlug } from "./connected-app-operations.js";
const DISCOVERY = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"]);
const BLOCKED = new Set(["COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL"]);
const GMAIL_READ_ONLY = new Set(["GMAIL_GET_PROFILE", "GMAIL_LIST_THREADS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"]);
export const CONNECTED_APP_APPROVAL = "bud_connected_app_action";
export function connectedAppPolicy(call) {
    if (!validAppToolName(call.name) || (call.arguments !== undefined &&
        (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments))))
        return "blocked";
    if (BLOCKED.has(call.name))
        return "blocked";
    if (DISCOVERY.has(call.name))
        return "read";
    if (call.name === "COMPOSIO_MANAGE_CONNECTIONS") {
        const rows = call.arguments?.toolkits;
        return Array.isArray(rows) && rows.length > 0 && rows.length <= 50 && rows.every(row => row && typeof row === "object" && !Array.isArray(row) && row.action === "list" && validAppToolSlug(row.name)) ? "read" : "blocked";
    }
    if (call.name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
        const rows = call.arguments?.tools;
        if (!Array.isArray(rows) || !rows.length || rows.length > 50 || rows.some(row => !row || typeof row !== "object" || !validAppToolSlug(row.tool_slug) ||
            row.tool_slug.startsWith("COMPOSIO_") || !row.arguments || typeof row.arguments !== "object" || Array.isArray(row.arguments)))
            return "blocked";
    }
    // Unknown tools, read-looking names and readOnlyHint=true are not authority.
    return "review";
}
/** Product-selected sources bind execution, including calls hidden in a batch. */
export function allowedOfficeAppCall(call, allowedApps) {
    if (!allowedApps)
        return true; // Non-product adapters retain their explicit contract.
    if (DISCOVERY.has(call.name))
        return allowedApps.length > 0;
    const allowed = (slug) => typeof slug === "string" && allowedApps.some(app => slug.toLowerCase().startsWith(`${app.toLowerCase()}_`));
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
const liveBrokers = new Set();
let revocationGeneration = 0;
export const connectedAppsBrokerGeneration = () => revocationGeneration;
/** Revoke only connected-app capabilities; unrelated model work stays alive. */
export function revokeConnectedAppsBrokers() {
    revocationGeneration++;
    for (const broker of [...liveBrokers])
        broker.close();
}
export async function startConnectedAppsBroker(options) {
    const generationAtStart = revocationGeneration;
    if (!options.key.trim())
        throw new Error("Set up Bud's Connected apps key first.");
    const token = randomBytes(32).toString("hex");
    // Project Gmail uses its server-owned adapter exclusively. Its project key
    // must never be sent to a consumer MCP endpoint, even if a URL was retained.
    const upstream = options.localTransport ? null : options.url || null;
    if (!options.localTransport && !upstream)
        throw new Error("Connected apps need a Platform session endpoint.");
    if (upstream) {
        const target = new URL(upstream);
        if (upstream.length > 2048 || target.username || target.password || target.hash ||
            (target.protocol !== "https:" && !(target.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(target.hostname))))
            throw new Error("Connected apps need a secure endpoint without embedded credentials.");
    }
    const upstreamAuth = options.headers && Object.keys(options.headers).length
        ? Object.fromEntries(Object.entries(options.headers).map(([name, value]) => [name.toLowerCase(), String(value)]))
        : { "x-api-key": options.key };
    let closed = false;
    let session = null;
    let cachedBytes = 0;
    const operations = options.operations ?? connectedAppOperations;
    const controllers = new Set();
    // A duplicate transport request shares its original result, including denials
    // and uncertain outcomes. A changed body cannot reuse an old approval.
    const requests = new Map();
    const errorResult = (text) => ({ content: [{ type: "text", text }], isError: true });
    const server = createServer((req, res) => {
        void (async () => {
            if (closed || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) {
                res.writeHead(403).end();
                return;
            }
            if (req.method !== "POST" || req.url !== "/mcp") {
                res.writeHead(405).end();
                return;
            }
            const timer = setTimeout(() => req.destroy(), 10_000);
            timer.unref();
            req.setEncoding("utf8");
            let body = "";
            try {
                for await (const chunk of req) {
                    body += chunk;
                    if (Buffer.byteLength(body) > 32_000) {
                        res.writeHead(413).end();
                        return;
                    }
                }
            }
            finally {
                clearTimeout(timer);
            }
            let msg;
            try {
                msg = JSON.parse(body);
            }
            catch {
                res.writeHead(400).end();
                return;
            }
            if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
                res.writeHead(400).end();
                return;
            }
            const id = msg.id;
            if (id === undefined) {
                res.writeHead(202).end();
                return;
            }
            if ((typeof id !== "number" && typeof id !== "string") || String(id).length > 100) {
                res.writeHead(400).end();
                return;
            }
            const reply = (result) => {
                if (!res.destroyed)
                    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
            };
            const requestKey = `${typeof id}:${id}`;
            const prior = requests.get(requestKey);
            if (prior) {
                if (prior.body !== body) {
                    reply(errorResult("This request changed. Bud must prepare a new action for review."));
                    return;
                }
                reply(await prior.response);
                return;
            }
            if (requests.size >= 512 || controllers.size >= 4) {
                reply(errorResult("Bud's connected-app session is busy or full. Start a fresh task before continuing."));
                return;
            }
            const controller = new AbortController();
            controllers.add(controller);
            const disconnected = () => { if (!res.writableEnded)
                controller.abort(); };
            res.on("close", disconnected);
            const run = async () => {
                let operationId;
                let dispatched = false;
                let receiptSaveFailed = false;
                const finish = (status, partial = false) => {
                    if (!operationId)
                        return;
                    try {
                        operations.finish(operationId, status, partial);
                    }
                    catch {
                        receiptSaveFailed = true;
                        throw new Error("App receipt needs recovery.");
                    }
                };
                try {
                    if (!options.isActive())
                        return errorResult("Bud is no longer working on this request. Nothing new was started.");
                    if (!["initialize", "tools/list", "tools/call", "ping"].includes(msg.method))
                        return errorResult("This connected-app capability is not available in Bud.");
                    if (msg.method === "tools/call") {
                        managedService.assertCapability("connected-tools");
                        const call = msg.params;
                        if (!call || !validAppToolName(call.name) ||
                            (call.arguments !== undefined && (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments))))
                            return errorResult("Bud received an invalid app action.");
                        if (options.localTransport && (Object.keys(call).some(key => !["name", "arguments", "_meta"].includes(key)) ||
                            (call._meta !== undefined && (!call._meta || typeof call._meta !== "object" || Array.isArray(call._meta)))))
                            return errorResult("Bud received an invalid app action envelope.");
                        if (!allowedOfficeAppCall(call, options.allowedApps))
                            return errorResult("This source is off or unavailable in Ask. Open Add to choose office sources before starting a new request.");
                        const policy = options.localTransport
                            ? (GMAIL_READ_ONLY.has(call.name) ? "review" : "blocked")
                            : connectedAppPolicy(call);
                        if (policy === "blocked")
                            return errorResult(options.localTransport
                                ? "This Gmail review allows only GMAIL_GET_PROFILE, GMAIL_LIST_THREADS and GMAIL_FETCH_MESSAGE_BY_THREAD_ID. Sending, drafts, account changes and other app tools are unavailable."
                                : "This operation is outside Bud's connected-app boundary. Use direct app tools to prepare reviewable work. Ask Bud to connect an app separately.");
                        const receipt = { threadId: options.threadId, toolName: call.name, toolSlugs: call.name === "COMPOSIO_MULTI_EXECUTE_TOOL"
                                ? call.arguments.tools.map(row => row.tool_slug) : [] };
                        if (policy === "review") {
                            const context = options.localTransport
                                ? `Gmail read-only review. Account: ${options.readOnlyAccountId || "the account selected in Connected apps"}. At most 10 threads from the last 7 days; only thread IDs returned in this task can be read. No sends, drafts, or mailbox changes. This approval applies once to this request only.\n\n`
                                : "Bud wants to use a connected app. Review the exact operation and account or recipient below. This approval applies once to this request only.\n\n";
                            const summary = (context + JSON.stringify(redactSecrets(call), null, 2)).replaceAll(options.key, "[private app key]");
                            if (!await options.approve(summary, controller.signal)) {
                                operations.deny(receipt);
                                return errorResult("You did not approve this connected-app action. Nothing was sent or changed by this call. Do not retry without a new user request.");
                            }
                        }
                        if (controller.signal.aborted || closed || !options.isActive()) {
                            operations.deny(receipt);
                            return errorResult("Bud stopped this action before it started.");
                        }
                        // Approval may remain open past expiry or a grant change. A
                        // person approving the action cannot extend service authority.
                        managedService.assertCapability("connected-tools");
                        // The durable receipt must exist before any tool is dispatched.
                        operationId = operations.start(receipt).id;
                    }
                    // Recheck after waiting for a person: a cancelled/stale turn cannot act.
                    if (controller.signal.aborted || closed || !options.isActive())
                        return errorResult("Bud stopped this action before it started.");
                    dispatched = true;
                    const upstreamSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
                    let result;
                    let headers = {};
                    if (options.localTransport) {
                        // Hermes' MCP SDK attaches protocol metadata. The internal adapter
                        // receives the exact reviewed tool arguments, without that envelope.
                        const params = msg.method === "tools/call" ? { name: msg.params.name, arguments: msg.params.arguments } : msg.params;
                        result = await options.localTransport.request(msg.method, params, upstreamSignal);
                    }
                    else {
                        headers = {
                            "content-type": "application/json", accept: "application/json, text/event-stream",
                            ...upstreamAuth,
                            ...(session ? { "mcp-session-id": session } : {}),
                        };
                        if (typeof req.headers["mcp-protocol-version"] === "string")
                            headers["mcp-protocol-version"] = req.headers["mcp-protocol-version"];
                        const upstreamResponse = await fetch(upstream, { method: "POST", headers, body,
                            redirect: "error", signal: upstreamSignal });
                        if (!upstreamResponse.ok) {
                            await upstreamResponse.body?.cancel().catch(() => { });
                            finish("unknown");
                            return errorResult(`Bud's connected app returned HTTP ${upstreamResponse.status}. Check its status before retrying; this operation was not automatically repeated.`);
                        }
                        if (upstreamResponse.headers.has("mcp-session-id"))
                            session = upstreamResponse.headers.get("mcp-session-id");
                        result = await readMcpRpcResponse(upstreamResponse, id, upstreamSignal);
                    }
                    if (operationId) {
                        const outcome = connectedAppResultStatus(result);
                        finish(outcome.status, outcome.partial);
                        if (outcome.status !== "succeeded")
                            result.isError = true;
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
                            await initialized.body?.cancel().catch(() => { });
                            if (!initialized.ok)
                                return errorResult("Bud could not finish connecting to the app service.");
                        }
                    }
                    // A provider may echo request headers in an error payload. The worker
                    // must never receive the upstream credential, even through a result.
                    return JSON.parse(JSON.stringify(redactSecrets(result)).replaceAll(JSON.stringify(options.key).slice(1, -1), "[private app key]"));
                }
                catch (error) {
                    if (error instanceof ServiceEntitlementError && !dispatched) {
                        return errorResult(`${error.message} Nothing was sent or changed by this call. Contact RealBud support before retrying.`);
                    }
                    if (receiptSaveFailed)
                        return errorResult("Bud could not save the app outcome. The operation may have happened. App actions are paused for recovery; check the app before trying again.");
                    if (operationId && dispatched) {
                        try {
                            finish("unknown");
                        }
                        catch {
                            return errorResult("Bud could not save the app outcome. The operation may have happened. App actions are paused for recovery; check the app before trying again.");
                        }
                    }
                    if (msg.method === "tools/call" && !dispatched)
                        return errorResult("Bud could not record this app operation. It was not sent. Check connected-app history and disk access before continuing.");
                    return errorResult("Bud's app connection was interrupted. The outcome may be unknown; check the app before trying this action again. No automatic retry was made.");
                }
                finally {
                    controllers.delete(controller);
                    res.off("close", disconnected);
                }
            };
            const response = run();
            requests.set(requestKey, { body, response });
            const result = await response;
            const size = Buffer.byteLength(JSON.stringify(result));
            if (cachedBytes + size > 8_000_000) {
                // Keep a tombstone rather than evicting the identity and replaying work.
                requests.set(requestKey, { body, response: Promise.resolve(errorResult("This request already finished. Its response is no longer cached. Check the connected app before continuing; do not repeat the action.")) });
            }
            else
                cachedBytes += size;
            reply(result);
        })().catch(() => { if (!res.destroyed && !res.headersSent)
            res.writeHead(400).end(); });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    if (generationAtStart !== revocationGeneration) {
        server.closeAllConnections();
        server.close();
        throw new Error("Bud's app connection was revoked during setup.");
    }
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Bud could not open its app connection.");
    const cancelPending = () => { for (const controller of controllers)
        controller.abort(); };
    const broker = {
        descriptor: { type: "http", name: "connected-apps", url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: "authorization", value: `Bearer ${token}` }] },
        cancelPending,
        close() { if (closed)
            return; closed = true; cancelPending(); server.closeAllConnections(); server.close(); requests.clear(); liveBrokers.delete(broker); },
    };
    liveBrokers.add(broker);
    return broker;
}
/** Inspect protocol/provider status envelopes, never retain their payloads.
 * A successful tool receipt describes the service response, not proof of an
 * external business outcome such as delivery or a completed payment. */
export function connectedAppResultStatus(result) {
    let failures = 0, successes = 0, nodes = 0, bounded = true;
    const inspect = (value, depth = 0) => {
        if (++nodes > 512 || depth > 12) {
            bounded = false;
            return;
        }
        if (Array.isArray(value)) {
            for (const row of value) {
                if (!bounded)
                    break;
                inspect(row, depth + 1);
            }
            return;
        }
        if (!value || typeof value !== "object")
            return;
        const row = value;
        const before = failures + successes;
        for (const key of ["data", "result", "response", "structuredContent"])
            if (row[key] && typeof row[key] === "object")
                inspect(row[key], depth + 1);
        if (row.results && typeof row.results === "object")
            inspect(Array.isArray(row.results) ? row.results : Object.values(row.results), depth + 1);
        if (Array.isArray(row.content))
            for (const block of row.content) {
                if (block?.type === "text" && typeof block.text === "string") {
                    try {
                        inspect(JSON.parse(block.text), depth + 1);
                    }
                    catch { /* ordinary tool text */ }
                }
            }
        if (Array.isArray(row.content) && row.content.length > 1) {
            // Some MCP servers split one JSON envelope across text blocks.
            const combined = row.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
            try {
                inspect(JSON.parse(combined), depth + 1);
            }
            catch { /* independent or ordinary text blocks */ }
        }
        if (row.isError === true || row.successful === false || row.success === false ||
            (row.error !== undefined && row.error !== null && row.error !== false && row.error !== ""))
            failures++;
        else if (before === failures + successes && (row.successful === true || row.success === true))
            successes++;
    };
    inspect(result);
    if (failures)
        return { status: "failed", partial: successes > 0 };
    const payload = result;
    const content = Array.isArray(payload?.content) && payload.content.some(block => block && typeof block.type === "string" &&
        (block.type !== "text" || (typeof block.text === "string" && block.text.trim())));
    const structured = payload?.structuredContent && typeof payload.structuredContent === "object" && Object.keys(payload.structuredContent).length > 0;
    if (!bounded || (!content && !structured && !successes))
        return { status: "unknown", partial: false };
    return { status: "succeeded", partial: false };
}
