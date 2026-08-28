import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { foldAskSpentConnects } from "@/lib/ask-thread";
import { ASK_WORKER_SETUP_DETAIL, askSetupActionMessages } from "./ChatView";

function actionMessage(index: number, status: "pending" | "allowed" | "denied" | "stale" = "pending"): Message {
  return {
    id: `message-${index}`,
    role: "bot",
    kind: "action",
    at: index,
    action: {
      schemaVersion: 1,
      id: `action-${index}`,
      status,
      title: "Open Connections",
      detail: "Open the human-owned connection setup.",
      createdAt: index,
      kind: "open-setup",
      target: "connections",
    },
  };
}

describe("Ask worker setup banner", () => {
  it("does not tell the PM that Ask is blocked while named routines still run", () => {
    expect(ASK_WORKER_SETUP_DETAIL).toMatch(/Named routines still run from Ask/i);
    expect(ASK_WORKER_SETUP_DETAIL).not.toMatch(/Ask waits/i);
  });
});

describe("Ask setup transcript continuity", () => {
  it("keeps pending requests and settled receipts visible while chat setup is paused", () => {
    const messages: Message[] = [
      { id: "user-1", role: "user", kind: "text", text: "Connect Telegram", at: 0 },
      actionMessage(1, "allowed"),
      actionMessage(2, "pending"),
      { id: "activity-1", role: "bot", kind: "activity", tool: { name: "Checking setup", ok: true }, at: 3 },
    ];
    expect(askSetupActionMessages(messages).map((message) => message.id)).toEqual(["message-1", "message-2"]);
  });

  it("bounds the setup projection to the latest five action receipts", () => {
    const selected = askSetupActionMessages(Array.from({ length: 7 }, (_, index) => actionMessage(index)));
    expect(selected.map((message) => message.id)).toEqual([
      "message-2",
      "message-3",
      "message-4",
      "message-5",
      "message-6",
    ]);
  });
});

describe("Ask spent connect transcript", () => {
  it("folds older spent receipts after the office has moved on", () => {
    const messages: Message[] = [
      { id: "user-1", role: "user", kind: "text", text: "connect gmail", at: 0 },
      actionMessage(1, "allowed"),
      { id: "user-2", role: "user", kind: "text", text: "connect calendar", at: 2 },
      actionMessage(3, "allowed"),
      { id: "user-3", role: "user", kind: "text", text: "What needs me?", at: 4 },
    ];
    const items = foldAskSpentConnects(messages);
    expect(items.filter((item) => item.kind === "spent-group")).toHaveLength(1);
    expect(items.some((item) => item.kind === "message" && item.message.id === "user-3")).toBe(true);
    expect(items.filter((item) => item.kind === "message" && item.message.kind === "action")).toHaveLength(0);
  });
});
