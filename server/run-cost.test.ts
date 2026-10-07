/** A run's AI usage and its Modelvia-only price. Receipts come from a stubbed
 * fetch; every id, key and amount is fictional. */
import { describe, expect, it } from "vitest";

import { cleanRunUsage, emptyRunUsage, MAX_RUN_REQUEST_IDS, noteModelviaReply, noteModelviaRequest, runCost } from "./run-cost.ts";

const KEY = "fictional-office-key";
const access = { baseUrl: "https://gateway.fictional.test/v1/", key: KEY };
const receipt = (requestId: string, fields: Record<string, unknown>) => ({ requestId, state: "settled", model: "fictional-model", priceBasis: "retail", ...fields });

/** Answers `GET /v1/requests/{id}` from `receipts`; records what was asked and how many were in flight. */
function receipts(byId: Record<string, unknown>, status = 200) {
  const asked: { url: string; authorization: string | null }[] = [];
  let inFlight = 0, peak = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight--;
    const url = String(input);
    asked.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    const id = decodeURIComponent(url.split("/requests/")[1] ?? "");
    return new Response(JSON.stringify(byId[id] ?? { error: { code: "not_found" } }), { status: byId[id] ? status : 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, asked, peak: () => peak };
}

describe("recording a run's Modelvia requests", () => {
  it("keeps header ids once each, ignores unreadable ids, and adds tokens only from a JSON usage", () => {
    const usage = emptyRunUsage();
    noteModelviaRequest(usage, "req-fictional-1");
    noteModelviaReply(usage, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } });
    noteModelviaRequest(usage, "req-fictional-1");
    noteModelviaRequest(usage, null);
    noteModelviaRequest(usage, "not an id/../x");
    noteModelviaReply(usage, { usage: { prompt_tokens: -1, completion_tokens: "9" } });
    expect(usage).toEqual({ requestIds: ["req-fictional-1"], calls: 4, inputTokens: 12, outputTokens: 5 });
  });

  it("takes the original id from a 409 request_already_processed receipt", () => {
    const usage = emptyRunUsage();
    noteModelviaRequest(usage, null);
    noteModelviaReply(usage, { error: { code: "request_already_processed" }, receipt: receipt("req-fictional-original", { chargedNanoAud: "100" }) });
    expect(usage).toEqual({ requestIds: ["req-fictional-original"], calls: 1 });
  });

  it("caps the ids a run keeps", () => {
    const usage = emptyRunUsage();
    for (let index = 0; index < MAX_RUN_REQUEST_IDS + 5; index++) noteModelviaRequest(usage, `req-fictional-${index}`);
    expect(usage.requestIds).toHaveLength(MAX_RUN_REQUEST_IDS);
    expect(usage.calls).toBe(MAX_RUN_REQUEST_IDS + 5);
  });

  it("loads a saved usage record and drops a malformed one", () => {
    expect(cleanRunUsage({ requestIds: ["req-fictional-1", 7, "bad id", "req-fictional-1"], calls: 2, inputTokens: 3, extra: true }))
      .toEqual({ requestIds: ["req-fictional-1"], calls: 2, inputTokens: 3 });
    expect(cleanRunUsage(undefined)).toBeUndefined();
    expect(cleanRunUsage({ requestIds: "req-fictional-1", calls: 1 })).toBeUndefined();
    expect(cleanRunUsage({ requestIds: [], calls: -1 })).toBeUndefined();
  });
});

describe("pricing a run from Modelvia receipts", () => {
  const usage = { requestIds: ["req-fictional-1", "req-fictional-2"], calls: 2 };

  it("sums the charged nanoAUD with the office key, never returning the key", async () => {
    const stub = receipts({
      "req-fictional-1": receipt("req-fictional-1", { chargedNanoAud: "25000000" }),
      "req-fictional-2": receipt("req-fictional-2", { chargedNanoAud: "15000000", wholesaleNanoAud: "1" }),
    });
    const cost = await runCost(usage, access, { fetch: stub.fetcher });
    expect(cost).toEqual({ state: "priced", requests: 2, chargedNanoAud: "40000000" });
    expect(stub.asked.map(request => request.url).sort()).toEqual([
      "https://gateway.fictional.test/v1/requests/req-fictional-1", "https://gateway.fictional.test/v1/requests/req-fictional-2"]);
    expect(stub.asked.every(request => request.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(JSON.stringify(cost)).not.toContain(KEY);
  });

  it("reads withheld as not priced, never A$0", async () => {
    const stub = receipts({
      "req-fictional-1": receipt("req-fictional-1", { priceBasis: "withheld", chargedNanoAud: "0" }),
      "req-fictional-2": receipt("req-fictional-2", { chargedNanoAud: "15000000" }),
    });
    expect(await runCost(usage, access, { fetch: stub.fetcher })).toEqual({ state: "not-priced", requests: 2 });
  });

  it("reads an unsettled retail charge of 0 as pending", async () => {
    const stub = receipts({
      "req-fictional-1": receipt("req-fictional-1", { state: "dispatched", chargedNanoAud: "0", reservedNanoAud: "90000000" }),
      "req-fictional-2": receipt("req-fictional-2", { chargedNanoAud: "15000000" }),
    });
    expect(await runCost(usage, access, { fetch: stub.fetcher })).toEqual({ state: "pending", requests: 2 });
  });

  it("degrades to unavailable on a refused, missing or mismatched receipt, a timeout, or no office key", async () => {
    expect(await runCost(usage, access, { fetch: receipts({ "req-fictional-1": receipt("req-fictional-1", { chargedNanoAud: "1" }) }).fetcher })).toEqual({ state: "unavailable", requests: 2 });
    expect(await runCost(usage, access, { fetch: receipts({ "req-fictional-1": receipt("req-fictional-1", {}), "req-fictional-2": receipt("req-fictional-2", {}) }, 503).fetcher })).toEqual({ state: "unavailable", requests: 2 });
    expect(await runCost(usage, access, { fetch: receipts({ "req-fictional-1": receipt("req-fictional-other", {}), "req-fictional-2": receipt("req-fictional-2", {}) }).fetcher })).toEqual({ state: "unavailable", requests: 2 });
    const hang = (async (_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    expect(await runCost(usage, access, { fetch: hang, timeoutMs: 20 })).toEqual({ state: "unavailable", requests: 2 });
    expect(await runCost(usage, access, { fetch: receipts({ "req-fictional-1": receipt("req-fictional-1", { chargedNanoAud: "1", padding: "x".repeat(70_000) }), "req-fictional-2": receipt("req-fictional-2", { chargedNanoAud: "1" }) }).fetcher })).toEqual({ state: "unavailable", requests: 2 });
    expect(await runCost(usage, null)).toEqual({ state: "unavailable", requests: 2 });
    expect(await runCost(usage, { ...access, baseUrl: "http://gateway.fictional.test/v1" })).toEqual({ state: "unavailable", requests: 2 });
    expect(await runCost({ requestIds: [], calls: 3 }, access)).toEqual({ state: "unavailable", requests: 3 });
  });

  it("is none for a run without AI requests, and bounds concurrent receipt reads", async () => {
    expect(await runCost(undefined, access)).toEqual({ state: "none" });
    expect(await runCost(emptyRunUsage(), access)).toEqual({ state: "none" });
    const ids = Array.from({ length: 12 }, (_, index) => `req-fictional-${index}`);
    const stub = receipts(Object.fromEntries(ids.map(id => [id, receipt(id, { chargedNanoAud: "1000000" })])));
    expect(await runCost({ requestIds: ids, calls: 12 }, access, { fetch: stub.fetcher })).toEqual({ state: "priced", requests: 12, chargedNanoAud: "12000000" });
    expect(stub.peak()).toBeLessThanOrEqual(4);
  });
});
