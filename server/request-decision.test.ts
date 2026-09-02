import { describe, expect, it } from "vitest";

import { parseRequestDecision } from "./request-decision.ts";

describe("parseRequestDecision", () => {
  it("accepts a task-scoped allow", () => {
    expect(parseRequestDecision({ requestId: "req-1", behavior: "allow", scope: "session" })).toEqual({
      requestId: "req-1",
      decision: { behavior: "allow", scope: "session" },
    });
  });

  it("accepts a portal standing-rule offer on allow", () => {
    expect(
      parseRequestDecision({
        requestId: "req-3",
        behavior: "allow",
        rule: { surface: "portal-read", origin: "https://www.PropertyMe.com.au/report" },
      }),
    ).toEqual({
      requestId: "req-3",
      decision: { behavior: "allow" },
      rule: { surface: "portal-read", origin: "propertyme.com.au" },
    });
  });

  it("keeps an ordinary answer bounded", () => {
    expect(parseRequestDecision({ requestId: "req-2", behavior: "answer", message: "Tuesday" })).toEqual({
      requestId: "req-2",
      decision: { behavior: "answer", message: "Tuesday" },
    });
  });

  it.each([
    [{ requestId: "", behavior: "allow" }, /requestId/],
    [{ requestId: "req", behavior: "approve" }, /behavior/],
    [{ requestId: "req", behavior: "deny", scope: "session" }, /only valid for allow/],
    [{ requestId: "req", behavior: "allow", scope: "forever" }, /scope/],
    [{ requestId: "req", behavior: "answer", message: "x".repeat(4_001) }, /message/],
  ])("rejects invalid request decisions", (input, message) => {
    expect(() => parseRequestDecision(input)).toThrow(message);
  });
});
