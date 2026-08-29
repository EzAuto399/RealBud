import {
  isCompletedToolConnect,
  isConnectSetupAction,
  isUnsupportedOfficeConnect,
  type AskActionProposal,
} from "@shared/ask-actions";

import type { Message } from "@/state/store";

export function followingAskAction(
  messages: readonly Message[],
  userMessageId: string,
): AskActionProposal | undefined {
  const index = messages.findIndex((message) => message.id === userMessageId);
  if (index < 0) return undefined;
  const next = messages[index + 1];
  return next?.kind === "action" ? next.action : undefined;
}

export function askUserTurnStatus(
  message: Pick<Message, "requestState" | "requestStatusDetail">,
  followingAction?: AskActionProposal,
): { label: string; tone: "hold" | "muted" | "working" | "agency" } {
  if (message.requestState === "held") {
    return { label: message.requestStatusDetail ?? "Needs your attention", tone: "hold" };
  }
  if (message.requestState !== "settled") {
    return { label: "Saved locally · Bud working", tone: "working" };
  }
  if (followingAction && isConnectSetupAction(followingAction)) {
    if (isUnsupportedOfficeConnect(followingAction)) return { label: "Not a source", tone: "hold" };
    if (isCompletedToolConnect(followingAction)) return { label: "Connected", tone: "agency" };
    if (followingAction.status === "pending") return { label: "Needs Allow", tone: "muted" };
    return { label: "Card opened", tone: "muted" };
  }
  const detail = message.requestStatusDetail ?? "";
  if (/isn't a named office source/i.test(detail)) return { label: "Not a source", tone: "hold" };
  if (/accepted this key|is on this device/i.test(detail)) return { label: "Connected", tone: "agency" };
  if (/opened the requested setup|nothing connected/i.test(detail)) return { label: "Card opened", tone: "muted" };
  if (/waiting for your decision/i.test(detail)) return { label: "Needs Allow", tone: "muted" };
  if (/stopped safely/i.test(detail)) return { label: "Stopped safely", tone: "hold" };
  return { label: "Completed", tone: "muted" };
}
