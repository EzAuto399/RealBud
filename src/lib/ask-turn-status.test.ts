import { describe, expect, it } from "vitest";

import type { AskActionProposal } from "@shared/ask-actions";

import { askUserTurnStatus, followingAskAction } from "./ask-turn-status";
import type { Message } from "@/state/store";

const instagram: AskActionProposal = {
  schemaVersion: 1,
  id: "setup-ig",
  status: "allowed",
  title: "Instagram isn't a named office source",
  detail: "Social accounts stay out.",
  createdAt: 1,
  decidedAt: 2,
  kind: "open-setup",
  target: "connections",
  service: "Instagram",
};

describe("Ask user-turn status", () => {
  it("does not call a refused social connect Completed", () => {
    expect(askUserTurnStatus({ requestState: "settled" }, instagram)).toEqual({
      label: "Not a source",
      tone: "hold",
    });
    expect(askUserTurnStatus({
      requestState: "settled",
      requestStatusDetail: "Opened the requested setup in Ask. Nothing connected automatically.",
    }, {
      ...instagram,
      service: "Gmail",
      title: "Connect Gmail",
    })).toEqual({
      label: "Card opened",
      tone: "muted",
    });
    expect(askUserTurnStatus({
      requestState: "settled",
      requestStatusDetail: "The routine ran once and its results are available on Desk.",
    })).toEqual({
      label: "Completed",
      tone: "muted",
    });
  });

  it("reads the action that followed the user turn, even on older copy", () => {
    const messages: Message[] = [
      { id: "user-ig", role: "user", kind: "text", text: "connecgt me to instagram", at: 1, requestState: "settled" },
      { id: "action-ig", role: "bot", kind: "action", at: 2, action: instagram },
    ];
    expect(followingAskAction(messages, "user-ig")).toEqual(instagram);
    expect(askUserTurnStatus(messages[0]!, followingAskAction(messages, "user-ig")).label).toBe("Not a source");
  });
});
