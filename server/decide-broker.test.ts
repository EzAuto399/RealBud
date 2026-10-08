// Bud's `decide` tool: answers are suggestions; authority is re-checked per
// call; credential-shaped state is refused before any call; 10 calls per turn.
import { afterEach, describe, expect, it, vi } from "vitest";

import { DECIDE_SERVER, MAX_DECISIONS_PER_TURN, SUGGESTION_ONLY, secretKeyName, startDecideBroker, type BudDecisions } from "./decide-broker.ts";
import type { JevRequest, JevResult } from "./jev-client.ts";
import type { LoopbackToolServer } from "./web-research-broker.ts";

const question = { kind: { type: "choice", instructions: "Which kind of mail is this?", criteria: { repair: "A repair request", other: "Anything else" } } };
const ok: JevResult = { ok: true, answers: { kind: { type: "choice", choice: "repair", confidence: 0.9 } }, model: "jev-fictional", ms: 3, usage: { input_tokens: 10, output_tokens: 1 } };

describe("decide broker", () => {
  let broker: LoopbackToolServer | undefined;
  afterEach(() => { broker?.close(); broker = undefined; vi.restoreAllMocks(); });
  const start = async (over: Partial<BudDecisions> = {}, turn: { id: string | null } = { id: "turn-1" }) => {
    const receipts: unknown[] = [];
    const decide = vi.fn(async (_request: JevRequest, _options: { signal?: AbortSignal }): Promise<JevResult> => ok);
    const binding: BudDecisions = { sameMember: () => true, ready: () => true, decide, ...over };
    broker = await startDecideBroker({ turnId: () => turn.id, decisions: () => binding, receipt: receipt => receipts.push(receipt) });
    return { receipts, decide: (over.decide ?? decide) as typeof decide };
  };
  const rpc = async (method: string, params: unknown) => ((await (await fetch(broker!.descriptor.url, { method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(broker!.descriptor.headers.map(r => [r.name, r.value])) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any).result;
  const call = (args: unknown) => rpc("tools/call", { name: "decide", arguments: args });

  it("offers one decide tool on its own server", async () => {
    await start();
    expect(broker!.descriptor.name).toBe(DECIDE_SERVER);
    expect((await rpc("tools/list", {})).tools.map((tool: { name: string }) => tool.name)).toEqual(["decide"]);
  });

  it("returns the answers marked as a suggestion, and records no state, answers or usage", async () => {
    const logs: string[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args.join(" ")); });
    const { receipts, decide } = await start();
    const state = { subject: "Leaking tap at 1 Sample St" };
    const result = await call({ state, questions: question });
    expect(result.isError).toBeUndefined();
    expect(decide).toHaveBeenCalledWith({ state, questions: question }, { signal: expect.any(AbortSignal) });
    expect(JSON.parse(result.content[0].text.split("\n")[0])).toEqual({ answers: ok.ok && ok.answers });
    expect(result.content[0].text.endsWith(SUGGESTION_ONLY)).toBe(true);
    expect(receipts).toEqual([{ tool: "decide", outcome: "succeeded", questions: 1 }]);
    const recorded = JSON.stringify(receipts) + logs.join("\n");
    expect(recorded).not.toMatch(/Sample St|repair|input_tokens/);
  });

  it("refuses once the turn is no longer active", async () => {
    const turn = { id: "turn-1" as string | null };
    const { decide } = await start({}, turn);
    turn.id = null;
    const result = await call({ state: "x", questions: question });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no longer working/);
    expect(decide).not.toHaveBeenCalled();
  });

  it("refuses when the member changed or Jev is no longer ready", async () => {
    const changed = await start({ sameMember: () => false });
    expect((await call({ state: "x", questions: question })).content[0].text).toMatch(/member changed/);
    expect(changed.decide).not.toHaveBeenCalled();
    broker!.close();
    const notReady = await start({ ready: () => false });
    const result = await call({ state: "x", questions: question });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available/);
    expect(notReady.decide).not.toHaveBeenCalled();
    expect(notReady.receipts).toEqual([{ tool: "decide", outcome: "refused" }]);
  });

  it("refuses credential-shaped state and secret-named keys at any depth, sending nothing", async () => {
    const { decide } = await start();
    for (const state of [
      "Authorization: Bearer fictionalbearer0123456789",
      { note: "password=fictional-pass-123" },
      { rows: [{ meta: { Cookie: "a" } }] },
      { deep: { sessionId: "s" } },
      { list: [[{ api_token: "t" }]] },
      { otp: "123456" },
    ]) {
      const result = await call({ state, questions: question });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Nothing was sent/);
    }
    expect(decide).not.toHaveBeenCalled();
  });

  it("refuses secret-named keys by whole token, confusable keys and one-time codes, and allows ordinary property keys", async () => {
    for (const key of ["credentials", "pwd", "pin", "apiKey", "APIKey", "x-api-key", "private_key", "authToken", "verificationCode", "code", "sessionId",
      "pаssword", "ｐａｓｓｗｏｒｄ", "pass2"]) {
      expect(secretKeyName(key), key).toBe(true);
    }
    for (const key of ["possessionDate", "footprint", "postcode", "zipCode", "keyDates", "tokenised", "author", "spinner", "passengerCount", "propertyCode"]) {
      expect(secretKeyName(key), key).toBe(false);
    }
    const { decide } = await start();
    for (const state of [{ credentials: "x" }, { pwd: "x" }, { pin: "x" }, { apiKey: "x" }, { ["pаssword"]: "x" }, "Your code is 482913", { sms: "OTP: 1234" }]) {
      const result = await call({ state, questions: question });
      expect(result.isError, JSON.stringify(state)).toBe(true);
      expect(result.content[0].text).toMatch(/Nothing was sent/);
    }
    expect((await call({ state: "x", questions: { kind: { ...question.kind, instructions: "Your verification code is 482913. Which kind?" } } })).isError).toBe(true);
    expect(decide).not.toHaveBeenCalled();
    for (const state of [{ possessionDate: "2026-11-01" }, { footprint: "120 m2" }, { postcode: "2000" }, { zipCode: "2000", keyDates: ["2026-11-01"] }, "Property code: 4021", { note: "Invoice code 88231 for unit 4" }]) {
      expect((await call({ state, questions: question })).isError, JSON.stringify(state)).toBeUndefined();
    }
    expect(decide).toHaveBeenCalledTimes(6);
  });

  it("surfaces Jev's invalid answer (e.g. more than 8 questions) as a clear error", async () => {
    const questions = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`q${index}`, question.kind]));
    const { receipts } = await start({ decide: vi.fn(async () => ({ ok: false, reason: "invalid" }) as JevResult) });
    const result = await call({ state: "x", questions });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/1 to 8 questions.*Nothing was decided/);
    expect(receipts).toEqual([{ tool: "decide", outcome: "failed", questions: 9 }]);
  });

  it(`stops at ${MAX_DECISIONS_PER_TURN} calls per turn and starts again for the next turn`, async () => {
    const turn = { id: "turn-1" as string | null };
    const { decide } = await start({}, turn);
    for (let index = 0; index < MAX_DECISIONS_PER_TURN; index++) expect((await call({ state: "x", questions: question })).isError).toBeUndefined();
    const eleventh = await call({ state: "x", questions: question });
    expect(eleventh.isError).toBe(true);
    expect(eleventh.content[0].text).toMatch(/the most allowed/);
    expect(decide).toHaveBeenCalledTimes(MAX_DECISIONS_PER_TURN);
    turn.id = "turn-2";
    expect((await call({ state: "x", questions: question })).isError).toBeUndefined();
  });

  it("rejects unknown arguments and missing questions", async () => {
    const { decide } = await start();
    expect((await call({ state: "x" })).isError).toBe(true);
    expect((await call({ state: "x", questions: question, model: "other" })).isError).toBe(true);
    expect(decide).not.toHaveBeenCalled();
  });
});
