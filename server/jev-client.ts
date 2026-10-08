/**
 * TypeSafe Jev: typed decisions through the office's Modelvia grant, billed
 * per office. Jev output is DATA, never authority: a caller may use an answer
 * to suggest or narrow, never to approve or act.
 *
 * Runs in the server process only. The office key comes from
 * `workerModelAccessSnapshot()` and goes only into this request's header; it
 * never enters env, Hermes or a log. Nothing here logs the key, the state or
 * the answers: one line per call with the outcome code, milliseconds and, for
 * a 400 (a client bug), Modelvia's error code. Token usage goes back to the
 * caller (for run cost) and is never logged or shown; cost never comes back.
 * `decide` never throws.
 *
 * Contract agreed with Modelvia (mirrors OpenRouter decisions):
 * - POST `${grant.baseUrl}/decisions` (the base ends in /v1), `Authorization:
 *   Bearer <office key>`, `Idempotency-Key: <fresh UUID per decision>`.
 * - Request `{model, state, questions}`; `model` is the use's primary (below);
 *   REALBUD_JEV_MODEL="off" means refused with no call. No session_id or user.
 *   `toWire` mirrors Modelvia's request schema
 *   so a bad request is "invalid" before any (billable) call: state a non-empty
 *   string, object or array; question and option keys /^[A-Za-z0-9_.:-]{1,64}$/
 *   and never __proto__/constructor/prototype; instructions non-blank and at
 *   most 8,000 characters; every criterion non-blank and at most 4,000; a choice
 *   offers at least 2 options.
 * - Response `{id, model, answers, usage:{input_tokens, output_tokens}}`, no cost.
 *   `id` is the Modelvia request id (also `X-Request-Id`): the run records it
 *   and prices the call from its receipt (`GET /v1/requests/{id}`, run-cost.ts).
 *   `model` may be a dated id ("typesafe/jev-1.13-20260917"); extra fields are ignored.
 * - Retry once with the SAME key only after 503 serving_temporarily_unavailable
 *   (never charged); model_route_unavailable is configuration, so no retry. Never after a timeout or a
 *   dropped connection: the first call may have been charged.
 * - 401/403 refused · 402 budget · 409 no answer (http) · those two 503s
 *   (after the retry) unavailable · 502 invalid_provider_answers and 400 invalid.
 * - Primary per use, from RealBud's decisions eval of 8 Oct 2026 (190 labelled
 *   cases; Modelvia docs/DECISIONS-EVAL-2026-10-08.md): the model that auto-accepts
 *   the most cases with zero wrong-accepts. Jev (the default: cheapest, ZDR) for
 *   ask, recipe, mail noise and bills; `prefer: "luna"` (GPT-6 Luna Decisions,
 *   unless REALBUD_LUNA_MODEL is off) for payer → tenant hints (Jev made 2 wrong
 *   accepts) and ledger columns (58.6% vs 51.7%). REALBUD_JEV_MODEL, when set, is
 *   the primary for every use, so an eval can force one model; `options.model`
 *   is the primary for that one call.
 * - Fallback: for a text decision, the other of Jev and Luna (or
 *   REALBUD_JEV_FALLBACK_MODEL for every use; "off" disables it; never the primary) is
 *   asked once, under `<primary key>:fallback`, only after a 502, a 503 model_route_unavailable (free),
 *   a dropped connection before any response, or the primary's own timeout when
 *   the caller set no timeoutMs. Never after 400, 402, 409 or any other status:
 *   a 409 request_already_processed was already charged. The result names the
 *   primary in `fallbackFrom`, and when the primary got no response, its key in
 *   `abandonedIdempotencyKey` so its receipt can be reconciled.
 */
import { randomUUID } from "node:crypto";
import { workerModelGrant } from "./worker-model-access.ts";
import { MANAGED_MODEL_KEY_ENV } from "./hermes-pack.ts";
import { normalizedGatewayUrl, onWorkerModelAccessChange, workerModelAccessSnapshot } from "./hermes-runtime-env.ts";
import { managedServiceFailure } from "./managed-service.ts";
import { noteKeyAnswer } from "./ask-model-relay.ts";

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  /** Ordered: the answer's score is a float index into this array. */
  | { type: "score"; instructions: string; criteria: string[] };
export interface JevRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
}
/** confidence and probabilities are optional: a caller that needs a margin
 * treats missing ones as below its threshold. noul is P(yes). */
export type JevAnswer =
  | { type: "choice"; choice: string; confidence?: number; probabilities?: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence?: number; probabilities?: Record<string, number> };
/** Every failure is "no answer" to the caller. */
export type JevFailure = "refused" | "budget" | "unavailable" | "timeout" | "http" | "invalid" | "aborted";
/** `usage`, when Modelvia sent a well-formed one, is for counting run cost: never logged or shown. */
export type JevUsage = { input_tokens: number; output_tokens: number };
/** Set only when the fallback was asked: the primary model, and the primary's
 * Idempotency-Key when it got no response (it may still have been billed). */
export type JevFallback = { fallbackFrom?: string; abandonedIdempotencyKey?: string };
/** `model` is the model that answered, as Modelvia names it. `id`: the Modelvia
 * request id, for run cost (`recordJevUsage` in run-cost.ts). A failure carries
 * one only when Modelvia answered 2xx (so charged) with answers that failed validation. */
export type JevResult = ({ ok: true; id: string; answers: Record<string, JevAnswer>; model: string; ms: number; usage?: JevUsage } | { ok: false; reason: JevFailure; id?: string }) & JevFallback;

const MAX_QUESTIONS = 8, MAX_OPTIONS = 64, MAX_STATE_BYTES = 16 * 1024, MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
// Jev and Luna both answer in about 0.5 s at the gateway (eval p95 under 0.7 s), so 8 s without a
// reply means the primary is broken: ask the fallback instead. This is deliberately below Modelvia's 120 s
// decisions bound, which keeps running after the client leaves, so an abandoned primary call may
// still be billed (a fraction of a cent each). The owner accepts that as the price of speed.
const PRIMARY_TIMEOUT_MS = 8_000;
const DECISIONS_PATH = "/decisions";
const RETRYABLE_503 = ["serving_temporarily_unavailable"];
// Installed apps set no env, so the Modelvia catalogue ids are the defaults. Until the
// operator enables a route Modelvia refuses before dispatch (403/503, never charged).
// Owner, 2026-10-08: the primary is chosen per use from eval data (header); GPT-6 Luna
// Decisions alone reads images (desktop control picks).
const JEV_DECISIONS_MODEL = "jev-1.13-decisions";
/** GPT-6 Luna Decisions (`openai/gpt-6-luna-decisions` upstream). REALBUD_LUNA_MODEL
 * overrides the Modelvia id; "off" disables it. */
export const LUNA_DECISIONS_MODEL = "gpt-6-luna-decisions";
export const lunaModel = (): string | null => { const set = process.env.REALBUD_LUNA_MODEL?.trim(); return set === "off" ? null : set || LUNA_DECISIONS_MODEL; };
/** A use's primary: REALBUD_JEV_MODEL for every use when set ("off": none), else Luna when preferred and on, else Jev. */
const primaryModel = (prefer?: "jev" | "luna") => {
  const set = process.env.REALBUD_JEV_MODEL?.trim();
  return set === "off" ? null : set || prefer === "luna" && lunaModel() || JEV_DECISIONS_MODEL;
};
/** The text fallback: REALBUD_JEV_FALLBACK_MODEL ("off" disables it), else the other of Jev and Luna. */
const fallbackModel = (primary: string) => {
  const set = process.env.REALBUD_JEV_FALLBACK_MODEL?.trim() || (primary === lunaModel() ? JEV_DECISIONS_MODEL : lunaModel()) || "off";
  return set === "off" || set === primary ? null : set;
};
/** Modelvia's /v1/decisions refuses a state over 256,000 bytes
 * (managed-gateway/decisions.ts MAX_STATE_BYTES); the base64 image counts
 * toward it. Raise both together when Modelvia lifts it for image routes.
 * Nothing downscales the image: a larger one is refused. */
export const MODELVIA_STATE_BYTES = 256_000;
export const MAX_IMAGE_BYTES = Math.floor((MODELVIA_STATE_BYTES - 16 * 1024) * 3 / 4);
const PNG_BASE64 = /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/;

const MAX_INSTRUCTIONS = 8_000, MAX_CRITERION = 4_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const filled = (value: unknown, max: number): value is string => text(value) && !!value.trim() && value.length <= max;
const criterion = (value: unknown) => filled(value, MAX_CRITERION);
const safeKey = (key: string) => /^[A-Za-z0-9_.:-]{1,64}$/.test(key) && !["__proto__", "constructor", "prototype"].includes(key);
const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const unitMap = (value: unknown, keys?: string[]): value is Record<string, number> =>
  record(value) && Object.entries(value).every(([key, p]) => unit(p) && (!keys || keys.includes(key)));

/**
 * The decision state with one PNG attached, in OpenRouter's decisions shape
 * (docs/guides/community/multimodal-decisions, read 2026-10-08): `state`
 * becomes a top-level array whose text items are plain strings and whose
 * image is `{type:"image_url", image_url:{url:"data:image/png;base64,…"}}`.
 * Images nested inside objects are not read, and remote URLs are not fetched.
 * Only GPT-6 Luna Decisions reads images; Jev is text only.
 */
export function withImage(state: Record<string, unknown>, pngBase64: string): unknown[] {
  return [JSON.stringify(state), { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}`, detail: "low" } }];
}

/** The request body, or null when it breaks the schema or the hygiene caps. The
 * 16 KiB state cap is checked before the image (bounded by MAX_IMAGE_BYTES) is attached. */
function toWire(request: JevRequest, model: string, image?: string): string | null {
  const questions = Object.entries(record(request.questions) ? request.questions : {});
  if (!questions.length || questions.length > MAX_QUESTIONS) return null;
  for (const [key, question] of questions) {
    if (!safeKey(key) || !record(question) || !filled(question.instructions, MAX_INSTRUCTIONS)) return null;
    const criteria: unknown = question.criteria;
    const ok = question.type === "choice" ? record(criteria) && Object.keys(criteria).length >= 2 && Object.keys(criteria).length <= MAX_OPTIONS &&
        Object.keys(criteria).every(safeKey) && Object.values(criteria).every(criterion)
      : question.type === "noul" ? criteria === undefined || record(criteria) && Object.keys(criteria).sort().join(",") === "false,true" && criterion(criteria.true) && criterion(criteria.false)
      : question.type === "score" ? Array.isArray(criteria) && criteria.length >= 1 && criteria.length <= MAX_OPTIONS && criteria.every(criterion)
      : false;
    if (!ok) return null;
  }
  const { state } = request;
  if (!(text(state) ? state.length > 0 : !!state && typeof state === "object")) return null;
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) return null;
  if (image === undefined) return JSON.stringify({ model, state, questions: request.questions });
  if (!record(state) || !PNG_BASE64.test(image) || Math.floor(image.length * 3 / 4) > MAX_IMAGE_BYTES) return null;
  const imageState = withImage(state, image);
  if (Buffer.byteLength(JSON.stringify(imageState), "utf8") > MODELVIA_STATE_BYTES) return null;
  return JSON.stringify({ model, state: imageState, questions: request.questions });
}

/** The strictly validated answers, or null. */
function fromWire(body: unknown, request: JevRequest): { id: string; answers: Record<string, JevAnswer>; model: string; usage?: JevUsage } | null {
  if (!record(body) || !text(body.id) || !text(body.model) || !record(body.answers)) return null;
  const asked = Object.keys(request.questions), given = body.answers;
  if (Object.keys(given).length !== asked.length) return null;
  const answers: Record<string, JevAnswer> = {};
  for (const key of asked) {
    const question = request.questions[key], answer = given[key];
    if (!record(answer) || answer.type !== question.type) return null;
    if ((answer.confidence !== undefined && !unit(answer.confidence))) return null;
    const optional = { ...(answer.confidence !== undefined ? { confidence: answer.confidence as number } : {}),
      ...(answer.probabilities !== undefined ? { probabilities: answer.probabilities as Record<string, number> } : {}) };
    if (question.type === "choice") {
      const offered = Object.keys(question.criteria);
      if (!text(answer.choice) || !offered.includes(answer.choice) || (answer.probabilities !== undefined && !unitMap(answer.probabilities, offered))) return null;
      answers[key] = { type: "choice", choice: answer.choice, ...optional };
    } else if (question.type === "score") {
      // `legend` is accepted and not passed on.
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1 ||
          (answer.probabilities !== undefined && !unitMap(answer.probabilities))) return null;
      answers[key] = { type: "score", score: answer.score, ...optional };
    } else {
      if (!unit(answer.noul)) return null;
      answers[key] = { type: "noul", noul: answer.noul };
    }
  }
  const tokens = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  const usage = record(body.usage) && tokens(body.usage.input_tokens) && tokens(body.usage.output_tokens)
    ? { usage: { input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens } } : {};
  return { id: body.id, answers, model: body.model, ...usage };
}

/** Whether `decide` could call out at all: a Jev model is configured and the
 * office has an active grant with its key. Callers skip silently otherwise. */
export function jevReady(): boolean {
  return !!primaryModel() && grantReady();
}
const grantReady = () => workerModelGrant().state === "active" && !!workerModelAccessSnapshot()[MANAGED_MODEL_KEY_ENV]?.trim();

/** Modelvia's error code, only when it is a plain code (never free text). */
function errorCode(body: unknown): string | null {
  const error = record(body) ? body.error : undefined;
  const code = record(error) ? error.code ?? error.type : error;
  return text(code) && /^[a-z][a-z0-9_.:-]{0,79}$/.test(code) ? code : null;
}

/** `jevReady()` for Luna: its model is configured and the office grant is active. */
export function lunaReady(): boolean {
  return !!lunaModel() && grantReady();
}

/** Ask the use's primary (`prefer`, default Jev; or `model`, e.g. `lunaModel()`). Refused without a configured model, an active grant, its key,
 * the managed service's reasoning entitlement, or an https (or loopback http)
 * gateway. `image` (base64 PNG, at most MAX_IMAGE_BYTES) needs an object state; it is never logged. */
export async function decide(request: JevRequest, options: { signal?: AbortSignal; timeoutMs?: number; model?: string; image?: string; prefer?: "jev" | "luna" } = {}): Promise<JevResult> {
  const started = Date.now();
  let fellBack: JevFallback = {}, note = "";
  const done = (result: JevResult, code: string | null = null): JevResult => {
    console.info(`[jev] ${result.ok ? "ok" : result.reason} ${Date.now() - started}ms${code ? ` code=${code}` : ""}${note}`);
    return { ...result, ...fellBack };
  };
  if (options.signal?.aborted) return done({ ok: false, reason: "aborted" });
  const model = options.model === undefined ? primaryModel(options.prefer) : options.model.trim();
  if (!model) return done({ ok: false, reason: "refused" });
  const grant = workerModelGrant();
  const key = workerModelAccessSnapshot()[MANAGED_MODEL_KEY_ENV]?.trim();
  if (grant.state !== "active" || !key || managedServiceFailure("reasoning")) return done({ ok: false, reason: "refused" });
  let base: URL;
  try { base = new URL(normalizedGatewayUrl(grant.baseUrl)); } catch { return done({ ok: false, reason: "refused" }); }
  if (base.username || base.password || base.search || base.hash ||
      !(base.protocol === "https:" || base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) {
    return done({ ok: false, reason: "refused" });
  }
  const body = toWire(request, model, options.image);
  if (body === null) return done({ ok: false, reason: "invalid" });

  // A withdrawn, cleared or replaced key ends this call.
  const withdrawn = new AbortController();
  const stopWatch = onWorkerModelAccessChange(() => {
    const now = workerModelGrant();
    if (now.state !== "active" || now.keyId !== grant.keyId || workerModelAccessSnapshot()[MANAGED_MODEL_KEY_ENV]?.trim() !== key) withdrawn.abort();
  });
  type Outcome = { status: number; requestId: string | null; body: unknown } | { failed: "timeout" | "aborted" | "http"; early: boolean };
  /** One model under one Idempotency-Key and its own timeout; only an uncharged
   * 503 is retried, with the same key. `early`: the failure came before any response. */
  const attempt = async (payload: string, idempotencyKey: string, timeoutMs: number): Promise<Outcome> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([timeout, withdrawn.signal, ...(options.signal ? [options.signal] : [])]);
    let early = true;
    /** One exchange: status, Modelvia's request id and parsed body (undefined when unreadable). */
    const exchange = async (): Promise<{ status: number; requestId: string | null; body: unknown }> => {
      early = true;
      const response = await fetch(`${normalizedGatewayUrl(grant.baseUrl)}${DECISIONS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}`, "idempotency-key": idempotencyKey },
        body: payload, redirect: "error", signal,
      });
      early = false;
      // 403 is a mode or model refusal, not a rejected key; only 401 and success inform the check-in.
      if (response.status !== 403) noteKeyAnswer(grant.keyId, response.status);
      const requestId = response.headers.get("x-request-id");
      const chunks: Uint8Array[] = []; let size = 0;
      if (response.body) for await (const part of response.body) {
        size += part.length;
        if (size > MAX_RESPONSE_BYTES) return { status: response.status, requestId, body: undefined };
        chunks.push(part);
      }
      try { return { status: response.status, requestId, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }; }
      catch { return { status: response.status, requestId, body: undefined }; }
    };
    try {
      const answer = await exchange();
      return answer.status === 503 && RETRYABLE_503.includes(errorCode(answer.body) ?? "") ? await exchange() : answer;
    } catch {
      return { failed: timeout.aborted ? "timeout" : signal.aborted ? "aborted" : "http", early };
    }
  };
  const fallback = options.image === undefined ? fallbackModel(model) : null, primaryKey = randomUUID();
  try {
    let outcome = await attempt(body, primaryKey, options.timeoutMs ?? (fallback ? PRIMARY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS));
    if (fallback) {
      // A caller's own timeoutMs is its latency budget: no second call after it runs out.
      const unanswered = "failed" in outcome && outcome.early && (outcome.failed === "http" || outcome.failed === "timeout" && options.timeoutMs === undefined);
      const routeFailed = "status" in outcome && (outcome.status === 502 || outcome.status === 503 && errorCode(outcome.body) === "model_route_unavailable");
      if (unanswered || routeFailed) {
        fellBack = { fallbackFrom: model, ...(unanswered ? { abandonedIdempotencyKey: primaryKey } : {}) };
        note = ` fallback=${"failed" in outcome ? outcome.failed : outcome.status}${unanswered ? ` abandoned=${primaryKey}` : ""}`;
        outcome = await attempt(toWire(request, fallback)!, `${primaryKey}:fallback`, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      }
    }
    if ("failed" in outcome) return done({ ok: false, reason: outcome.failed });
    const { status } = outcome, code = errorCode(outcome.body);
    if (status === 401 || status === 403) return done({ ok: false, reason: "refused" });
    if (status === 402) return done({ ok: false, reason: "budget" });
    if (status === 503 && (RETRYABLE_503.includes(code ?? "") || code === "model_route_unavailable")) return done({ ok: false, reason: "unavailable" });
    if (status === 502 && code === "invalid_provider_answers") return done({ ok: false, reason: "invalid" });
    if (status === 400) return done({ ok: false, reason: "invalid" }, code);
    if (status < 200 || status >= 300) return done({ ok: false, reason: "http" });
    const read = fromWire(outcome.body, request);
    if (read) return done({ ok: true, ...read, ms: Date.now() - started });
    // Answered, so charged: keep the id so the run still counts the call.
    const id = outcome.requestId ?? (record(outcome.body) && text(outcome.body.id) ? outcome.body.id : null);
    return done({ ok: false, reason: "invalid", ...(id ? { id } : {}) });
  } catch { return done({ ok: false, reason: "http" }); } finally { stopWatch(); }
}
