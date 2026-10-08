/** Jev client against a stubbed fetch; every value is fictional. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const entitlement = vi.hoisted(() => ({ failure: null as string | null }));
vi.mock("./managed-service.ts", async (original) => ({
  ...await original<typeof import("./managed-service.ts")>(),
  managedServiceFailure: () => entitlement.failure,
}));
vi.mock("./office-link.ts", async (original) => ({ ...await original<typeof import("./office-link.ts")>(), noteModelKeyAnswer: vi.fn() }));

import { decide, LUNA_DECISIONS_MODEL, lunaModel, lunaReady, MAX_IMAGE_BYTES, withImage, type JevRequest } from "./jev-client.ts";
import { setWorkerModelAccessSnapshot } from "./hermes-runtime-env.ts";
import { setWorkerModelGrant } from "./worker-model-access.ts";

const KEY = "fictional-jev-office-key-0001";
const BASE = "https://models.fictional.test/v1";
const request: JevRequest = {
  state: { payer: "FICTIONAL PAYER", amount: "410.00" },
  questions: { tenant: { type: "choice", instructions: "Pick one.", criteria: { t1: "Alex Fictional", none: "None." } } },
};
const answer = (choice = "t1", confidence = 0.95, probabilities: Record<string, number> = { t1: 0.95, none: 0.05 }) =>
  ({ id: "fictional-decision-1", model: "jev-1.13", answers: { tenant: { type: "choice", choice, confidence, probabilities } },
    usage: { input_tokens: 10, output_tokens: 2 } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (status: number, code: string) => json({ error: { code, message: "fictional detail FICTIONAL PAYER" } }, status);
const hang = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
const keyOf = (call: number) => fetchStub.mock.calls[call][1].headers["idempotency-key"];
let fetchStub: ReturnType<typeof vi.fn>;
let logs: string[];

beforeEach(() => {
  entitlement.failure = null;
  process.env.REALBUD_JEV_MODEL = "jev-1.13-decisions";
  process.env.REALBUD_JEV_FALLBACK_MODEL = "off"; // the fallback has its own suite below
  setWorkerModelGrant({ state: "active", baseUrl: `${BASE}/`, keyId: "fictional-key-id", spendCapLabel: "A$1" });
  setWorkerModelAccessSnapshot({ REALBUD_MODEL_API_KEY: KEY });
  fetchStub = vi.fn(async () => json(answer()));
  vi.stubGlobal("fetch", fetchStub);
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args.join(" ")); });
});
afterEach(() => { delete process.env.REALBUD_JEV_MODEL; delete process.env.REALBUD_JEV_FALLBACK_MODEL; delete process.env.REALBUD_LUNA_MODEL; vi.unstubAllGlobals(); vi.restoreAllMocks(); setWorkerModelGrant({ state: "none" }); setWorkerModelAccessSnapshot({}); });

describe("jev decide", () => {
  it("posts {model, state, questions} to /decisions with the office key and a fresh idempotency key per decision", async () => {
    const result = await decide(request);
    expect(result).toMatchObject({ ok: true, model: "jev-1.13", answers: { tenant: { choice: "t1", confidence: 0.95 } } });
    // Token usage goes back to the caller for run cost; never cost, never into a log line.
    expect(result).toMatchObject({ usage: { input_tokens: 10, output_tokens: 2 } });
    // Modelvia's request id, the receipt key the run prices the call by.
    expect(result).toMatchObject({ id: "fictional-decision-1" });
    expect(JSON.stringify(result)).not.toMatch(/cost/);
    expect(logs.join("\n")).not.toMatch(/usage|tokens|input_tokens/);
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe(`${BASE}/decisions`);
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual({ model: "jev-1.13-decisions", state: request.state, questions: request.questions });
    await decide(request);
    expect(keyOf(0)).toMatch(/^[0-9a-f-]{36}$/);
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("refuses without a model, grant, key, entitlement or an https/loopback gateway, and never calls out", async () => {
    process.env.REALBUD_JEV_MODEL = "off";
    expect(await decide(request)).toEqual({ ok: false, reason: "refused" });
    delete process.env.REALBUD_JEV_MODEL; // installed apps: the catalogue id is the default
    setWorkerModelGrant({ state: "withdrawn" });
    expect(await decide(request)).toEqual({ ok: false, reason: "refused" });
    setWorkerModelGrant({ state: "active", baseUrl: BASE, keyId: "k", spendCapLabel: "" });
    setWorkerModelAccessSnapshot({});
    expect(await decide(request)).toEqual({ ok: false, reason: "refused" });
    setWorkerModelAccessSnapshot({ REALBUD_MODEL_API_KEY: KEY });
    entitlement.failure = "Managed service is unavailable.";
    expect(await decide(request)).toEqual({ ok: false, reason: "refused" });
    entitlement.failure = null;
    setWorkerModelGrant({ state: "active", baseUrl: "http://models.fictional.test/v1", keyId: "k", spendCapLabel: "" });
    expect(await decide(request)).toEqual({ ok: false, reason: "refused" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("times out after one attempt and never retries", async () => {
    fetchStub.mockImplementation(hang);
    expect(await decide(request, { timeoutMs: 20 })).toEqual({ ok: false, reason: "timeout" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("never retries a dropped connection", async () => {
    fetchStub.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await decide(request)).toEqual({ ok: false, reason: "http" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("retries once with the same key only after an uncharged 503", async () => {
    fetchStub.mockResolvedValueOnce(failure(503, "serving_temporarily_unavailable"));
    expect(await decide(request)).toMatchObject({ ok: true });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(keyOf(0));
    fetchStub.mockReset();
    fetchStub.mockImplementation(async () => failure(503, "model_route_unavailable"));
    expect(await decide(request)).toEqual({ ok: false, reason: "unavailable" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    fetchStub.mockReset();
    fetchStub.mockImplementation(async () => failure(503, "something_else"));
    expect(await decide(request)).toEqual({ ok: false, reason: "http" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "invalid_api_key", "refused"], [403, "mode_not_allowed", "refused"], [403, "model_not_allowed", "refused"],
    [402, "monthly_cap_exceeded", "budget"], [402, "credit_limit_exceeded", "budget"], [402, "max_cap_reached", "budget"],
    [409, "request_already_processed", "http"], [409, "idempotency_conflict", "http"],
    [502, "invalid_provider_answers", "invalid"], [500, "internal_error", "http"],
    [400, "unsupported_parameter:temperature", "invalid"],
  ])("maps %i %s to %s without retrying", async (status, code, reason) => {
    fetchStub.mockResolvedValueOnce(failure(status, code));
    expect(await decide(request)).toEqual({ ok: false, reason });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("logs a 400's error code only", async () => {
    fetchStub.mockResolvedValueOnce(failure(400, "invalid_questions"));
    await decide(request);
    expect(logs).toEqual([expect.stringMatching(/^\[jev\] invalid \d+ms code=invalid_questions$/)]);
  });

  it("rejects an unoffered choice, values outside [0,1], a missing id and unreadable JSON", async () => {
    // Answered, so charged: the id (when there is one) still comes back for run cost.
    for (const body of [answer("t9"), answer("t1", 1.2), answer("t1", 0.9, { t1: 0.9, none: -0.1 })]) {
      fetchStub.mockResolvedValueOnce(json(body));
      expect(await decide(request)).toEqual({ ok: false, reason: "invalid", id: "fictional-decision-1" });
    }
    fetchStub.mockResolvedValueOnce(json({ ...answer(), id: undefined }));
    expect(await decide(request)).toEqual({ ok: false, reason: "invalid" });
    fetchStub.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    expect(await decide(request)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a reply body over 256 KiB as invalid", async () => {
    fetchStub.mockResolvedValueOnce(json({ ...answer(), pad: "x".repeat(256 * 1024) }));
    expect(await decide(request)).toEqual({ ok: false, reason: "invalid" });
    fetchStub.mockResolvedValueOnce(json({ ...answer(), pad: "x".repeat(1024) }));
    expect(await decide(request)).toMatchObject({ ok: true });
  });

  it("returns a below-threshold answer as data for the caller to ignore", async () => {
    fetchStub.mockResolvedValueOnce(json(answer("t1", 0.4, { t1: 0.4, none: 0.6 })));
    expect(await decide(request)).toMatchObject({ ok: true, answers: { tenant: { choice: "t1", confidence: 0.4 } } });
  });

  it("follows the noul and score schemas", async () => {
    const typed: JevRequest = { state: {}, questions: {
      rent: { type: "noul", instructions: "Is this rent?", criteria: { true: "Rent.", false: "Not rent." } },
      fit: { type: "score", instructions: "How well?", criteria: ["Poor", "Good"] } } };
    fetchStub.mockResolvedValueOnce(json({ id: "d", model: "jev-1.13", answers: {
      rent: { type: "noul", noul: 0.8 }, fit: { type: "score", score: 0.7, confidence: 0.9, probabilities: { "0": 0.1, "1": 0.9 } } } }));
    expect(await decide(typed)).toMatchObject({ ok: true, answers: { rent: { noul: 0.8 }, fit: { score: 0.7 } } });
    fetchStub.mockResolvedValueOnce(json({ id: "d", model: "jev-1.13", answers: { rent: { type: "noul", noul: true }, fit: { type: "score", score: 1, confidence: 1, probabilities: {} } } }));
    expect(await decide(typed)).toEqual({ ok: false, reason: "invalid", id: "d" });
    fetchStub.mockResolvedValueOnce(json({ id: "d", model: "jev-1.13", answers: { rent: { type: "noul", noul: 0.2 }, fit: { type: "score", score: 1.4 } } }));
    expect(await decide(typed)).toEqual({ ok: false, reason: "invalid", id: "d" }); // score past the last criterion
    fetchStub.mockResolvedValueOnce(json({ id: "d", model: "jev-1.13", answers: { rent: { type: "noul", noul: 0.2 } } }));
    expect(await decide({ state: {}, questions: { rent: { type: "noul", instructions: "Is this rent?" } } })).toMatchObject({ ok: true, answers: { rent: { noul: 0.2 } } });
    const noFalse = { state: {}, questions: { rent: { type: "noul", instructions: "x", criteria: { true: "Rent." } } } } as unknown as JevRequest;
    const noArray = { state: {}, questions: { fit: { type: "score", instructions: "x", criteria: { a: "b" } } } } as unknown as JevRequest;
    expect(await decide(noFalse)).toEqual({ ok: false, reason: "invalid" });
    expect(await decide(noArray)).toEqual({ ok: false, reason: "invalid" });
    expect(fetchStub).toHaveBeenCalledTimes(4);
  });

  it("accepts a choice without confidence or probabilities and a score with a legend, passing neither extra on", async () => {
    fetchStub.mockResolvedValueOnce(json({ id: "d", model: "jev-1.13", answers: { tenant: { type: "choice", choice: "none" } } }));
    expect(await decide(request)).toEqual({ ok: true, id: "d", model: "jev-1.13", ms: expect.any(Number), answers: { tenant: { type: "choice", choice: "none" } } });
    fetchStub.mockResolvedValueOnce(json({ id: "d", model: "jev-1.13", answers: { fit: { type: "score", score: 0.5, legend: "fictional" } } }));
    expect((await decide({ state: {}, questions: { fit: { type: "score", instructions: "x", criteria: ["a", "b"] } } }) as { answers: unknown }).answers)
      .toEqual({ fit: { type: "score", score: 0.5 } });
  });

  it("enforces the request caps without calling out", async () => {
    const noul = { type: "noul" as const, instructions: "x", criteria: { true: "y", false: "n" } };
    expect(await decide({ state: {}, questions: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i}`, noul])) })).toEqual({ ok: false, reason: "invalid" });
    const options = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`o${i}`, "x"]));
    expect(await decide({ state: {}, questions: { q: { type: "choice", instructions: "x", criteria: options } } })).toEqual({ ok: false, reason: "invalid" });
    expect(await decide({ ...request, state: "x".repeat(17 * 1024) })).toEqual({ ok: false, reason: "invalid" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each<[string, (questions: Record<string, unknown>) => unknown]>([
    ["a choice with one option", () => ({ q: { type: "choice", instructions: "x", criteria: { only: "y" } } })],
    ["blank instructions", () => ({ q: { type: "noul", instructions: " \n\t " } })],
    ["instructions over 8,000 characters", () => ({ q: { type: "noul", instructions: "x".repeat(8_001) } })],
    ["a blank choice criterion", () => ({ q: { type: "choice", instructions: "x", criteria: { a: "y", b: "  " } } })],
    ["a choice criterion over 4,000 characters", () => ({ q: { type: "choice", instructions: "x", criteria: { a: "y", b: "z".repeat(4_001) } } })],
    ["a blank noul criterion", () => ({ q: { type: "noul", instructions: "x", criteria: { true: "", false: "n" } } })],
    ["a score criterion over 4,000 characters", () => ({ q: { type: "score", instructions: "x", criteria: ["a", "b".repeat(4_001)] } })],
    ["a question key with a space", () => ({ "the tenant": { type: "noul", instructions: "x" } })],
    ["a question key over 64 characters", () => ({ ["q".repeat(65)]: { type: "noul", instructions: "x" } })],
    ["an empty question key", () => ({ "": { type: "noul", instructions: "x" } })],
    ["a constructor question key", () => ({ constructor: { type: "noul", instructions: "x" } })],
    ["a prototype question key", () => ({ prototype: { type: "noul", instructions: "x" } })],
    ["a __proto__ question key", () => JSON.parse('{"__proto__": {"type": "noul", "instructions": "x"}}')],
    ["an option key that is a name", () => ({ q: { type: "choice", instructions: "x", criteria: { "Alex Fictional": "y", none: "n" } } })],
    ["a __proto__ option key", () => ({ q: { type: "choice", instructions: "x", criteria: JSON.parse('{"__proto__": "y", "none": "n"}') } })],
    ["a constructor option key", () => ({ q: { type: "choice", instructions: "x", criteria: { constructor: "y", none: "n" } } })],
  ])("refuses %s as invalid without calling out", async (_label, questions) => {
    expect(await decide({ state: { payer: "x" }, questions: questions({}) } as JevRequest)).toEqual({ ok: false, reason: "invalid" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each([["null", null], ["undefined", undefined], ["an empty string", ""], ["a number", 7], ["a boolean", true]])
  ("refuses %s state as invalid without calling out", async (_label, state) => {
    expect(await decide({ ...request, state })).toEqual({ ok: false, reason: "invalid" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("sends a string, object or array state as given and accepts edge-valid keys and lengths", async () => {
    const edge: JevRequest["questions"] = { ["a".repeat(64)]: { type: "choice", instructions: "x".repeat(8_000), criteria: { "t0": "y".repeat(4_000), "row.1:a_b-c": "n" } } };
    for (const state of ["a note", [], ["a"], {}]) {
      fetchStub.mockResolvedValueOnce(json({ id: "d", model: "jev-1.13", answers: { ["a".repeat(64)]: { type: "choice", choice: "t0" } } }));
      expect(await decide({ state, questions: edge })).toMatchObject({ ok: true });
      expect(JSON.parse(fetchStub.mock.calls.at(-1)![1].body).state).toEqual(state);
    }
  });

  it("keeps the request id of a charged answer that fails validation, and none for a refusal", async () => {
    fetchStub.mockResolvedValueOnce(new Response(JSON.stringify({ ...answer("t9"), id: "fictional-decision-body" }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "fictional-decision-header" } }));
    expect(await decide(request)).toEqual({ ok: false, reason: "invalid", id: "fictional-decision-header" });
    fetchStub.mockResolvedValueOnce(json({ ...answer("t9"), id: "fictional-decision-body" }));
    expect(await decide(request)).toEqual({ ok: false, reason: "invalid", id: "fictional-decision-body" });
    fetchStub.mockResolvedValueOnce(failure(402, "budget_exhausted"));
    expect(await decide(request)).toEqual({ ok: false, reason: "budget" });
  });

  it("returns usage only when it is well formed, and never fails the answer over it", async () => {
    for (const usage of [undefined, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 1.5, output_tokens: 2 }, { input_tokens: "10" }, null]) {
      fetchStub.mockResolvedValueOnce(json({ ...answer(), usage }));
      const result = await decide(request);
      expect(result).toMatchObject({ ok: true });
      expect(result).not.toHaveProperty("usage");
    }
  });

  it("accepts a dated reply model and ignores extra reply fields", async () => {
    fetchStub.mockResolvedValueOnce(json({ ...answer(), model: "typesafe/jev-1.13-20260917", created: 1, provider: "fictional", extra: { a: 1 } }));
    expect(await decide(request)).toEqual({ ok: true, id: "fictional-decision-1", model: "typesafe/jev-1.13-20260917", ms: expect.any(Number),
      answers: { tenant: { type: "choice", choice: "t1", confidence: 0.95, probabilities: { t1: 0.95, none: 0.05 } } }, usage: { input_tokens: 10, output_tokens: 2 } });
  });

  it("aborts on the caller's signal and when the office key changes mid-call", async () => {
    fetchStub.mockImplementation(hang);
    const caller = new AbortController();
    const pending = decide(request, { signal: caller.signal });
    caller.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
    const second = decide(request);
    setWorkerModelAccessSnapshot({ REALBUD_MODEL_API_KEY: "fictional-jev-office-key-0002" });
    expect(await second).toEqual({ ok: false, reason: "aborted" });
  });

  it("never puts the key into env and logs only the outcome code and ms", async () => {
    await decide(request);
    fetchStub.mockResolvedValueOnce(json(answer("t9")));
    await decide(request);
    fetchStub.mockResolvedValueOnce(failure(402, "monthly_cap_exceeded"));
    await decide(request);
    expect(Object.values(process.env).some(value => value?.includes(KEY))).toBe(false);
    expect(logs).toHaveLength(3);
    for (const line of logs) {
      expect(line).toMatch(/^\[jev\] (ok|invalid|budget) \d+ms$/);
      for (const secret of [KEY, "FICTIONAL PAYER", "410.00", "Alex Fictional", "t1", "usage", "cost"]) expect(line).not.toContain(secret);
    }
    const source = readFileSync(new URL("./jev-client.ts", import.meta.url), "utf8");
    expect(source.match(/process\.env\.\w+/g)).toEqual(["process.env.REALBUD_LUNA_MODEL", "process.env.REALBUD_JEV_MODEL", "process.env.REALBUD_JEV_FALLBACK_MODEL"]);
    expect(source).not.toMatch(/session_id:|user:/);
  });

  describe("Luna vision fallback", () => {
    // A fictional 1x1 PNG's leading bytes; never a real screenshot.
    const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(32, 7)]).toString("base64");
    afterEach(() => { delete process.env.REALBUD_LUNA_MODEL; });

    it("sends a per-call model and the image as an image_url part of the state array, never logging it", async () => {
      expect(lunaModel()).toBe(LUNA_DECISIONS_MODEL);
      expect(lunaReady()).toBe(true);
      const result = await decide(request, { model: lunaModel()!, image: PNG });
      expect(result.ok).toBe(true);
      const body = JSON.parse(fetchStub.mock.calls[0][1].body);
      expect(body).toEqual({ model: "gpt-6-luna-decisions", state: withImage(request.state as Record<string, unknown>, PNG), questions: request.questions });
      expect(body.state).toEqual([JSON.stringify(request.state), { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}`, detail: "low" } }]);
      expect(logs.join("\n")).not.toContain(PNG.slice(0, 12));
    });

    it("is off with REALBUD_LUNA_MODEL=off and refuses a non-PNG, an oversized image or a string state before any call", async () => {
      process.env.REALBUD_LUNA_MODEL = "off";
      expect(lunaModel()).toBeNull();
      expect(lunaReady()).toBe(false);
      delete process.env.REALBUD_LUNA_MODEL;
      const big = `iVBORw0KGgo${"A".repeat(Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8)}`;
      for (const [state, image] of [[request.state, "not-a-png"], [request.state, big], ["a string state", PNG]] as const) {
        expect(await decide({ ...request, state }, { model: "gpt-6-luna-decisions", image })).toEqual({ ok: false, reason: "invalid" });
      }
      expect(await decide(request, { model: " " })).toEqual({ ok: false, reason: "refused" });
      expect(fetchStub).not.toHaveBeenCalled();
    });
  });
});

describe("jev decide with Jev primary and Luna fallback", () => {
  const LUNA = "gpt-6-luna-decisions", JEV = "jev-1.13-decisions";
  const sentModel = (call: number) => JSON.parse(fetchStub.mock.calls[call][1].body).model;
  const luna = { ...answer(), id: "fictional-decision-luna", model: "openai/gpt-6-luna-decisions-2026-09-22" };
  /** Records the timeout each attempt asked for; the 8 s primary runs as 20 ms. */
  const timeouts = () => {
    const real = AbortSignal.timeout.bind(AbortSignal), asked: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { asked.push(ms); return real(ms === 8_000 ? 20 : ms); });
    return asked;
  };
  // Installed apps: Jev first, Luna behind it. Unless a test says otherwise, the fallback (Luna) answers.
  beforeEach(() => { delete process.env.REALBUD_JEV_MODEL; delete process.env.REALBUD_JEV_FALLBACK_MODEL; fetchStub.mockImplementation(async () => json(luna)); });

  it("default config: Jev's free 503 model_route_unavailable falls back to Luna under its own key", async () => {
    fetchStub.mockResolvedValueOnce(failure(503, "model_route_unavailable"));
    const result = await decide(request);
    expect(result).toEqual({ ok: true, id: luna.id, model: luna.model, ms: expect.any(Number), fallbackFrom: JEV,
      answers: { tenant: { type: "choice", choice: "t1", confidence: 0.95, probabilities: { t1: 0.95, none: 0.05 } } }, usage: { input_tokens: 10, output_tokens: 2 } });
    expect(result).not.toHaveProperty("abandonedIdempotencyKey");
    expect([sentModel(0), sentModel(1)]).toEqual([JEV, LUNA]);
    expect(keyOf(0)).toMatch(/^[0-9a-f-]{36}$/);
    expect(keyOf(1)).toBe(`${keyOf(0)}:fallback`);
    expect(logs).toEqual([expect.stringMatching(/^\[jev\] ok \d+ms fallback=503$/)]);
  });

  it("returns Jev's answer when Jev answers, without asking Luna", async () => {
    fetchStub.mockResolvedValueOnce(json(answer()));
    const result = await decide(request);
    expect(result).toMatchObject({ ok: true, model: "jev-1.13", answers: { tenant: { choice: "t1" } } });
    expect(result).not.toHaveProperty("fallbackFrom");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(sentModel(0)).toBe(JEV);
  });

  it("passes on a Luna fallback answer without confidence or probabilities as unsure, never inventing them", async () => {
    fetchStub.mockResolvedValueOnce(failure(502, "invalid_provider_answers")).mockResolvedValueOnce(json({ ...luna, answers: { tenant: { type: "choice", choice: "t1" } } }));
    expect(await decide(request)).toEqual({ ok: true, id: luna.id, model: luna.model, ms: expect.any(Number), fallbackFrom: JEV,
      answers: { tenant: { type: "choice", choice: "t1" } }, usage: { input_tokens: 10, output_tokens: 2 } });
  });

  it.each([[502, "invalid_provider_answers"], [502, "provider_refused"], [503, "model_route_unavailable"]])
  ("falls back to Luna after %i %s", async (status, code) => {
    fetchStub.mockResolvedValueOnce(failure(status, code));
    expect(await decide(request)).toMatchObject({ ok: true, model: luna.model, fallbackFrom: JEV });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(`${keyOf(0)}:fallback`);
  });

  it("never falls back after another 503: the uncharged one retries Jev under the same key, then stops", async () => {
    fetchStub.mockImplementation(async () => failure(503, "serving_temporarily_unavailable"));
    expect(await decide(request)).toEqual({ ok: false, reason: "unavailable" });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect([sentModel(0), sentModel(1), keyOf(1)]).toEqual([JEV, JEV, keyOf(0)]);
    fetchStub.mockReset();
    fetchStub.mockImplementation(async () => failure(503, "something_else"));
    expect(await decide(request)).toEqual({ ok: false, reason: "http" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "invalid_questions", "invalid"], [402, "monthly_cap_exceeded", "budget"], [402, "request_cap_exceeded", "budget"],
    [409, "request_already_processed", "http"], [409, "idempotency_conflict", "http"],
    [401, "invalid_api_key", "refused"], [403, "model_not_allowed", "refused"], [500, "internal_error", "http"],
  ])("never falls back after %i %s (%s)", async (status, code, reason) => {
    fetchStub.mockResolvedValueOnce(failure(status, code));
    expect(await decide(request)).toEqual({ ok: false, reason });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("falls back after Jev's own 8 s timeout with Luna's 10 s, naming the abandoned Jev key", async () => {
    const asked = timeouts();
    fetchStub.mockImplementationOnce(hang);
    const result = await decide(request);
    expect(result).toMatchObject({ ok: true, model: luna.model, fallbackFrom: JEV, abandonedIdempotencyKey: keyOf(0) });
    expect(asked).toEqual([8_000, 10_000]);
    expect(keyOf(1)).toBe(`${keyOf(0)}:fallback`);
    expect(logs).toEqual([expect.stringMatching(new RegExp(`^\\[jev\\] ok \\d+ms fallback=timeout abandoned=${keyOf(0)}$`))]);
  });

  it("falls back after a dropped connection before any response, naming the abandoned Jev key", async () => {
    fetchStub.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await decide(request)).toMatchObject({ ok: true, fallbackFrom: JEV, abandonedIdempotencyKey: keyOf(0) });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("keeps a caller's timeoutMs for Jev and never falls back after it", async () => {
    const asked = timeouts();
    fetchStub.mockImplementation(hang);
    expect(await decide(request, { timeoutMs: 20 })).toEqual({ ok: false, reason: "timeout" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([20]);
  });

  it("uses the caller's timeoutMs for both calls after a quick 502", async () => {
    const asked = timeouts();
    fetchStub.mockResolvedValueOnce(failure(502, "invalid_provider_answers"));
    expect(await decide(request, { timeoutMs: 2_500 })).toMatchObject({ ok: true, fallbackFrom: JEV });
    expect(asked).toEqual([2_500, 2_500]);
  });

  it("keeps a call whose primary is the fallback itself (Luna) at 10 s with no fallback", async () => {
    process.env.REALBUD_JEV_MODEL = LUNA;
    const asked = timeouts();
    fetchStub.mockResolvedValueOnce(failure(503, "model_route_unavailable"));
    expect(await decide(request)).toEqual({ ok: false, reason: "unavailable" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([10_000]);
  });

  it("never falls back for an image: the caller's timeout (else 10 s) and one model only", async () => {
    const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(32, 7)]).toString("base64");
    const asked = timeouts();
    fetchStub.mockImplementation(async () => failure(503, "model_route_unavailable"));
    expect(await decide(request, { model: LUNA, image: PNG })).toEqual({ ok: false, reason: "unavailable" });
    expect(await decide(request, { model: JEV, image: PNG, timeoutMs: 3_000 })).toEqual({ ok: false, reason: "unavailable" });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(asked).toEqual([10_000, 3_000]);
  });

  it("never falls back when the caller aborts or the office key changes", async () => {
    fetchStub.mockImplementation(hang);
    const caller = new AbortController();
    const pending = decide(request, { signal: caller.signal });
    caller.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
    const second = decide(request);
    setWorkerModelAccessSnapshot({ REALBUD_MODEL_API_KEY: "fictional-jev-office-key-0002" });
    expect(await second).toEqual({ ok: false, reason: "aborted" });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("reports Luna's own failure after a fallback, still naming the primary", async () => {
    fetchStub.mockResolvedValueOnce(failure(503, "model_route_unavailable")).mockResolvedValueOnce(failure(402, "monthly_cap_exceeded"));
    expect(await decide(request)).toEqual({ ok: false, reason: "budget", fallbackFrom: JEV });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("honours REALBUD_JEV_FALLBACK_MODEL (another model, off, or the primary itself) and REALBUD_LUNA_MODEL=off", async () => {
    process.env.REALBUD_JEV_FALLBACK_MODEL = "fictional-fallback-decisions";
    fetchStub.mockResolvedValueOnce(failure(503, "model_route_unavailable"));
    expect(await decide(request)).toMatchObject({ ok: true, fallbackFrom: JEV });
    expect(sentModel(1)).toBe("fictional-fallback-decisions");
    for (const [primary, fallback] of [[JEV, "off"], ["fictional-only-decisions", "fictional-only-decisions"]]) {
      fetchStub.mockReset();
      fetchStub.mockImplementation(async () => failure(503, "model_route_unavailable"));
      process.env.REALBUD_JEV_MODEL = primary; process.env.REALBUD_JEV_FALLBACK_MODEL = fallback;
      expect(await decide(request)).toEqual({ ok: false, reason: "unavailable" });
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(sentModel(0)).toBe(primary);
    }
    // No explicit fallback and Luna switched off: Jev alone.
    delete process.env.REALBUD_JEV_MODEL; delete process.env.REALBUD_JEV_FALLBACK_MODEL; process.env.REALBUD_LUNA_MODEL = "off";
    fetchStub.mockClear();
    expect(await decide(request)).toEqual({ ok: false, reason: "unavailable" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    delete process.env.REALBUD_LUNA_MODEL;
  });
});
