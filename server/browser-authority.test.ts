import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  authorizeBrowserAction,
  BrowserApprovalStore,
  browserApprovalDraft,
  browserKey,
  classifyBrowserAction,
  consequentialKind,
  accountMarkerShown,
  legacyBrowserGrant,
  type BrowserObservation,
  type BrowserPortalControls,
} from "./browser-authority.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { parseBrowserTaskGrant, type BrowserActionClass, type BrowserTaskGrant } from "../shared/browser-task.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const RUN = "3d7e8a52-0b8f-4c2a-9a55-2f4f0a3f1e01";
const grant = (capabilities: string[] = ["portal-read", "portal-prefill", "portal-submit"]) =>
  legacyBrowserGrant({ runId: RUN, allowedOrigins: ["portal.example"], capabilities });
/** An explicit task grant on the same site: the saved job's grant without its `legacy-job` marker. */
const explicitTask = (overrides: Partial<BrowserTaskGrant>) => {
  const { origin: _savedJob, ...base } = grant();
  return parseBrowserTaskGrant({ ...base, ...overrides });
};
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
    expect(send.facts.map(fact => fact.name)).toEqual(["to", "subject", "bodyHash", "bodyExcerpt"]);
    const changed = browserApprovalDraft("send", page('@e1 textbox "To" value="fictional@example.test"\n@e2 textbox "Subject" value="Fictional rent"\n@e3 textbox "Message" value="Hello again"\n@e4 button "Send"'), "@e4", 'button "Send"');
    expect(changed.fingerprint).not.toBe(send.fingerprint);
    expect(browserApprovalDraft("delete", page('@e1 button "Delete invoice FICT-9"'), "@e1", 'button "Delete invoice FICT-9"').facts).toEqual([{ name: "target", value: "invoice FICT-9", confirmed: true }]);
  });

  it("shows a short redacted excerpt of the message being sent; the hash still binds all of it", () => {
    const body = `Hello, the fictional rent for September is due. api_key=fictionalfictional123 ${"filler ".repeat(60)}`;
    const draft = browserApprovalDraft("send", page(`@e1 textbox "To" value="fictional@example.test"\n@e2 textbox "Message" value="${body}"\n@e3 button "Send"`), "@e3", 'button "Send"');
    expect(draft.unconfirmed).toEqual([]);
    const excerpt = draft.facts.find(fact => fact.name === "bodyExcerpt")!;
    expect(excerpt.confirmed).toBe(true);
    expect(excerpt.value!.startsWith("Hello, the fictional rent for September is due.")).toBe(true);
    expect(excerpt.value!.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(draft)).not.toContain("fictionalfictional123");
    expect(JSON.stringify(draft)).not.toContain("filler ".repeat(40));
    const edited = browserApprovalDraft("send", page(`@e1 textbox "To" value="fictional@example.test"\n@e2 textbox "Message" value="${body}!"\n@e3 button "Send"`), "@e3", 'button "Send"');
    expect(edited.facts.find(fact => fact.name === "bodyExcerpt")!.value).toBe(excerpt.value);
    expect(edited.fingerprint).not.toBe(draft.fingerprint);
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
    const grants = [grant(), grant(["portal-read"]), explicitTask({ actions: ["read", "navigate", "fill", "click", "download", "upload", "keys", "submit"] })];
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

describe("keys, dropdowns, downloads and uploads", () => {
  const ALL = ["read", "navigate", "fill", "click", "download", "upload", "keys", "submit"] as const;
  const task = (actions: readonly string[] = ALL) => explicitTask({ actions: [...actions] as BrowserActionClass[], uploads: [{ name: "fictional-lease.pdf", sha256: "b".repeat(64) }] });
  const PAY_FORM = page(`${PAY_PAGE.text}\n@e3 textbox "Amount"\n@e4 combobox "Frequency"`);
  const FORM = page('@e1 textbox "Property code"\n@e2 searchbox "Search tenants"\n@e3 button "Show details"\n@e4 combobox "Sort by"\n@e5 row "Invoice FICT-3"\n@e6 button "Choose file"\n@e7 link "Download report"\n@e8 button "Download payment receipt"\n@e9 textbox "Password"');
  const everyRule = ["portal:read:portal.example", "portal:prefill:portal.example", "portal:submit:portal.example"].map(key => ({ key, decision: "allow" as const }));

  it.each([
    ["Tab in a field", FORM, "browser_press", { ref: "@e1", key: "Tab" }, "routine", "keys"],
    ["Shift+Tab in a field", FORM, "browser_press", { ref: "@e1", key: "shift+tab" }, "routine", "keys"],
    ["typing in a field", FORM, "browser_press", { ref: "@e1", key: "a" }, "routine", "fill"],
    ["Enter in a field submits its form", FORM, "browser_press", { ref: "@e1", key: "Enter" }, "routine", "submit"],
    ["Ctrl+S saves the form", FORM, "browser_press", { ref: "@e3", key: "Ctrl+S" }, "routine", "submit"],
    ["Enter in a search box reads", FORM, "browser_press", { ref: "@e2", key: "Enter" }, "routine", "keys"],
    ["Enter on a button presses it", FORM, "browser_press", { ref: "@e3", key: "Enter" }, "routine", "click"],
    ["Delete on a row", FORM, "browser_press", { ref: "@e5", key: "Delete" }, "consequential", "delete"],
    ["a letter outside a field", FORM, "browser_press", { ref: "@e3", key: "r" }, "unknown", undefined],
    ["an unknown shortcut", FORM, "browser_press", { ref: "@e1", key: "Alt+w" }, "unknown", undefined],
    ["paste", FORM, "browser_press", { ref: "@e1", key: "Meta+V" }, "out-of-scope", undefined],
    ["an unsupported key", FORM, "browser_press", { ref: "@e1", key: "Hyper+Enter" }, "out-of-scope", undefined],
    ["a key sequence", FORM, "browser_press", { ref: "@e1", key: "Enter Enter" }, "out-of-scope", undefined],
    ["typing in a password field", FORM, "browser_press", { ref: "@e9", key: "a" }, "credential", undefined],
    ["Enter on a payment form", PAY_FORM, "browser_press", { ref: "@e3", key: "Enter" }, "consequential", "pay"],
    ["an arrow in a payment form's dropdown", PAY_FORM, "browser_press", { ref: "@e4", key: "ArrowDown" }, "consequential", "pay"],
    ["an ordinary dropdown", FORM, "browser_select", { ref: "@e4", values: ["date"] }, "routine", "fill"],
    ["a destructive option", FORM, "browser_select", { ref: "@e4", values: ["delete-all"] }, "consequential", "delete"],
    ["a dropdown on a payment form", PAY_FORM, "browser_select", { ref: "@e4", values: ["monthly"] }, "consequential", "pay"],
    ["a dropdown on a bank page", page(`${BANK_PAGE.text}\n@e5 combobox "Account"`), "browser_select", { ref: "@e5", values: ["fictional-1"] }, "unknown", undefined],
    ["no option values", FORM, "browser_select", { ref: "@e4", values: [] }, "out-of-scope", undefined],
    ["a password dropdown", FORM, "browser_select", { ref: "@e9", values: ["x"] }, "credential", undefined],
    ["a report download", FORM, "browser_download", { ref: "@e7" }, "routine", "download"],
    ["a receipt download that names a payment", FORM, "browser_download", { ref: "@e8" }, "unknown", undefined],
    ["a payment control as a download", PAY_PAGE, "browser_download", { ref: "@e1" }, "consequential", "pay"],
    ["a granted upload", FORM, "browser_upload", { ref: "@e6", file: "fictional-lease.pdf" }, "routine", "upload"],
    ["an upload the task was not given", FORM, "browser_upload", { ref: "@e6", file: "other.pdf" }, "out-of-scope", undefined],
    ["an upload on a payment form", page(`${PAY_PAGE.text}\n@e3 button "Choose file"`), "browser_upload", { ref: "@e3", file: "fictional-lease.pdf" }, "unknown", undefined],
  ] as const)("%s", (_name, observation, tool, args, expected, detail) => {
    const classification = classifyBrowserAction(task(), observation, tool, { ...args });
    expect(classification.class).toBe(expected);
    if (detail) expect(classification).toMatchObject(expected === "consequential" ? { kind: detail } : { action: detail });
  });

  it("parses one key in the helper's spelling", () => {
    expect(browserKey("control+shift+enter")).toEqual({ spec: "Ctrl+Shift+Enter", key: "Enter", modifiers: ["Ctrl", "Shift"] });
    expect(browserKey("Cmd+s")).toEqual({ spec: "Meta+s", key: "s", modifiers: ["Meta"] });
    for (const bad of ["constructor", "Ctrl+Ctrl+A", "toString+A", "-", "Enter\n", "", "F13"]) expect(browserKey(bad), bad).toBeNull();
  });

  it("requires each tool's own action class, whatever the effect", () => {
    const reason = "This task does not include that browser step. Ask again with the step you need.";
    const noKeys = task(ALL.filter(action => action !== "keys"));
    expect(authorizeBrowserAction(noKeys, FORM, "browser_press", { ref: "@e3", key: "Enter" }, { rules: everyRule })).toMatchObject({ decision: "deny", reason });
    expect(authorizeBrowserAction(noKeys, PAY_FORM, "browser_press", { ref: "@e3", key: "Enter" })).toMatchObject({ decision: "deny", reason });
    expect(authorizeBrowserAction(task(["read", "keys"]), FORM, "browser_press", { ref: "@e3", key: "Enter" })).toMatchObject({ decision: "deny", reason });
    expect(authorizeBrowserAction(task(["read", "keys", "fill"]), FORM, "browser_press", { ref: "@e1", key: "Enter" }))
      .toMatchObject({ decision: "deny", reason: "This job cannot press Submit. Add 'Bud may press Submit' on the job if it should." });
    expect(authorizeBrowserAction(task(["read", "click"]), FORM, "browser_download", { ref: "@e7" })).toMatchObject({ decision: "deny", reason });
    expect(authorizeBrowserAction(task(["read", "fill"]), FORM, "browser_upload", { ref: "@e6", file: "fictional-lease.pdf" })).toMatchObject({ decision: "deny", reason });
    expect(authorizeBrowserAction(task(["read", "click"]), FORM, "browser_select", { ref: "@e4", values: ["date"] }))
      .toMatchObject({ decision: "deny", reason: "This job is read-only. Add prefill on Schedule if Bud should fill forms." });
    // A saved job's legacy grant has none of the newer classes.
    expect(authorizeBrowserAction(grant(), FORM, "browser_press", { ref: "@e1", key: "Tab" })).toMatchObject({ decision: "deny", reason });
    // Its fill class is for fields only: a saved job's own grant never chooses in a dropdown, while a task with fill may.
    expect(grant().origin).toBe("legacy-job");
    expect(authorizeBrowserAction(grant(), FORM, "browser_select", { ref: "@e4", values: ["date"] }))
      .toMatchObject({ decision: "deny", reason: "This browser tool or its arguments are not available." });
    expect(authorizeBrowserAction(task(["read", "fill"]), FORM, "browser_select", { ref: "@e4", values: ["date"] })).toMatchObject({ decision: "ask" });
  });

  it("asks once, with the verified facts, before Enter or a dropdown submits a payment form", () => {
    for (const rules of [[], everyRule]) {
      const enter = authorizeBrowserAction(task(), PAY_FORM, "browser_press", { ref: "@e3", key: "Enter" }, { rules, now: 1_000 });
      expect(enter).toMatchObject({ decision: "ask", once: true, fence: { surface: "portal-submit", ruleOffer: null } });
      if (enter.decision !== "ask" || !enter.draft) throw new Error("expected an approval draft");
      expect(enter.summary).toBe("Pay AUD 480.00 to Fictional Plumbing Pty Ltd (reference INV-FICTIONAL-7) by pressing Enter in 'Amount' on portal.example. This approval is for this one payment and expires in 2 minutes.");
      const choice = authorizeBrowserAction(task(), PAY_FORM, "browser_select", { ref: "@e4", values: ["monthly"] }, { rules, now: 1_000 });
      expect(choice).toMatchObject({ decision: "ask", once: true });
      expect(choice.decision === "ask" && choice.summary).toMatch(/by choosing 'monthly' in 'Frequency', which may submit the form on portal\.example\./);
      const click = authorizeBrowserAction(task(), PAY_FORM, "browser_click_semantic", { ref: "@e1" }, { rules, now: 1_000 });
      if (click.decision !== "ask" || !click.draft || choice.decision !== "ask" || !choice.draft) throw new Error("expected approval drafts");
      // One payment, three ways to press it: separate approvals, one effect for the never-replay hold.
      expect(new Set([enter.draft.fingerprint, choice.draft.fingerprint, click.draft.fingerprint]).size).toBe(3);
      expect(new Set([enter.draft.effect, choice.draft.effect, click.draft.effect]).size).toBe(1);
    }
  });

  it("lets a read rule allow downloads only; keys, dropdowns and uploads still ask", () => {
    expect(authorizeBrowserAction(task(), FORM, "browser_download", { ref: "@e7" }, { rules: everyRule })).toMatchObject({ decision: "allow", note: "allowed by rule · Reading on portal.example" });
    expect(authorizeBrowserAction(task(), FORM, "browser_download", { ref: "@e7" })).toMatchObject({ decision: "ask", once: false, summary: "Download the file from link \"Download report\" on portal.example into this task's private folder." });
    expect(authorizeBrowserAction(task(), FORM, "browser_press", { ref: "@e1", key: "Tab" }, { rules: everyRule })).toMatchObject({ decision: "ask", summary: "Press Tab in textbox \"Property code\" on portal.example." });
    expect(authorizeBrowserAction(task(), FORM, "browser_select", { ref: "@e4", values: ["date"] }, { rules: everyRule })).toMatchObject({ decision: "ask", fence: { surface: "portal-prefill", ruleOffer: null } });
    expect(authorizeBrowserAction(task(), FORM, "browser_upload", { ref: "@e6", file: "fictional-lease.pdf" }, { rules: everyRule }))
      .toMatchObject({ decision: "ask", once: false, summary: "Upload the task's file 'fictional-lease.pdf' into button \"Choose file\" on portal.example.", fence: { surface: "portal-prefill", ruleOffer: null } });
    expect(authorizeBrowserAction(task(), FORM, "browser_download", { ref: "@e8" }, { rules: everyRule })).toMatchObject({ decision: "ask", once: true });
    expect(authorizeBrowserAction(task(), PAY_PAGE, "browser_download", { ref: "@e1" }, { rules: everyRule })).toMatchObject({ decision: "deny", draft: null });
    expect(authorizeBrowserAction(task(), FORM, "browser_press", { ref: "@e9", key: "Enter" }, { rules: everyRule })).toMatchObject({ decision: "deny" });
  });

  it("never allows a consequential key, choice or download, whatever the rules or grant", () => {
    const pages = ["Payee: Fictional Plumbing\nAmount: AUD 10.00\n", "Fictional Bank\nTransaction history\n", "Sign here\n", 'To: fictional@example.test\n@e8 textbox "Subject" value="Rent"\n@e9 textbox "Message" value="Hi"\n'];
    const controls = ['textbox "Amount"', 'combobox "Option"', 'button "Pay now"', 'button "Send"', 'row "Invoice FICT-1"', 'button "Continue"'];
    const steps: Array<[string, Record<string, unknown>]> = [["browser_press", { key: "Enter" }], ["browser_press", { key: "Ctrl+Enter" }], ["browser_press", { key: "Space" }],
      ["browser_press", { key: "ArrowDown" }], ["browser_press", { key: "Delete" }], ["browser_select", { values: ["x"] }], ["browser_download", {}]];
    let consequential = 0;
    for (const text of pages) for (const control of controls) for (const [tool, extra] of steps) {
      const observation = page(`${text}@e1 ${control}`);
      if (classifyBrowserAction(task(), observation, tool, { ref: "@e1", ...extra }).class !== "consequential") continue;
      consequential += 1;
      expect(authorizeBrowserAction(task(), observation, tool, { ref: "@e1", ...extra }, { rules: everyRule }).decision, `${tool} ${control}`).not.toBe("allow");
    }
    expect(consequential).toBeGreaterThan(60);
  });
});

// Observations in the helper's own format (server/fixtures/browser, same syntax
// as outputs/browser-integration-2026-09-20/fictional-observation.txt).
const vom = (name: string, url = "https://portal.example/levies/pay") =>
  page(readFileSync(fileURLToPath(new URL(`./fixtures/browser/${name}.vom.txt`, import.meta.url)), "utf8"), url);
const shown = (facts: ReadonlyArray<{ name: string; value: string | null }>) =>
  Object.fromEntries(facts.filter(fact => fact.name !== "documentHash" && fact.name !== "bodyHash").map(fact => [fact.name, fact.value]));
const LOT_12 = { recipient: "Fictional Owners Corporation SP 12345", amount: "1240.00", currency: "AUD", reference: "FICT-LOT12-Q3" };
const BODY = "Hello Fictional Owner, The fictional Lot 12 levy of A$1,240.00 is due on 30 September.";

describe("facts from the helper's observation (VOM)", () => {
  it.each([
    ["a strata levy form", "strata-levy-payment", "@e6", "pay", LOT_12],
    ["one bill's row in a bills table", "bills-table", "@e11", "pay", { recipient: "Fictional Plumbing Pty Ltd", amount: "480.00", currency: "$", reference: "INV-FICT-7" }],
    ["another bill's row in the same table", "bills-table", "@e12", "pay", { recipient: "Fictional Roofing Pty Ltd", amount: "1920.50", currency: "$", reference: "INV-FICT-8" }],
    ["the first of two levy forms", "adversarial-two-levy-forms", "@e6", "pay", LOT_12],
    ["the second of two levy forms", "adversarial-two-levy-forms", "@e10", "pay", { recipient: "Fictional Owners Corporation SP 67890", amount: "2480.00", currency: "AUD", reference: "FICT-LOT14-Q3" }],
    ["an email compose dialog", "email-compose", "@e24", "send", { to: "fictional.owner@example.test", subject: "Fictional Lot 12 levy reminder", bodyExcerpt: BODY }],
    ["a document signing form", "document-signing", "@e5", "sign", { document: "Fictional Lot 12 By-law Consent" }],
  ] as const)("confirms the facts of %s", (_name, fixture, ref, kind, expected) => {
    const auth = authorizeBrowserAction(grant(), vom(fixture), "browser_click_semantic", { ref }, { now: 1_000 });
    expect(auth).toMatchObject({ decision: "ask", once: true, classification: { class: "consequential", kind } });
    if (auth.decision !== "ask" || !auth.draft) throw new Error("expected an approval draft");
    expect(auth.draft.unconfirmed).toEqual([]);
    expect(shown(auth.draft.facts)).toEqual(expected);
  });

  it("shows the levy as the form states it and binds the whole message body", () => {
    const levy = authorizeBrowserAction(grant(), vom("strata-levy-payment"), "browser_click_semantic", { ref: "@e6" });
    expect(levy.decision === "ask" && levy.summary).toBe("Pay AUD 1240.00 to Fictional Owners Corporation SP 12345 (reference FICT-LOT12-Q3) by pressing 'Pay now' on portal.example. This approval is for this one payment and expires in 2 minutes.");
    const mail = authorizeBrowserAction(grant(), vom("email-compose"), "browser_click_semantic", { ref: "@e24" });
    if (mail.decision !== "ask" || !mail.draft) throw new Error("expected an approval draft");
    expect(mail.draft.facts.find(fact => fact.name === "bodyHash")?.value).toBe(createHash("sha256").update(BODY).digest("hex"));
    // The other form's payee and amount never reach this form's card.
    const first = authorizeBrowserAction(grant(), vom("adversarial-two-levy-forms"), "browser_click_semantic", { ref: "@e6" });
    expect(JSON.stringify(first)).not.toMatch(/67890|2480|LOT14/);
  });

  it.each([
    ["the recorded helper page: Transfer money beside a transaction list", "recorded-fictional-bank", "@e3", ["recipient", "amount", "currency"]],
    ["Pay levy now beside a list of statements", "statement-download", "@e9", ["recipient", "amount", "currency"]],
    ["Pay all over a table of bills", "bills-table", "@e13", ["recipient", "amount", "currency"]],
    ["two payments with no form between them", "adversarial-two-payments-no-form", "@e5", ["recipient", "amount", "currency"]],
    ["a payee shown in a different region", "adversarial-payee-other-region", "@e6", ["recipient"]],
    ["an amount only in an aria-label and a button name", "adversarial-levy-aria-only-amount", "@e6", ["amount", "currency"]],
    ["an amount only in hidden text", "adversarial-levy-hidden-amount", "@e6", ["amount", "currency"]],
    ["a control behind the focused dialog", "adversarial-levy-behind-dialog", "@e6", ["recipient", "amount", "currency"]],
  ])("does not confirm %s, so there is no approval card", (_name, fixture, ref, missing) => {
    const auth = authorizeBrowserAction(grant(), vom(fixture), "browser_click_semantic", { ref });
    expect(auth).toMatchObject({ decision: "deny", classification: { class: "consequential", kind: "pay" } });
    if (auth.decision !== "deny" || !auth.draft) throw new Error("expected a denied draft");
    expect(auth.draft.unconfirmed).toEqual(missing);
    expect(auth.reason).toMatch(/cannot be approved\. It stays with the person\.$/);
  });

  it("binds the amount in the form: a changed amount is a different approval, refused at dispatch", () => {
    const seen = authorizeBrowserAction(grant(), vom("strata-levy-payment"), "browser_click_semantic", { ref: "@e6" });
    const changed = authorizeBrowserAction(grant(), vom("adversarial-levy-amount-changed"), "browser_click_semantic", { ref: "@e6" });
    if (seen.decision !== "ask" || !seen.draft || changed.decision !== "ask" || !changed.draft) throw new Error("expected approval drafts");
    expect(shown(changed.draft.facts)).toEqual({ ...LOT_12, amount: "12400.00" });
    // The broker re-observes before dispatch and requires the approved fingerprint (server/browser-broker.ts).
    expect(changed.draft.fingerprint).not.toBe(seen.draft.fingerprint);
    expect(changed.draft.effect).not.toBe(seen.draft.effect);
  });

  it("reads a label beside its field, term and definition, and a label split from its value", () => {
    const text = [
      "@vom 1", "@view 1280x900", "@layers 1 focus=L1", "L1 page", '  RootWebArea "Fictional garden invoice"', '    dialog "Confirm payment"',
      '      term "Biller"', '      definition "Fictional Gardening"', '      LabelText "Amount"', '      @e2 textbox value="75.50"', '      StaticText "$"',
      '      StaticText "Invoice:"', '      StaticText "FICT-GARDEN-3"', '      @e3 button "Confirm payment"',
    ].join("\n");
    const draft = browserApprovalDraft("pay", page(text), "@e3", 'button "Confirm payment"');
    expect(draft.unconfirmed).toEqual([]);
    expect(shown(draft.facts)).toEqual({ recipient: "Fictional Gardening", amount: "75.50", currency: "$", reference: "FICT-GARDEN-3" });
  });

  it("downloads a statement as reading; the page's payment still needs its facts", () => {
    const task = explicitTask({ actions: ["read", "navigate", "click", "download"] });
    expect(authorizeBrowserAction(task, vom("statement-download"), "browser_download", { ref: "@e7" })).toMatchObject({
      decision: "ask", once: false, classification: { class: "routine", action: "download" },
      summary: 'Download the file from link "Download Q3 2026 statement (PDF)" on portal.example into this task\'s private folder.',
    });
  });

  it.each([
    ["A$1,240.00", "1240.00", "AUD"],
    ["AUD 1,240.00", "1240.00", "AUD"],
    ["1,240.00 AUD", "1240.00", "AUD"],
    ["US$95", "95", "USD"],
    ["$1,240.00", "1240.00", "$"],
  ])("normalises the amount %s", (written, amount, currency) => {
    const draft = browserApprovalDraft("pay", page(`Payee: Fictional Plumbing\nAmount: ${written}\n@e1 button "Pay"`), "@e1", 'button "Pay"');
    expect(shown(draft.facts)).toMatchObject({ amount, currency });
  });

  it("takes a bare number's currency from its label or the one currency shown, never a guess", () => {
    const draft = (text: string) => browserApprovalDraft("pay", page(`Payee: Fictional Plumbing\n${text}\n@e9 button "Pay"`), "@e9", 'button "Pay"');
    expect(shown(draft('@e1 textbox "Amount (AUD)" value="1,240.00"').facts)).toMatchObject({ amount: "1240.00", currency: "AUD" });
    expect(shown(draft('Balance: A$1,240.00\n@e1 textbox "Amount" value="1240"').facts)).toMatchObject({ amount: "1240", currency: "AUD" });
    // The same amount written twice is one amount.
    expect(draft('Amount: $1,240.00\n@e1 textbox "Amount" value="1240.00"').unconfirmed).toEqual([]);
    expect(draft('@e1 textbox "Amount" value="1,240.00"').unconfirmed).toEqual(["currency"]);
  });
});

describe("a portal pack's declared read-safe controls", () => {
  const PORTAL: BrowserPortalControls = {
    origin: "https://portal.example", readSafe: ["Search", "Status", "Next", "Previous"], menu: ["Process", "Bank reconciliation"], pagination: ["Next", "Previous"], pager: { role: "navigation", name: "Pagination" },
    consequential: ["Save", "Process Receipts", "Finalise", "Reconcile", "Post", "Disburse", "Pay"], signInHosts: ["signin.portal.example"],
  };
  const task = explicitTask({ route: "ask", sites: ["https://portal.example", "https://signin.portal.example"], actions: ["read", "navigate", "click", "fill", "keys"] });
  const vom = (lines: string[], url = "https://portal.example/reconciliation/bank") => page(["@vom 1", "@view 1280x900", "@layers 1 focus=L1", "L1 page", ...lines].join("\n"), url);
  /** A bank reconciliation page: a search bar and a pager beside the grid, the page's record-changing controls elsewhere in main. */
  const BANK_LINES = [
    '  RootWebArea "Bank reconciliation"',
    "    banner", '      @e20 button "FICT1"',
    '    navigation "Main"', '      @e1 link "Process"', '        @e2 link "Bank reconciliation"', '      @e3 link "Settings"',
    "    main", '      heading "Bank reconciliation"', '      StaticText "Statement balance: 1,185.00"',
    '      region "Unreconciled items"',
    '        search "Filter"', '          @e4 textbox "Search" value=""',
    '        table "Results"', "          row", '            columnheader "Description"', "          row", '            cell "Fictional deposit"',
    '        navigation "Pagination"', '          @e5 button "Previous" [disabled]', '          @e21 link "1"', '          @e6 button "Next"',
    '      @e7 button "Save"', '      @e8 button "Process Receipts"', '      @e9 button "Finalise"', '      @e10 button "Cancel"',
  ];
  const BANK_VOM = vom(BANK_LINES);
  const use = (tool: string, args: Record<string, unknown>, observation = BANK_VOM, portal: BrowserPortalControls | null = PORTAL, grant = task) =>
    authorizeBrowserAction(grant, observation, tool, args, portal ? { portal } : {});
  /** Relaxed to a read: a routine click or fill. (Off a bank page the global rule still makes Next a routine submit, which a read grant lacks.) */
  const routine = (auth: ReturnType<typeof use>) => auth.classification.class === "routine" && auth.classification.action !== "submit";

  it("reads the search bar, a pager beside the grid and the menu as reading, on the pack's own origin", () => {
    // Without the pack's declaration the global bank heuristic still decides.
    expect(use("browser_fill", { ref: "@e4", value: "deposit" }, BANK_VOM, null)).toMatchObject({ decision: "deny", classification: { class: "consequential", kind: "pay" } });
    expect(use("browser_click_semantic", { ref: "@e6" }, BANK_VOM, null)).toMatchObject({ classification: { class: "consequential", kind: "pay" } });
    expect(use("browser_click_semantic", { ref: "@e1" }, BANK_VOM, null)).toMatchObject({ decision: "ask", once: true, classification: { class: "unknown" } });
    expect(use("browser_fill", { ref: "@e4", value: "deposit" })).toMatchObject({ decision: "ask", once: false, classification: { class: "routine", action: "fill" } });
    expect(use("browser_press", { ref: "@e4", key: "Tab" })).toMatchObject({ classification: { class: "routine", action: "keys" } });
    expect(use("browser_press", { ref: "@e4", key: "Enter" })).toMatchObject({ classification: { class: "routine", action: "keys" } });
    expect(use("browser_click_semantic", { ref: "@e6" })).toMatchObject({ decision: "ask", once: false, classification: { class: "routine", action: "click" }, fence: { surface: "portal-read" } });
    expect(use("browser_press", { ref: "@e6", key: "Enter" })).toMatchObject({ classification: { class: "routine", action: "click" } });
    expect(use("browser_click_semantic", { ref: "@e1" })).toMatchObject({ classification: { class: "routine", action: "click" } });
    expect(use("browser_click_semantic", { ref: "@e2" })).toMatchObject({ classification: { class: "routine", action: "click" } });
    // A menu link the pack does not list is not relaxed.
    expect(use("browser_click_semantic", { ref: "@e3" })).toMatchObject({ decision: "ask", once: true, classification: { class: "unknown" } });
  });

  it("keeps Save, Process, Finalise and Cancel on the same bank page approval-only", () => {
    expect(use("browser_click_semantic", { ref: "@e7" })).toMatchObject({ decision: "deny", classification: { class: "consequential", kind: "pay" } });
    for (const ref of ["@e8", "@e9"]) {
      expect(use("browser_click_semantic", { ref })).toMatchObject({ decision: "ask", once: true, classification: { class: "unknown" } });
      expect(authorizeBrowserAction(task, BANK_VOM, "browser_click_semantic", { ref }, { portal: PORTAL, rules: [{ key: "portal:read:portal.example", decision: "allow" }] }).decision).not.toBe("allow");
    }
    expect(use("browser_click_semantic", { ref: "@e10" })).toMatchObject({ classification: { class: "consequential", kind: "account-change" } });
    // A pack-consequential name is never routine, even off a bank page.
    expect(use("browser_click_semantic", { ref: "@e1" }, vom(["  main", '    @e1 button "Finalise"'], "https://portal.example/work"))).toMatchObject({ decision: "ask", once: true, classification: { class: "unknown" } });
  });

  it("never relaxes Next beside a consequential control, outside a pager by a grid, or in an unnamed form", () => {
    const bank = (lines: string[]) => vom(['  RootWebArea "Bank reconciliation"', "    main", '      heading "Bank reconciliation"',
      '      table "Results"', "        row", '          cell "Fictional deposit"', ...lines]);
    // Next loose in main (no pager group) beside a pack or global consequential control.
    for (const other of ['button "Finalise"', 'button "Post"', 'button "Disburse"', 'button "Delete batch"', 'button "Issue notice"', 'button "Close account"']) {
      expect(routine(use("browser_click_semantic", { ref: "@e1" }, bank(['      @e1 button "Next"', `      @e2 ${other}`]))), other).toBe(false);
    }
    // Next loose in main with nothing else is still not a pager beside a grid.
    expect(routine(use("browser_click_semantic", { ref: "@e1" }, bank(['      @e1 button "Next"'])))).toBe(false);
    // A pager group that holds a consequential control.
    expect(routine(use("browser_click_semantic", { ref: "@e1" }, bank(['      navigation "Pagination"', '        @e1 button "Next"', '        @e2 button "Reconcile"'])))).toBe(false);
    // A pager group with no table or grid beside it.
    expect(routine(use("browser_click_semantic", { ref: "@e1" }, vom(['  RootWebArea "Bank reconciliation"', "    main", '      navigation "Pagination"', '        @e1 button "Next"'])))).toBe(false);
    // Chromium shows an unnamed <form> as a plain generic node: Next and Save share it and nothing names a form.
    expect(routine(use("browser_click_semantic", { ref: "@e1" }, bank(["      generic", '        @e1 button "Next"', '        @e2 button "Save"'])))).toBe(false);
    // With no form around it, a page that shows a payment form anywhere keeps the global rule, even for a proper pager.
    const payingPage = bank(['      navigation "Pagination"', '        @e1 button "Next"', "      generic", '        StaticText "Payee: Fictional Plumbing"', '        StaticText "Amount: AUD 480.00"']);
    expect(routine(use("browser_click_semantic", { ref: "@e1" }, payingPage))).toBe(false);
    // A search field beside Reconcile in main (no search bar) is not relaxed either.
    expect(use("browser_fill", { ref: "@e1", value: "x" }, bank(['      @e1 textbox "Search" value=""', '      @e2 button "Reconcile"']))).toMatchObject({ decision: "deny" });
    // Next inside a named payment form stays the payment's step.
    const payForm = vom(["  main", '    form "Transfer"', '      StaticText "Payee: Fictional Plumbing"', '      StaticText "Amount: AUD 480.00"',
      '      table "Lines"', "        row", '          cell "Levy"', '      navigation "Pagination"', '        @e1 button "Next"'], "https://portal.example/bank/transfer");
    expect(routine(use("browser_click_semantic", { ref: "@e1" }, payForm))).toBe(false);
  });

  it("never relaxes a wizard's Next, a pager under an open confirm, or Next in main beside Reconcile", () => {
    const grid = ['      table "Preview"', "        row", '          cell "Fictional deposit"'];
    const withRegion = (lines: string[]) => vom(['  RootWebArea "Bank reconciliation"', "    main", '      region "Items"', ...lines.map(line => `  ${line}`)]);
    // A: a "Wizard" group holding Next and Finalise, beside a table.
    const wizard = withRegion([...grid, '      group "Wizard"', '        @e1 button "Next"', '        @e2 button "Finalise"']);
    expect(routine(use("browser_click_semantic", { ref: "@e1" }, wizard))).toBe(false);
    // A as reported: main > [table "Preview", group "Wizard" > Next, Finalise beside the group], no region.
    const reported = vom(['  RootWebArea "Wizard"', "    main", ...grid, '      group "Wizard"', '        @e1 button "Next"', '      @e2 button "Finalise"'], "https://portal.example/import");
    expect(routine(use("browser_click_semantic", { ref: "@e1" }, reported))).toBe(false);
    // A fieldset shown as a group: Next beside a field is a wizard step, not a pager.
    const fieldset = withRegion([...grid, '      group "Step 2 of 3"', '        @e1 textbox "Amount" value=""', '        @e2 button "Next"']);
    expect(routine(use("browser_click_semantic", { ref: "@e2" }, fieldset))).toBe(false);
    // A real pager (page numbers, arrows, page size) stays read-safe.
    const pager = withRegion([...grid, '      navigation "Pagination"', '        @e1 button "Previous"', '        @e2 link "1"', '        @e3 link "2"', '        @e4 button "Next"',
      '        @e5 combobox "Page size" value="25"']);
    expect(use("browser_click_semantic", { ref: "@e4" }, pager)).toMatchObject({ classification: { class: "routine", action: "click" } });
    // E: an alertdialog layered above that same valid pager.
    const confirm = vom(['  RootWebArea "Bank reconciliation"', "    main", '      region "Items"', ...[...grid, '      navigation "Pagination"', '        @e3 link "1"', '        @e4 button "Next"'].map(line => `  ${line}`),
      '    alertdialog "Finalise period?"', '      StaticText "This closes the period."', '      @e9 button "OK"']);
    expect(routine(use("browser_click_semantic", { ref: "@e4" }, confirm))).toBe(false);
    // A second layer that has focus is the same.
    const layered = page(["@vom 1", "@layers 2 focus=L2", "L1 page", "  main", '    region "Items"', ...grid.map(line => `  ${line}`), '      navigation "Pagination"', '        @e3 link "1"', '        @e4 button "Next"',
      "L2 popup", '  @e9 button "OK"'].join("\n"), "https://portal.example/reconciliation/bank");
    expect(routine(use("browser_click_semantic", { ref: "@e4" }, layered))).toBe(false);
    // I2: main > region "Step 2 of 3" > [table "Preview", group "Footer" > Next], sibling region "Footer actions" > Process Receipts.
    const i2 = vom(['  RootWebArea "Bulk receipting"', "    main", '      region "Step 2 of 3"', '        table "Preview"', "          row", '            cell "Fictional deposit"',
      '        group "Footer"', '          @e1 button "Next"', '      region "Footer actions"', '        @e2 button "Process Receipts"'], "https://portal.example/importbanklink");
    expect(routine(use("browser_click_semantic", { ref: "@e1" }, i2))).toBe(false);
    // A "Wizard" group with Previous + Next beside table "Preview", Process Receipts in a sibling region: arrows alone never make a pager.
    const arrows = vom(['  RootWebArea "Bulk receipting"', "    main", '      region "Step 2 of 3"', '        table "Preview"', "          row", '            cell "Fictional deposit"',
      '        group "Wizard"', '          @e1 button "Previous"', '          @e2 button "Next"', '      region "Footer actions"', '        @e3 button "Process Receipts"'], "https://portal.example/importbanklink");
    expect(routine(use("browser_click_semantic", { ref: "@e2" }, arrows))).toBe(false);
    // A lone Next in a navigation group beside a table, nothing consequential anywhere: still not a pager.
    const lone = vom(['  RootWebArea "Bank reconciliation"', "    main", '      region "Items"', ...grid.map(line => `  ${line}`), '        navigation "Pagination"', '          @e1 button "Next"']);
    expect(routine(use("browser_click_semantic", { ref: "@e1" }, lone))).toBe(false);
    // The pure pager (page numbers + Next beside a table, nothing consequential anywhere) stays read-safe.
    const pure = vom(['  RootWebArea "Bank reconciliation"', "    main", ...grid, '      navigation "Pagination"', '        @e1 link "1"', '        @e2 link "2"', '        @e3 button "Next"']);
    expect(use("browser_click_semantic", { ref: "@e3" }, pure)).toMatchObject({ classification: { class: "routine", action: "click" } });
    // Without a declared pager nothing is a read-safe pager, whatever its shape.
    const { pager: _pager, ...undeclared } = PORTAL;
    expect(routine(use("browser_click_semantic", { ref: "@e3" }, pure, undeclared))).toBe(false);
    // A numbered step bar has a pager's shape but is not the declared pager.
    const steps = vom(['  RootWebArea "Bank reconciliation"', "    main", ...grid, '      group "Steps"', '        @e1 button "1"', '        @e2 button "2"', '        @e3 button "3"',
      '        @e4 button "Previous"', '        @e5 button "Next"']);
    expect(routine(use("browser_click_semantic", { ref: "@e5" }, steps))).toBe(false);
    // A valid pager straight in main (no region of its own) beside Reconcile: main is its landmark.
    const inMain = vom(['  RootWebArea "Bank reconciliation"', "    main", ...grid, '      navigation "Pagination"', '        @e3 link "1"', '        @e4 button "Next"', '      @e5 button "Reconcile"']);
    expect(routine(use("browser_click_semantic", { ref: "@e4" }, inMain))).toBe(false);
  });

  it("checks the account marker only where the portal shows it", () => {
    const bound = explicitTask({ route: "ask", sites: ["https://portal.example"], actions: ["read", "click"], browser: { id: null, accountMarker: "FICT1" } });
    const marked = { ...PORTAL, accountMarker: { landmark: "banner", role: "button" } };
    expect(use("browser_click_semantic", { ref: "@e6" }, BANK_VOM, marked, bound)).toMatchObject({ classification: { class: "routine" } });
    // The banner shows FICT2; FICT1 appears only in an account-switcher list and a table cell.
    const switched = vom(BANK_LINES.map(line => line.replace('@e20 button "FICT1"', '@e20 button "FICT2"'))
      .concat(['    complementary "Switch business"', '      list', '        listitem "FICT1"', '      table "Businesses"', "        row", '          cell "FICT1"']));
    expect(use("browser_click_semantic", { ref: "@e6" }, switched, marked, bound)).toMatchObject({ decision: "deny", classification: { class: "out-of-scope" } });
  });

  it("does not relax a read-safe label on another origin, another scheme or subdomain, or without the helper's tree", () => {
    const both = explicitTask({ route: "ask", sites: ["https://portal.example", "https://other-portal.example"], actions: ["read", "navigate", "click", "fill", "keys"] });
    const elsewhere = { ...BANK_VOM, url: "https://other-portal.example/reconciliation/bank" };
    expect(use("browser_click_semantic", { ref: "@e6" }, elsewhere, PORTAL, both)).toMatchObject({ classification: { class: "consequential", kind: "pay" } });
    expect(use("browser_fill", { ref: "@e4", value: "x" }, elsewhere, PORTAL, both)).toMatchObject({ decision: "deny" });
    for (const origin of ["http://portal.example", "https://app.portal.example"]) {
      expect(use("browser_click_semantic", { ref: "@e6" }, BANK_VOM, { ...PORTAL, origin })).toMatchObject({ classification: { class: "consequential", kind: "pay" } });
    }
    expect(use("browser_click_semantic", { ref: "@e1" }, page('Bank reconciliation\n@e1 button "Next"'))).toMatchObject({ classification: { class: "consequential", kind: "pay" } });
  });

  it("only waits on the pack's sign-in host: nothing is typed, pressed or opened there", () => {
    const signIn = page('@vom 1\nL1 page\n  main\n    @e1 textbox "Email Address"\n    @e2 button "Next"', "https://signin.portal.example/authorize");
    expect(use("browser_read", { tab_id: 1 }, signIn)).toMatchObject({ decision: "ask", classification: { class: "routine", action: "read" } });
    expect(use("browser_fill", { ref: "@e1", value: "x" }, signIn)).toMatchObject({ decision: "deny", classification: { class: "credential" } });
    expect(use("browser_click_semantic", { ref: "@e2" }, signIn)).toMatchObject({ decision: "deny", classification: { class: "credential" } });
    expect(use("browser_navigate", { url: "https://signin.portal.example/other" }, signIn)).toMatchObject({ decision: "deny" });
  });

  it("requires the account marker as a whole name, not a substring", () => {
    const bound = explicitTask({ route: "ask", sites: ["https://portal.example"], actions: ["read", "click"], browser: { id: null, accountMarker: "FICT1" } });
    expect(use("browser_click_semantic", { ref: "@e6" }, BANK_VOM, PORTAL, bound)).toMatchObject({ classification: { class: "routine" } });
    const otherBusiness = vom(BANK_LINES.map(line => line.replace('"FICT1"', '"FICT10"')));
    expect(use("browser_click_semantic", { ref: "@e6" }, otherBusiness, PORTAL, bound)).toMatchObject({ decision: "deny", classification: { class: "out-of-scope" } });
    expect(accountMarkerShown("Signed in to FICT10 today", "FICT1")).toBe(false);
    expect(accountMarkerShown('@e1 button "FICT1"', "FICT1")).toBe(true);
    expect(accountMarkerShown("  FICT1  ", "FICT1")).toBe(true);
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
