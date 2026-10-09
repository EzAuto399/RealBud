// RealBud owns this boundary; upstream tool annotations and worker permission
// modes cannot authorize an external action. Credentials never reach the worker.
import { managedService } from "./managed-service.ts";
import { ServiceEntitlementError } from "./service-entitlement.ts";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readMcpRpcResponse } from "./composio.ts";
import { redactSecrets, redactSecretsInText } from "./redact.ts";
import { connectedAppOperations, validAppToolName, validAppToolSlug, type ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { connectedAppCanonical, parseConnectedMailBindings, unsupportedConnectedMailTool, connectedMailSenderArgsAllowed, verifiedMailAddress, connectedMailGatewayOrigin, type ConnectedMailBinding, type ConnectedMailReview, type ConnectedMailReviewArtifacts } from "../shared/connected-app-binding.ts";
import { appToolOperations, classifyAppToolCall, combineAppToolPolicies, MAIL_SENDS } from "../shared/app-tool-policy.ts";
import { approvalGroupKey, decide, defaultApprovalSettings, lockedOff, OFFICE_UNCHECKED, READ_ONLY_APP_TOOLS, type ApprovalCall, type ApprovalCallClass, type ApprovalDecision, type ApprovalSettings } from "../shared/approval-settings.ts";
import { approvalsEditableHere, governingApprovals, OFFICE_NOT_CHECKED, settingsAfterCard } from "./approval-settings.ts";
import { APPROVAL_DENIED, APPROVAL_TIMED_OUT, APPROVAL_TIMED_OUT_RECEIPT, approvalAnswer, type ApprovalAnswer } from "./approval-answer.ts";
import type { ApprovalCardDetails } from "./contracts.ts";
import { managedMailboxAccess } from "./managed-connectors.ts";

const DISCOVERY = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"]);
const BLOCKED = new Set(["COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL"]);
/** The project-key Gmail reader (gmail-readonly mode) only; the managed service uses the full mailbox policy. */
const GMAIL_READ_ONLY = new Set(["GMAIL_GET_PROFILE", "GMAIL_LIST_THREADS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"]);
export const CONNECTED_APP_APPROVAL = "bud_connected_app_action";
/** The office shared mailbox's own MCP server, beside "connected-apps" (the person's own), in mailbox mode `both`. */
export const OFFICE_MAIL_SERVER = "office-mail";
/** How every card of an office-mail session names the mailbox, so it never reads like the person's own. */
export const officeMailboxName = (address?: string): string =>
  `Office shared Gmail${address && /^[\x21-\x3f\x41-\x7e]{1,128}@[\x21-\x3f\x41-\x7e]{1,128}$/.test(address) ? ` (${address})` : ""}, not your own Gmail`;
/** True when the person's own message asks for the office mailbox. Only this
 * mounts it in mailbox mode `both`; tool output and email content never do. */
export const asksForOfficeMailbox = (text: string): boolean =>
  /\b(?:office|shared|team)(?:'s)?\s+(?:shared\s+)?(?:g?mail(?:box)?|inbox|e-?mails?|account)\b/i.test(text);
type Call = { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
type Policy = "read" | "review" | "blocked";
let hostMailReviewArtifacts: ConnectedMailReviewArtifacts | undefined;
/** Called by host startup with its protected encrypted vault. Never a worker
 * configuration or tool; a missing store holds mail instead of losing review. */
export function governConnectedMailReviewArtifacts(artifacts: ConnectedMailReviewArtifacts): void { hostMailReviewArtifacts = artifacts; }

export function connectedAppPolicy(call: Call, options: { managed?: boolean } = {}): Policy {
  if (!validAppToolName(call.name) || (call.arguments !== undefined &&
    (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)))) return "blocked";
  if (BLOCKED.has(call.name)) return "blocked";
  if (unsupportedConnectedMailTool(call.name)) return "blocked";
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
    if (rows.some(row => MAIL_SENDS.has(row.tool_slug) || unsupportedConnectedMailTool(row.tool_slug))) return "blocked";
    if (!options.managed) return "review";
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
  /** Shows the one-time card: `summary` is plain lines, `card` its exact request, phone class and read offer. */
  approve(summary: string, signal: AbortSignal, card?: ApprovalCardDetails): Promise<ApprovalAnswer>;
  /** The approval settings that govern this desktop (default: the host's registered store). */
  approvalSettings?: () => Promise<ApprovalSettings[]>;
  operations?: ConnectedAppOperationStore;
  reviewArtifacts?: ConnectedMailReviewArtifacts;
  localTransport?: ConnectedAppsLocalTransport;
  /** Server-selected account shown on read approvals, never a caller argument. */
  readOnlyAccountId?: string;
  allowedApps?: string[];
  /** Upstream is the office's managed connection service (tools classified). */
  managed?: boolean;
  /** How long a reviewed draft send waits for mail calls already in flight on its mailbox. */
  mailDrainMs?: number;
  /** The office shared mailbox's session (its headers select it at the gateway). */
  mailbox?: "office";
  /** The office mailbox's confirmed address, named on every card of an office session. */
  officeAddress?: string;
}): Promise<ConnectedAppsBroker> {
  const generationAtStart = revocationGeneration;
  const office = options.mailbox === "office" ? officeMailboxName(options.officeAddress) : undefined;
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
  let mailBindings: ConnectedMailBinding[] = [];
  const acceptBindings = (result: Record<string, unknown>) => {
    mailBindings = result.realbudMailBindings === undefined ? [] : parseConnectedMailBindings(result.realbudMailBindings);
  };
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
        const result = await readMcpRpcResponse(initialized, rpcId, signal);
        acceptBindings(result);
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
        let reviewedOperation = false;
        let reviewedBinding: ConnectedMailBinding | undefined;
        const bindingCurrent = () => !reviewedBinding || mailBindings.some(row => connectedAppCanonical(row) === connectedAppCanonical(reviewedBinding));
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
            if (!options.managed && !options.localTransport && MAIL_SENDS.has(call.name)) return errorResult(MAIL_BINDING_REQUIRED);
            if (!options.managed && (call.name.startsWith("GMAIL_") || call.name.startsWith("OUTLOOK_")) && namespacedPolicy(call.name, call.arguments ?? {}) === "blocked") return errorResult("This mail tool is outside the reviewed mail boundary. Connect the managed mailbox and prepare a supported direct mail action.");
            // A shared office mailbox without the owner's full-access grant is held
            // to the three bounded reads by the gateway; say so before any card.
            if (options.managed && !options.localTransport && managedMailboxAccess(options.key, options.mailbox) === "read_only" && gmailBeyondReads(call)) return errorResult(SHARED_MAILBOX_READ_ONLY);
            const mailKeys = mailProviders(call).map(provider => `${mailIdentity}:${provider}`);
            if (mailKeys.some(key => mailbox(key).hold)) return errorResult(MAIL_HELD);
            const reviewProtocol = typeof req.headers["mcp-protocol-version"] === "string" ? req.headers["mcp-protocol-version"] : undefined;
            const isMailSend = Boolean(options.managed && !options.localTransport && MAIL_SENDS.has(call.name));
            if (isMailSend) {
              if (!session && !await refreshSession(session, reviewProtocol, controller.signal)) return errorResult(MAIL_BINDING_REQUIRED);
              const provider = call.name.startsWith("GMAIL_") ? "gmail" : "outlook";
              reviewedBinding = mailBindings.find(row => row.provider === provider);
              if (!reviewedBinding) return errorResult(MAIL_BINDING_REQUIRED);
              if (!reviewedBinding.companyId) return errorResult('The managed gateway cannot verify this mailbox company/tenant. Update/check the managed connection before sending; older metadata still permits reads.');
              if (!verifiedMailAddress(reviewedBinding.emailAddress)) return errorResult('The connected mailbox has no verified sending address. Check/reconnect the managed Gmail account and its fixed profile read. Outlook sends remain held until its fixed account profile is verified. Reads remain available.');
              if (!connectedMailSenderArgsAllowed(call.arguments)) return errorResult("A sending user, mailbox or From override is not covered by this account approval. Remove the override and use the connected account's own mailbox; aliases need separate provider-bound verification.");
            }
            const reviewRead = async (name: string, args: Record<string, unknown>) => {
              const result = await upstreamRead(name, args, reviewProtocol, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
              if (!bindingCurrent() || controller.signal.aborted || !options.isActive()) throw new Error(MAIL_BINDING_CHANGED);
              managedService.assertCapability("connected-tools"); return result;
            };
            /** Set for a saved-draft send: re-reads the draft for the final comparison. */
            let recheckDraft: (() => Promise<string>) | undefined;
            let recheckDraftDigest: string | undefined;
            let mailIdentityFields: { accountDigest: string; realmDigest: string; bindingDigest: string; effectDigest: string; reviewDigest: string; workspaceDigest: string; repeatOf?: string } | undefined;
            let originalMailReview: ConnectedMailReview | undefined;
            const mailApprovalId = isMailSend ? randomBytes(16).toString("hex") : undefined;
            const receipt = { threadId: options.threadId, toolName: call.name, toolSlugs: call.name === "COMPOSIO_MULTI_EXECUTE_TOOL"
              ? (call.arguments!.tools as { tool_slug: string }[]).map(row => row.tool_slug) : [] };
            // Approval settings (Workspace → Approvals) after the boundary's own
            // checks: Ask and Don't use only tighten, and only an owner-reviewed
            // direct read or a this-task grant on an allowlisted read is widened.
            let review = policy === "review";
            let approval: string | undefined;
            let card: ApprovalCardDetails = {};
            let unchecked = false;
            const rows = appRows(call);
            const how = { direct: !options.managed || Boolean(options.localTransport), local: Boolean(options.localTransport) };
            const readSettings = options.approvalSettings ?? governingApprovals;
            if (rows.length) {
              let settings: ApprovalSettings[];
              try { settings = await readSettings(); }
              catch { return errorResult(APPROVALS_RECOVERY); }
              const verdict = appVerdict(rows, settings, how);
              if (verdict.decision === "refuse") return errorResult(verdict.reason);
              review = verdict.decision === "card" && !(verdict.offer && taskReadGrants.has(options.threadId, verdict.offer.group));
              unchecked = settings.some(item => item.unchecked);
              card = { remote: options.managed && !options.localTransport && MAIL_SENDS.has(call.name) ? "send" : verdict.remote,
                ...(verdict.offer ? { readOffer: { ...verdict.offer, always: await approvalsEditableHere() } } : {}) };
            }
            reviewedOperation = review || policy === "review";
            if (reviewedOperation && !isMailSend) {
              const unresolved = operations.list().find(row => row.toolName === call.name && ["started", "unknown"].includes(row.status));
              if (unresolved) return errorResult(`A previous reviewed ${call.name} operation has an unresolved outcome (${unresolved.id}). Check it in the app before continuing. Account-bound GUI recovery is available only for supported managed mail; this tool remains held rather than replaying uncertain work.`);
            }
            if (review) {
              const safe = redactSecrets(call) as Call;
              const hide = (text: string) => redactSecretsInText(text.replaceAll(options.key, "[private app key]"));
              const shown = appCardText(safe, { office, account: options.localTransport ? options.readOnlyAccountId || "the account selected in Connected apps" : undefined });
              let summary = hide(shown.text);
              // A phone approves only what it shows in full: a shortened or redacted card stays on this computer.
              if ((card.remote === "read" || card.remote === "write") && (!shown.complete || summary !== shown.text || JSON.stringify(safe) !== JSON.stringify(call))) card = { ...card, remote: "desktop-only" };
              let detail = hide(JSON.stringify(safe, null, 2));
              if (isMailSend) {
                // A message is approved only as the person will see it sent:
                // every recipient, the subject, the body and the attachments.
                const review = await prepareMailReview(call, reviewRead, office).catch(() => null);
                if (!review || typeof review === "string") return errorResult(typeof review === "string" ? review : MAIL_UNREADABLE);
                if ([review.card, review.exact].some(text => text.includes(options.key) || redactSecretsInText(text) !== text)) return errorResult("This message contains what looks like a password, key or token, so Bud will not send it. Remove it and prepare the message again.");
                const account = reviewedBinding!;
                const gatewayOrigin = connectedMailGatewayOrigin(upstream!);
                if (review.sender) {
                  const sender = /<([^<>]+)>$/.exec(review.sender.trim())?.[1] ?? review.sender.trim();
                  if (!verifiedMailAddress(sender) || sender.toLowerCase() !== account.emailAddress!.toLowerCase()) return errorResult('The saved draft uses a different or unverified From address. Open the exact account and use its verified sending address; aliases need separate provider-bound verification. Nothing was sent.');
                }
                summary = `Verified sending account: ${visibleMailText(account.emailAddress!)} (${account.provider}, account ${account.accountId}).\nCompany: ${visibleMailText(account.companyId!)}; managed gateway: ${gatewayOrigin}.\n\n${review.card}`;
                detail = review.exact;
                const accountDigest = mailAccountDigest(account, gatewayOrigin);
                const realmDigest = mailRealmDigest(account, gatewayOrigin);
                const effectDigest = mailDigest({ workspaceDigest: operations.workspaceDigest, accountDigest, message: review.effect });
                let prior;
                try { prior = operations.priorMailEffect(effectDigest, realmDigest); }
                catch (error) { return errorResult(error instanceof Error ? error.message : "This mail outcome needs recovery before sending again."); }
                if (prior) summary = `INTENTIONAL REPEAT: this exact message was already sent or manually confirmed sent (operation ${prior.id}). Allowing this separate card sends it again once to the same verified account and recipients.\n\n${summary}`;
                mailIdentityFields = { accountDigest, realmDigest, bindingDigest: account.generation, effectDigest, reviewDigest: mailDigest({ summary, detail, approvalId: mailApprovalId }), workspaceDigest: operations.workspaceDigest, ...(prior ? { repeatOf: prior.id } : {}) };
                if (review.recheck) { recheckDraft = review.recheck; recheckDraftDigest = review.digest; }
              }
              if (unchecked) summary = `${summary}\n${OFFICE_UNCHECKED}`;
              if (mailIdentityFields) {
                if (summary.includes(options.key) || redactSecretsInText(summary) !== summary) return errorResult(MAIL_BINDING_REQUIRED);
                mailIdentityFields.reviewDigest = mailDigest({ summary, detail, approvalId: mailApprovalId });
              }
              // The review id rides on the card and is read back after the answer so the receipt names a phone answer.
              const reviewId = randomBytes(6).toString("hex");
              openReviews.set(reviewId, { threadId: options.threadId });
              let answer: ReturnType<typeof approvalAnswer>;
              try { answer = approvalAnswer(await options.approve(summary, controller.signal, { ...card, detail, reviewId })); }
              finally { approval = openReviews.get(reviewId)?.approval; openReviews.delete(reviewId); }
              // A card nobody answered, or a stop, is named on the receipt; it is never the person's answer.
              if (!answer.allowed && !approval && answer.resolution !== "user") approval = answer.resolution === "timeout" ? APPROVAL_TIMED_OUT_RECEIPT : "Stopped before anyone answered";
              const refused = (text: string) => { operations.deny({ ...receipt, ...(approval ? { approval } : {}) }); return errorResult(text); };
              if (!answer.allowed) return refused(answer.resolution === "timeout" ? APPROVAL_TIMED_OUT : answer.resolution === "stopped" ? "Bud stopped this action before it started."
                : `${APPROVAL_DENIED} Do not retry without a new user request.`);
              if (mailIdentityFields) originalMailReview = { version: 1, gatewayOrigin: connectedMailGatewayOrigin(upstream!), workspaceDigest: mailIdentityFields.workspaceDigest, accountDigest: mailIdentityFields.accountDigest,
                bindingDigest: mailIdentityFields.bindingDigest, reviewDigest: mailIdentityFields.reviewDigest, binding: { ...reviewedBinding! }, card: summary, exact: detail, approvedAt: Date.now(), approvalId: mailApprovalId! };
              // A Don't use saved while the card waited still refuses it.
              if (rows.length) {
                let now: ApprovalSettings[];
                try { now = await settingsAfterCard(readSettings); } catch { return refused(APPROVALS_RECOVERY); }
                if (now.some(item => item.unchecked)) return refused(OFFICE_NOT_CHECKED);
                const again = appVerdict(rows, now, how);
                if (again.decision === "refuse") return refused(`Approval settings changed to Don't use for ${again.label}; Bud did not do it.`);
              }
            }
            if (controller.signal.aborted || closed || !options.isActive()) {
              operations.deny(receipt);
              return errorResult("Bud stopped this action before it started.");
            }
            if (!bindingCurrent()) { operations.deny(receipt); return errorResult(MAIL_BINDING_CHANGED); }
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
              if (!bindingCurrent()) { operations.deny(receipt); return errorResult(MAIL_BINDING_CHANGED); }
            } else {
              // Counted from here (no await before dispatch) until it settles,
              // so a draft send waits for it before its final read.
              for (const key of mailKeys) releases.push(countMailCall(key));
            }
            // Approval may remain open past expiry or a grant change. A
            // person approving the action cannot extend service authority.
            managedService.assertCapability("connected-tools");
            if (originalMailReview) {
              const artifacts = options.reviewArtifacts ?? hostMailReviewArtifacts;
              if (!artifacts) { operations.deny(receipt); return errorResult("The protected original mail review could not be saved. Nothing was sent. Recover this private workspace's encrypted review storage before preparing the message again."); }
              try { await artifacts.write(originalMailReview); }
              catch { operations.deny(receipt); return errorResult("The protected original mail review could not be saved. Nothing was sent. Check private storage and disk access before preparing the message again."); }
              if (!bindingCurrent() || controller.signal.aborted || !options.isActive()) { operations.deny(receipt); return errorResult(MAIL_BINDING_CHANGED); }
              // The artifact write and source reread crossed await boundaries.
              // Recheck effective policy immediately before the durable start.
              let now: ApprovalSettings[];
              try { now = await settingsAfterCard(readSettings); } catch { operations.deny(receipt); return errorResult(APPROVALS_RECOVERY); }
              if (now.some(item => item.unchecked) || appVerdict(rows, now, how).decision === 'refuse') { operations.deny(receipt); return errorResult("Approval settings changed while saving the review. Nothing was sent; prepare a new action under the current policy."); }
              if (!bindingCurrent() || controller.signal.aborted || !options.isActive()) { operations.deny(receipt); return errorResult(MAIL_BINDING_CHANGED); }
              managedService.assertCapability("connected-tools");
            }
            // The durable receipt must exist before any tool is dispatched.
            try { operationId = operations.start({ ...receipt, ...mailIdentityFields, ...(approval ? { approval } : {}) }).id; }
            catch (error) { return errorResult(`${error instanceof Error ? error.message : "This app outcome needs recovery before dispatch."} It was not sent.`); }
            if (reviewedBinding) dispatchBody = JSON.stringify({ ...msg, params: { name: call.name, arguments: call.arguments, _meta: { realbudReviewedMailBinding: reviewedBinding } } });
          }
          // Recheck after waiting for a person: a cancelled/stale turn cannot act.
          if (controller.signal.aborted || closed || !options.isActive() || !bindingCurrent()) {
            if (operationId) operations.cancelBeforeDispatch(operationId);
            return errorResult(bindingCurrent() ? "Bud stopped this action before it started." : MAIL_BINDING_CHANGED);
          }
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
              managedService.assertCapability("connected-tools");
              if (controller.signal.aborted || !options.isActive() || !bindingCurrent()) throw new Error(MAIL_BINDING_CHANGED);
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
            // Session expiry is a documented pre-adapter refusal. Reviewed
            // operations never reinitialize/replay an old approval. Only safe
            // unapproved reads may transparently refresh the session.
            if (options.managed && upstreamResponse.status === 409 && msg.method !== "initialize" &&
              await gatewayErrorCode(upstreamResponse) === "connector_session_expired") {
              if (reviewedOperation) {
                // Even an unchanged account needs a fresh, separately reviewed
                // action after an expired-session refusal. Only unapproved
                // reads refresh transparently.
                session = null; mailBindings = [];
                if (operationId) operations.cancelBeforeDispatch(operationId);
                operationId = undefined;
                return errorResult("The app connection expired after review. This request was refused before dispatch and was not replayed. Prepare a new action for a fresh approval.");
              }
              if (await refreshSession(sessionUsed, protocolVersion, upstreamSignal)) upstreamResponse = await post();
            }
            if (!upstreamResponse.ok) {
              await upstreamResponse.body?.cancel().catch(() => {});
              finish("unknown");
              return errorResult("Bud couldn't reach the connected app just now. Check the app before asking again; Bud won't repeat this operation on its own.");
            }
            if (upstreamResponse.headers.has("mcp-session-id")) session = upstreamResponse.headers.get("mcp-session-id");
            result = await readMcpRpcResponse(upstreamResponse, id, upstreamSignal);
            if (msg.method === "initialize" && options.managed) acceptBindings(result);
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
            delete result.realbudMailBindings;
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
    descriptor: { type: "http", name: options.mailbox === "office" ? OFFICE_MAIL_SERVER : "connected-apps", url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: "authorization", value: `Bearer ${token}` }] },
    cancelPending,
    close() { if (closed) return; closed = true; cancelPending(); server.closeAllConnections(); server.close(); requests.clear(); liveBrokers.delete(broker); },
  };
  liveBrokers.add(broker);
  return broker;
}

// ── Approval settings at this boundary ──
const APPROVALS_RECOVERY = "The approval settings on this computer need recovery, so Bud did not use the app. Nothing was sent or changed. Check Workspace → Approvals.";
/** This-task read grants ("Allow for this task" on a read offer): an app's
 * allowlisted reads run without a card until the turn ends. A grant never
 * passes an effective Ask or Don't use, nor a direct tool the owner has not
 * reviewed: the broker checks both again on every call. */
const taskReads = new Map<string, Set<string>>();
export const taskReadGrants = {
  add(threadId: string, group: string): void { if (approvalGroupKey(group)) taskReads.set(threadId, new Set([...taskReads.get(threadId) ?? [], group])); },
  has: (threadId: string, group: string): boolean => taskReads.get(threadId)?.has(group) === true,
  clear(threadId: string): void { taskReads.delete(threadId); },
};
/** Cards waiting for a person, by the review id each card carries. */
const openReviews = new Map<string, { threadId: string; approval?: string }>();
/** Records who answered a waiting card away from this computer, for its receipt. */
export function recordConnectedAppApproval(threadId: string, reviewId: string, line: string): void {
  const review = openReviews.get(reviewId);
  if (review?.threadId === threadId && review.approval === undefined) review.approval = line;
}
type AppRow = { slug: string; args: Record<string, unknown> };
/** The app tools a call dispatches, batch members included; RealBud's own discovery tools have none. */
function appRows(call: Call): AppRow[] {
  if (DISCOVERY.has(call.name) || call.name === "COMPOSIO_MANAGE_CONNECTIONS") return [];
  if (call.name === "COMPOSIO_MULTI_EXECUTE_TOOL") return (call.arguments!.tools as Array<{ tool_slug: string; arguments: Record<string, unknown> }>).map(row => ({ slug: row.tool_slug, args: row.arguments }));
  return [{ slug: call.name, args: call.arguments ?? {} }];
}
/** `app:<toolkit>` for a Composio slug, or null for a name no setting can name. */
const appGroup = (slug: string): string | null => {
  const group = NAMESPACED.test(slug) ? `app:${slug.slice(0, slug.indexOf("_")).toLowerCase()}` : "";
  return approvalGroupKey(group) ? group : null;
};
const APP_LABELS: Record<string, string> = { gmail: "Gmail", outlook: "Outlook", googlecalendar: "Google Calendar", googledrive: "Google Drive", googlesheets: "Google Sheets", googledocs: "Google Docs" };
const appLabel = (group: string) => { const toolkit = group.slice(4); return APP_LABELS[toolkit] ?? toolkit.charAt(0).toUpperCase() + toolkit.slice(1); };
const STRICTNESS: Record<ApprovalDecision, number> = { run: 0, card: 1, refuse: 2 };
/** In-app changes a phone may approve: writing or editing a Gmail draft, and a
 * label edit the policy lets run (never Trash or Spam). Everything else that changes is desktop only. */
const PHONE_WRITES = new Set(["GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_UPDATE_DRAFT", "GMAIL_ADD_LABEL_TO_EMAIL", "GMAIL_MODIFY_THREAD_LABELS"]);
type Remote = NonNullable<ApprovalCardDetails["remote"]>;
type AppVerdict = { decision: "refuse"; reason: string; label: string }
  | { decision: "run" | "card"; remote: Remote; offer?: { appLabel: string; group: string } };
/** The strictest answer across a call's rows. A managed row is classed as the
 * policy above classes it; a direct row only so an owner-reviewed read can run
 * (it never refuses what a direct connection reviews today). A row no setting
 * can name keeps today's answer. What a row actually does (pays, sends,
 * deletes, uploads…) never changes run or card; a locked Don't use on it refuses. */
export function appVerdict(rows: AppRow[], settings: readonly ApprovalSettings[], how: { direct: boolean; local?: boolean }): AppVerdict {
  if (rows.some(row => unsupportedConnectedMailTool(row.slug))) return { decision: 'refuse', label: 'Mail', reason: 'This mail tool has no complete reviewed message/account contract. Use a supported direct mail tool.' };
  const list = settings.length ? settings : [defaultApprovalSettings()];
  const calls = rows.map(row => {
    const policy: Policy = how.direct ? (classifyAppToolCall(row.slug, row.args) === "read" ? "read" : "review") : namespacedPolicy(row.slug, row.args);
    const operations = appToolOperations(row.slug, row.args);
    const cls: ApprovalCallClass = policy === "read" ? "read" : policy === "blocked" ? "blocked" : operations[0] ?? "write";
    const group = appGroup(row.slug);
    const call: ApprovalCall | null = group ? { group, tool: row.slug, args: row.args, cls, ...(how.direct ? { direct: true } : {}) } : null;
    const decision: ApprovalDecision = lockedOff(list, operations) ? "refuse" : call ? decide(list, call)
      : policy === "blocked" ? "refuse" : how.direct || policy === "review" || list.some(item => item.unchecked) ? "card" : "run";
    // A phone sees exact reads as reads, and a few in-app changes as writes; names confer no authority on a
    // direct connection, so only the owner's reviewed reads may be answered away from this computer.
    const phone: Remote = operations.length || cls !== "read" ? "desktop-only"
      : READ_ONLY_APP_TOOLS.has(row.slug) && (!how.direct || how.local || list.every(item => item.reviewedReads.includes(row.slug))) ? "read"
      : !how.direct && PHONE_WRITES.has(row.slug) ? "write" : "desktop-only";
    return { row, call, decision, phone };
  });
  if (!calls.length) return { decision: "refuse", reason: "Bud received an invalid app action.", label: "this app" };
  const strictest = calls.reduce((a, b) => STRICTNESS[b.decision] > STRICTNESS[a.decision] ? b : a);
  if (strictest.decision === "refuse") {
    const group = strictest.call?.group;
    const name = group ? appLabel(group) : "this app";
    return group && list.some(item => item.groups[group] === "deny")
      ? { decision: "refuse", label: name, reason: `${name} is set to Don't use in Workspace → Approvals, so Bud did not use it. Nothing was sent or changed.` }
      : { decision: "refuse", label: `this kind of action in ${name}`, reason: `This kind of action is set to Don't use in Workspace → Approvals, so Bud did not do it in ${name}. Nothing was sent or changed.` };
  }
  const remote: Remote = calls.some(({ phone }) => phone === "desktop-only") ? "desktop-only" : calls.some(({ phone }) => phone === "write") ? "write" : "read";
  // A read offer only where a grant could apply: one app, exact allowlisted reads, and
  // nothing but a default holding them back (no saved Ask or Don't use, no unreviewed direct tool).
  const group = calls[0].call?.group;
  const widened = group ? list.map(item => Object.hasOwn(item.groups, group) ? item : { ...item, groups: { ...item.groups, [group]: "read-without-asking" as const } }) : [];
  const offer = strictest.decision === "card" && group && calls.every(({ call, row }) => call?.group === group && call.cls === "read" && READ_ONLY_APP_TOOLS.has(row.slug) && decide(widened, call) === "run")
    ? { appLabel: appLabel(group), group } : undefined;
  return { decision: strictest.decision, remote, ...(offer ? { offer } : {}) };
}
/** Plain lines for a card: the app, the action in words, the account and the
 * key fields. Each value is one line (a line break shows as ↵, invisible
 * characters are spelled out); long or nested values point to the exact request. */
export function appCard(call: Call, where: { office?: string; account?: string } = {}): string {
  return appCardText(call, where).text;
}
/** The card's lines, and whether they show every argument in full (only then may a phone approve it). */
function appCardText(call: Call, where: { office?: string; account?: string }): { text: string; complete: boolean } {
  const rows = appRows(call);
  let complete = true;
  const cut = <T>(shown: T): T => { complete = false; return shown; };
  const words = (text: string, key = false) => {
    const plain = visibleMailText(text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[\s_-]+/g, " ").trim().toLowerCase());
    const shown = plain.length > 60 ? (key ? cut(plain.slice(0, 60)) : plain.slice(0, 60)) : plain;
    return shown ? shown.charAt(0).toUpperCase() + shown.slice(1) : "Field";
  };
  const action = (slug: string) => `${words(appGroup(slug) ? slug.slice(slug.indexOf("_") + 1) : slug)} (${slug})`;
  const value = (item: unknown): string => {
    if (typeof item === "string") {
      const line = visibleMailText(item.replace(/\r\n?|\n/g, " ↵ ").replace(/\t/g, " "));
      return line.length > 240 ? cut(`${line.slice(0, 240)}… (${item.length} characters, see Exact request)`) : line || "(empty)";
    }
    if (typeof item === "number" || typeof item === "boolean") return String(item);
    if (item === null) return "none";
    if (Array.isArray(item) && item.every(entry => entry === null || ["string", "number", "boolean"].includes(typeof entry))) {
      return item.length ? `${item.slice(0, 10).map(value).join(", ")}${item.length > 10 ? cut(`, and ${item.length - 10} more`) : ""}` : "none";
    }
    return cut("see Exact request");
  };
  const fields = (args: Record<string, unknown>, indent = "") => {
    const entries = Object.entries(args);
    return [...entries.slice(0, 12).map(([key, item]) => `${indent}${words(key, true)}: ${value(item)}`),
      ...(entries.length > 12 ? [cut(`${indent}And ${entries.length - 12} more fields (see Exact request)`)] : [])];
  };
  const apps = [...new Set(rows.map(row => appGroup(row.slug)))];
  const named = apps.length === 1 && apps[0] ? appLabel(apps[0]) : null;
  // The account comes first and fields sit indented under their action, so no argument can pass for either.
  const lines = [where.office ? `Bud wants to use the ${where.office}.` : named ? `Bud wants to use ${named}.` : apps.length > 1 ? "Bud wants to use connected apps." : "Bud wants to use a connected app.",
    `Account: ${where.office ? `the ${where.office}` : where.account ?? "the account connected in Connected apps"}`];
  if (call.name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    lines.push(`${rows.length} actions in one request, allowed or denied together:`);
    rows.forEach((row, index) => {
      const group = appGroup(row.slug);
      lines.push(`${index + 1}. ${group && !named ? `${appLabel(group)}: ` : ""}${action(row.slug)}`, ...fields(row.args, "   "));
    });
  } else lines.push(`Action: ${action(call.name)}`, ...fields(call.arguments ?? {}, "  "));
  if (where.account) lines.push("Gmail read-only review: at most 10 threads from the last 7 days, and only thread IDs returned in this task can be read. No sends, drafts or mailbox changes.");
  lines.push("This approval applies once to this request only. The exact request is under Exact request.");
  return { text: lines.join("\n"), complete };
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
const MAIL_BINDING_REQUIRED = "Bud could not verify the sending account and connection generation. Nothing was sent. Check Connected apps and update the managed connector before preparing this message again.";
const MAIL_BINDING_CHANGED = "The verified sending account or connection changed after this message was prepared. Nothing new was sent. Check Connected apps and prepare a new message for review.";
const mailDigest = (value: unknown): string => createHash("sha256").update(connectedAppCanonical(value)).digest("hex");
export const mailRealmDigest = (binding: ConnectedMailBinding, gatewayOrigin: string): string => {
  if (!binding.companyId || connectedMailGatewayOrigin(gatewayOrigin) !== gatewayOrigin) throw new Error(MAIL_BINDING_REQUIRED);
  return mailDigest({ companyId: binding.companyId, gatewayOrigin });
};
export const mailAccountDigest = (binding: ConnectedMailBinding, gatewayOrigin: string): string => {
  mailRealmDigest(binding, gatewayOrigin);
  return mailDigest({ provider: binding.provider, accountId: binding.accountId, companyId: binding.companyId, gatewayOrigin });
};
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
async function prepareMailReview(call: Call, read: MailRead, office?: string): Promise<{ card: string; exact: string; effect: unknown; sender?: string; digest?: string; recheck?: () => Promise<string> } | string> {
  const a: Obj = call.arguments ?? {};
  const mailbox = a.user_id ?? a.userId;
  if (mailbox !== undefined && mailbox !== "me") return "Bud sends only from the connected account's own mailbox (user_id \"me\"). Nothing was sent.";
  let view: MailView, notes: string[] = [], action: string;
  let original: MailView | undefined;
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
  } else if (call.name === "GMAIL_FORWARD_MESSAGE" || call.name === "OUTLOOK_FORWARD_MESSAGE") {
    const id = text(a.message_id, 512);
    if (!id || !/^[A-Za-z0-9_=+/-]{1,512}$/.test(id)) return MAIL_UNREADABLE;
    const load = async (): Promise<MailView> => call.name === "GMAIL_FORWARD_MESSAGE"
      ? gmailMessage(identified(resultData(await read("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", { message_id: id, format: "full" })), id))
      : outlookMessage(read, id, false).then(({ replyTo: _replyTo, ...rest }) => rest);
    original = await load();
    ({ view } = explicitView(call.name, a));
    view.subject = `Fwd: ${original.subject ?? ""}`;
    view.attachments = original.attachments;
    recheck = async () => connectedAppCanonical(await load());
    notes.push("The original message below and every listed original attachment will be forwarded. If the original changes or cannot be read again after approval, Bud will not forward it.");
    action = `Forward message ${JSON.stringify(id)}`;
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
  if (original) {
    if (original.plain !== undefined) sections.push(["Original message (plain text)", original.plain]);
    if (original.html !== undefined) {
      sections.push(["Original message HTML as text (links in brackets)", mailHtmlText(original.html)]);
      sections.push(["Original message HTML source", original.html]);
    }
  }
  const shown = (attachment: MailAttachment) => JSON.stringify(attachment.name) +
    (attachment.type || attachment.size !== undefined ? ` (${[attachment.type, attachment.size !== undefined ? `${attachment.size} bytes` : undefined].filter(Boolean).join(", ")})` : "");
  const card = [
    `Bud wants to send an email from ${office ? `the ${office}` : "the connected mailbox"}. Check every recipient, the subject, the message and the attachments. This approval sends this one message once.`,
    "",
    `Action: ${action} (${call.name})`,
    office ? `From: the ${office}${view.from ? `, as ${JSON.stringify(view.from)}` : ""}` : `From: ${view.from ? JSON.stringify(view.from) : "the connected account"}`,
    `To: ${quote(view.to)}`,
    `Cc: ${quote(view.cc)}`,
    `Bcc: ${quote(view.bcc)}`,
    `Subject: ${view.subject === undefined ? "none" : JSON.stringify(view.subject)}`,
    `Attachments: ${view.attachments.length ? view.attachments.map(shown).join(", ") : "none"}`,
    ...(original ? [`Original From: ${original.from ? JSON.stringify(original.from) : "none"}`, `Original To: ${quote(original.to)}`,
      `Original Cc: ${quote(original.cc)}`, `Original Bcc: ${quote(original.bcc)}`, `Original subject: ${original.subject === undefined ? "none" : JSON.stringify(original.subject)}`] : []),
    ...notes,
    ...sections.flatMap(([title, body]) => {
      const lines = body.replace(/\r\n?/g, "\n").split("\n");
      return [`${title}, ${body.length} characters, every line shown:`, ...lines.map(line => `| ${line}`)];
    }),
  ].join("\n");
  // The exact request goes under the card's "Exact request" disclosure.
  const exact = visibleMailText(JSON.stringify(call, null, 2));
  // Effect identity follows the delivery represented on the card, so changing
  // an ignored argument, protocol metadata or key order cannot replay it.
  const effectView = (message: MailView) => ({ ...message, version: undefined,
    to: [...message.to].sort(), cc: [...message.cc].sort(), bcc: [...message.bcc].sort(), attachments: [...message.attachments].sort((a, b) => connectedAppCanonical(a).localeCompare(connectedAppCanonical(b))) });
  const effect = { message: effectView(view), ...(original ? { original: effectView(original) } : {}),
    ...(call.name.includes("REPLY") ? { replyTo: a.thread_id ?? a.message_id ?? null } : {}) };
  return { card: visibleMailText(card), exact, effect, ...(call.name.endsWith("SEND_DRAFT") && view.from ? { sender: view.from } : {}), ...(recheck ? { digest: original ? connectedAppCanonical(original) : JSON.stringify(view), recheck } : {}) };
}
