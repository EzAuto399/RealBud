import { describe, expect, it } from "vitest";
import { LiveStreamRecovery, restoredLiveStreams } from "./live-stream.ts";

const delta = (text: string, turnId = "turn-1", threadId = "thread-1") => ({ kind: "runtime", event: { type: "content.delta", turnId, threadId, streamKind: "assistant_text", delta: text } });
const event = (type: string, turnId = "turn-1", extra = {}) => ({ kind: "runtime", event: { type, threadId: "thread-1", turnId, ...extra } });

describe("reconnecting answer streams", () => {
  it("restores the entire active answer, then replaces it with no preview after completion", () => {
    const recovery = new LiveStreamRecovery();
    recovery.accept(delta("Before disconnect. "));
    recovery.accept(delta("Arrived while disconnected."));
    expect(restoredLiveStreams(recovery.snapshot())).toEqual({ streaming: { "thread-1": "Before disconnect. Arrived while disconnected." }, reasoning: {} });
    recovery.accept(event("turn.completed"));
    expect(restoredLiveStreams(recovery.snapshot())).toEqual({ streaming: {}, reasoning: {} });
  });
  it("does not append the preceding turn or pre-tool narration to a new answer", () => {
    const recovery = new LiveStreamRecovery();
    recovery.accept(delta("Old answer"));
    recovery.accept(delta("New answer", "turn-2"));
    recovery.accept(event("turn.completed")); // late old completion cannot delete the new one
    expect(recovery.snapshot()[0]?.text).toBe("New answer");
    recovery.accept(event("item.started", "turn-2", { itemType: "tool" }));
    recovery.accept(delta("Verified result", "turn-2"));
    expect(recovery.snapshot()[0]?.text).toBe("Verified result");
    recovery.accept({ kind: "message", threadId: "thread-1", message: { kind: "text", role: "bot", text: "Verified result" } });
    expect(recovery.snapshot()).toEqual([]);
  });
  it("clears stopped and rewound streams while retaining another thread", () => {
    const recovery = new LiveStreamRecovery();
    recovery.accept(delta("One")); recovery.accept(delta("Two", "turn-2", "thread-2"));
    recovery.accept({ kind: "bot", bot: { threadId: "thread-1", busy: false } });
    expect(recovery.snapshot().map(row => row.threadId)).toEqual(["thread-2"]);
    recovery.accept({ kind: "thread", threadId: "thread-2" });
    expect(recovery.snapshot()).toEqual([]);
  });
  it("bounds ephemeral recovery without returning a misleading truncated answer", () => {
    const recovery = new LiveStreamRecovery();
    recovery.accept(delta("x".repeat(262_144)));
    recovery.accept(delta("overflow")); recovery.accept(delta("tail"));
    expect(recovery.snapshot()).toEqual([]);
    recovery.accept(delta("Fresh answer", "turn-2"));
    expect(recovery.snapshot()[0]?.text).toBe("Fresh answer");
  });
  it("rejects malformed snapshots instead of keeping old text or accepting unsafe keys", () => {
    for (const value of [undefined, {}, [{ threadId: "__proto__", turnId: "turn-1", text: "bad", reasoning: "" }], [{ threadId: "thread-1", turnId: "turn-1", text: 3, reasoning: "" }]]) {
      expect(restoredLiveStreams(value)).toEqual({ streaming: {}, reasoning: {} });
    }
  });
});
