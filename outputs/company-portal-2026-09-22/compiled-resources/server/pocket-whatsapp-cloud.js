// Official WhatsApp Business Cloud transport for RealBud Pocket. This is a
// transport only: signed, allowlisted messages enter the canonical Ask thread
// and native buttons call the same server-owned Allow/Deny decision as Desk.
// It never launches the worker gateway or receives a worker toolset.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
import { parsePocketDecision, parsePocketText, pocketApprovalRequestText, pocketDecisionId, pocketHelpText, pocketUnsupportedCommandText, } from "./pocket-shared.js";
import { redactSecretsInText } from "./redact.js";
export const WHATSAPP_GRAPH_VERSION = "v26.0";
const DEFAULT_WEBHOOK_PORT = 8_090;
const WEBHOOK_PATH = "/whatsapp/webhook";
const MAX_WEBHOOK_BYTES = 1_000_000;
const MAX_MESSAGES_PER_WEBHOOK = 20;
// Meta may retry a previously acknowledged webhook. Keep a practical replay
// window for a busy one-PM desk while bounding disk and atomic-write cost.
const MAX_INBOUND_RECEIPTS = 5_000;
const MAX_OUTBOUND_RECEIPTS = 500;
const WHATSAPP_TEXT_LIMIT = 3_500;
function emptyLedger() {
    return { version: 1, inbound: [], outbound: [] };
}
export function normalizeWhatsAppPhoneNumberId(value) {
    if (typeof value !== "string")
        return null;
    const clean = value.trim();
    return /^\d{10,20}$/.test(clean) ? clean : null;
}
export function normalizeWhatsAppUserId(value) {
    if (typeof value !== "string")
        return null;
    const clean = value.replace(/^\+/, "").trim();
    return /^[1-9]\d{6,19}$/.test(clean) ? clean : null;
}
export function normalizeWhatsAppAccessToken(value) {
    if (typeof value !== "string")
        return null;
    const clean = value.trim();
    return clean.length >= 40 && clean.length <= 4_096 && !/[\s\u0000-\u001f\u007f]/.test(clean) ? clean : null;
}
export function normalizeWhatsAppAppSecret(value) {
    if (typeof value !== "string")
        return null;
    const clean = value.trim();
    return /^[a-fA-F0-9]{32,128}$/.test(clean) ? clean : null;
}
export function normalizeWhatsAppVerifyToken(value) {
    if (typeof value !== "string")
        return null;
    const clean = value.trim();
    return /^[A-Za-z0-9_-]{20,128}$/.test(clean) ? clean : null;
}
export function normalizeWhatsAppWebhookPort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1_024 && port <= 65_535 ? port : null;
}
function normalizeGraphVersion(value) {
    return typeof value === "string" && /^v\d{1,2}\.0$/.test(value.trim()) ? value.trim() : WHATSAPP_GRAPH_VERSION;
}
function parseLedger(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("WhatsApp Pocket state is invalid");
    const value = raw;
    if (value.version !== 1 || !Array.isArray(value.inbound) || !Array.isArray(value.outbound)) {
        throw new Error("WhatsApp Pocket state is invalid");
    }
    const inbound = value.inbound.map((item) => {
        if (!item || typeof item.digest !== "string" || !/^[a-f0-9]{64}$/.test(item.digest) ||
            !["message", "decision", "ignored"].includes(item.kind) ||
            !["claimed", "completed", "failed", "interrupted"].includes(item.state) ||
            !Number.isFinite(item.at))
            throw new Error("WhatsApp Pocket inbound receipt is invalid");
        return { ...item };
    });
    const outbound = value.outbound.map((item) => {
        if (!item || typeof item.id !== "string" || !/^[a-f0-9]{24}$/.test(item.id) ||
            typeof item.digest !== "string" || !/^[a-f0-9]{64}$/.test(item.digest) ||
            !["sending", "delivered", "rejected", "effect-unknown"].includes(item.state) ||
            !Number.isFinite(item.at))
            throw new Error("WhatsApp Pocket outbound receipt is invalid");
        return { ...item };
    });
    return {
        version: 1,
        ...(Number.isFinite(value.webhookVerifiedAt) ? { webhookVerifiedAt: Number(value.webhookVerifiedAt) } : {}),
        ...(typeof value.webhookBindingDigest === "string" && /^[a-f0-9]{64}$/.test(value.webhookBindingDigest)
            ? { webhookBindingDigest: value.webhookBindingDigest }
            : {}),
        ...(Number.isFinite(value.lastInboundAt) ? { lastInboundAt: Number(value.lastInboundAt) } : {}),
        inbound: inbound.slice(-MAX_INBOUND_RECEIPTS),
        outbound: outbound.slice(-MAX_OUTBOUND_RECEIPTS),
    };
}
function splitText(value) {
    const clean = value.replace(/\r\n/g, "\n").trim();
    if (!clean)
        return ["RealBud finished without a text reply. Open Ask to review the result."];
    const chunks = [];
    let remaining = clean;
    while (remaining.length > WHATSAPP_TEXT_LIMIT) {
        let cut = remaining.lastIndexOf("\n", WHATSAPP_TEXT_LIMIT);
        if (cut < WHATSAPP_TEXT_LIMIT / 2)
            cut = remaining.lastIndexOf(" ", WHATSAPP_TEXT_LIMIT);
        if (cut < WHATSAPP_TEXT_LIMIT / 2)
            cut = WHATSAPP_TEXT_LIMIT;
        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trimStart();
    }
    if (remaining)
        chunks.push(remaining);
    return chunks;
}
function safeEqualText(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}
export function verifyWhatsAppSignature(raw, signature, appSecret) {
    if (typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/i.test(signature))
        return false;
    const expected = `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;
    return safeEqualText(signature.toLowerCase(), expected.toLowerCase());
}
function graphError(status, body) {
    const code = Number(body?.error?.code);
    const denied = status === 401 || status === 403 || code === 190;
    return Object.assign(new Error(denied ? "Meta rejected the WhatsApp access token." : "Meta rejected the WhatsApp request."), {
        effectUnknown: false,
        status: denied ? 401 : 502,
    });
}
async function graphCall(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    let response;
    try {
        response = await fetchImpl(`${input.graphBase ?? "https://graph.facebook.com"}/${input.path.replace(/^\/+/, "")}`, {
            method: input.method ?? "GET",
            headers: {
                authorization: `Bearer ${input.accessToken}`,
                ...(input.payload ? { "content-type": "application/json" } : {}),
            },
            ...(input.payload ? { body: JSON.stringify(input.payload) } : {}),
            signal: input.signal,
        });
    }
    catch (cause) {
        if (cause instanceof Error && cause.name === "AbortError")
            throw cause;
        throw Object.assign(new Error("Meta could not be reached for WhatsApp."), { effectUnknown: true, status: 502 });
    }
    const body = await response.json().catch(() => null);
    if (!response.ok)
        throw graphError(response.status, body);
    return body;
}
export async function verifyWhatsAppCloudConfig(input, options) {
    const accessToken = normalizeWhatsAppAccessToken(input.accessToken);
    const phoneNumberId = normalizeWhatsAppPhoneNumberId(input.phoneNumberId);
    if (!accessToken)
        throw Object.assign(new Error("Enter a valid WhatsApp Cloud access token."), { status: 400 });
    if (!phoneNumberId)
        throw Object.assign(new Error("Enter the numeric WhatsApp Phone Number ID from Meta."), { status: 400 });
    const controller = options?.signal ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), 15_000) : null;
    try {
        const result = await graphCall({
            accessToken,
            path: `${normalizeGraphVersion(input.graphVersion)}/${phoneNumberId}?fields=display_phone_number,verified_name`,
            fetchImpl: options?.fetchImpl,
            graphBase: options?.graphBase,
            signal: options?.signal ?? controller?.signal,
        });
        return {
            displayPhoneNumber: typeof result.display_phone_number === "string" ? result.display_phone_number : null,
            verifiedName: typeof result.verified_name === "string" ? result.verified_name : null,
        };
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function readBoundedBody(req) {
    return await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            reject(error);
        };
        req.on("data", (chunk) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += data.length;
            if (size > MAX_WEBHOOK_BYTES) {
                fail(Object.assign(new Error("webhook body too large"), { status: 413 }));
                req.resume();
                return;
            }
            chunks.push(data);
        });
        req.on("end", () => {
            if (settled)
                return;
            settled = true;
            resolve(Buffer.concat(chunks));
        });
        req.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    });
}
function reply(res, status, body, contentType = "text/plain; charset=utf-8") {
    res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
    res.end(body);
}
function extractMessages(raw, expectedPhoneNumberId) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("invalid WhatsApp webhook");
    const body = raw;
    if (body.object !== "whatsapp_business_account" || !Array.isArray(body.entry))
        throw new Error("invalid WhatsApp webhook");
    const messages = [];
    for (const entry of body.entry.slice(0, 20)) {
        const changes = entry?.changes;
        if (!Array.isArray(changes))
            continue;
        for (const change of changes.slice(0, 20)) {
            const value = change?.value;
            if (change.field !== "messages" || !value)
                continue;
            if (String(value.metadata?.phone_number_id ?? "") !== expectedPhoneNumberId)
                continue;
            if (Array.isArray(value.messages))
                messages.push(...value.messages.slice(0, MAX_MESSAGES_PER_WEBHOOK));
            if (messages.length >= MAX_MESSAGES_PER_WEBHOOK)
                return messages.slice(0, MAX_MESSAGES_PER_WEBHOOK);
        }
    }
    return messages;
}
export class WhatsAppCloudGateway {
    handlers;
    stateFile;
    fetchImpl;
    graphBase;
    now;
    configuredPort;
    onStatusChange;
    ledger = emptyLedger();
    config = {
        enabled: false,
        pilotReady: false,
        accessToken: "",
        appSecret: "",
        verifyToken: "",
        phoneNumberId: "",
        allowedUserId: "",
        webhookPort: DEFAULT_WEBHOOK_PORT,
        graphVersion: WHATSAPP_GRAPH_VERSION,
    };
    current = {
        provider: "whatsapp-cloud",
        configured: false,
        enabled: false,
        pilotReady: false,
        state: "off",
        detail: "WhatsApp Business is off.",
        allowedUserId: "",
        phoneNumberId: "",
        displayPhoneNumber: null,
        verifiedName: null,
        webhookPort: DEFAULT_WEBHOOK_PORT,
        webhookPath: WEBHOOK_PATH,
        webhookVerifiedAt: null,
        lastInboundAt: null,
        deliveryUncertain: false,
    };
    server = null;
    generation = 0;
    workQueue = Promise.resolve();
    constructor(options) {
        this.handlers = options.handlers;
        this.stateFile = options.stateFile ?? join(DATA_DIR, "pocket-whatsapp-state.json");
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.graphBase = options.graphBase ?? "https://graph.facebook.com";
        this.now = options.now ?? Date.now;
        this.configuredPort = options.listenPort;
        this.onStatusChange = options.onStatusChange;
    }
    status() {
        return { ...this.current };
    }
    setStatus(patch) {
        this.current = { ...this.current, ...patch };
        this.onStatusChange?.(this.status());
    }
    persistLedger() {
        mkdirSync(dirname(this.stateFile), { recursive: true });
        this.ledger.inbound = this.ledger.inbound.slice(-MAX_INBOUND_RECEIPTS);
        this.ledger.outbound = this.ledger.outbound.slice(-MAX_OUTBOUND_RECEIPTS);
        writeFileAtomic(this.stateFile, JSON.stringify(this.ledger));
    }
    webhookBindingDigest() {
        return createHmac("sha256", this.config.appSecret)
            .update(`realbud-pocket-whatsapp-v1\0${this.config.phoneNumberId}\0${this.config.verifyToken}`)
            .digest("hex");
    }
    assertGeneration(generation) {
        if (generation !== this.generation) {
            throw Object.assign(new Error("WhatsApp Pocket changed while this request was running."), {
                code: "POCKET_INTERRUPTED",
            });
        }
    }
    setInboundState(receipt, state) {
        receipt.state = state;
        const durable = this.ledger.inbound.find((item) => item.digest === receipt.digest);
        if (durable)
            durable.state = state;
    }
    loadLedger() {
        this.ledger = existsSync(this.stateFile)
            ? parseLedger(JSON.parse(readFileSync(this.stateFile, "utf8")))
            : emptyLedger();
        let interrupted = false;
        for (const receipt of this.ledger.inbound) {
            if (receipt.state === "claimed") {
                receipt.state = "interrupted";
                interrupted = true;
            }
        }
        for (const receipt of this.ledger.outbound) {
            if (receipt.state === "sending")
                receipt.state = "effect-unknown";
        }
        if (interrupted || this.ledger.outbound.some((item) => item.state === "effect-unknown"))
            this.persistLedger();
        return { interrupted };
    }
    async configure(input) {
        await this.stop();
        const accessToken = normalizeWhatsAppAccessToken(input.accessToken) ?? "";
        const appSecret = normalizeWhatsAppAppSecret(input.appSecret) ?? "";
        const verifyToken = normalizeWhatsAppVerifyToken(input.verifyToken) ?? "";
        const phoneNumberId = normalizeWhatsAppPhoneNumberId(input.phoneNumberId) ?? "";
        const allowedUserId = normalizeWhatsAppUserId(input.allowedUserId) ?? "";
        const webhookPort = this.configuredPort ?? normalizeWhatsAppWebhookPort(input.webhookPort) ?? DEFAULT_WEBHOOK_PORT;
        const graphVersion = normalizeGraphVersion(input.graphVersion);
        const configured = Boolean(accessToken && appSecret && verifyToken && phoneNumberId && allowedUserId);
        this.config = {
            enabled: input.enabled,
            pilotReady: input.pilotReady,
            accessToken,
            appSecret,
            verifyToken,
            phoneNumberId,
            allowedUserId,
            webhookPort,
            graphVersion,
        };
        this.setStatus({
            configured,
            enabled: input.enabled,
            pilotReady: input.pilotReady,
            allowedUserId,
            phoneNumberId,
            displayPhoneNumber: null,
            verifiedName: null,
            webhookPort,
            webhookVerifiedAt: null,
            lastInboundAt: null,
            deliveryUncertain: false,
        });
        if (!input.pilotReady) {
            this.setStatus({ state: "pilot-gated", detail: "Name the pilot agency and PM before WhatsApp Business can connect." });
            return this.status();
        }
        if (!input.enabled) {
            this.setStatus({ state: "off", detail: configured ? "WhatsApp Business is configured but off." : "WhatsApp Business is off." });
            return this.status();
        }
        if (!configured) {
            this.setStatus({ state: "setup-required", detail: "Add the Meta business number, PM allowlist, access token, App Secret and Verify Token." });
            return this.status();
        }
        let interrupted = false;
        try {
            ({ interrupted } = this.loadLedger());
        }
        catch {
            this.setStatus({ state: "attention", detail: "WhatsApp delivery state is unreadable. RealBud refused the webhook so old requests cannot replay." });
            return this.status();
        }
        const bindingDigest = this.webhookBindingDigest();
        if (this.ledger.webhookBindingDigest !== bindingDigest) {
            // A verification from another number/app-secret/token combination is
            // not evidence that this configuration is connected.
            delete this.ledger.webhookVerifiedAt;
            this.ledger.webhookBindingDigest = bindingDigest;
            this.persistLedger();
        }
        this.setStatus({
            state: "connecting",
            detail: "Checking the Meta business number…",
            webhookVerifiedAt: this.ledger.webhookVerifiedAt ?? null,
            lastInboundAt: this.ledger.lastInboundAt ?? null,
            deliveryUncertain: this.ledger.outbound.some((item) => item.state === "effect-unknown"),
        });
        try {
            const verified = await verifyWhatsAppCloudConfig({ accessToken, phoneNumberId, graphVersion }, { fetchImpl: this.fetchImpl, graphBase: this.graphBase });
            await this.startServer();
            const deliveryUncertain = this.ledger.outbound.some((item) => item.state === "effect-unknown");
            const webhookVerifiedAt = this.ledger.webhookVerifiedAt ?? null;
            const state = deliveryUncertain || interrupted
                ? "attention"
                : webhookVerifiedAt
                    ? "ready"
                    : "setup-required";
            this.setStatus({
                state,
                detail: deliveryUncertain
                    ? "A prior WhatsApp reply has an unknown delivery result. Check Ask before repeating it."
                    : interrupted
                        ? "RealBud restarted during a WhatsApp request. It was not replayed; check Ask before resending."
                        : webhookVerifiedAt
                            ? "Connected to the same Ask thread through the signed Meta webhook."
                            : `Meta credentials are valid. Point an HTTPS tunnel at 127.0.0.1:${this.current.webhookPort}${WEBHOOK_PATH}, then verify the webhook in Meta.`,
                displayPhoneNumber: verified.displayPhoneNumber,
                verifiedName: verified.verifiedName,
                webhookVerifiedAt,
                deliveryUncertain,
            });
        }
        catch (error) {
            await this.closeServer();
            this.setStatus({
                state: "attention",
                detail: error.status === 401
                    ? "Meta rejected the WhatsApp access token. Replace it in You."
                    : error.code === "EADDRINUSE"
                        ? `WhatsApp webhook port ${webhookPort} is already in use. Choose another local port.`
                        : "WhatsApp Business could not start. Check the Meta setup and local webhook port.",
            });
        }
        return this.status();
    }
    async stop() {
        this.generation += 1;
        await this.closeServer();
    }
    async closeServer() {
        const active = this.server;
        this.server = null;
        if (!active)
            return;
        await new Promise((resolve) => active.close(() => resolve()));
    }
    async startServer() {
        const generation = this.generation;
        const server = createServer((req, res) => void this.handleHttp(req, res, generation));
        server.requestTimeout = 15_000;
        server.headersTimeout = 10_000;
        server.maxConnections = 32;
        await new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            server.once("error", onError);
            server.listen(this.config.webhookPort, "127.0.0.1", () => {
                server.off("error", onError);
                const address = server.address();
                if (address && typeof address === "object") {
                    this.config.webhookPort = address.port;
                    this.setStatus({ webhookPort: address.port });
                }
                resolve();
            });
        });
        this.server = server;
    }
    async handleHttp(req, res, generation) {
        try {
            const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.config.webhookPort}`);
            if (url.pathname === "/health" && req.method === "GET") {
                return reply(res, 200, JSON.stringify({
                    app: "realbud-pocket",
                    channel: "whatsapp-cloud",
                    configured: this.current.configured,
                    webhookVerified: Boolean(this.ledger.webhookVerifiedAt),
                }), "application/json; charset=utf-8");
            }
            if (url.pathname !== WEBHOOK_PATH || generation !== this.generation)
                return reply(res, 404, "not found");
            if (req.method === "GET")
                return this.handleVerification(url, res);
            if (req.method !== "POST")
                return reply(res, 405, "method not allowed");
            const raw = await readBoundedBody(req);
            if (!verifyWhatsAppSignature(raw, req.headers["x-hub-signature-256"], this.config.appSecret)) {
                return reply(res, 401, "invalid signature");
            }
            let body;
            try {
                body = JSON.parse(raw.toString("utf8"));
            }
            catch {
                return reply(res, 400, "invalid json");
            }
            const messages = extractMessages(body, this.config.phoneNumberId);
            for (const message of messages)
                this.claimAndQueue(message, generation);
            // Claims are durable before this acknowledgement. Work continues on a
            // serial queue because Meta expects a fast webhook response, while an
            // Ask turn may take minutes.
            return reply(res, 200, "EVENT_RECEIVED");
        }
        catch (error) {
            return reply(res, Number(error.status) || 400, "webhook rejected");
        }
    }
    handleVerification(url, res) {
        const mode = url.searchParams.get("hub.mode") ?? "";
        const token = url.searchParams.get("hub.verify_token") ?? "";
        const challenge = url.searchParams.get("hub.challenge") ?? "";
        if (mode !== "subscribe" || !token || !safeEqualText(token, this.config.verifyToken) || !challenge || challenge.length > 512) {
            return reply(res, 403, "verification failed");
        }
        this.ledger.webhookVerifiedAt = this.now();
        this.ledger.webhookBindingDigest = this.webhookBindingDigest();
        this.persistLedger();
        this.setStatus({
            state: this.current.deliveryUncertain ? "attention" : "ready",
            detail: this.current.deliveryUncertain
                ? this.current.detail
                : "Connected to the same Ask thread through the signed Meta webhook.",
            webhookVerifiedAt: this.ledger.webhookVerifiedAt,
        });
        return reply(res, 200, challenge);
    }
    claimAndQueue(message, generation) {
        const rawId = typeof message.id === "string" ? message.id : "";
        if (!rawId || rawId.length > 256)
            return;
        const digest = createHash("sha256").update(rawId).digest("hex");
        if (this.ledger.inbound.some((item) => item.digest === digest))
            return;
        const from = normalizeWhatsAppUserId(message.from);
        const decisionValue = message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id;
        const receipt = {
            digest,
            kind: from !== this.config.allowedUserId
                ? "ignored"
                : parsePocketDecision(decisionValue)
                    ? "decision"
                    : "message",
            state: "claimed",
            at: this.now(),
        };
        this.ledger.inbound.push(receipt);
        this.persistLedger();
        if (from !== this.config.allowedUserId) {
            receipt.state = "completed";
            this.persistLedger();
            return;
        }
        this.ledger.lastInboundAt = this.now();
        this.persistLedger();
        this.setStatus({ lastInboundAt: this.ledger.lastInboundAt });
        this.workQueue = this.workQueue
            .then(async () => {
            if (generation !== this.generation) {
                this.setInboundState(receipt, "interrupted");
                this.persistLedger();
                return;
            }
            try {
                await this.handleMessage(message, generation);
                this.setInboundState(receipt, "completed");
            }
            catch {
                if (generation !== this.generation) {
                    this.setInboundState(receipt, "interrupted");
                }
                else {
                    this.setInboundState(receipt, "failed");
                    await this.deliver("RealBud could not complete that mobile request. Nothing was retried automatically; open Ask to review it.", undefined, generation).catch(() => { });
                }
            }
            this.persistLedger();
        })
            .catch(() => { });
    }
    async handleMessage(message, generation) {
        const decision = parsePocketDecision(message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id);
        if (decision) {
            let outcome;
            try {
                outcome = await this.handlers.onDecision(decision.messageId, decision.decision);
            }
            catch (error) {
                outcome = redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 300)
                    || "RealBud could not apply that decision.";
            }
            this.assertGeneration(generation);
            await this.deliver(outcome, undefined, generation);
            return;
        }
        const parsed = parsePocketText(message.type === "text" ? message.text?.body : undefined);
        if (!parsed.ok) {
            await this.deliver(parsed.reason, undefined, generation);
            return;
        }
        const command = parsed.text.toLowerCase();
        if (command === "/start" || command === "/help" || command === "help") {
            await this.deliver(pocketHelpText("WhatsApp Business"), undefined, generation);
            return;
        }
        if (command === "/status" || command === "status") {
            const status = await this.handlers.onStatus();
            this.assertGeneration(generation);
            await this.deliver(status, undefined, generation);
            return;
        }
        if (command.startsWith("/")) {
            await this.deliver(pocketUnsupportedCommandText(), undefined, generation);
            return;
        }
        const result = await this.handlers.onText(parsed.text);
        this.assertGeneration(generation);
        await this.deliver(result.text, result.action, generation);
    }
    async deliver(text, action, generation) {
        this.assertGeneration(generation);
        const clean = redactSecretsInText(text);
        if (action) {
            // Validate the server-owned id before the first possible network effect.
            const allowId = pocketDecisionId("allow", action.messageId);
            const denyId = pocketDecisionId("deny", action.messageId);
            for (const chunk of splitText(clean)) {
                await this.sendPayload({ type: "text", text: { preview_url: false, body: chunk } }, generation);
            }
            const body = pocketApprovalRequestText(action, 1_024);
            await this.sendPayload({
                type: "interactive",
                interactive: {
                    type: "button",
                    body: { text: body },
                    action: { buttons: [
                            { type: "reply", reply: { id: allowId, title: "Allow once" } },
                            { type: "reply", reply: { id: denyId, title: "Not now" } },
                        ] },
                },
            }, generation);
            return;
        }
        for (const chunk of splitText(clean)) {
            await this.sendPayload({ type: "text", text: { preview_url: false, body: chunk } }, generation);
        }
    }
    async sendPayload(payload, generation) {
        this.assertGeneration(generation);
        const deliveryConfig = {
            accessToken: this.config.accessToken,
            graphVersion: this.config.graphVersion,
            phoneNumberId: this.config.phoneNumberId,
            allowedUserId: this.config.allowedUserId,
        };
        const serialized = JSON.stringify(payload);
        const receipt = {
            id: randomBytes(12).toString("hex"),
            digest: createHash("sha256").update(serialized).digest("hex"),
            state: "sending",
            at: this.now(),
        };
        this.ledger.outbound.push(receipt);
        this.persistLedger();
        try {
            await graphCall({
                accessToken: deliveryConfig.accessToken,
                path: `${deliveryConfig.graphVersion}/${deliveryConfig.phoneNumberId}/messages`,
                method: "POST",
                payload: {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: deliveryConfig.allowedUserId,
                    ...payload,
                },
                fetchImpl: this.fetchImpl,
                graphBase: this.graphBase,
            });
            receipt.state = "delivered";
            const durable = this.ledger.outbound.find((item) => item.id === receipt.id);
            if (durable)
                durable.state = "delivered";
            this.persistLedger();
            this.assertGeneration(generation);
        }
        catch (error) {
            if (generation !== this.generation) {
                // Reconfiguration already projected any in-flight send as unknown.
                // Do not attach old-channel failure state to the new channel.
                throw error;
            }
            if (error.effectUnknown) {
                receipt.state = "effect-unknown";
                this.setStatus({
                    state: "attention",
                    detail: "A WhatsApp reply may not have arrived. Check Ask before repeating the request.",
                    deliveryUncertain: true,
                });
            }
            else {
                receipt.state = "rejected";
                this.setStatus({
                    state: "attention",
                    detail: error.status === 401
                        ? "Meta rejected the saved WhatsApp access token."
                        : "Meta rejected a WhatsApp reply. Check the 24-hour reply window and business setup.",
                });
            }
            this.persistLedger();
            throw error;
        }
    }
}
