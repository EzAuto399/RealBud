import type { AskActionProposal, AskConnectRequest, AskSetupTarget } from "@shared/ask-actions";
import { isKnownOfficeService, prettyOfficeName, resolveAskOfficeTool } from "@shared/ask-connections";

export type AskConnectPanel =
  | "mail"
  | "book"
  | "sources"
  | "api"
  | "pocket-whatsapp"
  | "pocket-telegram"
  | "computer-use"
  | "reminders"
  | "worker"
  | "composio"
  | "unsupported";

export type AskConnectMethod = "direct-api" | "approved-mcp" | "isolated-cli" | "restricted-composio";
export type AskConnectMethodFill = "composio" | "export" | "gated" | "composio-unavailable";
export type AskConnectMethodBadgeTone = "standard" | "live" | "gated";

/** Professional rank: first-party, current live standard, reviewed MCP, file fallback. */
export const ASK_CONNECT_METHOD_ORDER: readonly AskConnectMethod[] = [
  "direct-api",
  "restricted-composio",
  "approved-mcp",
  "isolated-cli",
];

export const COMPOSIO_SIGN_IN_URL = "https://platform.composio.dev";

/** A named toolkit signs in through Composio. Generic inbox/calendar defaults
 * to an export — not a CLI, and not a live API claim. */
export function defaultAskConnectMethod(options: {
  composioLinked: boolean;
  hasNamedToolkit: boolean;
}): AskConnectMethod {
  if (options.hasNamedToolkit) return "restricted-composio";
  return "isolated-cli";
}

export function isLiveAskConnectMethod(method: AskConnectMethod): boolean {
  return method === "restricted-composio" || method === "isolated-cli";
}

export function askConnectMethodTitle(method: AskConnectMethod): string {
  switch (method) {
    case "restricted-composio":
      return "Restricted Composio";
    case "isolated-cli":
      return "Attach an export";
    case "direct-api":
      return "Direct API";
    case "approved-mcp":
      return "Approved MCP";
  }
}

export function askConnectMethodBadge(options: {
  method: AskConnectMethod;
  currentStandard: AskConnectMethod;
}): { label: string; tone: AskConnectMethodBadgeTone } {
  if (options.method === options.currentStandard) {
    return { label: "Current standard", tone: "standard" };
  }
  if (!isLiveAskConnectMethod(options.method)) {
    return { label: "Not in this build", tone: "gated" };
  }
  return { label: "Available", tone: "live" };
}

export function askConnectMethodFill(options: {
  method: AskConnectMethod;
  hasNamedToolkit: boolean;
}): AskConnectMethodFill {
  if (options.method === "direct-api" || options.method === "approved-mcp") return "gated";
  if (options.method === "isolated-cli") return "export";
  if (!options.hasNamedToolkit) return "composio-unavailable";
  return "composio";
}

export function askConnectUseStandardLabel(standard: AskConnectMethod): string {
  return `Use ${askConnectMethodTitle(standard)}`;
}

export function askConnectGatedDetail(method: AskConnectMethod, options: {
  toolLabel: string;
  currentStandard: AskConnectMethod;
}): string {
  const standardTitle = askConnectMethodTitle(options.currentStandard);
  if (method === "direct-api") {
    return `A live ${options.toolLabel} API is not in this build. ${standardTitle} is the current standard.`;
  }
  if (method === "approved-mcp") {
    return `An approved MCP for ${options.toolLabel} is not in this build. ${standardTitle} is the current standard.`;
  }
  return "";
}

export function askConnectComposioUnavailableDetail(toolLabel: string): string {
  return `This build has no named toolkit for ${toolLabel}. Attach an export is the current standard.`;
}

export function askConnectComposioStatus(options: {
  composioLinked: boolean;
  toolConnected: boolean | null;
  hasNamedToolkit: boolean;
}): string {
  if (!options.composioLinked) return "Sign in";
  if (options.toolConnected) return "Connected";
  if (options.hasNamedToolkit) return "Ready to sign in";
  return "No named toolkit";
}

export function askConnectMailSubtitle(composioLinked: boolean, hasNamedToolkit = true): string {
  if (!hasNamedToolkit) return "Attach an export this office already has. Nothing sends.";
  return composioLinked
    ? "Sign in this account or attach an export. Nothing sends."
    : "Sign in to Composio here, then paste the Connect key. Nothing sends.";
}

export function askConnectBookSubtitle(): string {
  return "Name the book this office already uses, then attach an export. Nothing sends.";
}

export function sameAskConnectRequest(left: AskConnectRequest, right: AskConnectRequest): boolean {
  return left.target === right.target && (left.service ?? "") === (right.service ?? "");
}

const ASK_CONNECT_STACK_LIMIT = 4;

export function replaceAskConnectState(next: AskConnectRequest): {
  askConnect: AskConnectRequest;
  askConnectStack: AskConnectRequest[];
} {
  return { askConnect: next, askConnectStack: [] };
}

export function pushAskConnectState(
  current: AskConnectRequest | null,
  stack: readonly AskConnectRequest[],
  next: AskConnectRequest,
): { askConnect: AskConnectRequest; askConnectStack: AskConnectRequest[] } {
  if (current && sameAskConnectRequest(current, next)) {
    return { askConnect: next, askConnectStack: [...stack] };
  }
  return {
    askConnect: next,
    askConnectStack: current ? [...stack, current].slice(-ASK_CONNECT_STACK_LIMIT) : [],
  };
}

export function popAskConnectState(stack: readonly AskConnectRequest[]): {
  askConnect: AskConnectRequest | null;
  askConnectStack: AskConnectRequest[];
} {
  if (stack.length === 0) return { askConnect: null, askConnectStack: [] };
  return {
    askConnect: stack[stack.length - 1]!,
    askConnectStack: stack.slice(0, -1),
  };
}

export function askConnectHeading(request: AskConnectRequest): string {
  const tool = resolveAskOfficeTool(request.service ?? "");
  if (tool) return `Connect ${tool.label}`;
  if (request.target === "connections" && request.service?.trim() && !isKnownOfficeService(request.service)) {
    return `${prettyOfficeName(request.service)} isn't a named office source`;
  }
  if (request.service?.trim() && isKnownOfficeService(request.service)) {
    return `Connect ${prettyOfficeName(request.service)}`;
  }
  switch (request.target) {
    case "worker":
      return "Connect Bud";
    case "desktop-reminders":
      return "Desktop reminders";
    case "computer-use":
      return "Connect computer use";
    case "composio-account":
      return "Sign in to Composio";
    default:
      return "Connect a source";
  }
}

export function askConnectPanel(request: AskConnectRequest): AskConnectPanel {
  if (request.target === "worker") return "worker";
  if (request.target === "desktop-reminders") return "reminders";
  if (request.target === "computer-use") return "computer-use";
  if (request.target === "composio-account") return "composio";
  const service = (request.service ?? "").toLowerCase();
  if (/whatsapp/.test(service)) return "pocket-whatsapp";
  if (/telegram/.test(service)) return "pocket-telegram";
  if (/gmail|outlook|hotmail|incoming mail|inbox|calendar/.test(service)) return "mail";
  if (/property book|property tree|propertyme|reapit|pms|portfolio/.test(service)) return "book";
  if (/\bapi\b|\bmcp\b/.test(service)) return "api";
  if (request.service?.trim() && !isKnownOfficeService(request.service)) return "unsupported";
  return "sources";
}

/** Catalog slot names stay generic; only a known office name can prefill an alias. */
export function suggestedOfficeName(service?: string): string | null {
  const tool = resolveAskOfficeTool(service ?? "");
  if (tool && tool.id !== "incoming-mail") return tool.label.slice(0, 40);
  const name = service?.trim();
  if (!name || !isKnownOfficeService(name)) return null;
  if (/^(incoming mail|property book|computer use|worker|desktop reminders|api and mcp|composio account)$/i.test(name)) {
    return null;
  }
  return prettyOfficeName(name).slice(0, 40);
}

export function askConnectFromTarget(target: AskSetupTarget, service?: string): AskConnectRequest {
  return { target, ...(service?.trim() ? { service: service.trim() } : {}) };
}

/** Reopen a spent connect receipt. Unlike honoredSetupRequest, this is not time-windowed. */
export function askConnectFromSpentAction(action: AskActionProposal): AskConnectRequest | null {
  if (action.status !== "allowed") return null;
  if (action.kind === "choose-connection") {
    const selected = action.options.find((option) => option.id === action.selectedId);
    return {
      target: selected?.target ?? "connections",
      ...(selected?.service ? { service: selected.service } : {}),
    };
  }
  if (action.kind === "open-setup") {
    return { target: action.target, ...(action.service ? { service: action.service } : {}) };
  }
  return null;
}
