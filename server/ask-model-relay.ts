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
 * Messages, tools and replay fields pass through untouched.
 *
 * Key custody: the office key stays in this process (`workerModelAccessSnapshot`,
 * refreshed from the private vault). An Ask worker gets only the loopback URL
 * and a random per-process token, under the env name the profile's
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
 * the key. This is Ask only: one-shot CLI jobs and loops still receive the key
 * in their launch environment through `applyManagedModelLaunchEnv`.
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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { DATA_DIR } from "./config.ts";
import { writePrivateJson } from "./private-json.ts";
import { hermesHome } from "./hermes-paths.ts";
import { managedServiceFailure } from "./managed-service.ts";
import { workerModelGrant } from "./worker-model-access.ts";
import { MANAGED_MODEL_KEY_ENV, MANAGED_MODEL_PROVIDER_ENTRY, managedModelProfile } from "./hermes-pack.ts";
import { MANAGED_ACCESS_RELAY_DOWN, managedModelLaunchRefusal, normalizedGatewayUrl, workerModelAccessSnapshot } from "./hermes-runtime-env.ts";
import { managedModelChoice } from "../shared/managed-model-choices.ts";
import { noteModelKeyAnswer } from "./office-link.ts";

/** Office copy when an Ask launch finds no running relay in this process.
 * Listed in `MANAGED_ACCESS_REFUSALS`, so Ask shows exactly this sentence. */
export const ASK_MODEL_RELAY_UNAVAILABLE = MANAGED_ACCESS_RELAY_DOWN;

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
const IDEMPOTENCY_MEMORY = 256;
/** Output ceiling before the gateway's listing has been read: the smallest
 * `max_output_tokens` the gateway publishes for the offered models. */
const FALLBACK_MAX_OUTPUT_TOKENS = 32_000;
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
  url: string; token: string; home: string; overlayDir: string; overlayPath: string; overlayBody: string;
  compromised: boolean; onTamper?: () => void;
}
let active: ActiveRelay | null = null;

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
  env[MANAGED_MODEL_KEY_ENV] = relay.token;
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

function tokenMatches(request: IncomingMessage, token: Buffer): boolean {
  const auth = request.headers.authorization;
  const presented = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7)
    : typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : "";
  const candidate = Buffer.from(presented);
  return candidate.length === token.length && timingSafeEqual(candidate, token);
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

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new RelayRefusal(413, "This request is too large for Bud's AI connection.");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new RelayRefusal(413, "This request is too large for Bud's AI connection.");
    chunks.push(chunk);
  }
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
function noteKeyAnswer(keyId: string, status: number): void {
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
  const serviceFailure = options.serviceFailure ?? (() => managedServiceFailure("reasoning"));
  const tokenText = randomBytes(32).toString("hex"), token = Buffer.from(tokenText);
  // body digest → the Idempotency-Key its first attempt carried, so an SDK
  // retry of a lost reply is answered from Modelvia's receipt instead of
  // charged again, while a genuinely new request (retry count 0) is new.
  const issued = new Map<string, string>();
  const inflight = new Set<AbortController>();
  // model → the output ceiling the gateway's listing published for it.
  const maxOutput = new Map<string, number>();
  let relay: ActiveRelay | undefined;

  const server: Server = createServer((request, response) => { void handle(request, response); });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const forwarding = new AbortController();
    inflight.add(forwarding);
    // The worker went away (turn cancelled, process stopped): stop the upstream exchange too.
    const abandon = () => { if (!response.writableFinished) forwarding.abort(); };
    response.once("close", abandon);
    const timer = setTimeout(() => forwarding.abort(), timeoutMs);
    timer.unref();
    try {
      // Hermes probes local-server metadata (Ollama, LM Studio, llama.cpp,
      // vLLM) for a loopback base URL; none of it is forwarded. The one read
      // that is: `GET /models`, which Hermes reads first for the context window
      // (agent/model_metadata.py `_resolve_endpoint_context_length`).
      const path = (request.url ?? "").split("?")[0];
      const listing = request.method === "GET" && path === MODELS_PATH;
      if (request.method !== "POST" && !listing) { request.resume(); response.writeHead(404, { "cache-control": "no-store" }); response.end(); return; }
      if (!tokenMatches(request, token)) { request.resume(); refuse(response, 401, "Bud's AI connection did not accept this worker."); return; }
      if (!listing && path !== CHAT_PATH) { request.resume(); response.writeHead(404, { "cache-control": "no-store" }); response.end(); return; }
      // The overlay is re-verified before every forwarded request, so a change
      // made mid-session can drive no further model call.
      if (!relay || !overlayHolds(relay)) { request.resume(); refuse(response, 503, ASK_MODEL_RELAY_UNAVAILABLE); return; }
      const raw = listing ? Buffer.alloc(0) : await readBody(request, maxRequestBytes);
      if (listing) request.resume();

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
      if (body.model !== choice.model) throw new RelayRefusal(400, "This request names a model other than the one chosen for this office.");
      if (body.stream !== undefined && typeof body.stream !== "boolean") throw new RelayRefusal(400, "Bud's AI connection received a request it cannot read.");
      // The choice table pairs each model only with an effort the gateway
      // accepts for it (Flash only ever `high`), so this never adds a value a
      // model refuses. Whatever the worker sent is replaced.
      body.reasoning_effort = choice.effort;
      // No second channel for reasoning or provider options, one completion
      // per request, and no output beyond the model's published ceiling.
      delete body.reasoning; delete body.extra_body;
      if (body.n !== undefined) {
        if (typeof body.n !== "number" || !Number.isFinite(body.n) || body.n < 1) throw new RelayRefusal(400, "Bud's AI connection received a request it cannot read.");
        body.n = 1;
      }
      clampOutput(body, maxOutput.get(choice.model) ?? FALLBACK_MAX_OUTPUT_TOKENS);

      const digest = createHash("sha256").update(raw).digest("hex");
      const retry = Number(request.headers["x-stainless-retry-count"] ?? 0) > 0;
      let idempotencyKey = retry ? issued.get(digest) : undefined;
      if (!idempotencyKey) {
        idempotencyKey = `realbud-ask-${randomBytes(24).toString("hex")}`;
        issued.delete(digest); issued.set(digest, idempotencyKey);
        while (issued.size > IDEMPOTENCY_MEMORY) issued.delete(issued.keys().next().value!);
      }

      const accept = typeof request.headers.accept === "string" && request.headers.accept.length <= 200 ? request.headers.accept
        : body.stream === true ? "text/event-stream" : "application/json";
      const upstream = await fetch(`${normalizedGatewayUrl(grant.baseUrl)}${CHAT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept, authorization: `Bearer ${key}`, "idempotency-key": idempotencyKey },
        body: JSON.stringify(body),
        redirect: "error",
        signal: forwarding.signal,
      });
      noteKeyAnswer(grant.keyId, upstream.status);
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
      });
      response.flushHeaders();
      if (!upstream.body) { response.end(); return; }
      let relayed = 0;
      const bound = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          relayed += chunk.length;
          done(relayed > maxResponseBytes ? new Error("response too large") : null, chunk);
        },
      });
      // pipeline carries backpressure from the worker's socket back to the
      // upstream read, chunk by chunk, in order; SSE events pass unchanged.
      await pipeline(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>), bound, response);
    } catch (error) {
      if (error instanceof RelayRefusal) { request.resume(); refuse(response, error.status, error.message); }
      else if (!response.headersSent) refuse(response, forwarding.signal.aborted ? 504 : 502, "Bud's AI connection could not reach the AI service.");
      else response.destroy();
    } finally {
      clearTimeout(timer);
      inflight.delete(forwarding);
      response.off("close", abandon);
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
  const current: ActiveRelay = { url, token: tokenText, home, overlayDir, overlayPath, overlayBody: JSON.stringify(overlay), compromised: false, onTamper: options.onTamper };
  relay = current;
  active = current;

  let closed = false;
  return {
    url,
    overlayDir,
    async close() {
      if (closed) return;
      closed = true;
      if (active === current) active = null;
      for (const controller of inflight) controller.abort();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      // A later process writes its own; a stale overlay only ever names a dead port.
      try { removeOverlay(overlayDir); } catch { /* best effort */ }
    },
  };
}
