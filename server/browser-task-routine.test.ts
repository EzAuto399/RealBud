import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeBrowserAction, type BrowserAuthorityOptions, type BrowserObservation } from "./browser-authority.ts";
import { parseBrowserTaskGrant, type BrowserTaskGrant } from "../shared/browser-task.ts";

const request = "Search the fictional portal for invoice FICT-7";
const grant = (): BrowserTaskGrant => parseBrowserTaskGrant({
  version: 1, purpose: "browser-task-grant", id: "fictional-task", runId: "fictional-run", route: "ask",
  request: { text: request, sha256: createHash("sha256").update(request).digest("hex") },
  sites: ["https://portal.example", "https://other.example"], browser: { id: "fictional-browser", accountMarker: null },
  actions: ["read", "navigate", "click", "fill", "keys", "download", "upload", "submit"], consequential: "ask-each", uploads: [], expiresAt: 50_000, budget: 20,
});
const page: BrowserObservation = { url: "https://portal.example/work", text: '@vom 1\nL1 page\n  main\n    form "Invoice search"\n      @e1 searchbox "Search"\n      @e2 button "Search"\n    @e3 button "Mystery action"\n    @e4 button "Save"\n    @e5 link "Download report"\n    @e6 textbox "Reference"\n    @e7 button "Log out"' };
const proof = (g = grant()): NonNullable<BrowserAuthorityOptions["taskScope"]> => ({ grantId: g.id, runId: g.runId, requestHash: g.request.sha256, browserId: "fictional-browser", tabId: 1, origin: "https://portal.example", accountMarker: g.browser.accountMarker, readOnly: true });
const decide = (tool: string, args: Record<string, unknown> = {}, options: BrowserAuthorityOptions = {}, g = grant(), observation = page) =>
  authorizeBrowserAction(g, observation, tool, { tab_id: 1, ...args }, { now: 1_000, taskScope: proof(g), ...options });

describe("bounded task-local routine authority", () => {
  it.each([
    ["browser_borrow", {}], ["browser_read", {}], ["browser_navigate", { url: "https://portal.example/invoices" }],
    ["browser_fill", { ref: "@e1", value: "FICT-7" }], ["browser_click_semantic", { ref: "@e2" }],
  ])("uses the live native task scope for %s without creating a standing rule", (tool, args) => {
    expect(decide(tool as string, args as Record<string, unknown>)).toMatchObject({ decision: "allow", note: "allowed for this browser task", fence: { ruleOffer: null } });
  });

  it("does not treat the parsed task, a legacy job or an indefinite scope as live authority", () => {
    expect(decide("browser_read", {}, { taskScope: undefined }).decision).toBe("ask");
    for (const changed of [{ route: "job", origin: "legacy-job" }, { browser: { id: null, accountMarker: null } }, { expiresAt: null }, { budget: null }]) {
      const g = parseBrowserTaskGrant({ ...grant(), ...changed });
      expect(decide("browser_read", {}, {}, g).decision).not.toBe("allow");
    }
  });

  it.each(["grantId", "runId", "requestHash", "browserId", "tabId", "origin"] as const)("rejects proof for another %s", key => {
    const taskScope = { ...proof(), [key]: key === "tabId" ? 2 : "other" };
    expect(decide("browser_read", {}, { taskScope }).decision).not.toBe("allow");
  });

  it("preserves expiry, step limits, missing classes and denied standing preferences", () => {
    expect(decide("browser_read", {}, { now: 50_000 }).decision).toBe("deny");
    expect(decide("browser_read", {}, { used: 20 }).decision).toBe("deny");
    expect(decide("browser_read", {}, {}, { ...grant(), actions: ["navigate"] }).decision).toBe("deny");
    expect(decide("browser_read", {}, { rules: [{ key: "portal:read:portal.example", decision: "deny" }] }).decision).toBe("ask");
  });

  it("does not use this allowance to change sites, write, transfer files, or use arbitrary controls", () => {
    for (const [tool, args] of [
      ["browser_navigate", { url: "https://other.example/invoices" }],
      ["browser_navigate", { url: "https://portal.example/api/delete?id=7" }],
      ["browser_click_semantic", { ref: "@e3" }], ["browser_click_semantic", { ref: "@e4" }],
      ["browser_click_semantic", { ref: "@e7" }], ["browser_download", { ref: "@e5" }],
      ["browser_upload", { ref: "@e6", file: "unknown.csv" }],
      ["browser_fill", { ref: "@e6", value: "arbitrary" }], ["browser_press", { ref: "@e1", key: "Enter" }],
      ["browser_select", { ref: "@e6", values: ["other"] }],
    ] as const) expect(decide(tool, args).decision, `${tool} ${JSON.stringify(args)}`).not.toBe("allow");
  });

  it("follows a plain link to a read-only page of the same site, but not a confirming or consequential one, nor one beside a control that changes records", () => {
    const links = { ...page, text: '@vom 1\nL1 page\n  navigation "Main"\n    @e1 link "Reports" url="/reports"\n  main\n    table "Results"\n      row\n        @e2 link "Tenant contact export" url="https://portal.example/reports/tenants?format=csv"\n      row\n        @e3 link "Continue" url="/next"\n      row\n        @e4 link "Delete tenant" url="/tenants/4"\n      row\n        @e5 link "Approve" url="/approvals"' };
    const plain = { ...links, text: links.text.split("\n").slice(0, 8).join("\n") };
    for (const ref of ["@e1", "@e2"]) expect(decide("browser_click_semantic", { ref }, {}, grant(), plain), ref).toMatchObject({ decision: "allow", note: "allowed for this browser task" });
    // A confirming name, a deletion, or any link on a page that also offers one, still asks.
    for (const ref of ["@e1", "@e2", "@e3", "@e4", "@e5"]) expect(decide("browser_click_semantic", { ref }, {}, grant(), links).decision, ref).not.toBe("allow");
    // The page's own Save and Log out buttons sit in the same main region: its plain link asks too.
    expect(decide("browser_click_semantic", { ref: "@e5" }).decision).not.toBe("allow");
    // Without the live task scope a plain link asks as before.
    expect(decide("browser_click_semantic", { ref: "@e1" }, { taskScope: undefined }, grant(), links).decision).toBe("ask");
  });

  it("asks before a harmless-looking link whose address writes, leaves the site, runs script, submits a form or is not shown", () => {
    const one = (line: string) => ({ url: page.url, text: `@vom 1\nL1 page\n  main\n    ${line}` });
    const click = (observation: BrowserObservation) => decide("browser_click_semantic", { ref: "@e1" }, {}, grant(), observation).decision;
    // The control: the same label to a reading page of this site is followed without a card.
    expect(click(one('@e1 link "Tenant 123" url="/tenants/123"'))).toBe("allow");
    for (const url of ["/tenants/123/delete", "/tenants/123?action=archive", "/tenants?delete=123", "/tenants/123?do=%61pprove", "/process/run", "/account/logout",
      "/api/tenants/123", "javascript:deleteTenant(123)", "data:text/html,hi", "#", "/tenants/123#edit", "https://other.example/tenants", "https://evil.portal.example/tenants",
      "//evil.example/tenants", "http://portal.example/tenants", "https://portal.example:8443/tenants", "https://user@portal.example/tenants", ""]) {
      expect(click(one(`@e1 link "Tenant 123" url=${JSON.stringify(url)}`)), url).not.toBe("allow");
    }
    // No address (an onclick-only link), a button styled as a link, a link inside a form or dialog, a hidden link.
    for (const line of ['@e1 link "Tenant 123"', '@e1 button "Tenant 123" url="/tenants/123"', 'form "Tenant"\n      @e1 link "Tenant 123" url="/tenants/123"',
      'dialog "Tenant"\n      @e1 link "Tenant 123" url="/tenants/123"', '@e1 link "Tenant 123" [hidden] url="/tenants/123"']) {
      expect(click(one(line)), line).not.toBe("allow");
    }
    // The address is RealBud's to check: a name cannot smuggle one in, and the label never carries it.
    expect(click(one('@e1 link "Tenant url=\\"/tenants/1\\""'))).not.toBe("allow");
  });

  it("retains bound account proof and rejects a search button inside a save form", () => {
    const g = { ...grant(), browser: { id: "fictional-browser", accountMarker: "Fictional office" } };
    expect(decide("browser_fill", { ref: "@e1", value: "FICT-7" }, {}, g).decision).not.toBe("allow");
    const withAccount = { ...page, text: page.text + '\n    paragraph "Fictional office"' };
    expect(decide("browser_fill", { ref: "@e1", value: "FICT-7" }, {}, g, withAccount).decision).toBe("allow");
    expect(decide("browser_fill", { ref: "@e1", value: "FICT-7" }, { taskScope: { ...proof(g), accountMarker: "Other office" } }, g, withAccount).decision).not.toBe("allow");
    const unsafe = { ...page, text: '@vom 1\nL1 page\n  main\n    form "Edit invoice"\n      @e1 searchbox "Search"\n      @e2 button "Search"\n      @e3 button "Save"' };
    expect(decide("browser_click_semantic", { ref: "@e2" }, {}, grant(), unsafe).decision).not.toBe("allow");
  });
});
