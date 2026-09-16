// OpenAI-compatible gateway. Hermes (or any OpenAI client) sends a RealBud
// office key; we settle the call to the configured OpenRouter-compatible
// upstream and meter the office wallet.
import type { IncomingMessage, ServerResponse } from "node:http";

import { hostAllowed } from "./session-auth.ts";
import {
  billingSettings,
  lookupOfficeKey,
  officeHasCredit,
  recordLlmUsageLocked,
} from "./llm-billing.ts";

const GATEWAY_MAX_BYTES = 8_000_000;
const UPSTREAM_TIMEOUT_MS = 120_000;

export type FetchLike = typeof fetch;

function openaiError(status: number, message: string, type = "invalid_request_error", code?: string) {
  return { status, body: { error: { message, type, code: code ?? null } } };
}

function bearerFrom(req: IncomingMessage): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const alt = req.headers["x-api-key"];
  if (typeof alt === "string") return alt.trim();
  if (Array.isArray(alt) && typeof alt[0] === "string") return alt[0].trim();
  return "";
}

function readJsonBody(req: IncomingMessage, maxBytes = GATEWAY_MAX_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const fail = (status: number, message: string) => {
      if (done) return;
      done = true;
      reject(Object.assign(new Error(message), { status }));
    };
    req.on("data", (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > maxBytes) return fail(413, "body too large");
      chunks.push(buf);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        fail(400, "invalid JSON body");
      }
    });
    req.on("error", (error) => fail(400, error instanceof Error ? error.message : String(error)));
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function usageFromPayload(payload: unknown): {
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  found: boolean;
} {
  const rec = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const usage = rec && rec.usage && typeof rec.usage === "object" ? (rec.usage as Record<string, unknown>) : null;
  if (!usage) return { promptTokens: 0, completionTokens: 0, costUsd: null, found: false };
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const costRaw = usage.cost ?? usage.total_cost ?? usage.cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  return {
    promptTokens: Number.isFinite(prompt) ? Math.max(0, prompt) : 0,
    completionTokens: Number.isFinite(completion) ? Math.max(0, completion) : 0,
    costUsd,
    found: true,
  };
}

export function usageFromSse(text: string): ReturnType<typeof usageFromPayload> {
  let last = { promptTokens: 0, completionTokens: 0, costUsd: null as number | null, found: false };
  for (const block of text.split(/\n\n/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = usageFromPayload(JSON.parse(data));
      if (parsed.found) last = parsed;
    } catch {
      /* keep scanning */
    }
  }
  return last;
}

function withUsageOnStream(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const rec = body as Record<string, unknown>;
  if (rec.stream !== true) return body;
  const existing = rec.stream_options && typeof rec.stream_options === "object" && !Array.isArray(rec.stream_options)
    ? (rec.stream_options as Record<string, unknown>)
    : {};
  return { ...rec, stream_options: { ...existing, include_usage: true } };
}

function modelFromBody(body: unknown): string {
  if (body && typeof body === "object" && !Array.isArray(body) && typeof (body as { model?: unknown }).model === "string") {
    return (body as { model: string }).model.slice(0, 200);
  }
  return "";
}

function upstreamHeaders(req: IncomingMessage, upstreamKey: string, settings: ReturnType<typeof billingSettings>): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${upstreamKey}`,
    "content-type": "application/json",
    accept: typeof req.headers.accept === "string" ? req.headers.accept : "application/json",
    "http-referer": typeof req.headers["http-referer"] === "string" ? req.headers["http-referer"] : settings.referer,
    "x-title": typeof req.headers["x-title"] === "string" ? req.headers["x-title"] : settings.title,
  };
  return headers;
}

async function meterFromUsage(
  keyId: string,
  model: string,
  usage: ReturnType<typeof usageFromPayload>,
  dir?: string,
): Promise<void> {
  await recordLlmUsageLocked({
    keyId,
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    upstreamCostUsd: usage.costUsd,
    usageAvailable: usage.found,
  }, dir);
}

export async function handleLlmGateway(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { port: number; path: string; method: string; fetchImpl?: FetchLike; dir?: string },
): Promise<void> {
  const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
  if (!hostAllowed(host, opts.port)) {
    writeJson(res, 403, openaiError(403, "refused host").body);
    return;
  }

  const allowed =
    (opts.method === "GET" && opts.path === "/v1/models") ||
    (opts.method === "POST" && (opts.path === "/v1/chat/completions" || opts.path === "/v1/completions"));
  if (!allowed) {
    writeJson(res, 404, openaiError(404, `no route: ${opts.method} ${opts.path}`).body);
    return;
  }

  const secret = bearerFrom(req);
  const key = lookupOfficeKey(secret, opts.dir);
  if (!key) {
    writeJson(res, 401, openaiError(401, "invalid RealBud office key", "invalid_request_error", "invalid_api_key").body);
    return;
  }
  if (!officeHasCredit(opts.dir)) {
    writeJson(res, 402, openaiError(402, "Insufficient RealBud credits. Top up on You → Model spend.", "insufficient_quota", "insufficient_quota").body);
    return;
  }

  const settings = billingSettings();
  const upstreamKey = process.env.REALBUD_OPENROUTER_API_KEY?.trim() ?? "";
  if (!settings.upstreamConfigured || !upstreamKey) {
    writeJson(
      res,
      503,
      openaiError(503, "Managed model path is not configured. Set REALBUD_OPENROUTER_API_KEY on the RealBud server.", "server_error", "upstream_unconfigured").body,
    );
    return;
  }

  let body: unknown = {};
  if (opts.method === "POST") {
    try {
      body = withUsageOnStream(await readJsonBody(req));
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400;
      writeJson(res, status, openaiError(status, error instanceof Error ? error.message : String(error)).body);
      return;
    }
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const target = `${settings.upstreamBaseUrl}${opts.path.slice("/v1".length)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  req.on("close", () => controller.abort());

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: opts.method,
      headers: upstreamHeaders(req, upstreamKey, settings),
      body: opts.method === "POST" ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted;
    writeJson(
      res,
      aborted ? 504 : 502,
      openaiError(aborted ? 504 : 502, aborted ? "upstream model timed out" : error instanceof Error ? error.message : "upstream model did not answer", "server_error").body,
    );
    return;
  }
  clearTimeout(timer);

  const contentType = upstream.headers.get("content-type") ?? "application/json";
  const model = modelFromBody(body);
  if (contentType.includes("text/event-stream") && upstream.body) {
    res.writeHead(upstream.status, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(value);
          text += decoder.decode(value, { stream: true });
        }
      }
    } catch {
      /* client or upstream dropped; still meter what we saw */
    }
    res.end();
    if (upstream.ok) {
      try {
        await meterFromUsage(key.id, model, usageFromSse(text), opts.dir);
      } catch {
        /* ledger miss must not crash the already-finished stream */
      }
    }
    return;
  }

  const raw = await upstream.text();
  let parsed: unknown = raw;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { error: { message: raw.slice(0, 300) || "upstream returned a non-JSON body" } };
  }
  writeJson(res, upstream.status, parsed);
  if (upstream.ok) {
    try {
      await meterFromUsage(key.id, model, usageFromPayload(parsed), opts.dir);
    } catch {
      /* keep the model answer even if the ledger write misses */
    }
  }
}
