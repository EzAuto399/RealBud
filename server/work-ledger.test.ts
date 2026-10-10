import { describe, expect, it } from "vitest";
import { createWorkLedger, workLedger } from "./work-ledger.ts";

const idle = { working: 0, waiting: 0, byKind: {} };

describe("work ledger", () => {
  it("counts an entry as working or waiting until it ends, and ending twice is harmless", () => {
    const ledger = createWorkLedger();
    expect(ledger.snapshot()).toEqual(idle);
    const turn = ledger.begin("turn");
    const card = ledger.begin("approval-card", "waiting");
    expect(ledger.snapshot()).toEqual({ working: 1, waiting: 1, byKind: { turn: { working: 1, waiting: 0 }, "approval-card": { working: 0, waiting: 1 } } });
    turn.set("waiting");
    expect(ledger.snapshot()).toMatchObject({ working: 0, waiting: 2 });
    turn.end(); turn.end(); card.end();
    // An ended entry stays ended: a late set cannot bring it back.
    turn.set("working");
    expect(ledger.snapshot()).toEqual(idle);
  });

  it("tracks a promise until it settles, either way", async () => {
    const ledger = createWorkLedger();
    let finish!: (value: string) => void, fail!: (error: Error) => void;
    const done = ledger.track("job-run", new Promise<string>(resolve => { finish = resolve; }));
    const failed = ledger.track("job-run", new Promise<string>((_, reject) => { fail = reject; }));
    expect(ledger.snapshot().byKind["job-run"]).toEqual({ working: 2, waiting: 0 });
    finish("prepared");
    expect(await done).toBe("prepared");
    fail(new Error("worker failed"));
    await expect(failed).rejects.toThrow("worker failed");
    expect(ledger.snapshot()).toEqual(idle);
  });

  it("reads a probe on every snapshot until it is unregistered, and fails closed when it throws or miscounts", () => {
    const ledger = createWorkLedger();
    let state: { working?: number; waiting?: number } = {};
    const release = ledger.probe("bank-import", () => state);
    expect(ledger.snapshot()).toEqual(idle);
    state = { waiting: 1 };
    expect(ledger.snapshot()).toEqual({ working: 0, waiting: 1, byKind: { "bank-import": { working: 0, waiting: 1 } } });
    state = { working: 2 };
    expect(ledger.snapshot()).toMatchObject({ working: 2, waiting: 0 });
    for (const bad of [-1, 1.5, Number.NaN, "1" as unknown as number]) {
      state = { working: bad };
      expect(ledger.snapshot()).toEqual({ working: 1, waiting: 0, byKind: { "bank-import": { working: 1, waiting: 0 } } });
    }
    const unreadable = ledger.probe("desk-check", () => { throw new Error("not ready"); });
    state = {};
    expect(ledger.snapshot()).toEqual({ working: 1, waiting: 0, byKind: { "desk-check": { working: 1, waiting: 0 } } });
    unreadable(); release(); release();
    expect(ledger.snapshot()).toEqual(idle);
  });

  it("adds kinds that share a name, including names Object.prototype owns", () => {
    const ledger = createWorkLedger();
    ledger.begin("constructor"); ledger.probe("constructor", () => ({ working: 1, waiting: 2 }));
    expect(ledger.snapshot()).toEqual({ working: 2, waiting: 2, byKind: { constructor: { working: 2, waiting: 2 } } });
  });

  it("refuses a malformed kind or state rather than counting it silently", () => {
    const ledger = createWorkLedger();
    for (const kind of ["", "Turn", "__proto__", "a b", "x".repeat(65)]) expect(() => ledger.begin(kind)).toThrow("Invalid work kind.");
    expect(() => ledger.probe("__proto__", () => ({}))).toThrow("Invalid work kind.");
    expect(() => ledger.begin("turn", "paused" as "working")).toThrow("Invalid work state.");
    expect(ledger.snapshot()).toEqual(idle);
  });

  it("exports one process-wide ledger", () => {
    expect(typeof workLedger.snapshot).toBe("function");
    expect(workLedger.snapshot()).toEqual(idle);
  });
});
