import { describe, expect, it } from "vitest";

import { fenceBrowserPrepare, fenceDecision, fenceEvidenceLine, fencePayload, hasReadBack, isComputerTool, normalizeToolName, ruleAllowNote, type FenceContext } from "./portal-fence.ts";
import { uncheckedOfficeSettings, type ApprovalChoice, type ApprovalSettings } from "../shared/approval-settings.ts";

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

  it("treats namespaced shell and computer tools as computer actions", () => {
    expect(isComputerTool("mcp__computer__shell")).toBe(true);
    expect(isComputerTool("computer.shell")).toBe(true);
    expect(isComputerTool("mcp__computer__navigate")).toBe(true);
    expect(isComputerTool("mcp__computer__screenshot_desktop")).toBe(true);
    expect(isComputerTool("edit")).toBe(false);
  });

  it("keeps bounded CUA and browser tools fenced", () => {
    for (const tool of ["navigate", "click_semantic", "fill", "read", "click_xy", "javascript", "computer_exec", "browser_navigate", "mcp__browser__click", "mcp_computer_click"]) {
      expect(isComputerTool(tool), tool).toBe(true);
    }
    // A non-command tool whose summary names a computer tool is still fenced.
    expect(isComputerTool("other", "mcp_computer_click_xy")).toBe(true);
  });

  it("does not treat the engine's own code or terminal runs as computer actions", () => {
    // Hermes execute_code permission as it reaches the host (ACP kind "execute" -> "shell").
    expect(isComputerTool("shell", "execute_code <<'PY'\nimport csv\ndf.fillna(0)\nPY")).toBe(false);
    expect(isComputerTool("shell", "python3 scrape.py --browser chrome --navigate https://example.com")).toBe(false);
    expect(isComputerTool("terminal", "ls -la && open screenshot.png")).toBe(false);
    expect(isComputerTool("execute_code", "print('fill')")).toBe(false);
    expect(isComputerTool("Bash", "npx playwright screenshot")).toBe(false);
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
    // Lodging a filing with an authority has no observed document on this route, so it stays with the person.
    for (const label of ["Pay now", "Send notice", "Sign lease", "Delete record", "Terminate", "Evict", "BPAY", "Direct debit", "Authorise", "Approve payment", "Lodge bond", "Lodge the application"]) {
      expect(
        fenceDecision(submit, {
          tool: "click_semantic",
          params: { label, url: "https://vantagestrata.com.au" },
        }),
      ).toMatchObject({ kind: "deny", reason: "Submit, Pay and Send stay with you.", surface: "portal-submit" });
    }
  });

  it("uses the one consequential table on the route that has no page observation", () => {
    const submit: FenceContext = { ...ctx, capabilities: ["portal-read", "portal-prefill", "portal-submit"] };
    // Without an observed page the facts cannot be verified, so these stay denied here;
    // the browser broker is the route that can ask for a once-only approval.
    for (const label of ["Transfer money", "Cancel booking", "Log out", "Sign in", "Remove tenant", "Purchase"]) {
      expect(fenceDecision(submit, { tool: "click_semantic", params: { label, url: "https://vantagestrata.com.au" } }), label)
        .toMatchObject({ kind: "deny", reason: "Submit, Pay and Send stay with you.", surface: "portal-submit" });
    }
    expect(fenceDecision(submit, { tool: "click_semantic", params: { label: "Show levy history", url: "https://vantagestrata.com.au" } }))
      .toEqual({ kind: "ask", surface: "portal-read", origin: "vantagestrata.com.au" });
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

describe("approval settings on the job fence", () => {
  const settings = (groups: Record<string, ApprovalChoice>): ApprovalSettings[] => [{ version: 1, purpose: "approval-settings", groups, reviewedReads: [] }];
  const rules = [{ key: "portal:read:vantagestrata.com.au", decision: "allow" as const }, { key: "portal:prefill:vantagestrata.com.au", decision: "allow" as const }];
  const all: FenceContext = { ...ctx, capabilities: ["portal-read", "portal-prefill", "portal-submit"], rules };
  const REQUESTS = [
    { tool: "read", params: { url: "https://vantagestrata.com.au/arrears" } },
    { tool: "navigate", params: { url: "https://portal.vantagestrata.com.au/levy" } },
    { tool: "fill", params: { label: "Property code", url: "https://vantagestrata.com.au" } },
    { tool: "fill", params: { label: "Password", url: "https://vantagestrata.com.au" } },
    { tool: "click_semantic", params: { label: "Show details", url: "https://vantagestrata.com.au" } },
    { tool: "click_semantic", params: { label: "Lodge request", url: "https://vantagestrata.com.au" } },
    { tool: "click_semantic", params: { label: "Pay now", url: "https://vantagestrata.com.au" } },
    { tool: "navigate", params: { url: "https://evil.example/login" } },
    { tool: "get_browser_state", params: {} },
  ];

  it.each(REQUESTS)("with nothing saved, decides exactly as today: $tool $params.label $params.url", request => {
    for (const context of [ctx, all]) {
      const today = fenceDecision(context, request);
      for (const approvals of [[], settings({}), settings({ "site:other.example": "deny" })]) expect(fenceDecision({ ...context, approvals }, request)).toEqual(today);
    }
  });

  it("refuses a site set to Don't use with one plain line, and every step while settings need recovery", () => {
    for (const request of REQUESTS.slice(0, 7).filter(row => row.params.label !== "Password")) {
      expect(fenceDecision({ ...all, approvals: settings({ "site:vantagestrata.com.au": "deny" }) }, request)).toMatchObject({
        kind: "deny", reason: "vantagestrata.com.au is set to Don't use in Workspace → Approvals, so Bud did nothing there." });
      expect(fenceDecision({ ...all, approvals: null }, request)).toMatchObject({ kind: "deny", reason: expect.stringContaining("need recovery") });
    }
  });

  it("lets Ask every time override a standing allow rule", () => {
    const approvals = settings({ "site:vantagestrata.com.au": "ask" });
    for (const request of REQUESTS.slice(0, 3)) {
      expect(fenceDecision(all, request).kind).toBe("allow");
      expect(fenceDecision({ ...all, approvals }, request).kind).toBe("ask");
    }
    // Stricter only: a consequential label stays denied, an off-job site stays denied.
    expect(fenceDecision({ ...all, approvals }, REQUESTS[6]).kind).toBe("deny");
    expect(fenceDecision({ ...all, approvals }, REQUESTS[7]).kind).toBe("deny");
  });

  it("treats Read without asking as a reading rule for reads and same-site opens only", () => {
    const approvals = settings({ "site:vantagestrata.com.au": "read-without-asking" });
    const bySettings = { kind: "allow", surface: "portal-read", origin: "vantagestrata.com.au", bySettings: true };
    expect(fenceDecision({ ...ctx, approvals }, REQUESTS[0])).toEqual(bySettings);
    expect(fenceDecision({ ...ctx, approvals }, REQUESTS[1])).toEqual(bySettings);
    for (const request of REQUESTS.slice(2)) expect(fenceDecision({ ...ctx, approvals }, request)).toEqual(fenceDecision(ctx, request));
    // The log names what allowed the step: the setting, or a saved rule when there is one.
    expect(ruleAllowNote(fenceDecision({ ...ctx, approvals }, REQUESTS[0]))).toBe("allowed by approval settings · Reading on vantagestrata.com.au");
    expect(ruleAllowNote(fenceDecision({ ...all, approvals }, REQUESTS[0]))).toBe("allowed by rule · Reading on vantagestrata.com.au");
  });

  it("never lets Read without asking open an address that may change records, and a locked submit row refuses it", () => {
    const approvals = settings({ "site:vantagestrata.com.au": "read-without-asking" });
    for (const url of ["https://vantagestrata.com.au/submit?record=7", "https://vantagestrata.com.au/api/tickets?operation=update", "https://portal.vantagestrata.com.au/levy/delete"]) {
      const request = { tool: "navigate", params: { url } };
      expect(fenceDecision({ ...ctx, approvals }, request), url).toEqual(fenceDecision(ctx, request));
      expect(fenceDecision({ ...ctx, approvals }, request).kind, url).toBe("ask");
      expect(fenceDecision({ ...all, approvals: settings({ "class:submit": "deny" }) }, request), url).toMatchObject({ kind: "deny" });
    }
    expect(fenceDecision({ ...all, approvals: settings({ "class:submit": "deny" }) }, REQUESTS[1])).toEqual(fenceDecision(all, REQUESTS[1]));
  });

  it("marks every ask that a site's Ask every time (or unchecked office settings) requires, so no rule answers it and it offers none", () => {
    for (const approvals of [settings({ "site:vantagestrata.com.au": "ask" }), [...settings({}), uncheckedOfficeSettings()]]) {
      for (const request of REQUESTS.slice(0, 6).filter(row => row.params.label !== "Password")) {
        const decision = fenceDecision({ ...all, approvals }, request);
        expect(decision, `${request.tool} ${request.params.label ?? ""}`).toMatchObject({ kind: "ask", siteAsks: true });
        expect(fencePayload(decision)?.ruleOffer, request.tool).toBeNull();
      }
    }
    // Nothing saved: no mark, and the rule offer stays.
    const today = fenceDecision(ctx, REQUESTS[0]);
    expect(today).toEqual({ kind: "ask", surface: "portal-read", origin: "vantagestrata.com.au" });
    expect(fencePayload(today)?.ruleOffer).not.toBeNull();
  });
});
