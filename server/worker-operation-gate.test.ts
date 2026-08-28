import { describe, expect, it } from "vitest";

import { WorkerOperationGate } from "./worker-operation-gate.ts";

describe("WorkerOperationGate", () => {
  it("serializes worker work and reports the active operation", () => {
    const gate = new WorkerOperationGate();
    const ask = gate.acquire("ask", "answering in Ask");

    expect(gate.snapshot()).toMatchObject({ kind: "ask", detail: "answering in Ask" });
    expect(() => gate.acquire("update", "preparing a private worker update")).toThrow(/answering in Ask/);

    ask.release();
    const update = gate.acquire("update", "preparing a private worker update");
    expect(gate.snapshot()?.kind).toBe("update");
    update.release();
    expect(gate.snapshot()).toBeNull();
  });

  it("makes release idempotent and prevents a stale release from clearing a newer lease", () => {
    const gate = new WorkerOperationGate();
    const first = gate.acquire("test", "testing the worker");
    first.release();
    const second = gate.acquire("desk", "checking the book");

    first.release();
    expect(gate.snapshot()?.kind).toBe("desk");
    second.release();
    expect(gate.snapshot()).toBeNull();
  });

  it("returns a conflict with an authoritative HTTP status and code", () => {
    const gate = new WorkerOperationGate();
    gate.acquire("update", "preparing a private worker update");

    try {
      gate.acquire("ask", "answering in Ask");
      throw new Error("expected a conflict");
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: "worker-operation-busy" });
    }
  });
});
