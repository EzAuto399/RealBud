import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { creditBalance, issueOfficeKey } from "./llm-billing.ts";
import { handleLlmGateway, usageFromPayload, usageFromSse } from "./llm-proxy.ts";

const dirs: string[] = [];
const prevKey = process.env.REALBUD_OPENROUTER_API_KEY;
const prevBase = process.env.REALBUD_OPENROUTER_BASE_URL;
const prevMarkup = process.env.REALBUD_BILLING_MARKUP;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (prevKey) process.env.REALBUD_OPENROUTER_API_KEY = prevKey;
  else delete process.env.REALBUD_OPENROUTER_API_KEY;
  if (prevBase) process.env.REALBUD_OPENROUTER_BASE_URL = prevBase;
  else delete process.env.REALBUD_OPENROUTER_BASE_URL;
  if (prevMarkup) process.env.REALBUD_BILLING_MARKUP = prevMarkup;
  else delete process.env.REALBUD_BILLING_MARKUP;
});

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-proxy-"));
  dirs.push(dir);
  return dir;
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe("usage extractors", () => {
  it("reads OpenRouter cost from a JSON body and the last SSE usage chunk", () => {
    expect(usageFromPayload({ usage: { prompt_tokens: 9, completion_tokens: 3, cost: 0.002 } })).toEqual({
      promptTokens: 9,
      completionTokens: 3,
      costUsd: 0.002,
      found: true,
    });
    const sse = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":1,\"total_cost\":0.01}}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    expect(usageFromSse(sse)).toMatchObject({ promptTokens: 4, completionTokens: 1, costUsd: 0.01, found: true });
  });
});

describe("OpenAI-compatible gateway", () => {
  it("refuses a missing key, empty balance, and a missing upstream secret", async () => {
    const dir = tmpHome();
    delete process.env.REALBUD_OPENROUTER_API_KEY;
    const issued = issueOfficeKey("Hermes", dir);
    const gateway = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void handleLlmGateway(req, res, { port: gateway.port, path: url.pathname, method: req.method ?? "GET", dir });
    });
    try {
      const anon = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x", messages: [] }),
      });
      expect(anon.status).toBe(401);

      const broke = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${issued.key}` },
        body: JSON.stringify({ model: "x", messages: [] }),
      });
      expect(broke.status).toBe(402);

      creditBalance({ usd: 5 }, dir);
      const unconfigured = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${issued.key}` },
        body: JSON.stringify({ model: "x", messages: [] }),
      });
      expect(unconfigured.status).toBe(503);
      expect(String((await unconfigured.json() as { error?: { message?: string } }).error?.message)).toMatch(/REALBUD_OPENROUTER_API_KEY/);
    } finally {
      await gateway.close();
    }
  });

  it("forwards a billed completion and records marked-up usage", async () => {
    const dir = tmpHome();
    process.env.REALBUD_BILLING_MARKUP = "2";
    process.env.REALBUD_OPENROUTER_API_KEY = "or-test-placeholder-not-a-real-secret";
    const issued = issueOfficeKey("Hermes", dir);
    creditBalance({ usd: 10 }, dir);

    const upstream = await listen((req, res) => {
      expect(req.headers.authorization).toBe("Bearer or-test-placeholder-not-a-real-secret");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "gen_1",
        choices: [{ message: { role: "assistant", content: "held" } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.25 },
      }));
    });
    process.env.REALBUD_OPENROUTER_BASE_URL = `http://127.0.0.1:${upstream.port}`;

    const gateway = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void handleLlmGateway(req, res, { port: gateway.port, path: url.pathname, method: req.method ?? "GET", dir });
    });
    try {
      const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${issued.key}` },
        body: JSON.stringify({ model: "anthropic/claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      expect((await res.json() as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content).toBe("held");
      const { loadBilling } = await import("./llm-billing.ts");
      const book = loadBilling(dir);
      expect(book.ledger.some((row) => row.kind === "llm" && row.billedMicroUsd === 500_000)).toBe(true);
      expect(book.balanceMicroUsd).toBe(10_000_000 - 500_000);
    } finally {
      await gateway.close();
      await upstream.close();
    }
  });
});
