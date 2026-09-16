import { formatUsd } from "../../shared/billing-money.ts";

export type BillingKeyRow = {
  id: string;
  label: string;
  hint: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  active: boolean;
};

export type BillingRecentRow = {
  id: string;
  at: number;
  kind: "llm" | "topup";
  model: string;
  promptTokens: number;
  completionTokens: number;
  billedUsd: number;
  billedLabel: string;
  usageAvailable: boolean;
};

export type BillingView = {
  keys: BillingKeyRow[];
  usage: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    billedUsd: number;
    billedLabel: string;
    usageMissingCalls: number;
  };
  balanceLabel: string;
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
  hermes: { steps: string[] };
  recent: BillingRecentRow[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function readBillingView(body: unknown): BillingView | null {
  if (!isRecord(body) || !isRecord(body.usage) || !isRecord(body.payments) || !isRecord(body.gateway)) return null;
  const keys = Array.isArray(body.keys)
    ? body.keys.flatMap((row): BillingKeyRow[] => {
        if (!isRecord(row) || typeof row.id !== "string" || typeof row.hint !== "string") return [];
        return [{
          id: row.id,
          label: text(row.label, "Office key"),
          hint: row.hint,
          createdAt: num(row.createdAt),
          revokedAt: row.revokedAt == null ? null : num(row.revokedAt),
          lastUsedAt: row.lastUsedAt == null ? null : num(row.lastUsedAt),
          active: row.active !== false && row.revokedAt == null,
        }];
      })
    : [];
  const recent = Array.isArray(body.recent)
    ? body.recent.flatMap((row): BillingRecentRow[] => {
        if (!isRecord(row) || typeof row.id !== "string") return [];
        const kind = row.kind === "topup" ? "topup" : row.kind === "llm" ? "llm" : null;
        if (!kind) return [];
        return [{
          id: row.id,
          at: num(row.at),
          kind,
          model: text(row.model),
          promptTokens: num(row.promptTokens),
          completionTokens: num(row.completionTokens),
          billedUsd: num(row.billedUsd),
          billedLabel: text(row.billedLabel, formatUsd(Math.round(num(row.billedUsd) * 1_000_000))),
          usageAvailable: row.usageAvailable !== false,
        }];
      })
    : [];
  const hermes = isRecord(body.hermes) && Array.isArray(body.hermes.steps)
    ? { steps: body.hermes.steps.filter((step): step is string => typeof step === "string") }
    : { steps: [] };
  return {
    keys,
    usage: {
      calls: num(body.usage.calls),
      promptTokens: num(body.usage.promptTokens),
      completionTokens: num(body.usage.completionTokens),
      billedUsd: num(body.usage.billedUsd),
      billedLabel: text(body.usage.billedLabel, "US$0.00"),
      usageMissingCalls: num(body.usage.usageMissingCalls),
    },
    balanceLabel: text(body.balanceLabel, "US$0.00"),
    remainingLabel: text(body.remainingLabel, text(body.balanceLabel, "US$0.00")),
    markup: num(body.markup, 1.25),
    upstreamConfigured: body.upstreamConfigured === true,
    payments: {
      stripeConfigured: body.payments.stripeConfigured === true,
      mockEnabled: body.payments.mockEnabled === true,
      currency: "USD",
      todo: typeof body.payments.todo === "string" ? body.payments.todo : null,
    },
    gateway: {
      baseUrl: text(body.gateway.baseUrl),
      provider: "openrouter",
      envVar: "OPENROUTER_API_KEY",
      defaultModel: text(body.gateway.defaultModel, "anthropic/claude-sonnet-5"),
    },
    hermes,
    recent,
  };
}

export { formatUsd };
