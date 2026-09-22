import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  authorizeBrowserAction,
  BrowserApprovalStore,
  browserApprovalDraft,
  classifyBrowserAction,
  consequentialKind,
  legacyBrowserGrant,
  type BrowserObservation,
} from "./browser-authority.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { parseBrowserTaskGrant, type BrowserTaskGrant } from "../shared/browser-task.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const RUN = "3d7e8a52-0b8f-4c2a-9a55-2f4f0a3f1e01";
const grant = (capabilities: string[] = ["portal-read", "portal-prefill", "portal-submit"]) =>
  legacyBrowserGrant({ runId: RUN, allowedOrigins: ["portal.example"], capabilities });
const page = (text: string, url = "https://portal.example/work"): BrowserObservation => ({ url, text });
const PAY_PAGE = page('Pay a bill\nPayee: Fictional Plumbing Pty Ltd\nAmount: AUD 480.00\nReference: INV-FICTIONAL-7\n@e1 button "Pay now"\n@e2 button "Show details"');
const BANK_PAGE = page('Fictional Bank\nTransaction history\n@e1 button "Confirm"\n@e2 button "Settings"\n@e3 button "View statement"\n@e4 textbox "Amount"');

describe("browser action classification (one table)", () => {
  it.each([
    ["tab list", null, "browser_tabs", {}, "routine", undefined],
    ["release", null, "browser_release", {}, "routine", undefined],
    ["borrow on the site", page(""), "browser_borrow", { tab_id: 1 }, "routine", undefined],
    ["read on the site", page(""), "browser_read", { tab_id: 1 }, "routine", undefined],
    ["read on another site", page("", "https://other.example/"), "browser_read", { tab_id: 1 }, "out-of-scope", undefined],
    ["unlisted tool", page(""), "browser_evaluate", {}, "out-of-scope", undefined],
    ["same-site navigation", page(""), "browser_navigate", { url: "https://portal.example/reports" }, "routine", undefined],
    ["cross-site navigation", page(""), "browser_navigate", { url: "https://other.example/reports" }, "out-of-scope", undefined],
    ["navigation with a fragment", page(""), "browser_navigate", { url: "https://portal.example/reports#x" }, "out-of-scope", undefined],
    ["payment link", page(""), "browser_navigate", { url: "https://portal.example/pay?bill=1" }, "consequential", "pay"],
    ["password field", page('@e1 textbox "Password"'), "browser_fill", { ref: "@e1", value: "x" }, "credential", undefined],
    ["BSB field", page('@e1 textbox "BSB"'), "browser_fill", { ref: "@e1", value: "x" }, "credential", undefined],
    ["sign-in control", page('@e1 button "Sign in"'), "browser_click_semantic", { ref: "@e1" }, "credential", undefined],
    ["ordinary field", page('@e1 textbox "Property code"'), "browser_fill", { ref: "@e1", value: "FICT-1" }, "routine", undefined],
    ["field on a bank page", BANK_PAGE, "browser_fill", { ref: "@e4", value: "100" }, "consequential", "pay"],
    ["key presses in a value", page('@e1 textbox "Notes"'), "browser_fill", { ref: "@e1", value: "a\nb" }, "out-of-scope", undefined],
    ["stale reference", page('@e1 button "Open"'), "browser_click_semantic", { ref: "@e9" }, "out-of-scope", undefined],
    ["Pay now", page('@e1 button "Pay now"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "pay"],
    ["Transfer money", page('@e1 button "Transfer money"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "pay"],
    ["Approve payment", page('@e1 button "Approve payment"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "pay"],
    ["Sign lease", page('@e1 button "Sign lease"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "sign"],
    ["Issue notice", page('@e1 button "Issue notice"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "notice"],
    ["Terminate", page('@e1 button "Terminate"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "notice"],
    ["Send", page('@e1 button "Send"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "send"],
    ["Delete record", page('@e1 button "Delete record"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "delete"],
    ["Log out", page('@e1 button "Log out"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "account-change"],
    ["Add payee", page('@e1 button "Add payee"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "account-change"],
    ["Show details", page('@e1 button "Show details"'), "browser_click_semantic", { ref: "@e1" }, "routine", undefined],
    ["Save on an ordinary form", page('@e1 button "Save"'), "browser_click_semantic", { ref: "@e1" }, "routine", undefined],
    ["Confirm on a bank page", BANK_PAGE, "browser_click_semantic", { ref: "@e1" }, "consequential", "pay"],
    ["Settings on a bank page", BANK_PAGE, "browser_click_semantic", { ref: "@e2" }, "unknown", undefined],
    ["View statement on a bank page", BANK_PAGE, "browser_click_semantic", { ref: "@e3" }, "routine", undefined],
    ["Continue on a payment page", page('Payee: Fictional Plumbing\nAmount: $120.00\n@e1 button "Continue"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "pay"],
    ["Yes on a delete dialog", page('Are you sure you want to delete invoice FICT-9?\n@e1 button "Yes"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "delete"],
    ["Submit on a signature page", page('Sign here to accept the fictional lease\n@e1 button "Submit"'), "browser_click_semantic", { ref: "@e1" }, "consequential", "sign"],
  ] as const)("%s", (_name, observation, tool, args, expected, kind) => {
    const classification = classifyBrowserAction(grant(), observation, tool, { ...args });
    expect(classification.class).toBe(expected);
    if (kind) expect(classification).toMatchObject({ kind });
  });

  it("keeps the earlier word lists in one table", () => {
    for (const label of ["Pay now", "Send notice", "Sign lease", "Delete record", "Terminate", "Evict", "BPAY", "Direct debit", "Authorise", "Approve payment",
      "Transfer money", "Remit", "Purchase", "Buy", "Order", "Execute", "Trade", "Close account", "Beneficiary", "Payee", "Cancel", "Unsubscribe", "Logout", "Log out", "Remove"]) {
      expect(consequentialKind(label), label).not.toBeNull();
    }
    for (const label of ["Show details", "Next page", "Sign in", "Log in", "In order to read", "Lodge request", "Signed documents"]) expect(consequentialKind(label), label).toBeNull();
  });
});

describe("browser action authorisation", () => {
  const readRule = [{ key: "portal:read:portal.example", decision: "allow" as const }, { key: "portal:prefill:portal.example", decision: "allow" as const }];

  it("lets site rules allow only routine reading and prefill", () => {
    expect(authorizeBrowserAction(grant(), page(""), "browser_read", { tab_id: 1 }, { rules: readRule })).toMatchObject({ decision: "allow", note: "allowed by rule · Reading on portal.example" });
    expect(authorizeBrowserAction(grant(), page('@e1 textbox "Property code"'), "browser_fill", { ref: "@e1", value: "FICT-1" }, { rules: readRule })).toMatchObject({ decision: "allow" });
    expect(authorizeBrowserAction(grant(), page('@e1 button "Show details"'), "browser_click_semantic", { ref: "@e1" }, { rules: readRule })).toMatchObject({ decision: "ask", once: false });
    expect(authorizeBrowserAction(grant(), page(""), "browser_read", { tab_id: 1 })).toMatchObject({
      decision: "ask", once: false, fence: { surface: "portal-read", origin: "portal.example", ruleOffer: { surface: "portal-read", origin: "portal.example", label: "Reading on portal.example" } },
    });
  });

  it("keeps a saved job's earlier limits", () => {
    expect(authorizeBrowserAction(grant(["portal-read"]), page('@e1 textbox "Property code"'), "browser_fill", { ref: "@e1", value: "x" }))
      .toMatchObject({ decision: "deny", reason: "This job is read-only. Add prefill on Schedule if Bud should fill forms." });
    expect(authorizeBrowserAction(grant(["portal-read", "portal-prefill"]), page('@e1 button "Save"'), "browser_click_semantic", { ref: "@e1" }))
      .toMatchObject({ decision: "deny", reason: "This job cannot press Submit. Add 'Bud may press Submit' on the job if it should." });
    expect(authorizeBrowserAction(grant(), page('@e1 button "Save"'), "browser_click_semantic", { ref: "@e1" }))
      .toMatchObject({ decision: "ask", once: false, summary: "Bud wants to press 'Save' on portal.example. Check the form in the browser first.", fence: { surface: "portal-submit", ruleOffer: null } });
    expect(authorizeBrowserAction(grant(), page(""), "browser_navigate", { url: "https://portal.example/pay" }))
      .toMatchObject({ decision: "deny", reason: "Open this page yourself. Bud can only navigate within the job's exact HTTPS site, without account-changing links." });
    expect(authorizeBrowserAction(grant(), page('@e1 textbox "Payment reference"'), "browser_fill", { ref: "@e1", value: "x" })).toMatchObject({ decision: "deny" });
    expect(authorizeBrowserAction(grant(), BANK_PAGE, "browser_fill", { ref: "@e4", value: "100" }))
      .toMatchObject({ decision: "deny", reason: "This page is for reading. Enter bank and financial details yourself." });
  });

  it("asks once, with verified facts, for a consequential control", () => {
    const auth = authorizeBrowserAction(grant(), PAY_PAGE, "browser_click_semantic", { ref: "@e1" }, { rules: readRule, now: 1_000 });
    expect(auth).toMatchObject({ decision: "ask", once: true, fence: { surface: "portal-submit", origin: "portal.example", ruleOffer: null } });
    if (auth.decision !== "ask" || !auth.draft) throw new Error("expected an approval draft");
    expect(auth.draft).toMatchObject({ kind: "pay", origin: "https://portal.example", url: "https://portal.example/work", control: { ref: "@e1", label: "Pay now" }, unconfirmed: [], expiresAt: 121_000 });
    expect(Object.fromEntries(auth.draft.facts.map(fact => [fact.name, fact.value]))).toEqual({ recipient: "Fictional Plumbing Pty Ltd", amount: "480.00", currency: "AUD", reference: "INV-FICTIONAL-7" });
    expect(auth.summary).toBe("Pay AUD 480.00 to Fictional Plumbing Pty Ltd (reference INV-FICTIONAL-7) by pressing 'Pay now' on portal.example. This approval is for this one payment and expires in 2 minutes.");
  });

  it.each([
    ["no payee", 'Amount: $480.00\n@e1 button "Pay now"', ["recipient"]],
    ["two amounts", 'Payee: Fictional Plumbing\nBalance $900.00 and due $480.00\n@e1 button "Pay now"', ["amount", "currency"]],
    ["two payees", 'Payee: Fictional Plumbing\nPayee: Fictional Roofing\nAmount: $1\n@e1 button "Pay now"', ["recipient"]],
    ["no document", '@e1 button "Sign lease"', ["document"]],
    ["no message body", 'To: fictional@example.test\n@e1 button "Send"', ["bodyHash"]],
    ["bare delete", '@e1 button "Delete"', ["target"]],
  ])("does not approve facts the page does not confirm: %s", (_name, text, missing) => {
    const auth = authorizeBrowserAction(grant(), page(text), "browser_click_semantic", { ref: "@e1" });
    expect(auth.decision).toBe("deny");
    if (auth.decision !== "deny" || !auth.draft) throw new Error("expected a denied draft");
    expect(auth.draft.unconfirmed).toEqual(missing);
    expect(auth.reason).toMatch(/cannot be approved\. It stays with the person\.$/);
  });

  it("binds documents, messages and targets to what the page shows", () => {
    const sign = browserApprovalDraft("sign", page('@e1 heading "Fictional Residential Lease"\n@e2 button "Sign lease"'), "@e2", 'button "Sign lease"');
    expect(sign.unconfirmed).toEqual([]);
    expect(sign.facts.find(fact => fact.name === "document")?.value).toBe("Fictional Residential Lease");
    const send = browserApprovalDraft("send", page('@e1 textbox "To" value="fictional@example.test"\n@e2 textbox "Subject" value="Fictional rent"\n@e3 textbox "Message" value="Hello"\n@e4 button "Send"'), "@e4", 'button "Send"');
    expect(send.unconfirmed).toEqual([]);
    expect(send.facts.map(fact => fact.name)).toEqual(["to", "subject", "bodyHash"]);
    const changed = browserApprovalDraft("send", page('@e1 textbox "To" value="fictional@example.test"\n@e2 textbox "Subject" value="Fictional rent"\n@e3 textbox "Message" value="Hello again"\n@e4 button "Send"'), "@e4", 'button "Send"');
    expect(changed.fingerprint).not.toBe(send.fingerprint);
    expect(browserApprovalDraft("delete", page('@e1 button "Delete invoice FICT-9"'), "@e1", 'button "Delete invoice FICT-9"').facts).toEqual([{ name: "target", value: "invoice FICT-9", confirmed: true }]);
  });

  it("never lets a redacted fact authorise the original value", () => {
    const draft = browserApprovalDraft("pay", page('Payee: api_key=fictionalfictional123\nAmount: $5.00\n@e1 button "Pay"'), "@e1", 'button "Pay"');
    expect(draft.unconfirmed).toContain("recipient");
    expect(JSON.stringify(draft)).not.toContain("fictionalfictional123");
  });

  it("asks once for an unknown control on a financial page and denies credentials", () => {
    expect(authorizeBrowserAction(grant(), BANK_PAGE, "browser_click_semantic", { ref: "@e2" })).toMatchObject({ decision: "ask", once: true, fence: { ruleOffer: null } });
    expect(authorizeBrowserAction(grant(), page('@e1 textbox "One-time code"'), "browser_fill", { ref: "@e1", value: "x" }, { rules: readRule })).toMatchObject({ decision: "deny" });
    expect(authorizeBrowserAction(grant(), page("", "https://other.example/"), "browser_read", { tab_id: 1 }, { rules: [{ key: "portal:read:other.example", decision: "allow" }] })).toMatchObject({ decision: "deny" });
  });

  it("ends with the grant's expiry and step budget", () => {
    const base = grant();
    const limited: BrowserTaskGrant = parseBrowserTaskGrant({ ...base, expiresAt: 5_000, budget: 2 });
    expect(authorizeBrowserAction(limited, page(""), "browser_read", { tab_id: 1 }, { now: 5_000 })).toMatchObject({ decision: "deny" });
    expect(authorizeBrowserAction(limited, page(""), "browser_read", { tab_id: 1 }, { now: 1_000, used: 2 })).toMatchObject({ decision: "deny" });
    expect(authorizeBrowserAction(limited, null, "browser_release", {}, { now: 9_000, used: 9 })).toMatchObject({ decision: "allow" });
  });

  it("never allows a consequential classification, whatever the rules or grant", () => {
    // Deterministic generator: consequential words inside varied labels and pages.
    let seed = 7;
    const next = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
    const words = ["Pay", "Transfer", "Send", "Sign", "Delete", "Remove", "Terminate", "Notice", "Cancel", "Log out", "Approve", "Authorise", "BPAY", "Add payee", "Confirm", "Continue", "Yes", "Submit"];
    const fillers = ["now", "all", "invoice FICT-1", "the lease", "", "securely", "today"];
    const pages = ["", "Payee: Fictional Plumbing\nAmount: AUD 10.00\n", "Fictional Bank\nTransaction history\n", "Are you sure you want to delete invoice FICT-2?\n", "Sign here\n"];
    const everyRule = ["portal:read:portal.example", "portal:prefill:portal.example", "portal:submit:portal.example", "browser_click_semantic", "*"].map(key => ({ key, decision: "allow" as const }));
    const grants = [grant(), grant(["portal-read"]), parseBrowserTaskGrant({ ...grant(), actions: ["read", "navigate", "fill", "click", "download", "upload", "keys", "submit"] })];
    let consequential = 0;
    for (let i = 0; i < 600; i++) {
      const label = `${words[next(words.length)]} ${fillers[next(fillers.length)]}`.trim();
      const observation = page(`${pages[next(pages.length)]}@e1 button "${label}"`);
      const g = grants[next(grants.length)];
      const classification = classifyBrowserAction(g, observation, "browser_click_semantic", { ref: "@e1" });
      if (classification.class !== "consequential") continue;
      consequential += 1;
      for (const rules of [[], everyRule]) {
        expect(authorizeBrowserAction(g, observation, "browser_click_semantic", { ref: "@e1" }, { rules }).decision, label).not.toBe("allow");
      }
    }
    expect(consequential).toBeGreaterThan(300);
  });
});

describe("browser approval records", () => {
  it("persists privately before use and holds a damaged history", async () => {
    const root = privateTempRoot(join(tmpdir(), "rb-browser-approvals-")); cleanup.push(() => removeFixture(root));
    const file = join(root, "approvals.json");
    const store = new BrowserApprovalStore({ file });
    const auth = authorizeBrowserAction(grant(), PAY_PAGE, "browser_click_semantic", { ref: "@e1" }, { now: 10 });
    if (auth.decision !== "ask" || !auth.draft) throw new Error("expected an approval draft");
    const saved = await store.create(auth.draft, { grantId: grant().id, runId: RUN, threadId: "thread-fictional" }, "pending", 10);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).approvals[0]).toMatchObject({ id: saved.id, decision: "pending", outcome: "not-dispatched" });
    await store.update(saved.id, { decision: "approved", outcome: "unknown", decidedAt: 20 });
    expect(await new BrowserApprovalStore({ file }).unresolved(saved.fingerprint, 30)).toMatchObject({ id: saved.id });
    writeFileSync(file, "{\"version\":1,\"purpose\":\"browser-approvals\",\"approvals\":[{}]}", { mode: 0o600 });
    const damaged = new BrowserApprovalStore({ file });
    await expect(damaged.create(auth.draft, { grantId: grant().id, runId: RUN, threadId: "thread-fictional" }, "pending")).rejects.toThrow(/needs recovery/);
    expect(readFileSync(file, "utf8")).toContain("\"approvals\":[{}]");
  });
});
