// Standing rules: a saved allow/deny for one approval key.
// Guards from auto-approve always win — a rule can never widen into
// destructive or sensitive work. Portal rules are allow-only and
// scoped to one origin + surface (read or prefill). Never submit.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { approvalKey, looksDestructive, looksSensitive } from "./auto-approve.js";
import { DATA_DIR } from "./config.js";
import { reservedApprovalKey } from "../shared/approval-policy.js";
export const PORTAL_RULE_SURFACES = ["portal-read", "portal-prefill"];
function rulesPath() {
    return join(DATA_DIR, "rules.json");
}
function isDecision(value) {
    return value === "allow" || value === "deny";
}
export function isPortalRuleSurface(value) {
    return value === "portal-read" || value === "portal-prefill";
}
export function portalRuleKey(surface, origin) {
    return surface === "portal-read" ? `portal:read:${origin}` : `portal:prefill:${origin}`;
}
export function portalRuleLabel(surface, origin) {
    return surface === "portal-read" ? `Reading on ${origin}` : `Prefill on ${origin}`;
}
export function parsePortalRuleKey(key) {
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
function asRule(value) {
    if (!value || typeof value !== "object")
        return null;
    const row = value;
    if (typeof row.id !== "string" || !row.id.trim())
        return null;
    if (typeof row.key !== "string" || !row.key.trim())
        return null;
    if (!isDecision(row.decision))
        return null;
    if (typeof row.label !== "string")
        return null;
    if (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt))
        return null;
    const parsed = parsePortalRuleKey(row.key);
    const surface = isPortalRuleSurface(row.surface) ? row.surface : parsed?.surface;
    const origin = typeof row.origin === "string" && row.origin.trim()
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
function persist(rules) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(rulesPath(), `${JSON.stringify({ rules }, null, 2)}\n`, 0o600);
}
export function loadRules() {
    try {
        const parsed = JSON.parse(readFileSync(rulesPath(), "utf8"));
        const list = Array.isArray(parsed)
            ? parsed
            : parsed && typeof parsed === "object" && Array.isArray(parsed.rules)
                ? parsed.rules
                : null;
        if (!list)
            return [];
        const out = [];
        for (const row of list) {
            const rule = asRule(row);
            if (rule)
                out.push(rule);
        }
        return out;
    }
    catch {
        return [];
    }
}
export function ruleLabel(key) {
    const portal = parsePortalRuleKey(key);
    if (portal)
        return portalRuleLabel(portal.surface, portal.origin);
    const colon = key.indexOf(":");
    if (colon !== -1) {
        const program = key.slice(colon + 1);
        if (program)
            return `Run ${program} commands`;
    }
    if (key === "Read")
        return "Read workroom files";
    if (key === "Write" || key === "Edit")
        return "Change workroom files";
    return `Allow ${key}`;
}
export function addRule(key, decision, label) {
    if (reservedApprovalKey(key))
        throw Object.assign(new Error('Memory changes require a separate review each time and cannot use saved rules.'), { status: 400 });
    const portal = parsePortalRuleKey(key);
    if (portal) {
        if (decision !== "allow") {
            throw Object.assign(new Error("Portal rules can only allow."), { status: 400 });
        }
        return addPortalRule(portal.surface, portal.origin);
    }
    const next = loadRules().filter((rule) => rule.key !== key);
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
export function addPortalRule(surface, origin) {
    const key = portalRuleKey(surface, origin);
    const next = loadRules().filter((rule) => rule.key !== key);
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
export function removeRule(id) {
    const rules = loadRules();
    const next = rules.filter((rule) => rule.id !== id);
    if (next.length === rules.length)
        throw Object.assign(new Error("no such rule"), { status: 404 });
    persist(next);
    return next;
}
export function evaluateRules(rules, tool, summary) {
    if (reservedApprovalKey(tool))
        return null;
    if (looksDestructive(tool) || looksDestructive(summary) || looksSensitive(summary))
        return null;
    const key = approvalKey(tool, summary);
    return rules.find((rule) => rule.key === key)?.decision ?? null;
}
