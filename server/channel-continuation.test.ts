import { describe, expect, it } from "vitest";
import { channelContinuation } from "./channel-continuation.ts";
import type { Store } from "./store.ts";
const store = (messages: unknown[], busy = false) => ({ productBud: () => ({ threadId: "bud", busy }), activePath: () => messages }) as unknown as Store;
describe("cross-device continuation", () => {
  it("keeps ordinary requests on the agent path and commands explicit", () => {
    expect(channelContinuation("continue my owner update", store([]))).toBeNull();
    expect(channelContinuation("/help", store([]))).toContain("Send to phone");
    expect(channelContinuation("/help", store([]))).toContain("/summary");
  });
  it("shows useful empty and busy states without claiming current completion", () => {
    expect(channelContinuation("/continue", store([]))).toContain("no saved reply");
    expect(channelContinuation("/status", store([], true))).toContain("working");
    expect(channelContinuation("/continue", store([{ role: "bot", kind: "text", text: "Previous draft" }], true))).toContain("Previous saved reply");
  });
  it("returns only the latest saved assistant text, bounded for every messaging app", () => {
    const result = channelContinuation(" /CONTINUE ", store([{ role: "bot", kind: "text", text: "old" }, { role: "user", kind: "text", text: "private request" }, { role: "bot", kind: "text", text: "x".repeat(5000) }]))!;
    expect(result).not.toContain("private request");expect(result).not.toContain("old");expect(result.length).toBeLessThan(1600);expect(result).toContain("full reply");
  });
  it("returns a short handoff summary for /summary", () => {
    const result = channelContinuation("/summary", store([
      { role: "user", kind: "text", text: "[Telegram · Sam] scan gmail" },
      { role: "bot", kind: "text", text: "Here are five items" },
    ]))!;
    expect(result).toContain("Ask handoff summary");
    expect(result).toContain("You: scan gmail");
    expect(result).toContain("Bud: Here are five items");
    expect(result).not.toContain("[Telegram");
  });
});
