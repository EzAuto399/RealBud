/** Jev client against a stubbed fetch; every value is fictional. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const entitlement = vi.hoisted(() => ({ failure: null as string | null }));
vi.mock("./managed-service.ts", async (original) => ({
  ...await original<typeof import("./managed-service.ts")>(),
  managedServiceFailure: () => entitlement.failure,
}));
vi.mock("./office-link.ts", async (original) => ({ ...await original<typeof import("./office-link.ts")>(), noteModelKeyAnswer: vi.fn() }));

import { decide, type JevRequest } from "./jev-client.ts";
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
  setWorkerModelGrant({ state: "active", baseUrl: `${BASE}/`, keyId: "fictional-key-id", spendCapLabel: "A$1" });
  setWorkerModelAccessSnapshot({ REALBUD_MODEL_API_KEY: KEY });
  fetchStub = vi.fn(async () => json(answer()));
  vi.stubGlobal("fetch", fetchStub);
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args.join(" ")); });
});
afterEach(() => { delete process.env.REALBUD_JEV_MODEL; vi.unstubAllGlobals(); vi.restoreAllMocks(); setWorkerModelGrant({ state: "none" }); setWorkerModelAccessSnapshot({}); });

describe("jev decide", () => {
  it("posts {model, state, questions} to /decisions with the office key and a fresh idempotency key per decision", async () => {
    const result = await decide(request);
    expect(result).toMatchObject({ ok: true, model: "jev-1.13", answers: { tenant: { choice: "t1", confidence: 0.95 } } });
    // Token usage goes back to the caller for run cost; never cost, never into a log line.
    expect(result).toMatchObject({ usage: { input_tokens: 10, output_tokens: 2 } });
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
    for (const body of [answer("t9"), answer("t1", 1.2), answer("t1", 0.9, { t1: 0.9, none: -0.1 }), { ...answer(), id: undefined }]) {
      fetchStub.mockResolvedValueOnce(json(body));
      expect(await decide(request)).toEqual({ ok: false, reason: "invalid" });
    }
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
    expect(await decide(typed)).toEqual({ ok: false, reason: "invalid" });
    fetchStub.mockResolvedValueOnce(json({ id: "d", model: "jev-1.13", answers: { rent: { type: "noul", noul: 0.2 }, fit: { type: "score", score: 1.4 } } }));
    expect(await decide(typed)).toEqual({ ok: false, reason: "invalid" }); // score past the last criterion
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
    expect(await decide(request)).toEqual({ ok: true, model: "jev-1.13", ms: expect.any(Number), answers: { tenant: { type: "choice", choice: "none" } } });
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
    expect(await decide(request)).toEqual({ ok: true, model: "typesafe/jev-1.13-20260917", ms: expect.any(Number),
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
    expect(source.match(/process\.env\.\w+/g)).toEqual(["process.env.REALBUD_JEV_MODEL"]);
    expect(source).not.toMatch(/session_id:|user:/);
  });
});
