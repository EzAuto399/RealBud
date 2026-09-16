import { describe, expect, it } from "vitest";
import { toolFingerprint } from "./tool-fingerprint.ts";
import { TurnWatchdog } from "./turn-watchdog.ts";

describe("argument-aware tool progress", () => {
  it("allows ten different thread reads but still stops an identical read loop", () => {
    const expired: string[] = [];
    const dog = new TurnWatchdog({ stallMs: 1000, checkMs: 1000, maxTools: 30,
      maxRepeatedTool: 5, onStall: (_, reason) => expired.push(reason) });
    dog.watch("inbox", "bud");
    for (let i = 0; i < 10; i++) dog.noteTool("inbox", toolFingerprint("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", { thread_id: `thread-${i}` }));
    expect(expired).toEqual([]);
    for (let i = 0; i < 6; i++) dog.noteTool("inbox", toolFingerprint("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", { thread_id: "same" }));
    expect(expired).toEqual(["repeated-tool"]);
  });

  it("compares arguments consistently and keeps their content out of the fingerprint", () => {
    const first = toolFingerprint("read", { b: 2, a: { secret: "private-token", id: 1 } });
    expect(first).toBe(toolFingerprint("read", { a: { id: 1, secret: "private-token" }, b: 2 }));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("private-token");
    expect(first).not.toBe(toolFingerprint("write", { b: 2, a: { secret: "private-token", id: 1 } }));
  });

  it("preserves distinctions after the display-title cutoff and handles missing arguments", () => {
    const prefix = "read ".repeat(30);
    expect(toolFingerprint(prefix + "one")).not.toBe(toolFingerprint(prefix + "two"));
    expect(toolFingerprint("read")).toBe(toolFingerprint("read"));
  });
});
