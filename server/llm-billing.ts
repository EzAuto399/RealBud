// Office model-spend book: hashed RealBud keys, credit balance, usage ledger.
// One desk is one wallet. Hermes holds a RealBud-issued key and talks to
// the local OpenAI-compatible gateway — not a raw OpenRouter secret.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { formatUsd, MICRO_PER_USD, microToUsd, usdToMicro } from "../shared/billing-money.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

const FILE = "billing.json";
const KEY_PREFIX = "rbk_live_";
const LEDGER_CAP = 500;
const MAX_ACTIVE_KEYS = 20;
const DEFAULT_MARKUP = 1.25;
const DEFAULT_INPUT_PER_M = 3;
const DEFAULT_OUTPUT_PER_M = 15;

export type LedgerKind = "llm" | "topup";

export interface BillingKey {
  id: string;
  label: string;
  hash: string;
  prefix: string;
  hint: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface LedgerRow {
  id: string;
  at: number;
  kind: LedgerKind;
  keyId: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  upstreamMicroUsd: number;
  billedMicroUsd: number;
  usageAvailable: boolean;
  stripeSessionId?: string;
}

export interface BillingState {
  version: 1;
  balanceMicroUsd: number;
  keys: BillingKey[];
  ledger: LedgerRow[];
}

export interface BillingSettings {
  markup: number;
  upstreamBaseUrl: string;
  upstreamConfigured: boolean;
  mockTopup: boolean;
  stripeConfigured: boolean;
  stripeWebhookConfigured: boolean;
  fallbackInputUsdPerMillion: number;
  fallbackOutputUsdPerMillion: number;
  referer: string;
  title: string;
}

export interface BillingPublicView {
  keys: Array<{
    id: string;
    label: string;
    hint: string;
    createdAt: number;
    revokedAt: number | null;
    lastUsedAt: number | null;
    active: boolean;
  }>;
  usage: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    billedUsd: number;
    billedLabel: string;
    usageMissingCalls: number;
  };
  balanceUsd: number;
  balanceLabel: string;
  remainingUsd: number;
  remainingLabel: string;
  markup: number;
  upstreamConfigured: boolean;
  payments: {
    stripeConfigured: boolean;
    mockEnabled: boolean;
    currency: "USD";
    todo: string | null;
  };
  gateway: {
    baseUrl: string;
    provider: "openrouter";
    envVar: "OPENROUTER_API_KEY";
    defaultModel: string;
  };
  hermes: {
    steps: string[];
  };
  recent: Array<{
    id: string;
    at: number;
    kind: LedgerKind;
    model: string;
    promptTokens: number;
    completionTokens: number;
    billedUsd: number;
    billedLabel: string;
    usageAvailable: boolean;
  }>;
}

export interface IssuedKey {
  id: string;
  key: string;
  hint: string;
  label: string;
}

export interface LlmUsageInput {
  keyId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Upstream USD when the provider reports it; otherwise we estimate. */
  upstreamCostUsd?: number | null;
  usageAvailable: boolean;
}

type BillingJob<T> = () => T | Promise<T>;

let chain: Promise<void> = Promise.resolve();

function withLock<T>(job: BillingJob<T>): Promise<T> {
  let settle: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const run = chain.then(job, job);
  chain = gate;
  return Promise.resolve(run).finally(settle);
}

function billingPath(dir?: string): string {
  return join(dir ?? DATA_DIR, FILE);
}

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

export function billingSettings(): BillingSettings {
  const key = process.env.REALBUD_OPENROUTER_API_KEY?.trim() ?? "";
  const stripe = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  const webhook = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  const base = (process.env.REALBUD_OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  return {
    markup: envNumber("REALBUD_BILLING_MARKUP", DEFAULT_MARKUP, 1, 20),
    upstreamBaseUrl: base,
    upstreamConfigured: key.length > 8,
    mockTopup: process.env.REALBUD_BILLING_MOCK === "1",
    stripeConfigured: stripe.startsWith("sk_"),
    stripeWebhookConfigured: webhook.startsWith("whsec_"),
    fallbackInputUsdPerMillion: envNumber("REALBUD_BILLING_INPUT_USD_PER_1M", DEFAULT_INPUT_PER_M, 0, 1_000),
    fallbackOutputUsdPerMillion: envNumber("REALBUD_BILLING_OUTPUT_USD_PER_1M", DEFAULT_OUTPUT_PER_M, 0, 2_000),
    referer: process.env.REALBUD_OPENROUTER_HTTP_REFERER?.trim() || "https://realbud.app",
    title: process.env.REALBUD_OPENROUTER_TITLE?.trim() || "RealBud",
  };
}

export function gatewayBaseUrl(port: number): string {
  const fromEnv = process.env.REALBUD_LLM_GATEWAY_PUBLIC_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return `http://127.0.0.1:${port}/v1`;
}

export function defaultBilledModel(): string {
  return "anthropic/claude-sonnet-5";
}

export function hermesConnectSteps(baseUrl: string): string[] {
  return [
    "Create an office key on You → Model spend, or press Connect Bud to write it for you.",
    "Hermes provider stays OpenRouter. Do not paste a raw OpenRouter key.",
    `Set the model base URL to ${baseUrl}.`,
    "Paste the RealBud office key (rbk_live_…) as the API key.",
  ];
}

function emptyState(): BillingState {
  return { version: 1, balanceMicroUsd: 0, keys: [], ledger: [] };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asInt(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function decodeKey(value: unknown): BillingKey | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || typeof row.hash !== "string" || typeof row.hint !== "string") return null;
  if (!/^[a-z0-9_-]{6,64}$/i.test(row.id) || !/^[a-f0-9]{64}$/i.test(row.hash)) return null;
  return {
    id: row.id,
    label: typeof row.label === "string" && row.label.trim() ? row.label.trim().slice(0, 64) : "Office key",
    hash: row.hash.toLowerCase(),
    prefix: typeof row.prefix === "string" ? row.prefix.slice(0, 16) : row.hint.slice(0, 12),
    hint: row.hint.slice(0, 48),
    createdAt: asInt(row.createdAt, Date.now()),
    revokedAt: row.revokedAt == null ? null : asInt(row.revokedAt),
    lastUsedAt: row.lastUsedAt == null ? null : asInt(row.lastUsedAt),
  };
}

function decodeLedger(value: unknown): LedgerRow | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string") return null;
  const kind = row.kind === "topup" ? "topup" : row.kind === "llm" ? "llm" : null;
  if (!kind) return null;
  return {
    id: row.id,
    at: asInt(row.at, Date.now()),
    kind,
    keyId: typeof row.keyId === "string" ? row.keyId : null,
    model: typeof row.model === "string" ? row.model.slice(0, 200) : "",
    promptTokens: Math.max(0, asInt(row.promptTokens)),
    completionTokens: Math.max(0, asInt(row.completionTokens)),
    upstreamMicroUsd: asInt(row.upstreamMicroUsd),
    billedMicroUsd: asInt(row.billedMicroUsd),
    usageAvailable: row.usageAvailable !== false,
    stripeSessionId: typeof row.stripeSessionId === "string" ? row.stripeSessionId : undefined,
  };
}

export function loadBilling(dir?: string): BillingState {
  const path = billingPath(dir);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const rec = asRecord(raw);
    if (!rec) return emptyState();
    return {
      version: 1,
      balanceMicroUsd: asInt(rec.balanceMicroUsd),
      keys: Array.isArray(rec.keys) ? rec.keys.map(decodeKey).filter((row): row is BillingKey => Boolean(row)) : [],
      ledger: Array.isArray(rec.ledger) ? rec.ledger.map(decodeLedger).filter((row): row is LedgerRow => Boolean(row)) : [],
    };
  } catch {
    return emptyState();
  }
}

function persist(state: BillingState, dir?: string): void {
  const folder = dir ?? DATA_DIR;
  mkdirSync(folder, { recursive: true });
  const path = billingPath(dir);
  writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems that ignore mode */
  }
}

export function hashOfficeKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, "hex");
    const b = Buffer.from(right, "hex");
    return a.length === 32 && a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function validateLabel(value: unknown): string {
  const label = String(value ?? "").trim().slice(0, 64);
  if (/[\r\n\0]/.test(label)) {
    throw Object.assign(new Error("label cannot contain line breaks"), { status: 400 });
  }
  return label || "Office key";
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function publicBillingView(dir?: string, port = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799)): BillingPublicView {
  const state = loadBilling(dir);
  const settings = billingSettings();
  const baseUrl = gatewayBaseUrl(port);
  const llm = state.ledger.filter((row) => row.kind === "llm");
  const billedMicro = llm.reduce((sum, row) => sum + row.billedMicroUsd, 0);
  const paymentsTodo =
    settings.stripeConfigured || settings.mockTopup
      ? null
      : "Set STRIPE_SECRET_KEY to take card payments, or REALBUD_BILLING_MOCK=1 for a local practice top-up.";
  return {
    keys: state.keys.map((key) => ({
      id: key.id,
      label: key.label,
      hint: key.hint,
      createdAt: key.createdAt,
      revokedAt: key.revokedAt,
      lastUsedAt: key.lastUsedAt,
      active: key.revokedAt == null,
    })),
    usage: {
      calls: llm.length,
      promptTokens: llm.reduce((sum, row) => sum + row.promptTokens, 0),
      completionTokens: llm.reduce((sum, row) => sum + row.completionTokens, 0),
      billedUsd: microToUsd(billedMicro),
      billedLabel: formatUsd(billedMicro),
      usageMissingCalls: llm.filter((row) => !row.usageAvailable).length,
    },
    balanceUsd: microToUsd(state.balanceMicroUsd),
    balanceLabel: formatUsd(state.balanceMicroUsd),
    remainingUsd: microToUsd(state.balanceMicroUsd),
    remainingLabel: formatUsd(state.balanceMicroUsd),
    markup: settings.markup,
    upstreamConfigured: settings.upstreamConfigured,
    payments: {
      stripeConfigured: settings.stripeConfigured,
      mockEnabled: settings.mockTopup,
      currency: "USD",
      todo: paymentsTodo,
    },
    gateway: {
      baseUrl,
      provider: "openrouter",
      envVar: "OPENROUTER_API_KEY",
      defaultModel: defaultBilledModel(),
    },
    hermes: { steps: hermesConnectSteps(baseUrl) },
    recent: state.ledger
      .slice(-20)
      .reverse()
      .map((row) => ({
        id: row.id,
        at: row.at,
        kind: row.kind,
        model: row.model,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        billedUsd: microToUsd(row.billedMicroUsd),
        billedLabel: formatUsd(row.billedMicroUsd),
        usageAvailable: row.usageAvailable,
      })),
  };
}

export function issueOfficeKey(label: unknown, dir?: string): IssuedKey {
  const state = loadBilling(dir);
  const active = state.keys.filter((key) => key.revokedAt == null).length;
  if (active >= MAX_ACTIVE_KEYS) {
    throw Object.assign(new Error("this office already has the maximum number of keys"), { status: 400 });
  }
  const secret = `${KEY_PREFIX}${randomBytes(24).toString("hex")}`;
  const row: BillingKey = {
    id: newId("key"),
    label: validateLabel(label),
    hash: hashOfficeKey(secret),
    prefix: secret.slice(0, 12),
    hint: `${secret.slice(0, 12)}…${secret.slice(-4)}`,
    createdAt: Date.now(),
    revokedAt: null,
    lastUsedAt: null,
  };
  state.keys.push(row);
  persist(state, dir);
  return { id: row.id, key: secret, hint: row.hint, label: row.label };
}

export function revokeOfficeKey(id: string, dir?: string): boolean {
  const state = loadBilling(dir);
  const row = state.keys.find((key) => key.id === id);
  if (!row) return false;
  if (row.revokedAt == null) {
    row.revokedAt = Date.now();
    persist(state, dir);
  }
  return true;
}

export function lookupOfficeKey(secret: string, dir?: string): BillingKey | null {
  const token = String(secret ?? "").trim();
  if (!token.startsWith(KEY_PREFIX) || token.length < 20) return null;
  const digest = hashOfficeKey(token);
  const state = loadBilling(dir);
  for (const key of state.keys) {
    if (key.revokedAt != null) continue;
    if (hashesEqual(key.hash, digest)) return key;
  }
  return null;
}

export function estimateUpstreamMicroUsd(input: {
  promptTokens: number;
  completionTokens: number;
  upstreamCostUsd?: number | null;
}): { micro: number; usageAvailable: boolean } {
  const settings = billingSettings();
  const reported = input.upstreamCostUsd;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
    return { micro: usdToMicro(reported), usageAvailable: true };
  }
  const tokens = Math.max(0, input.promptTokens) + Math.max(0, input.completionTokens);
  if (tokens <= 0) return { micro: 0, usageAvailable: false };
  const usd =
    (Math.max(0, input.promptTokens) / 1_000_000) * settings.fallbackInputUsdPerMillion +
    (Math.max(0, input.completionTokens) / 1_000_000) * settings.fallbackOutputUsdPerMillion;
  return { micro: Math.max(0, usdToMicro(usd)), usageAvailable: true };
}

export function applyMarkup(upstreamMicroUsd: number, markup = billingSettings().markup): number {
  if (!Number.isFinite(upstreamMicroUsd) || upstreamMicroUsd <= 0) return 0;
  return Math.max(0, Math.round(upstreamMicroUsd * markup));
}

export function recordLlmUsage(input: LlmUsageInput, dir?: string): LedgerRow {
  const state = loadBilling(dir);
  const key = state.keys.find((row) => row.id === input.keyId);
  if (!key || key.revokedAt != null) {
    throw Object.assign(new Error("office key is not active"), { status: 401 });
  }
  const estimate = estimateUpstreamMicroUsd({
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    upstreamCostUsd: input.upstreamCostUsd,
  });
  const usageAvailable = input.usageAvailable && estimate.usageAvailable;
  const billed = applyMarkup(estimate.micro);
  const row: LedgerRow = {
    id: newId("use"),
    at: Date.now(),
    kind: "llm",
    keyId: key.id,
    model: String(input.model || "").slice(0, 200),
    promptTokens: Math.max(0, Math.trunc(input.promptTokens)),
    completionTokens: Math.max(0, Math.trunc(input.completionTokens)),
    upstreamMicroUsd: estimate.micro,
    billedMicroUsd: billed,
    usageAvailable,
  };
  key.lastUsedAt = row.at;
  state.balanceMicroUsd -= billed;
  state.ledger.push(row);
  if (state.ledger.length > LEDGER_CAP) state.ledger.splice(0, state.ledger.length - LEDGER_CAP);
  persist(state, dir);
  return row;
}

export function creditBalance(input: { usd: number; stripeSessionId?: string; label?: string }, dir?: string): LedgerRow {
  const usd = Number(input.usd);
  if (!Number.isFinite(usd) || usd < 1 || usd > 500) {
    throw Object.assign(new Error("top-up must be between US$1 and US$500"), { status: 400 });
  }
  const state = loadBilling(dir);
  if (input.stripeSessionId && state.ledger.some((row) => row.stripeSessionId === input.stripeSessionId)) {
    const existing = state.ledger.find((row) => row.stripeSessionId === input.stripeSessionId);
    if (existing) return existing;
  }
  const micro = usdToMicro(usd);
  const row: LedgerRow = {
    id: newId("top"),
    at: Date.now(),
    kind: "topup",
    keyId: null,
    model: input.label ?? "top-up",
    promptTokens: 0,
    completionTokens: 0,
    upstreamMicroUsd: 0,
    billedMicroUsd: micro,
    usageAvailable: true,
    stripeSessionId: input.stripeSessionId,
  };
  state.balanceMicroUsd += micro;
  state.ledger.push(row);
  if (state.ledger.length > LEDGER_CAP) state.ledger.splice(0, state.ledger.length - LEDGER_CAP);
  persist(state, dir);
  return row;
}

export function officeHasCredit(dir?: string): boolean {
  return loadBilling(dir).balanceMicroUsd > 0;
}

export function billedHermesAttachInput(opts: { apiKey: string; model?: string; baseUrl: string }): {
  providerId: "openrouter";
  apiKey: string;
  model: string;
  baseUrl: string;
} {
  const model = String(opts.model ?? "").trim() || defaultBilledModel();
  return {
    providerId: "openrouter",
    apiKey: opts.apiKey,
    model,
    baseUrl: opts.baseUrl,
  };
}

export async function issueOfficeKeyLocked(label: unknown, dir?: string): Promise<IssuedKey> {
  return withLock(() => issueOfficeKey(label, dir));
}

export async function revokeOfficeKeyLocked(id: string, dir?: string): Promise<boolean> {
  return withLock(() => revokeOfficeKey(id, dir));
}

export async function recordLlmUsageLocked(input: LlmUsageInput, dir?: string): Promise<LedgerRow> {
  return withLock(() => recordLlmUsage(input, dir));
}

export async function creditBalanceLocked(
  input: { usd: number; stripeSessionId?: string; label?: string },
  dir?: string,
): Promise<LedgerRow> {
  return withLock(() => creditBalance(input, dir));
}

export function revokeHermesLabeledKeys(dir?: string): void {
  const state = loadBilling(dir);
  let changed = false;
  for (const key of state.keys) {
    if (key.revokedAt == null && /^hermes$/i.test(key.label)) {
      key.revokedAt = Date.now();
      changed = true;
    }
  }
  if (changed) persist(state, dir);
}

export function verifyStripeSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!rawBody || !signatureHeader || !secret.startsWith("whsec_")) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const idx = part.indexOf("=");
      return [part.slice(0, idx).trim(), part.slice(idx + 1).trim()];
    }),
  );
  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) return false;
  const ageMs = Math.abs(Date.now() - Number(timestamp) * 1000);
  if (!Number.isFinite(Number(timestamp)) || ageMs > 5 * 60_000) return false;
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  try {
    const a = Buffer.from(digest, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function stripeSuccessUrl(): string {
  return process.env.REALBUD_BILLING_SUCCESS_URL?.trim() || "http://127.0.0.1:5199/?billing_session={CHECKOUT_SESSION_ID}#you-billing";
}

export function stripeCancelUrl(): string {
  return process.env.REALBUD_BILLING_CANCEL_URL?.trim() || "http://127.0.0.1:5199/#you-billing";
}

export async function createStripeCheckoutSession(
  amountUsd: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; sessionId: string }> {
  const secret = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!secret.startsWith("sk_")) {
    throw Object.assign(new Error("Stripe is not configured"), { status: 501, code: "stripe_unconfigured" });
  }
  const usd = Number(amountUsd);
  if (!Number.isFinite(usd) || usd < 1 || usd > 500) {
    throw Object.assign(new Error("top-up must be between US$1 and US$500"), { status: 400 });
  }
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", stripeSuccessUrl());
  params.set("cancel_url", stripeCancelUrl());
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][unit_amount]", String(Math.round(usd * 100)));
  params.set("line_items[0][price_data][product_data][name]", "RealBud model credits");
  params.set("metadata[kind]", "realbud_credits");
  params.set("metadata[amountUsd]", String(usd));
  const res = await fetchImpl("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || typeof body.id !== "string" || typeof body.url !== "string") {
    throw Object.assign(new Error(body.error?.message || "Stripe Checkout could not start"), { status: 502 });
  }
  return { url: body.url, sessionId: body.id };
}

export async function confirmStripeCheckoutSession(
  sessionId: string,
  dir?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LedgerRow> {
  const secret = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!secret.startsWith("sk_")) {
    throw Object.assign(new Error("Stripe is not configured"), { status: 501, code: "stripe_unconfigured" });
  }
  const id = String(sessionId ?? "").trim();
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) {
    throw Object.assign(new Error("checkout session id is not valid"), { status: 400 });
  }
  const existing = loadBilling(dir).ledger.find((row) => row.stripeSessionId === id);
  if (existing) return existing;
  const res = await fetchImpl(`https://api.stripe.com/v1/checkout/sessions/${id}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    payment_status?: string;
    status?: string;
    amount_total?: number;
    currency?: string;
    metadata?: { amountUsd?: string; kind?: string };
    error?: { message?: string };
  };
  if (!res.ok) {
    throw Object.assign(new Error(body.error?.message || "Stripe could not confirm that payment"), { status: 502 });
  }
  if (body.payment_status !== "paid" && body.status !== "complete") {
    throw Object.assign(new Error("that checkout is not paid yet"), { status: 409 });
  }
  const fromMeta = Number(body.metadata?.amountUsd);
  const fromAmount = typeof body.amount_total === "number" ? body.amount_total / 100 : NaN;
  const usd = Number.isFinite(fromMeta) && fromMeta >= 1 ? fromMeta : fromAmount;
  return creditBalanceLocked({ usd, stripeSessionId: id, label: "stripe" }, dir);
}

export { MICRO_PER_USD, formatUsd, microToUsd, usdToMicro };
