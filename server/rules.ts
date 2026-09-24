// Standing rules: a saved allow/deny for one approval key.
// Guards from auto-approve always win — a rule can never widen into
// destructive or sensitive work. Portal rules are allow-only and
// scoped to one origin + surface (read or prefill). Never submit.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { approvalKey, looksDestructive, looksSensitive } from "./auto-approve.ts";
import { DATA_DIR } from "./config.ts";
import { reservedApprovalKey } from '../shared/approval-policy.ts';

export type PortalRuleSurface = "portal-read" | "portal-prefill";

export interface BudRule {
  id: string;
  key: string;
  decision: "allow" | "deny";
  label: string;
  createdAt: number;
  surface?: PortalRuleSurface;
  origin?: string;
}

export const PORTAL_RULE_SURFACES: readonly PortalRuleSurface[] = ["portal-read", "portal-prefill"];

function rulesPath(): string {
  return join(DATA_DIR, "rules.json");
}

function isDecision(value: unknown): value is BudRule["decision"] {
  return value === "allow" || value === "deny";
}

export function isPortalRuleSurface(value: unknown): value is PortalRuleSurface {
  return value === "portal-read" || value === "portal-prefill";
}

export function portalRuleKey(surface: PortalRuleSurface, origin: string): string {
  return surface === "portal-read" ? `portal:read:${origin}` : `portal:prefill:${origin}`;
}

export function portalRuleLabel(surface: PortalRuleSurface, origin: string): string {
  return surface === "portal-read" ? `Reading on ${origin}` : `Prefill on ${origin}`;
}

export function parsePortalRuleKey(key: string): { surface: PortalRuleSurface; origin: string } | null {
  if (key.startsWith("portal:read:")) {
    const origin = key.slice("portal:read:".length).trim().toLowerCase();
    return origin ? { surface: "portal-read", origin } : null;
  }
  if (key.startsWith("portal:prefill:")) {
    const origin = key.slice("portal:prefill:".length).trim().toLowerCase();
    return origin ? { surface: "portal-prefill", origin } : null;
  }
  return null;
}

function asRule(value: unknown): BudRule | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  if (typeof row.key !== "string" || !row.key.trim()) return null;
  if (!isDecision(row.decision)) return null;
  if (typeof row.label !== "string") return null;
  if (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)) return null;
  const parsed = parsePortalRuleKey(row.key);
  const surface = isPortalRuleSurface(row.surface) ? row.surface : parsed?.surface;
  const origin =
    typeof row.origin === "string" && row.origin.trim()
      ? row.origin.trim().toLowerCase()
      : parsed?.origin;
  return {
    id: row.id,
    key: row.key,
    decision: row.decision,
    label: row.label,
    createdAt: row.createdAt,
    ...(surface ? { surface } : {}),
    ...(origin ? { origin } : {}),
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
  const portal = parsePortalRuleKey(key);
  if (portal) return portalRuleLabel(portal.surface, portal.origin);
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
  if (reservedApprovalKey(key)) throw Object.assign(new Error('Memory changes require a separate review each time and cannot use saved rules.'), { status: 400 });
  const portal = parsePortalRuleKey(key);
  if (portal) {
    if (decision !== "allow") {
      throw Object.assign(new Error("Portal rules can only allow."), { status: 400 });
    }
    return addPortalRule(portal.surface, portal.origin);
  }
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

export function addPortalRule(surface: PortalRuleSurface, origin: string): BudRule[] {
  const key = portalRuleKey(surface, origin);
  const next: BudRule[] = loadRules().filter((rule) => rule.key !== key);
  next.push({
    id: randomUUID(),
    key,
    decision: "allow",
    label: portalRuleLabel(surface, origin),
    createdAt: Date.now(),
    surface,
    origin,
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
  if (reservedApprovalKey(tool)) return null;
  if (looksDestructive(tool) || looksDestructive(summary) || looksSensitive(summary)) return null;
  const key = approvalKey(tool, summary);
  return rules.find((rule) => rule.key === key)?.decision ?? null;
}
