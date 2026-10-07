import type { IncomingMessage } from "node:http";
import type { ProviderAdapter } from "./contracts.ts";
import type { ApprovalEditor } from "./approval-settings.ts";
import { normalizeOrigin } from "./recipes.ts";
import { isPortalRuleSurface, type PortalRuleSurface } from "./rules.ts";
import type { ApprovalSettings } from "../shared/approval-settings.ts";

export type RequestDecision = Parameters<ProviderAdapter["respondToRequest"]>[2];

export interface ParsedPortalRule {
  surface: PortalRuleSurface;
  origin: string;
}

/** A read offer's answer: `task` lets this app's allowlisted reads run for the
 * rest of the task; `always-reads` saves the app as Read without asking. The
 * card itself is allowed once either way. */
export type ReadGrantScope = "task" | "always-reads";

export interface ParsedRequestDecision {
  requestId: string;
  decision: RequestDecision;
  rule?: ParsedPortalRule;
  readGrant?: ReadGrantScope;
}

const SCOPES = ["once", "session", "task", "always-reads"];

/** Validate approval input at the server boundary. A client cannot invent a
 * provider behavior or turn a denial/answer into a wider permission scope. */
export function parseRequestDecision(value: unknown): ParsedRequestDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("request decision must be an object"), { status: 400 });
  }
  const body = value as Record<string, unknown>;
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!requestId || requestId.length > 200) {
    throw Object.assign(new Error("requestId must be 1–200 characters"), { status: 400 });
  }
  if (body.behavior !== "allow" && body.behavior !== "deny" && body.behavior !== "answer") {
    throw Object.assign(new Error("behavior must be allow, deny, or answer"), { status: 400 });
  }
  if (body.scope !== undefined && !SCOPES.includes(body.scope as string)) {
    throw Object.assign(new Error("scope must be once, session, task or always-reads"), { status: 400 });
  }
  if (body.scope !== undefined && body.scope !== "once" && body.behavior !== "allow") {
    throw Object.assign(new Error(`${body.scope} scope is only valid for allow decisions`), { status: 400 });
  }
  const readGrant = body.scope === "task" || body.scope === "always-reads" ? body.scope : undefined;
  if (readGrant && body.rule !== undefined) {
    throw Object.assign(new Error("Choose a site rule or a read grant, not both."), { status: 400 });
  }
  if (body.message !== undefined && (typeof body.message !== "string" || body.message.length > 4_000)) {
    throw Object.assign(new Error("message must be at most 4000 characters"), { status: 400 });
  }
  let rule: ParsedPortalRule | undefined;
  if (body.rule !== undefined) {
    if (!body.rule || typeof body.rule !== "object" || Array.isArray(body.rule)) {
      throw Object.assign(new Error("rule must name a portal surface and origin"), { status: 400 });
    }
    const row = body.rule as Record<string, unknown>;
    if (!isPortalRuleSurface(row.surface)) {
      throw Object.assign(new Error("rule surface must be portal-read or portal-prefill"), { status: 400 });
    }
    const origin = typeof row.origin === "string" ? normalizeOrigin(row.origin) : null;
    if (!origin) {
      throw Object.assign(new Error("Use a portal hostname like propertyme.com.au — no path or port."), {
        status: 400,
      });
    }
    rule = { surface: row.surface, origin };
  }
  return {
    requestId,
    decision: {
      behavior: body.behavior,
      ...(typeof body.message === "string" ? { message: body.message } : {}),
      // A read grant answers this card once; the grant itself is recorded by the host.
      ...(readGrant ? { scope: "once" as const } : body.scope === "once" || body.scope === "session" ? { scope: body.scope } : {}),
    },
    ...(rule ? { rule } : {}),
    ...(readGrant ? { readGrant } : {}),
  };
}

/** A read grant answers only the live card's own read offer, and "always"
 * only where that card offered it. Null when it may proceed. */
export function readGrantError(card: { readOffer?: { always: boolean } } | undefined, grant: ReadGrantScope): string | null {
  if (!card?.readOffer) return "This request has no read offer. Choose Allow once or Deny.";
  if (grant === "always-reads" && !card.readOffer.always) return "Change how often Bud asks in Workspace → Approvals.";
  return null;
}

type Reply = { status: number; body: unknown };
/** The approval settings store (server/approval-settings.ts), as the respond route uses it. */
export interface AlwaysReadsStore {
  editor(request: Pick<IncomingMessage, "headers">): Promise<ApprovalEditor>;
  handle(path: string, method: string, request: Pick<IncomingMessage, "headers">, query: URLSearchParams, body?: unknown): Promise<Reply>;
}
/** "Always allow reading <app>": saves the app group as Read without asking
 * on this computer, through the same editor check, revision and receipt as
 * Workspace → Approvals. Never over a saved Ask or Don't use; an office member
 * changes theirs in Workspace → Approvals. Null when saved. */
export async function saveAlwaysReads(approvals: AlwaysReadsStore, request: Pick<IncomingMessage, "headers">, group: string): Promise<Reply | null> {
  const editor = await approvals.editor(request);
  if (!editor.ok) return { status: editor.status, body: { error: editor.error } };
  const view = await approvals.handle("/api/approvals", "GET", request, new URLSearchParams());
  if (view.status !== 200) return view;
  const current = view.body as { scope?: string; local?: { revision: number; settings: ApprovalSettings } };
  if (current.scope !== "computer" || !current.local) return { status: 403, body: { error: "In an office, change how often Bud asks in Workspace → Approvals." } };
  const choice = current.local.settings.groups[group];
  if (choice === "ask" || choice === "deny") return { status: 409, body: { error: "This app's approval setting changed. Check Workspace → Approvals." } };
  const settings: ApprovalSettings = { ...current.local.settings, groups: { ...current.local.settings.groups, [group]: "read-without-asking" } };
  const saved = await approvals.handle("/api/approvals", "PUT", request, new URLSearchParams(), { expectedRevision: current.local.revision, settings });
  return saved.status === 200 ? null : saved;
}
