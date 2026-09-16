import { describe, expect, it } from "vitest";

import { fenceBrowserPrepare, fenceDecision, fenceEvidenceLine, hasReadBack, isComputerTool, normalizeToolName, type FenceContext } from "./portal-fence.ts";

const ctx: FenceContext = {
  allowedOrigins: ["vantagestrata.com.au"],
  capabilities: ["portal-read", "portal-prefill"],
};

describe("portal fence", () => {
  it("normalises mcp computer prefixes", () => {
    expect(normalizeToolName("mcp__computer__navigate")).toBe("navigate");
    expect(normalizeToolName("computer.navigate")).toBe("navigate");
  });

  it("denies a tool outside the allowlist", () => {
    const decision = fenceDecision(ctx, { tool: "computer_exec", params: { url: "https://vantagestrata.com.au" } });
    expect(decision).toEqual({
      kind: "deny",
      reason: "Bud can only open, read, fill and click on this job's site.",
    });
  });

  it("denies a host that is not on the job", () => {
    expect(
      fenceDecision(ctx, { tool: "navigate", params: { url: "https://evil.example/login" } }),
    ).toMatchObject({ kind: "deny", reason: "That site is not on this job.", surface: "portal-read", origin: "evil.example" });
  });

  it("allows a subdomain of an allowed origin", () => {
    expect(
      fenceDecision(ctx, {
        tool: "navigate",
        params: { url: "https://portal.vantagestrata.com.au/levy" },
      }),
    ).toEqual({ kind: "ask", surface: "portal-read", origin: "vantagestrata.com.au" });
  });

  it("normalises mcp__computer__navigate onto the same rule", () => {
    expect(
      fenceDecision(ctx, {
        tool: "mcp__computer__navigate",
        params: { url: "https://portal.vantagestrata.com.au" },
      }),
    ).toEqual({ kind: "ask", surface: "portal-read", origin: "vantagestrata.com.au" });
  });

  it("denies filling a password or OTP field", () => {
    expect(
      fenceDecision(ctx, { tool: "fill", params: { label: "One-time password", url: "https://vantagestrata.com.au" } }),
    ).toMatchObject({
      kind: "deny",
      reason: "You sign in yourself — Bud never types a password.",
      surface: "portal-prefill",
    });
  });

  it("denies fill when the job is read-only", () => {
    expect(
      fenceDecision(
        { allowedOrigins: ["vantagestrata.com.au"], capabilities: ["portal-read"] },
        { tool: "fill", params: { label: "Search", url: "https://vantagestrata.com.au" } },
      ),
    ).toMatchObject({
      kind: "deny",
      reason: "This job is read-only. Add prefill on Schedule if Bud should fill forms.",
      surface: "portal-prefill",
    });
  });

  it("denies a click labelled Pay now", () => {
    expect(
      fenceDecision(ctx, {
        tool: "click_semantic",
        params: { label: "Pay now", url: "https://vantagestrata.com.au" },
      }),
    ).toMatchObject({ kind: "deny", reason: "Submit, Pay and Send stay with you.", surface: "portal-submit" });
  });

  it("asks for read or navigate on an allowed origin", () => {
    expect(
      fenceDecision(ctx, { tool: "read", params: { url: "https://vantagestrata.com.au/arrears" } }),
    ).toEqual({ kind: "ask", surface: "portal-read", origin: "vantagestrata.com.au" });
  });

  it("asks for a safe fill when prefill is granted", () => {
    expect(
      fenceDecision(ctx, { tool: "fill", params: { label: "Property code", url: "https://vantagestrata.com.au" } }),
    ).toEqual({ kind: "ask", surface: "portal-prefill", origin: "vantagestrata.com.au" });
  });

  it("denies navigate, fill, or click when the target cannot be confirmed", () => {
    expect(fenceDecision(ctx, { tool: "navigate", params: 12 })).toMatchObject({
      kind: "deny",
      reason: "Bud could not confirm which site or control this touches.",
    });
    expect(fenceDecision(ctx, { tool: "fill" })).toMatchObject({
      kind: "deny",
      reason: "Bud could not confirm which site or control this touches.",
    });
    expect(fenceDecision(ctx, { tool: "click_semantic", summary: "" })).toMatchObject({
      kind: "deny",
      reason: "Bud could not confirm which site or control this touches.",
    });
  });

  it("writes a plain-language evidence line", () => {
    expect(fenceEvidenceLine({ tool: "navigate" }, { kind: "ask" })).toBe("Asked to open a page.");
    expect(
      fenceEvidenceLine(
        { tool: "fill" },
        { kind: "deny", reason: "You sign in yourself — Bud never types a password." },
      ),
    ).toBe("Tried to fill a field. You sign in yourself — Bud never types a password.");
    expect(
      fenceEvidenceLine(
        { tool: "mcp__computer__navigate" },
        { kind: "deny", reason: "Only sites named in a saved job. Ask Bud to set the routine up as a job first." },
      ),
    ).toBe(
      "Tried to open a page. Only sites named in a saved job. Ask Bud to set the routine up as a job first.",
    );
  });

  it("treats shell and computer tools as computer actions", () => {
    expect(isComputerTool("shell")).toBe(true);
    expect(isComputerTool("mcp__computer__navigate")).toBe(true);
    expect(isComputerTool("edit")).toBe(false);
  });
});

describe("standing rules and submit", () => {
  it("allows read on the exact host and the matching parent origin", () => {
    const rules = [{ key: "portal:read:vantagestrata.com.au", decision: "allow" as const }];
    expect(
      fenceDecision(
        { ...ctx, rules },
        { tool: "read", params: { url: "https://vantagestrata.com.au/arrears" } },
      ),
    ).toEqual({ kind: "allow", surface: "portal-read", origin: "vantagestrata.com.au" });
    expect(
      fenceDecision(
        { ...ctx, rules },
        { tool: "navigate", params: { url: "https://portal.vantagestrata.com.au/levy" } },
      ),
    ).toEqual({ kind: "allow", surface: "portal-read", origin: "vantagestrata.com.au" });
  });

  it("never covers fill without the prefill capability", () => {
    expect(
      fenceDecision(
        {
          allowedOrigins: ["vantagestrata.com.au"],
          capabilities: ["portal-read"],
          rules: [{ key: "portal:prefill:vantagestrata.com.au", decision: "allow" }],
        },
        { tool: "fill", params: { label: "Property code", url: "https://vantagestrata.com.au" } },
      ),
    ).toMatchObject({
      kind: "deny",
      reason: "This job is read-only. Add prefill on Schedule if Bud should fill forms.",
    });
  });

  it("asks to submit only with portal-submit, and money labels stay denied", () => {
    const submit: FenceContext = {
      allowedOrigins: ["vantagestrata.com.au"],
      capabilities: ["portal-read", "portal-prefill", "portal-submit"],
    };
    expect(
      fenceDecision(submit, {
        tool: "click_semantic",
        params: { label: "Lodge request", url: "https://vantagestrata.com.au" },
      }),
    ).toEqual({ kind: "ask", surface: "portal-submit", origin: "vantagestrata.com.au" });
    expect(
      fenceDecision(ctx, {
        tool: "click_semantic",
        params: { label: "Submit levy", url: "https://vantagestrata.com.au" },
      }),
    ).toMatchObject({
      kind: "deny",
      reason: "This job cannot press Submit. Add 'Bud may press Submit' on the job if it should.",
      surface: "portal-submit",
    });
    for (const label of ["Pay now", "Send notice", "Sign lease", "Delete record", "Terminate", "Evict", "BPAY", "Direct debit", "Authorise", "Approve payment"]) {
      expect(
        fenceDecision(submit, {
          tool: "click_semantic",
          params: { label, url: "https://vantagestrata.com.au" },
        }),
      ).toMatchObject({ kind: "deny", reason: "Submit, Pay and Send stay with you.", surface: "portal-submit" });
    }
  });

  it("returns a surface on every on-site decision", () => {
    expect(fenceDecision(ctx, { tool: "read", params: { url: "https://vantagestrata.com.au" } }).surface).toBe(
      "portal-read",
    );
    expect(fenceDecision(ctx, { tool: "fill", params: { label: "Code", url: "https://vantagestrata.com.au" } }).surface).toBe(
      "portal-prefill",
    );
    expect(
      fenceDecision(ctx, { tool: "click_semantic", params: { label: "Tab", url: "https://vantagestrata.com.au" } }).surface,
    ).toBe("portal-read");
  });

  it("denies isolated browser_prepare and allow_launch", () => {
    expect(
      fenceDecision(ctx, {
        tool: "mcp__computer__browser_prepare",
        params: { profile: { mode: "isolated_new" }, allow_launch: true },
      }),
    ).toMatchObject({ kind: "deny", surface: "portal-read" });
    expect(
      fenceBrowserPrepare({ tool: "prepare", params: { allowLaunch: true } }),
    ).toMatchObject({ kind: "deny" });
  });

  it("asks only for existing_profile with pid and window_id", () => {
    expect(
      fenceDecision(ctx, {
        tool: "browser_prepare",
        params: { strategy: { kind: "existing_profile" }, pid: 4242, window_id: 7 },
      }),
    ).toEqual({ kind: "ask", surface: "portal-read" });
    expect(
      fenceDecision(ctx, {
        tool: "browser_prepare",
        params: { strategy: { kind: "existing_profile" }, pid: 4242 },
      }),
    ).toMatchObject({ kind: "deny", surface: "portal-read" });
  });

  it("allows read-only browser discovery so Bud can find the open window", () => {
    expect(fenceDecision(ctx, { tool: "get_browser_state" })).toEqual({ kind: "allow", surface: "portal-read" });
    expect(fenceDecision(ctx, { tool: "mcp__computer__list_windows" })).toEqual({
      kind: "allow",
      surface: "portal-read",
    });
  });
});

describe("read-back evidence", () => {
  it("needs an allowed origin and a seen-it marker", () => {
    expect(hasReadBack("portal.vantagestrata.com.au shows balance due", ["vantagestrata.com.au"])).toBe(true);
    expect(hasReadBack("The page looks done.", ["vantagestrata.com.au"])).toBe(false);
    expect(hasReadBack("The report shows arrears due", ["vantagestrata.com.au"])).toBe(false);
  });
});
