/**
 * TypeSafe Jev: typed decisions through the office's Modelvia grant, billed
 * per office. Jev output is DATA, never authority: a caller may use an answer
 * to suggest or narrow, never to approve or act.
 *
 * Runs in the server process only. The office key comes from
 * `workerModelAccessSnapshot()` and goes only into this request's header; it
 * never enters env, Hermes or a log. Nothing here logs the key, the state or
 * the answers: one line per call with the outcome code, milliseconds and, for
 * a 400 (a client bug), Modelvia's error code. Usage and cost are never
 * surfaced. `decide` never throws.
 *
 * Contract agreed with Modelvia (mirrors OpenRouter decisions):
 * - POST `${grant.baseUrl}/decisions` (the base ends in /v1), `Authorization:
 *   Bearer <office key>`, `Idempotency-Key: <fresh UUID per decision>`.
 * - Request `{model, state, questions}`; `model` is "jev-1.13-decisions" unless
 *   REALBUD_JEV_MODEL overrides it; REALBUD_JEV_MODEL="off" means refused with
 *   no call. No session_id or user. `toWire` mirrors Modelvia's request schema
 *   so a bad request is "invalid" before any (billable) call: state a non-empty
 *   string, object or array; question and option keys /^[A-Za-z0-9_.:-]{1,64}$/
 *   and never __proto__/constructor/prototype; instructions non-blank and at
 *   most 8,000 characters; every criterion non-blank and at most 4,000; a choice
 *   offers at least 2 options.
 * - Response `{id, model, answers, usage:{input_tokens, output_tokens}}`, no cost.
 *   `model` may be a dated id ("typesafe/jev-1.13-20260917"); extra fields are ignored.
 * - Retry once with the SAME key only after 503 serving_temporarily_unavailable
 *   (never charged); model_route_unavailable is configuration, so no retry. Never after a timeout or a
 *   dropped connection: the first call may have been charged.
 * - 401/403 refused · 402 budget · 409 no answer (http) · those two 503s
 *   (after the retry) unavailable · 502 invalid_provider_answers and 400 invalid.
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
export type JevResult = { ok: true; answers: Record<string, JevAnswer>; model: string; ms: number } | { ok: false; reason: JevFailure };

const MAX_QUESTIONS = 8, MAX_OPTIONS = 64, MAX_STATE_BYTES = 16 * 1024, MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DECISIONS_PATH = "/decisions";
const RETRYABLE_503 = ["serving_temporarily_unavailable"];
// Installed apps set no env, so the Modelvia catalogue id is the default. Until the
// operator enables the route Modelvia refuses before dispatch (403/503, never charged).
const JEV_DEFAULT_MODEL = "jev-1.13-decisions";
const jevModel = () => { const set = process.env.REALBUD_JEV_MODEL?.trim(); return set === "off" ? null : set || JEV_DEFAULT_MODEL; };

const MAX_INSTRUCTIONS = 8_000, MAX_CRITERION = 4_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const filled = (value: unknown, max: number): value is string => text(value) && !!value.trim() && value.length <= max;
const criterion = (value: unknown) => filled(value, MAX_CRITERION);
const safeKey = (key: string) => /^[A-Za-z0-9_.:-]{1,64}$/.test(key) && !["__proto__", "constructor", "prototype"].includes(key);
const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const unitMap = (value: unknown, keys?: string[]): value is Record<string, number> =>
  record(value) && Object.entries(value).every(([key, p]) => unit(p) && (!keys || keys.includes(key)));

/** The request body, or null when it breaks the schema or the hygiene caps. */
function toWire(request: JevRequest, model: string): string | null {
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
  return JSON.stringify({ model, state, questions: request.questions });
}

/** The strictly validated answers, or null. */
function fromWire(body: unknown, request: JevRequest): { answers: Record<string, JevAnswer>; model: string } | null {
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
  return { answers, model: body.model };
}

/** Whether `decide` could call out at all: a Jev model is configured and the
 * office has an active grant with its key. Callers skip silently otherwise. */
export function jevReady(): boolean {
  const grant = workerModelGrant();
  return !!jevModel() && grant.state === "active" && !!workerModelAccessSnapshot()[MANAGED_MODEL_KEY_ENV]?.trim();
}

/** Modelvia's error code, only when it is a plain code (never free text). */
function errorCode(body: unknown): string | null {
  const error = record(body) ? body.error : undefined;
  const code = record(error) ? error.code ?? error.type : error;
  return text(code) && /^[a-z][a-z0-9_.:-]{0,79}$/.test(code) ? code : null;
}

/** Ask Jev. Refused without a configured model, an active grant, its key,
 * the managed service's reasoning entitlement, or an https (or loopback http)
 * gateway. */
export async function decide(request: JevRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<JevResult> {
  const started = Date.now();
  const done = (result: JevResult, code: string | null = null): JevResult => {
    console.info(`[jev] ${result.ok ? "ok" : result.reason} ${Date.now() - started}ms${code ? ` code=${code}` : ""}`);
    return result;
  };
  if (options.signal?.aborted) return done({ ok: false, reason: "aborted" });
  const model = jevModel();
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
  const body = toWire(request, model);
  if (body === null) return done({ ok: false, reason: "invalid" });

  // A withdrawn, cleared or replaced key ends this call.
  const withdrawn = new AbortController();
  const stopWatch = onWorkerModelAccessChange(() => {
    const now = workerModelGrant();
    if (now.state !== "active" || now.keyId !== grant.keyId || workerModelAccessSnapshot()[MANAGED_MODEL_KEY_ENV]?.trim() !== key) withdrawn.abort();
  });
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = AbortSignal.any([timeout, withdrawn.signal, ...(options.signal ? [options.signal] : [])]);
  const idempotencyKey = randomUUID();
  /** One exchange: status and parsed body (undefined when unreadable). */
  const exchange = async (): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${normalizedGatewayUrl(grant.baseUrl)}${DECISIONS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}`, "idempotency-key": idempotencyKey },
      body, redirect: "error", signal,
    });
    // 403 is a mode or model refusal, not a rejected key; only 401 and success inform the check-in.
    if (response.status !== 403) noteKeyAnswer(grant.keyId, response.status);
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) for await (const part of response.body) {
      size += part.length;
      if (size > MAX_RESPONSE_BYTES) return { status: response.status, body: undefined };
      chunks.push(part);
    }
    try { return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }; }
    catch { return { status: response.status, body: undefined }; }
  };
  try {
    let answer = await exchange();
    if (answer.status === 503 && RETRYABLE_503.includes(errorCode(answer.body) ?? "")) answer = await exchange();
    const { status } = answer, code = errorCode(answer.body);
    if (status === 401 || status === 403) return done({ ok: false, reason: "refused" });
    if (status === 402) return done({ ok: false, reason: "budget" });
    if (status === 503 && (RETRYABLE_503.includes(code ?? "") || code === "model_route_unavailable")) return done({ ok: false, reason: "unavailable" });
    if (status === 502 && code === "invalid_provider_answers") return done({ ok: false, reason: "invalid" });
    if (status === 400) return done({ ok: false, reason: "invalid" }, code);
    if (status < 200 || status >= 300) return done({ ok: false, reason: "http" });
    const read = fromWire(answer.body, request);
    return done(read ? { ok: true, ...read, ms: Date.now() - started } : { ok: false, reason: "invalid" });
  } catch {
    if (timeout.aborted) return done({ ok: false, reason: "timeout" });
    if (signal.aborted) return done({ ok: false, reason: "aborted" });
    return done({ ok: false, reason: "http" });
  } finally { stopWatch(); }
}
