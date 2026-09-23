import { describe, expect, it } from "vitest";
import { browserTaskSite, legacyBrowserActions, parseBrowserTaskGrant, type BrowserTaskGrant } from "./browser-task.ts";

const grant = (): BrowserTaskGrant => ({
  version: 1,
  purpose: "browser-task-grant",
  id: "grant-fictional-1",
  runId: "run-fictional-1",
  route: "ask",
  request: { text: "Download this month's fictional invoices", sha256: "a".repeat(64) },
  sites: ["portal.example", "https://billing.example"],
  browser: { id: "fictional-browser", accountMarker: "Fictional Office" },
  actions: ["read", "navigate", "click", "download"],
  consequential: "ask-each",
  uploads: [{ name: "fictional-invoice.pdf", sha256: "b".repeat(64) }],
  expiresAt: 1_900_000_000_000,
  budget: 40,
});

describe("browser task grant", () => {
  it("round-trips a complete grant", () => {
    expect(parseBrowserTaskGrant(grant())).toEqual(grant());
  });

  it.each([
    ["an unknown key", { ...grant(), extra: true }],
    ["another version", { ...grant(), version: 2 }],
    ["another purpose", { ...grant(), purpose: "browser-task" }],
    ["a configurable consequential policy", { ...grant(), consequential: "allow" }],
    ["a duplicate action", { ...grant(), actions: ["read", "read"] }],
    ["an unknown action", { ...grant(), actions: ["read", "pay"] }],
    ["an http site", { ...grant(), sites: ["http://portal.example"] }],
    ["a site with a path", { ...grant(), sites: ["https://portal.example/login"] }],
    ["a site with credentials", { ...grant(), sites: ["https://user:secret@portal.example"] }],
    ["a bad request hash", { ...grant(), request: { text: "Fictional", sha256: "short" } }],
    ["an extra request key", { ...grant(), request: { text: "Fictional", sha256: "a".repeat(64), scope: "all" } }],
    ["an upload path", { ...grant(), uploads: [{ name: "../fictional.pdf", sha256: "b".repeat(64) }] }],
    ["an upload name with a drive or stream separator", { ...grant(), uploads: [{ name: "fictional.pdf:hidden", sha256: "b".repeat(64) }] }],
    ["an upload name that is only dots", { ...grant(), uploads: [{ name: "..", sha256: "b".repeat(64) }] }],
    ["an upload name with a trailing dot", { ...grant(), uploads: [{ name: "fictional.pdf.", sha256: "b".repeat(64) }] }],
    ["two uploads with one name", { ...grant(), uploads: [{ name: "Fictional.pdf", sha256: "b".repeat(64) }, { name: "fictional.pdf", sha256: "c".repeat(64) }] }],
    ["an unknown route", { ...grant(), route: "anywhere" }],
    ["a zero budget", { ...grant(), budget: 0 }],
  ])("rejects %s with a user-facing sentence", (_name, value) => {
    expect(() => parseBrowserTaskGrant(value)).toThrow("This browser task permission is incomplete or damaged. Start the task again from your request.");
  });

  it("accepts only exact HTTPS sites", () => {
    for (const site of ["portal.example", "https://portal.example", "vantagestrata.com.au"]) expect(browserTaskSite(site)).toBe(true);
    for (const site of ["portal", "https://portal.example:8443", "https://portal.example/?q=1", "ftp://portal.example", " portal.example"]) expect(browserTaskSite(site)).toBe(false);
  });

  it.each([
    [[], []],
    [["read-book", "draft"], []],
    [["portal-read"], ["read", "navigate", "click"]],
    [["portal-prefill"], ["read", "navigate", "click", "fill"]],
    [["portal-read", "portal-prefill"], ["read", "navigate", "click", "fill"]],
    [["portal-read", "portal-prefill", "portal-submit"], ["read", "navigate", "click", "fill", "submit"]],
    [["portal-read", "portal-submit"], ["read", "navigate", "click", "submit"]],
  ])("maps saved-job capabilities %j to exactly their earlier actions", (capabilities, actions) => {
    expect(legacyBrowserActions(capabilities)).toEqual(actions);
  });
});
