/**
 * Ask's model relay: a loopback chat-completions endpoint owned by the RealBud
 * server process, between the Ask worker (Hermes ACP) and the office's
 * Modelvia grant.
 *
 * Why it exists: Hermes 0.21.3 ACP builds every agent, including after
 * `session/set_model`, through `acp_adapter/session.py _make_agent` without a
 * `reasoning_config`, so the profile's `agent.reasoning_effort` never reaches
 * the wire and the office's model choice (`shared/managed-model-choices.ts`)
 * was only half applied in Ask. 0.21.5 ACP does pass the profile's effort
 * (and its custom provider sends `medium` when none is set), but the profile
 * sits in worker-writable storage, so the relay still decides. It sets
 * top-level `reasoning_effort` (the field the custom provider profile itself
 * uses, and the one Modelvia answers `unsupported_parameter:reasoning_effort`
 * on when a model refuses a value) from the current choice on every request,
 * replacing whatever the worker sent, and drops any second reasoning channel.
 * Messages, tools and replay fields pass through untouched. The one other
 * model it admits is `MANAGED_VISION_CHOICE`'s, for an office on a text-only
 * choice and only for Hermes' image call (`auxiliaryImageRequest`), never for
 * a turn.
 *
 * Key custody: the office key stays in this process (`workerModelAccessSnapshot`,
 * refreshed from the private vault). An Ask worker gets only the loopback URL
 * and a random execution-scoped token, under the env name the profile's
 * `providers.realbud.key_env` already names. The worker profile is not
 * rewritten: it keeps naming the granted endpoint, which every other managed
 * launch and readiness check still verifies. Ask is pointed at the relay per
 * launch through Hermes' own managed-scope overlay (`HERMES_MANAGED_DIR`,
 * hermes_cli/managed_scope.py), whose values win at the leaf over the profile
 * (hermes_cli/config.py `_merge_managed_overlay`). The overlay pins all three
 * URL spellings upstream reads (`api`, `url`, `base_url`;
 * hermes_cli/runtime_provider_custom.py `_entry_url`), so no profile edit can
 * route around it. If the overlay were ever ignored, the worker would present
 * the token to the granted endpoint and be refused: an Ask worker never holds
 * the key. Each token belongs to one execution's lease (`createAskModelRelayLease`,
 * `withAskModelRelayLease`): revoked on completion, error or Stop, it is
 * refused from then on and its in-flight exchanges are aborted. An exchange is
 * also aborted when the grant or key it was admitted under is withdrawn or
 * replaced. Ask turns, one-shot CLI jobs and loops (`recipe-draft.ts`
 * `askWorker`), `hermes-hands.ts` and `import-inspect.ts` all reason through
 * this relay; only assigned department cases use their own relay
 * (`department-worker.ts`). Each lease also counts the Modelvia requests its
 * exchanges made (`RunUsage`), so a run can show what it cost, and how long
 * they took (`RunUsage.timing`), for the Ask turn's operational log line.
 *
 * The overlay folder is outside the worker's Hermes home and workroom but, on
 * one OS account, nothing a same-user process cannot write. Hermes rereads it
 * whenever its mtime or size changes and also loads a `.env` from it, so a
 * worker that edited it could override pack policy mid-session. Every request
 * and launch therefore re-verifies the folder (only `config.yaml`, read-only
 * modes, exact bytes); on any change the relay refuses everything until
 * RealBud restarts and calls `onTamper` so the running workers are retired.
 *
 * Nothing here logs a body, a key or a token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";

import { DATA_DIR } from "./config.ts";
import { writePrivateJson } from "./private-json.ts";
import { hermesHome } from "./hermes-paths.ts";
import { managedServiceFailure } from "./managed-service.ts";
import { workerModelGrant } from "./worker-model-access.ts";
import { MANAGED_MODEL_KEY_ENV, MANAGED_MODEL_PROVIDER_ENTRY, managedModelProfile } from "./hermes-pack.ts";
import { MANAGED_ACCESS_RELAY_DOWN, managedModelLaunchRefusal, normalizedGatewayUrl, onWorkerModelAccessChange, workerModelAccessSnapshot } from "./hermes-runtime-env.ts";
import { MANAGED_VISION_CHOICE, managedModelChoice } from "../shared/managed-model-choices.ts";
import { noteModelKeyAnswer } from "./office-link.ts";
import { emptyRunUsage, noteModelExchange, noteModelviaReply, noteModelviaRequest, recordJevUsage, type JevCall } from "./run-cost.ts";
import type { RunUsage } from "../shared/contracts.ts";

/** Office copy when an Ask launch finds no running relay in this process.
 * Listed in `MANAGED_ACCESS_REFUSALS`, so Ask shows exactly this sentence. */
export const ASK_MODEL_RELAY_UNAVAILABLE = MANAGED_ACCESS_RELAY_DOWN;

const VISION_CHOICE = managedModelChoice(MANAGED_VISION_CHOICE);
/** What Bud is told when a text-only office's plan refuses the image model
 * (Modelvia 403 `mode_not_allowed`, 503 `model_route_unavailable`). */
export const ASK_VISION_UNAVAILABLE = `Bud can't read images on this office's AI plan right now. To read images, choose ${VISION_CHOICE.label} in Bud setup, or ask RealBud support to add it to the plan.`;

/** Hermes' auxiliary image call (0.21.5 tools/vision_tools.py `_media_messages`
 * → agent/auxiliary_client.py `async_call_llm(task="vision")`): one user
 * message of text and at least one image, and no tools. A turn carries Bud's
 * instructions and its conversation, so it never matches. */
function auxiliaryImageRequest(body: Record<string, unknown>): boolean {
  if (["tools", "tool_choice", "functions", "function_call"].some(key => body[key] !== undefined)) return false;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length !== 1) return false;
  const message = messages[0] as { role?: unknown; content?: unknown } | null;
  if (!message || typeof message !== "object" || message.role !== "user" || !Array.isArray(message.content)) return false;
  const types = (message.content as unknown[]).map(part => part && typeof part === "object" ? (part as { type?: unknown }).type : undefined);
  return types.includes("image_url") && types.every(type => type === "text" || type === "image_url");
}

/** The Hermes env name that selects a managed-scope directory. */
export const ASK_MODEL_RELAY_OVERLAY_ENV = "HERMES_MANAGED_DIR";

const CHAT_PATH = "/chat/completions";
const MODELS_PATH = "/models";
/** A model listing is a small JSON document; the read is bounded tighter than chat. */
const MAX_LISTING_BYTES = 1024 * 1024;
const LISTING_TIMEOUT_MS = 15_000;
/** Ask turns carry the whole conversation and, on Sonnet, images. */
const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** One model exchange, headers to last byte. The loopback URL makes Hermes
 * treat the endpoint as local and relax its own stale timers, so this is the
 * bound on a stalled upstream. */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** Once the AI service has answered, the longest it may go without sending a
 * byte before the exchange is ended. Streams carry tokens or keep-alives well
 * inside this. */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/** Abort reason for an answer that stopped arriving. */
const IDLE = Symbol("idle");
const STALLED = "The AI service stopped sending its answer. Try again.";
const IDEMPOTENCY_MEMORY = 256;
/** Output ceiling before the gateway's listing has been read: the smallest
 * `max_output_tokens` the gateway publishes for the offered models. */
const FALLBACK_MAX_OUTPUT_TOKENS = 32_000;
/** Longest 429 wait passed to the worker. Hermes' OpenAI SDK ignores a
 * longer Retry-After and falls back to its own short backoff. */
const MAX_RETRY_AFTER_SECONDS = 60;
/** A non-streamed JSON answer larger than this is relayed but not read for usage. */
const MAX_USAGE_BODY_BYTES = 2 * 1024 * 1024;
/** Abort reason for an exchange whose grant or key was withdrawn mid-flight. */
const GRANT_ENDED = Symbol("grant ended");
/** Read-only after writing; any other mode is a change made outside RealBud. */
const OVERLAY_DIR_MODE = 0o500, OVERLAY_FILE_MODE = 0o400;

export interface AskModelRelayOptions {
  /** Hermes home whose worker profile holds the office's choice. */
  root?: string;
  /** Private directory for the managed-scope overlay. Defaults under the data dir. */
  overlayDir?: string;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  /** No bytes from the AI service for this long, after it answered, ends the exchange. */
  idleTimeoutMs?: number;
  /** Entitlement check per request; defaults to the managed service's reasoning capability. */
  serviceFailure?: () => string | null;
  /** Called once when the overlay folder was changed outside RealBud; the
   * composition retires the running workers. */
  onTamper?: () => void;
}

export interface AskModelRelay {
  url: string;
  overlayDir: string;
  close(): Promise<void>;
}

interface ActiveRelay {
  url: string; home: string; overlayDir: string; overlayPath: string; overlayBody: string;
  compromised: boolean; onTamper?: () => void;
  /** Live execution tokens; a revoked lease's token is removed. */
  capabilities: Map<string, RelayCapability>;
}
interface RelayCapability {
  token: Buffer; relay: ActiveRelay; scope: LeaseScope;
  inflight: Set<AbortController>;
  /** body digest → the Idempotency-Key its first attempt carried, so an SDK
   * retry of a lost reply is answered from Modelvia's receipt instead of
   * charged again. Never shared across executions. */
  issued: Map<string, string>;
}
interface LeaseScope { revoked: boolean; capability?: RelayCapability; usage: RunUsage }
const leaseContext = new AsyncLocalStorage<LeaseScope>();
let active: ActiveRelay | null = null;

export interface AskModelRelayLease {
  /** Run a launch inside this lease, so `applyAskModelRelayEnv` mints its token. */
  run<T>(operation: () => T): T;
  /** Final and synchronous: the token is refused from now on and its exchanges abort. */
  revoke(): void;
  /** The Modelvia requests made since the last take; counting starts again. */
  takeUsage(): RunUsage;
  /** One Jev decision this execution asked (Bud's `decide` tool), counted with its requests. */
  recordJev(result: JevCall): void;
}

/** One execution's relay authority. Nothing is granted until a checked
 * launch inside `run` applies its environment. `usage`, when given, is the
 * counter its exchanges record into. */
export function createAskModelRelayLease(options: { signal?: AbortSignal; usage?: RunUsage } = {}): AskModelRelayLease {
  const scope: LeaseScope = { revoked: false, usage: options.usage ?? emptyRunUsage() };
  const revoke = () => {
    scope.revoked = true;
    options.signal?.removeEventListener("abort", revoke);
    const capability = scope.capability;
    if (!capability) return;
    capability.relay.capabilities.delete(capability.token.toString());
    capability.issued.clear();
    for (const controller of capability.inflight) controller.abort();
  };
  if (options.signal?.aborted) revoke();
  else options.signal?.addEventListener("abort", revoke, { once: true });
  const takeUsage = () => { const taken = scope.usage; scope.usage = emptyRunUsage(); return taken; };
  return { run: operation => leaseContext.run(scope, operation), revoke, takeUsage, recordJev: result => recordJevUsage(scope.usage, result) };
}

/** A one-shot launch holds relay authority only until its operation settles. */
export async function withAskModelRelayLease<T>(operation: () => Promise<T>, options: { signal?: AbortSignal; usage?: RunUsage } = {}): Promise<T> {
  const lease = createAskModelRelayLease(options);
  try { return await lease.run(operation); }
  finally { lease.revoke(); }
}

/** The overlay Hermes deep-merges over the profile for one Ask worker. JSON is
 * YAML, and upstream parses the file with `yaml.safe_load`. */
export function askModelRelayOverlay(relayUrl: string): { providers: Record<string, { api: string; url: string; base_url: string }> } {
  return { providers: { [MANAGED_MODEL_PROVIDER_ENTRY]: { api: relayUrl, url: relayUrl, base_url: relayUrl } } };
}

/**
 * Put the relay into one Ask worker launch. Call AFTER the adapter's strip
 * (`hardenHermesChildEnv`). Returns office copy instead of launching when the
 * managed access refuses, or when this process has no relay for that Hermes
 * home; nothing is added then. The office key is never added.
 */
export function applyAskModelRelayEnv(env: NodeJS.ProcessEnv, root?: string): string | null {
  const refusal = managedModelLaunchRefusal(root);
  if (refusal) return refusal;
  const relay = active;
  if (!relay || resolve(hermesHome(root, env)) !== relay.home || !overlayHolds(relay)) return ASK_MODEL_RELAY_UNAVAILABLE;
  // Outside a live lease there is no execution to scope a token to.
  const scope = leaseContext.getStore();
  if (!scope || scope.revoked || scope.capability && scope.capability.relay !== relay) return ASK_MODEL_RELAY_UNAVAILABLE;
  if (!scope.capability) {
    const tokenText = randomBytes(32).toString("hex");
    scope.capability = { token: Buffer.from(tokenText), relay, scope, inflight: new Set(), issued: new Map() };
    relay.capabilities.set(tokenText, scope.capability);
  }
  env[MANAGED_MODEL_KEY_ENV] = scope.capability.token.toString();
  env[ASK_MODEL_RELAY_OVERLAY_ENV] = relay.overlayDir;
  return null;
}

/** The running relay's loopback port, from this process's own state: a
 * worker launch's sandbox names it from here, never from the overlay file
 * (a worker-writable file must not decide what a later worker may reach). */
export function askModelRelayPort(): number | null {
  if (!active) return null;
  const port = Number(new URL(active.url).port);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** The folder holds exactly the `config.yaml` this process wrote: no `.env`
 * or other file, no link, the read-only modes, and the same bytes. */
export function overlayIntact(overlayDir: string, overlayBody: string): boolean {
  try {
    const folder = lstatSync(overlayDir);
    if (!folder.isDirectory() || folder.isSymbolicLink()) return false;
    const entries = readdirSync(overlayDir);
    if (entries.length !== 1 || entries[0] !== "config.yaml") return false;
    const path = join(overlayDir, "config.yaml"), file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1) return false;
    if (process.platform !== "win32" && ((folder.mode & 0o777) !== OVERLAY_DIR_MODE || (file.mode & 0o777) !== OVERLAY_FILE_MODE ||
        folder.uid !== process.getuid?.() || file.uid !== process.getuid?.())) return false;
    return readFileSync(path, "utf8") === overlayBody;
  } catch { return false; }
}

/** Once the overlay was changed, the relay stays refused until RealBud restarts. */
function overlayHolds(relay: ActiveRelay): boolean {
  if (relay.compromised) return false;
  if (overlayIntact(relay.overlayDir, relay.overlayBody)) return true;
  relay.compromised = true;
  try { relay.onTamper?.(); } catch { /* the refusal stands either way */ }
  return false;
}

function removeOverlay(overlayDir: string): void {
  try { if (process.platform !== "win32" && lstatSync(overlayDir).isDirectory()) chmodSync(overlayDir, 0o700); } catch { /* absent */ }
  rmSync(overlayDir, { recursive: true, force: true });
}

/** `max_tokens`/`max_completion_tokens` when present: a positive integer, at most the model's output ceiling. */
function clampOutput(body: Record<string, unknown>, ceiling: number): void {
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) throw new RelayRefusal(400, "Bud's AI connection received a request it cannot read.");
    body[field] = Math.min(Math.floor(value), ceiling);
  }
}

/** The upstream's Retry-After as whole seconds in [0, MAX_RETRY_AFTER_SECONDS],
 * from delta-seconds or an HTTP date; null when absent or malformed. */
export function boundedRetryAfter(value: string | null, now = Date.now()): string | null {
  const text = value?.trim() ?? "";
  let seconds: number;
  if (/^\d{1,10}$/.test(text)) seconds = Number(text);
  else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text) && Number.isFinite(Date.parse(text))) {
    seconds = Math.max(0, Math.ceil((Date.parse(text) - now) / 1000));
  } else return null;
  return String(Math.min(seconds, MAX_RETRY_AFTER_SECONDS));
}

/** The live execution capability this request's token names, if any. The
 * map lookup finds the candidate; the constant-time compare decides. */
function requestCapability(request: IncomingMessage, relay: ActiveRelay | undefined): RelayCapability | undefined {
  const auth = request.headers.authorization;
  const presented = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7)
    : typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : "";
  const capability = relay?.capabilities.get(presented);
  if (!capability || capability.scope.revoked) return undefined;
  const candidate = Buffer.from(presented);
  return candidate.length === capability.token.length && timingSafeEqual(candidate, capability.token) ? capability : undefined;
}

function refuse(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.destroyed) { response.destroy(); return; }
  const body = JSON.stringify({ error: { message, type: "realbud_relay_refused" } });
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(body);
}

class RelayRefusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function readBody(request: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new RelayRefusal(413, "This request is too large for Bud's AI connection.");
  const chunks: Buffer[] = []; let size = 0;
  // A lease revoked mid-upload stops the read too.
  const stop = () => request.destroy();
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) throw new RelayRefusal(413, "This request is too large for Bud's AI connection.");
      chunks.push(chunk);
    }
  } finally { signal.removeEventListener("abort", stop); }
  return Buffer.concat(chunks);
}

/**
 * Read-only `GET /models` from the granted gateway with the office key,
 * answered with only the office's chosen model entry (or an empty list), so
 * Hermes resolves the same context window it reads from the gateway directly
 * (an exact id match in `_resolve_endpoint_context_length`). A refusal status
 * passes through without its body; Hermes stops probing on 401/403.
 */
async function relayModelListing(response: ServerResponse, url: string, key: string, keyId: string, model: string, signal: AbortSignal, remember: (maxOutput: number) => void): Promise<void> {
  const upstream = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${key}` },
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(LISTING_TIMEOUT_MS)]),
  });
  const chunks: Uint8Array[] = []; let size = 0;
  if (upstream.body) for await (const part of upstream.body) {
    size += part.length;
    if (size > MAX_LISTING_BYTES) throw new RelayRefusal(502, "Bud's AI connection could not read the AI service's model list.");
    chunks.push(part);
  }
  noteKeyAnswer(keyId, upstream.status);
  if (!upstream.ok) { refuse(response, upstream.status, "The AI service did not return its model list."); return; }
  let listed: unknown;
  try { listed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RelayRefusal(502, "Bud's AI connection could not read the AI service's model list."); }
  const data = listed && typeof listed === "object" && Array.isArray((listed as { data?: unknown }).data) ? (listed as { data: unknown[] }).data : [];
  const chosen = data.filter(entry => !!entry && typeof entry === "object" && (entry as { id?: unknown }).id === model);
  const ceiling = (chosen[0] as { max_output_tokens?: unknown; max_completion_tokens?: unknown } | undefined);
  const maxOutput = ceiling?.max_output_tokens ?? ceiling?.max_completion_tokens;
  if (Number.isInteger(maxOutput) && (maxOutput as number) >= 1 && (maxOutput as number) <= 1_000_000) remember(maxOutput as number);
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ object: "list", data: chosen }));
}

/** The AI service's 401/403 for the office key is recorded for the website
 * check-in (office-link.ts); any success clears it. Nothing re-provisions here. */
export function noteKeyAnswer(keyId: string, status: number): void {
  if (status === 401 || status === 403) noteModelKeyAnswer(keyId, false);
  else if (status >= 200 && status < 300) noteModelKeyAnswer(keyId, true);
}

/** Start the relay on an ephemeral loopback port and publish it for Ask launches. */
export async function startAskModelRelay(options: AskModelRelayOptions = {}): Promise<AskModelRelay> {
  const root = options.root;
  const home = resolve(hermesHome(root));
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const serviceFailure = options.serviceFailure ?? (() => managedServiceFailure("reasoning"));
  const inflight = new Set<AbortController>();
  // Each forwarded exchange → the grant and key it was admitted under. A
  // withdrawn, cleared or replaced key ends exactly those exchanges; one
  // admitted under the current key carries on.
  const admittedUnder = new Map<AbortController, { keyId: string; key: string }>();
  const grantHolds = (admitted: { keyId: string; key: string }) => {
    const grant = workerModelGrant();
    return grant.state === "active" && grant.keyId === admitted.keyId && workerModelAccessSnapshot()[MANAGED_MODEL_KEY_ENV]?.trim() === admitted.key;
  };
  // model → the output ceiling the gateway's listing published for it.
  const maxOutput = new Map<string, number>();
  let relay: ActiveRelay | undefined;

  const server: Server = createServer((request, response) => { void handle(request, response); });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const forwarding = new AbortController();
    let capability: RelayCapability | undefined;
    inflight.add(forwarding);
    // The worker went away (turn cancelled, process stopped): stop the upstream exchange too.
    const abandon = () => { if (!response.writableFinished) forwarding.abort(); };
    response.once("close", abandon);
    const timer = setTimeout(() => forwarding.abort(), timeoutMs);
    timer.unref();
    let idleTimer: NodeJS.Timeout | undefined, streaming = false;
    // A chat exchange sent upstream: when, how long to its headers, its status (the run's `timing`).
    let exchange: { start: number; headersMs?: number; status?: number } | undefined;
    const stillArriving = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => forwarding.abort(IDLE), idleTimeoutMs);
      idleTimer.unref();
    };
    try {
      // Hermes probes local-server metadata (Ollama, LM Studio, llama.cpp,
      // vLLM) for a loopback base URL; none of it is forwarded. The one read
      // that is: `GET /models`, which Hermes reads first for the context window
      // (agent/model_metadata.py `_resolve_endpoint_context_length`).
      const path = (request.url ?? "").split("?")[0];
      const listing = request.method === "GET" && path === MODELS_PATH;
      if (request.method !== "POST" && !listing) { request.resume(); response.writeHead(404, { "cache-control": "no-store" }); response.end(); return; }
      capability = requestCapability(request, relay);
      if (!capability) { request.resume(); refuse(response, 401, "Bud's AI connection did not accept this worker."); return; }
      capability.inflight.add(forwarding);
      if (!listing && path !== CHAT_PATH) { request.resume(); response.writeHead(404, { "cache-control": "no-store" }); response.end(); return; }
      // The overlay is re-verified before every forwarded request, so a change
      // made mid-session can drive no further model call.
      if (!relay || !overlayHolds(relay)) { request.resume(); refuse(response, 503, ASK_MODEL_RELAY_UNAVAILABLE); return; }
      const raw = listing ? Buffer.alloc(0) : await readBody(request, maxRequestBytes, forwarding.signal);
      if (listing) request.resume();
      if (capability.scope.revoked) throw new RelayRefusal(401, "Bud's AI connection did not accept this worker.");

      // Authority at this boundary, per request: the grant, its key, the
      // profile still naming the granted endpoint, and the office's choice.
      const accessRefusal = managedModelLaunchRefusal(root);
      if (accessRefusal) throw new RelayRefusal(503, accessRefusal);
      const failure = serviceFailure();
      if (failure) throw new RelayRefusal(503, failure);
      const grant = workerModelGrant();
      const key = workerModelAccessSnapshot()[MANAGED_MODEL_KEY_ENV]?.trim();
      const choice = managedModelChoice(managedModelProfile(root).choice);
      if (grant.state !== "active" || !key || !choice) throw new RelayRefusal(503, "Bud's AI access is not ready on this computer.");
      admittedUnder.set(forwarding, { keyId: grant.keyId, key });
      const base = new URL(normalizedGatewayUrl(grant.baseUrl));
      if (base.username || base.password || base.search || base.hash ||
          !(base.protocol === "https:" || base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) {
        throw new RelayRefusal(503, "Bud's AI access is not ready on this computer.");
      }
      if (listing) { await relayModelListing(response, `${normalizedGatewayUrl(grant.baseUrl)}${MODELS_PATH}`, key, grant.keyId, choice.model, forwarding.signal, value => maxOutput.set(choice.model, value)); return; }

      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch { throw new RelayRefusal(400, "Bud's AI connection received a request it cannot read."); }
      // A text-only choice reads images with `MANAGED_VISION_CHOICE` (the
      // profile's `auxiliary.vision`, hermes-pack.ts `managedVisionRoute`).
      const vision = !choice.supportsVision && body.model === VISION_CHOICE.model && auxiliaryImageRequest(body);
      const route = vision ? VISION_CHOICE : choice;
      if (body.model !== route.model) throw new RelayRefusal(400, "This request names a model other than the one chosen for this office.");
      if (body.stream !== undefined && typeof body.stream !== "boolean") throw new RelayRefusal(400, "Bud's AI connection received a request it cannot read.");
      // The choice table pairs each model only with an effort the gateway
      // accepts for it (Flash only ever `high`), so this never adds a value a
      // model refuses. Whatever the worker sent is replaced.
      body.reasoning_effort = route.effort;
      // No second channel for reasoning or provider options, one completion
      // per request, and no output beyond the model's published ceiling.
      delete body.reasoning; delete body.extra_body;
      if (body.n !== undefined) {
        if (typeof body.n !== "number" || !Number.isFinite(body.n) || body.n < 1) throw new RelayRefusal(400, "Bud's AI connection received a request it cannot read.");
        body.n = 1;
      }
      clampOutput(body, maxOutput.get(route.model) ?? FALLBACK_MAX_OUTPUT_TOKENS);

      const digest = createHash("sha256").update(raw).digest("hex");
      const issued = capability.issued;
      const retry = Number(request.headers["x-stainless-retry-count"] ?? 0) > 0;
      let idempotencyKey = retry ? issued.get(digest) : undefined;
      if (!idempotencyKey) {
        idempotencyKey = `realbud-ask-${randomBytes(24).toString("hex")}`;
        issued.delete(digest); issued.set(digest, idempotencyKey);
        while (issued.size > IDEMPOTENCY_MEMORY) issued.delete(issued.keys().next().value!);
      }

      const accept = typeof request.headers.accept === "string" && request.headers.accept.length <= 200 ? request.headers.accept
        : body.stream === true ? "text/event-stream" : "application/json";
      exchange = { start: Date.now() };
      const upstream = await fetch(`${normalizedGatewayUrl(grant.baseUrl)}${CHAT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept, authorization: `Bearer ${key}`, "idempotency-key": idempotencyKey },
        body: JSON.stringify(body),
        redirect: "error",
        signal: forwarding.signal,
      });
      exchange.headersMs = Date.now() - exchange.start;
      exchange.status = upstream.status;
      noteModelviaRequest(capability.scope.usage, upstream.headers.get("x-request-id"));
      // A refused image call says nothing about the office key: the plan may
      // just not include the image model. Bud gets one plain sentence for that.
      if (!vision || upstream.ok) noteKeyAnswer(grant.keyId, upstream.status);
      forwarding.signal.throwIfAborted();
      if (vision && (upstream.status === 403 || upstream.status === 503)) {
        await upstream.body?.cancel().catch(() => {});
        throw new RelayRefusal(upstream.status, ASK_VISION_UNAVAILABLE);
      }
      const upstreamType = upstream.headers.get("content-type") || "application/json";
      streaming = /^text\/event-stream\b/i.test(upstreamType);
      const retryAfter = upstream.status === 429 ? boundedRetryAfter(upstream.headers.get("retry-after")) : null;
      response.writeHead(upstream.status, {
        "content-type": upstreamType,
        "cache-control": "no-store",
        ...(retryAfter === null ? {} : { "retry-after": retryAfter }),
      });
      response.flushHeaders();
      if (!upstream.body) { response.end(); return; }
      // Chunk by chunk, in order, SSE events unchanged; the next upstream read
      // waits for the worker's socket to drain, so backpressure carries back.
      // ponytail: only a non-streamed JSON answer is read for token `usage` and a
      // 409's original receipt id; streams pass untouched (no `stream_options`
      // added), so a streamed exchange records its header id only. Ask takes
      // its turn's tokens from ACP instead. Parse SSE usage if per-call tokens matter.
      const readUsage = !streaming && /^application\/json\b/i.test(upstreamType);
      const kept: Uint8Array[] = [];
      let relayed = 0;
      stillArriving();
      for await (const chunk of upstream.body) {
        stillArriving();
        relayed += chunk.length;
        if (relayed > maxResponseBytes) throw new Error("response too large");
        if (readUsage && relayed <= MAX_USAGE_BODY_BYTES) kept.push(chunk);
        if (!response.write(chunk)) await once(response, "drain", { signal: forwarding.signal });
      }
      response.end();
      if (readUsage && relayed <= MAX_USAGE_BODY_BYTES) {
        try { noteModelviaReply(capability.scope.usage, JSON.parse(Buffer.concat(kept).toString("utf8"))); }
        catch { /* an unreadable answer still counted as a request */ }
      }
    } catch (error) {
      if (error instanceof RelayRefusal) { request.resume(); refuse(response, error.status, error.message); }
      else if (forwarding.signal.reason === GRANT_ENDED && !response.headersSent) {
        refuse(response, 503, managedModelLaunchRefusal(root) ?? "Bud's AI access is not ready on this computer.");
      } else if (!response.headersSent) refuse(response, forwarding.signal.aborted ? 504 : 502, "Bud's AI connection could not reach the AI service.");
      else if (forwarding.signal.reason === IDLE && streaming && !response.writableEnded && !response.destroyed) {
        // A stream ends with an error event the worker's SDK raises, not a silent cut.
        response.end(`data: ${JSON.stringify({ error: { message: STALLED, type: "realbud_relay_refused" } })}\n\n`);
      } else response.destroy();
    } finally {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      inflight.delete(forwarding);
      admittedUnder.delete(forwarding);
      capability?.inflight.delete(forwarding);
      response.off("close", abandon);
      // Answered, refused, failed or stopped: its time lands on the lease's
      // current run. Last, so a bookkeeping fault cannot leave the exchange in flight.
      if (exchange && capability) noteModelExchange(capability.scope.usage, { ms: Date.now() - exchange.start, headersMs: exchange.headersMs, status: exchange.status });
    }
  }

  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); accept(); }); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Ask model relay did not bind."); }
  const url = `http://127.0.0.1:${address.port}`;
  const overlayDir = options.overlayDir ?? join(DATA_DIR, "ask-model-relay");
  const overlayPath = join(overlayDir, "config.yaml");
  const overlay = askModelRelayOverlay(url);
  try {
    // A fresh folder each start: nothing an earlier process or worker left stays.
    removeOverlay(overlayDir);
    await writePrivateJson(overlayPath, overlay);
    if (process.platform !== "win32") { chmodSync(overlayPath, OVERLAY_FILE_MODE); chmodSync(overlayDir, OVERLAY_DIR_MODE); }
  } catch (error) { server.close(); throw error; }
  const current: ActiveRelay = { url, home, overlayDir, overlayPath, overlayBody: JSON.stringify(overlay), compromised: false, onTamper: options.onTamper, capabilities: new Map() };
  relay = current;
  active = current;
  const stopAccessWatch = onWorkerModelAccessChange(() => {
    for (const [controller, admitted] of admittedUnder) if (!grantHolds(admitted)) controller.abort(GRANT_ENDED);
  });

  let closed = false;
  return {
    url,
    overlayDir,
    async close() {
      if (closed) return;
      closed = true;
      if (active === current) active = null;
      stopAccessWatch();
      for (const capability of current.capabilities.values()) { capability.scope.revoked = true; capability.issued.clear(); }
      current.capabilities.clear();
      for (const controller of inflight) controller.abort();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      // A later process writes its own; a stale overlay only ever names a dead port.
      try { removeOverlay(overlayDir); } catch { /* best effort */ }
    },
  };
}
