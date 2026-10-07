import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseRequestDecision, readGrantError, saveAlwaysReads } from "./request-decision.ts";
import { createApprovalSettings, SIGN_IN_TO_CHANGE } from "./approval-settings.ts";

describe("read grants on a read offer", () => {
  it("parses Allow for this task and Always allow reading as a one-time answer plus a grant", () => {
    for (const scope of ["task", "always-reads"] as const) {
      expect(parseRequestDecision({ requestId: "req-4", behavior: "allow", scope })).toEqual({ requestId: "req-4", decision: { behavior: "allow", scope: "once" }, readGrant: scope });
      expect(() => parseRequestDecision({ requestId: "req-4", behavior: "deny", scope })).toThrow("only valid for allow");
      expect(() => parseRequestDecision({ requestId: "req-4", behavior: "allow", scope, rule: { surface: "portal-read", origin: "portal.example" } })).toThrow("not both");
    }
  });

  it("answers only the card's own offer, and Always only where the card offered it", () => {
    expect(readGrantError(undefined, "task")).toMatch(/no read offer/);
    expect(readGrantError({}, "task")).toMatch(/no read offer/);
    expect(readGrantError({ readOffer: { always: false } }, "task")).toBeNull();
    expect(readGrantError({ readOffer: { always: false } }, "always-reads")).toMatch(/Workspace → Approvals/);
    expect(readGrantError({ readOffer: { always: true } }, "always-reads")).toBeNull();
  });

  const store = (seat: string | null) => {
    const dataDir = mkdtempSync(join(tmpdir(), "rb-read-grant-")); chmodSync(dataDir, 0o700);
    // No office answers here: a member cannot prove they may edit.
    return { dataDir, approvals: createApprovalSettings({ dataDir, seatIdentity: async () => seat, company: async () => ({ status: 503, body: null }) }) };
  };
  const request = { headers: {} };

  it("saves Always allow reading on this computer with a receipt, through the same editor check as Workspace → Approvals", async () => {
    const { dataDir, approvals } = store(null);
    expect(await saveAlwaysReads(approvals, request, "app:gmail")).toBeNull();
    const saved = JSON.parse(readFileSync(join(dataDir, "approval-settings.json"), "utf8"));
    expect(saved.revision).toBe(1);
    expect(saved.settings.groups).toEqual({ "app:gmail": "read-without-asking" });
    expect(saved.receipts).toEqual([expect.objectContaining({ by: "This computer", department: null, before: expect.objectContaining({ groups: {} }), after: saved.settings })]);
    // A saved Ask or Don't use is never overwritten from a card.
    for (const choice of ["ask", "deny"] as const) {
      const fresh = store(null);
      await fresh.approvals.handle("/api/approvals", "PUT", request, new URLSearchParams(), { expectedRevision: 0, settings: { version: 1, purpose: "approval-settings", groups: { "app:gmail": choice }, reviewedReads: [] } });
      expect(await saveAlwaysReads(fresh.approvals, request, "app:gmail")).toMatchObject({ status: 409 });
      expect(JSON.parse(readFileSync(join(fresh.dataDir, "approval-settings.json"), "utf8")).receipts).toHaveLength(1);
    }
  });

  it("refuses a member who cannot prove edit rights, and saves nothing", async () => {
    const { dataDir, approvals } = store("fictional-member-0001");
    expect(await saveAlwaysReads(approvals, request, "app:gmail")).toEqual({ status: 403, body: { error: SIGN_IN_TO_CHANGE } });
    expect(() => readFileSync(join(dataDir, "approval-settings.json"))).toThrow();
  });
});

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
