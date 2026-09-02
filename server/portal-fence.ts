// Portal fence: deny out-of-job browser actions before any approval card.
import { ALLOWED_TOOLS, FORBIDDEN_TOOLS } from "./cua-bounded.ts";
import type { JobCapability } from "../shared/contracts.ts";
import { portalRuleKey, portalRuleLabel, type PortalRuleSurface } from "./rules.ts";

export type PortalFenceSurface = "portal-read" | "portal-prefill" | "portal-submit";

export interface FenceContext {
  allowedOrigins: string[];
  capabilities: JobCapability[];
  rules?: Array<{ key: string; decision: "allow" | "deny" }>;
}

export type FenceDecision = {
  kind: "deny" | "ask" | "allow";
  reason?: string;
  surface?: PortalFenceSurface;
  origin?: string;
};

export interface FenceRequest {
  tool: string;
  params?: unknown;
  summary?: string;
}

export interface FencePayload {
  surface: PortalFenceSurface;
  origin: string;
  ruleOffer: { surface: PortalRuleSurface; origin: string; label: string } | null;
}

const ALLOWED = new Set<string>(ALLOWED_TOOLS);
const COMPUTER = new Set<string>([...ALLOWED_TOOLS, ...FORBIDDEN_TOOLS, "shell"]);
const PASSWORD_RE = /password|passcode|otp|one-time|verification code|mfa|2fa/i;
const MONEY_RE =
  /\b(pay|payment|transfer|remit|bpay|direct debit|authori[sz]e|approve payment|sign|send|delete|remove|notice|terminate|evict)\b/i;
const SUBMIT_ACTION_RE = /\b(submit|save|continue|next|confirm|lodge|create|update)\b/i;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const HOST_RE = /(?:^|[\s"'=:])(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#\s"'<>]|$)/gi;

const UNCONFIRMABLE = "Bud could not confirm which site or control this touches.";
export const SUBMIT_STAYS_WITH_YOU = "Submit, Pay and Send stay with you.";
export const SUBMIT_JOB_DENY = "This job cannot press Submit. Add 'Bud may press Submit' on the job if it should.";

export function normalizeToolName(tool: string): string {
  let name = tool.trim().toLowerCase();
  name = name.replace(/^mcp__[^_]+__/, "");
  name = name.replace(/^(?:computer|browser)[_./:-]+/, "");
  const slash = name.lastIndexOf("/");
  if (slash !== -1) name = name.slice(slash + 1);
  return name;
}

export function isComputerTool(tool: string, summary?: string): boolean {
  const name = normalizeToolName(tool);
  if (COMPUTER.has(name) || ALLOWED.has(name)) return true;
  return /computer|browser|navigate|click_semantic|click_xy|screenshot|fill/i.test(
    `${tool} ${summary ?? ""}`,
  );
}

function collectText(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) into.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectText(item, into);
  }
}

function parseableParams(params: unknown): boolean {
  return params == null || typeof params === "string" || typeof params === "object";
}

function hostsFromText(text: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  const add = (host: string) => {
    const clean = host.trim().toLowerCase().replace(/^www\./, "");
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    hosts.push(clean);
  };
  for (const match of text.matchAll(URL_RE)) {
    try {
      add(new URL(match[0]!).hostname);
    } catch {
      /* ignore */
    }
  }
  HOST_RE.lastIndex = 0;
  let hostMatch: RegExpExecArray | null;
  while ((hostMatch = HOST_RE.exec(text))) {
    add(hostMatch[1]!);
  }
  return hosts;
}

export function originMatches(host: string, allowed: string[]): boolean {
  return allowed.some((origin) => {
    const base = origin.trim().toLowerCase().replace(/^www\./, "");
    return base.length > 0 && (host === base || host.endsWith(`.${base}`));
  });
}

function jobOriginForHost(host: string, allowed: string[]): string | undefined {
  return allowed.find((origin) => originMatches(host, [origin]));
}

function fieldBlob(params: unknown): string {
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  const row = params as Record<string, unknown>;
  return [row.target, row.selector, row.label, row.type, row.name, row.role, row.text]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
}

function clickBlob(params: unknown): string {
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  const row = params as Record<string, unknown>;
  return [row.label, row.text, row.name, row.title, row.value]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
}

export function clickControlLabel(params?: unknown, summary?: string): string {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const row = params as Record<string, unknown>;
    for (const key of ["label", "text", "name", "title", "value"] as const) {
      const value = row[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  const fallback = typeof summary === "string" ? summary.trim() : "";
  return fallback || "Submit";
}

function actionWords(tool: string): string {
  const name = normalizeToolName(tool);
  if (name === "navigate") return "open a page";
  if (name === "read") return "read the page";
  if (name === "fill") return "fill a field";
  if (name === "click_semantic") return "click a control";
  return "use the browser";
}

function surfaceForTool(tool: string): PortalFenceSurface | undefined {
  if (tool === "read" || tool === "navigate") return "portal-read";
  if (tool === "fill") return "portal-prefill";
  if (tool === "click_semantic") return "portal-read";
  return undefined;
}

function resolveOrigin(ctx: FenceContext, hosts: string[]): string | undefined {
  for (const host of hosts) {
    const match = jobOriginForHost(host, ctx.allowedOrigins);
    if (match) return match;
  }
  if (hosts.length === 0) return ctx.allowedOrigins[0];
  return hosts[0];
}

function ruleAllows(ctx: FenceContext, surface: PortalRuleSurface, origin: string | undefined, hosts: string[]): boolean {
  if (!origin) return false;
  const keys = new Set<string>([portalRuleKey(surface, origin)]);
  for (const host of hosts) {
    keys.add(portalRuleKey(surface, host));
    const parent = jobOriginForHost(host, ctx.allowedOrigins);
    if (parent) keys.add(portalRuleKey(surface, parent));
  }
  return (ctx.rules ?? []).some((rule) => rule.decision === "allow" && keys.has(rule.key));
}

export function fenceDecision(ctx: FenceContext, request: FenceRequest): FenceDecision {
  const tool = normalizeToolName(request.tool);
  if (!ALLOWED.has(tool)) {
    return { kind: "deny", reason: "Bud can only open, read, fill and click on this job's site." };
  }

  if (!parseableParams(request.params) && (tool === "navigate" || tool === "fill" || tool === "click_semantic")) {
    return { kind: "deny", reason: UNCONFIRMABLE, surface: surfaceForTool(tool) };
  }

  const texts: string[] = [];
  collectText(request.params, texts);
  if (typeof request.summary === "string") texts.push(request.summary);
  const blob = texts.join(" ");
  const hosts = hostsFromText(blob);
  for (const host of hosts) {
    if (!originMatches(host, ctx.allowedOrigins)) {
      return {
        kind: "deny",
        reason: "That site is not on this job.",
        surface: surfaceForTool(tool),
        origin: host,
      };
    }
  }

  const origin = resolveOrigin(ctx, hosts);
  const surface = surfaceForTool(tool);

  if (tool === "navigate" || tool === "fill" || tool === "click_semantic") {
    const parsedObject = request.params != null && typeof request.params === "object";
    const parsedString = typeof request.params === "string" && request.params.trim().length > 0;
    const summary = typeof request.summary === "string" ? request.summary.trim() : "";
    if (!parsedObject && !parsedString && !summary) {
      return { kind: "deny", reason: UNCONFIRMABLE, surface, origin };
    }
    if (tool === "navigate" && hosts.length < 1 && !parsedObject && !parsedString) {
      return { kind: "deny", reason: UNCONFIRMABLE, surface, origin };
    }
  }

  if (tool === "fill") {
    const target = `${fieldBlob(request.params)} ${request.summary ?? ""}`;
    if (PASSWORD_RE.test(target)) {
      return { kind: "deny", reason: "You sign in yourself — Bud never types a password.", surface: "portal-prefill", origin };
    }
    if (!ctx.capabilities.includes("portal-prefill")) {
      return {
        kind: "deny",
        reason: "This job is read-only. Add prefill on Schedule if Bud should fill forms.",
        surface: "portal-prefill",
        origin,
      };
    }
    if (ruleAllows(ctx, "portal-prefill", origin, hosts)) {
      return { kind: "allow", surface: "portal-prefill", origin };
    }
    return { kind: "ask", surface: "portal-prefill", origin };
  }

  if (tool === "click_semantic") {
    const label = `${clickBlob(request.params)} ${request.summary ?? ""}`;
    if (MONEY_RE.test(label)) {
      return { kind: "deny", reason: SUBMIT_STAYS_WITH_YOU, surface: "portal-submit", origin };
    }
    if (SUBMIT_ACTION_RE.test(label)) {
      if (!ctx.capabilities.includes("portal-submit")) {
        return { kind: "deny", reason: SUBMIT_JOB_DENY, surface: "portal-submit", origin };
      }
      return { kind: "ask", surface: "portal-submit", origin };
    }
    return { kind: "ask", surface: "portal-read", origin };
  }

  if ((tool === "read" || tool === "navigate") && ruleAllows(ctx, "portal-read", origin, hosts)) {
    return { kind: "allow", surface: "portal-read", origin };
  }

  return { kind: "ask", surface, origin };
}

export function fencePayload(decision: FenceDecision): FencePayload | undefined {
  if (!decision.surface || !decision.origin) return undefined;
  const ruleOffer =
    decision.surface === "portal-read" || decision.surface === "portal-prefill"
      ? {
          surface: decision.surface,
          origin: decision.origin,
          label: portalRuleLabel(decision.surface, decision.origin),
        }
      : null;
  return { surface: decision.surface, origin: decision.origin, ruleOffer };
}

export function submitPressSummary(label: string, origin: string): string {
  return `Bud wants to press '${label}' on ${origin}. Check the form in the browser first.`;
}

export function ruleAllowNote(decision: FenceDecision): string {
  const surface: PortalRuleSurface = decision.surface === "portal-prefill" ? "portal-prefill" : "portal-read";
  const origin = decision.origin ?? "this site";
  return `allowed by rule · ${portalRuleLabel(surface, origin)}`;
}

export function fenceEvidenceLine(request: FenceRequest, decision: FenceDecision): string {
  const action = actionWords(request.tool);
  if (decision.kind === "deny") return decision.reason ?? "Denied.";
  if (decision.kind === "allow") return `Allowed to ${action}.`;
  return `Asked to ${action}.`;
}

const READ_BACK_RE = /observed|read back|shows|shown|found|balance|status|due|paid|outstanding/i;

export function hasReadBack(text: string, allowedOrigins: string[]): boolean {
  const body = text.trim();
  if (!body || !READ_BACK_RE.test(body)) return false;
  const lower = body.toLowerCase();
  return allowedOrigins.some((origin) => {
    const host = origin.trim().toLowerCase().replace(/^www\./, "");
    return host.length > 0 && lower.includes(host);
  });
}
