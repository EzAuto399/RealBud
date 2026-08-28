import { describe, expect, it } from "vitest";

import type { AskActionProposal } from "@shared/ask-actions";
import type { Message } from "@/state/store";

import { foldAskSpentConnects } from "./ask-thread";

function spent(index: number, title: string): Message {
  const action: AskActionProposal = {
    schemaVersion: 1,
    id: `setup-${index}`,
    status: "allowed",
    title,
    detail: `${title} here in Ask.`,
    createdAt: index,
    decidedAt: index + 1,
    kind: "open-setup",
    target: "connections",
    service: title,
  };
  return { id: `action-${index}`, role: "bot", kind: "action", at: index, action };
}

function text(id: string, at: number, role: Message["role"], body: string): Message {
  return { id, role, kind: "text", at, text: body };
}

describe("Ask spent connect folding", () => {
  it("leaves a single spent receipt as a one-line card", () => {
    const messages = [
      text("u1", 1, "user", "connect me to gmail"),
      spent(2, "Connect Gmail"),
    ];
    const items = foldAskSpentConnects(messages);
    expect(items.map((item) => item.kind)).toEqual(["message", "message"]);
    expect(items.every((item) => item.kind === "message")).toBe(true);
  });

  it("keeps the latest receipt and groups two or more older ones at the tail", () => {
    const messages = [
      spent(1, "Connect Instagram"),
      spent(2, "Connect Gmail"),
      spent(3, "Connect Google Calendar"),
    ];
    const items = foldAskSpentConnects(messages);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "spent-group",
      messages: [messages[0], messages[1]],
    });
    expect(items[1]).toMatchObject({ kind: "message", message: messages[2] });
  });

  it("folds every spent receipt once the thread has a later ask", () => {
    const messages = [
      text("u1", 1, "user", "connect me to instagram"),
      spent(2, "Connect Instagram"),
      text("u2", 3, "user", "connect me to gmail"),
      spent(4, "Connect Gmail"),
      text("u3", 5, "user", "What still needs Allow on Oak Street?"),
      text("b3", 6, "bot", "Oak Street has one hold."),
    ];
    const items = foldAskSpentConnects(messages);
    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "spent-group",
      "message",
      "message",
      "message",
    ]);
    expect(items[1]).toMatchObject({
      kind: "spent-group",
      messages: [messages[1], messages[3]],
    });
    expect(items.some((item) => item.kind === "message" && item.message.id === "action-4")).toBe(false);
  });

  it("does not fold a pending Allow or a routine card", () => {
    const pending: Message = {
      id: "pending-1",
      role: "bot",
      kind: "action",
      at: 2,
      action: {
        schemaVersion: 1,
        id: "routine-1",
        status: "pending",
        title: "Run Morning money check",
        detail: "Run it once now.",
        createdAt: 2,
        kind: "run-routine",
        loopId: "morning-arrears",
        loopName: "Morning money check",
        expectedLoopRevision: 1,
      },
    };
    const messages = [spent(1, "Connect Gmail"), pending, spent(3, "Connect Inbox")];
    const items = foldAskSpentConnects(messages);
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "message"]);
    expect(items[1]).toMatchObject({ kind: "message", message: pending });
  });
});
