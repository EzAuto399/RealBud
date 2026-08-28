import { redactSecretsInText } from "./redact.ts";

export const POCKET_INPUT_LIMIT = 8_000;

export type PocketConnectionState =
  | "off"
  | "pilot-gated"
  | "setup-required"
  | "connecting"
  | "ready"
  | "attention";

export interface PocketActionReply {
  messageId: string;
  title: string;
  detail: string;
  /** Human-readable projection only. The canonical broker still owns scope. */
  permission?: string;
  boundary?: string;
}

export interface PocketTurnReply {
  text: string;
  action?: PocketActionReply;
}

export interface PocketHandlers {
  onText(text: string): Promise<PocketTurnReply>;
  onDecision(messageId: string, decision: "allow" | "deny"): Promise<string>;
  onStatus(): Promise<string>;
}

export function pocketDecisionId(decision: "allow" | "deny", messageId: string): string {
  if (!/^[A-Za-z0-9-]{1,48}$/.test(messageId)) {
    throw new Error("mobile action id is invalid");
  }
  const value = `rb:${decision}:${messageId}`;
  if (value.length > 64) throw new Error("mobile action id is invalid");
  return value;
}

export function parsePocketDecision(value: unknown): { decision: "allow" | "deny"; messageId: string } | null {
  if (typeof value !== "string") return null;
  const match = /^rb:(allow|deny):([A-Za-z0-9-]{1,48})$/.exec(value);
  return match ? { decision: match[1] as "allow" | "deny", messageId: match[2]! } : null;
}

export function parsePocketText(value: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof value !== "string") {
    return { ok: false, reason: "Send a text request. Mobile files and photos are not enabled yet." };
  }
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  if (!clean) return { ok: false, reason: "Send a text request for Bud." };
  if (clean.length > POCKET_INPUT_LIMIT) {
    return { ok: false, reason: "That message is too long for Pocket. Shorten it or use Ask on the desktop." };
  }
  if (redactSecretsInText(clean) !== clean) {
    return { ok: false, reason: "That looks like a credential, so RealBud did not put it in Ask. Add credentials in You instead." };
  }
  return { ok: true, text: clean };
}

function clippedPocketText(value: string, maximum: number): string {
  const clean = redactSecretsInText(value).trim();
  if (clean.length <= maximum) return clean;
  return `${clean.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

/** A bounded mobile projection of the same one-time approval contract shown
 * in Ask. Fixed permission/boundary text is retained even when a long model
 * reason must be clipped for a provider payload limit. */
export function pocketApprovalRequestText(action: PocketActionReply, maximum = 4_096): string {
  const limit = Math.max(256, Math.min(8_000, Math.floor(maximum)));
  const title = clippedPocketText(action.title || "RealBud action", 160) || "RealBud action";
  const permission = clippedPocketText(
    action.permission || "Run this exact RealBud action one time.",
    240,
  );
  const boundary = clippedPocketText(
    action.boundary || "Bud may complete only this request. Nothing else changes.",
    280,
  );
  const before = `${title}\n\nWhy\n`;
  const after = `\n\nPermission\n${permission}\n\nStops at\n${boundary}\n\nFuture work still needs another Allow.`;
  const detailBudget = Math.max(16, limit - before.length - after.length);
  const detail = clippedPocketText(action.detail || "Bud prepared this request for your review.", detailBudget);
  return `${before}${detail}${after}`.slice(0, limit);
}

export function pocketHelpText(channelLabel: string): string {
  return `This is your RealBud Pocket connection on ${channelLabel}. Ask Bud normally, ask for status, and use Allow once or Not now when RealBud prepares a change. Every later action needs another Allow. The desktop app must be running.`;
}

export function pocketUnsupportedCommandText(): string {
  return "Pocket supports help and status only. Ask for work in normal language; model, update, terminal and gateway commands stay in RealBud.";
}
