// Standing rules: a saved allow/deny for one approval key.
// Guards from auto-approve always win — a rule can never widen into
// destructive or sensitive work.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { approvalKey, looksDestructive, looksSensitive } from "./auto-approve.ts";
import { DATA_DIR } from "./config.ts";

export interface BudRule {
  id: string;
  key: string;
  decision: "allow" | "deny";
  label: string;
  createdAt: number;
}

function rulesPath(): string {
  return join(DATA_DIR, "rules.json");
}

function isDecision(value: unknown): value is BudRule["decision"] {
  return value === "allow" || value === "deny";
}

function asRule(value: unknown): BudRule | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  if (typeof row.key !== "string" || !row.key.trim()) return null;
  if (!isDecision(row.decision)) return null;
  if (typeof row.label !== "string") return null;
  if (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)) return null;
  return {
    id: row.id,
    key: row.key,
    decision: row.decision,
    label: row.label,
    createdAt: row.createdAt,
  };
}

function persist(rules: BudRule[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(rulesPath(), `${JSON.stringify({ rules }, null, 2)}\n`, 0o600);
}

export function loadRules(): BudRule[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(rulesPath(), "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { rules?: unknown }).rules)
        ? (parsed as { rules: unknown[] }).rules
        : null;
    if (!list) return [];
    const out: BudRule[] = [];
    for (const row of list) {
      const rule = asRule(row);
      if (rule) out.push(rule);
    }
    return out;
  } catch {
    return [];
  }
}

export function ruleLabel(key: string): string {
  const colon = key.indexOf(":");
  if (colon !== -1) {
    const program = key.slice(colon + 1);
    if (program) return `Run ${program} commands`;
  }
  if (key === "Read") return "Read workroom files";
  if (key === "Write" || key === "Edit") return "Change workroom files";
  return `Allow ${key}`;
}

export function addRule(key: string, decision: BudRule["decision"], label?: string): BudRule[] {
  const next: BudRule[] = loadRules().filter((rule) => rule.key !== key);
  const trimmed = label?.trim();
  next.push({
    id: randomUUID(),
    key,
    decision,
    label: trimmed || ruleLabel(key),
    createdAt: Date.now(),
  });
  persist(next);
  return next;
}

export function removeRule(id: string): BudRule[] {
  const rules = loadRules();
  const next = rules.filter((rule) => rule.id !== id);
  if (next.length === rules.length) throw Object.assign(new Error("no such rule"), { status: 404 });
  persist(next);
  return next;
}

export function evaluateRules(rules: BudRule[], tool: string, summary: string): "allow" | "deny" | null {
  if (looksDestructive(tool) || looksDestructive(summary) || looksSensitive(summary)) return null;
  const key = approvalKey(tool, summary);
  return rules.find((rule) => rule.key === key)?.decision ?? null;
}
