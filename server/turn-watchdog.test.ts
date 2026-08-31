import { describe, expect, it } from "vitest";

import { TurnWatchdog, type TurnExpiryReason, type WatchedTurn } from "./turn-watchdog.ts";

const STALL = 10_000;

function rig(options: { maxMs?: number; maxTools?: number; maxRepeatedTool?: number } = {}) {
  let now = 0;
  const stalls: Array<{ turn: WatchedTurn; reason: TurnExpiryReason }> = [];
  const dog = new TurnWatchdog({
    stallMs: STALL,
    checkMs: 60_000,
    ...options,
    onStall: (turn, reason) => stalls.push({ turn, reason }),
    now: () => now,
  });
  return { dog, stalls, tick: (ms: number) => (now += ms) };
}

describe("TurnWatchdog", () => {
  it("stalls a silent turn once, and only once", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toEqual([{ turn: expect.objectContaining({ threadId: "t1", botId: "bot1" }), reason: "stall" }]);
    dog.sweep();
    expect(stalls).toHaveLength(1);
    expect(dog.watching("t1")).toBe(false);
  });

  it("any event on the thread resets the clock", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    for (let i = 0; i < 10; i++) {
      tick(STALL - 1);
      dog.touch("t1");
    }
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("never stalls a turn waiting on a human", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.setWaitingOnHuman("t1", true);
    tick(STALL * 100);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    dog.setWaitingOnHuman("t1", false);
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("a settled turn is forgotten", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.settle("t1");
    tick(STALL * 2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("expires an active turn at the hard deadline", () => {
    const { dog, stalls, tick } = rig({ maxMs: STALL * 2 });
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.touch("t1");
    tick(STALL + 1);
    dog.touch("t1");
    dog.sweep();
    expect(stalls).toEqual([{ turn: expect.objectContaining({ threadId: "t1" }), reason: "deadline" }]);
  });

  it("expires before a provider can exceed its tool budget", () => {
    const { dog, stalls } = rig({ maxTools: 2 });
    dog.watch("t1", "bot1");
    dog.noteTool("t1");
    dog.noteTool("t1");
    expect(stalls).toHaveLength(0);
    dog.noteTool("t1");
    expect(stalls).toEqual([{ turn: expect.objectContaining({ threadId: "t1", toolCount: 3 }), reason: "tool-budget" }]);
  });

  it("does not consume a tool budget while waiting on a human", () => {
    const { dog, stalls } = rig({ maxTools: 1 });
    dog.watch("t1", "bot1");
    dog.setWaitingOnHuman("t1", true);
    dog.noteTool("t1");
    dog.noteTool("t1");
    dog.setWaitingOnHuman("t1", false);
    dog.noteTool("t1");
    expect(stalls).toHaveLength(0);
  });

  it("stops a repeated tool loop without shrinking the total useful budget", () => {
    const { dog, stalls } = rig({ maxTools: 20, maxRepeatedTool: 3 });
    dog.watch("t1", "bot1");
    dog.noteTool("t1", "terminal: pwd");
    dog.noteTool("t1", "terminal: pwd");
    dog.noteTool("t1", "terminal: pwd");
    expect(stalls).toHaveLength(0);
    dog.noteTool("t1", "terminal: pwd");
    expect(stalls).toEqual([
      {
        turn: expect.objectContaining({ threadId: "t1", toolCount: 4, repeatedToolCount: 4 }),
        reason: "repeated-tool",
      },
    ]);
  });

  it("resets the repeat counter when useful work advances to another tool", () => {
    const { dog, stalls } = rig({ maxRepeatedTool: 2 });
    dog.watch("t1", "bot1");
    dog.noteTool("t1", "read: book.csv");
    dog.noteTool("t1", "read: book.csv");
    dog.noteTool("t1", "search: arrears");
    dog.noteTool("t1", "read: book.csv");
    dog.noteTool("t1", "read: book.csv");
    expect(stalls).toHaveLength(0);
  });
});
