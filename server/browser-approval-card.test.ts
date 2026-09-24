import { describe, expect, it } from "vitest";
import { browserApprovalDraft } from "./browser-authority.ts";
import { browserApprovalCardFrom, sanitizeBrowserApprovalCard, stopBrowserApprovalCards } from "./browser-approval-card.ts";
import { Store } from "./store.ts";

const ID = "00000000-0000-4000-8000-00000000000a";
const PAY_PAGE = 'Pay a levy\nPayee: Fictional Strata Pty Ltd\nAmount: AUD 1,240.00\nReference: LEVY-FICTIONAL-12\n@e1 button "Pay now"';
/** The params the broker hands to the approval card, from its persisted record. */
function brokerParams(kind: Parameters<typeof browserApprovalDraft>[0], text: string, label = 'button "Pay now"') {
  const draft = browserApprovalDraft(kind, { url: "https://portal.fictional-strata.example/levies?session=fictional", text }, "@e1", label, 1_000);
  return { url: draft.url, label, approval: { id: ID, kind: draft.kind, facts: draft.facts, expiresAt: draft.expiresAt } };
}

describe("browser approval card from the broker's record", () => {
  it("carries kind, site, control, each fact with its confirmation, and the expiry", () => {
    const card = browserApprovalCardFrom(brokerParams("pay", PAY_PAGE))!;
    expect(card).toEqual({
      version: 1, purpose: "browser-approval-card", id: ID, kind: "pay", site: "portal.fictional-strata.example", control: "Pay now",
      facts: [
        { name: "recipient", value: "Fictional Strata Pty Ltd", confirmed: true },
        { name: "amount", value: "1240.00", confirmed: true },
        { name: "currency", value: "AUD", confirmed: true },
        { name: "reference", value: "LEVY-FICTIONAL-12", confirmed: true },
      ],
      expiresAt: 121_000,
    });
  });

  it("marks what the page did not confirm and never shows a text hash", () => {
    const pay = browserApprovalCardFrom(brokerParams("pay", 'Amount: AUD 480.00\n@e1 button "Pay now"'))!;
    expect(pay.facts.find(fact => fact.name === "recipient")).toEqual({ name: "recipient", value: null, confirmed: false });
    const send = browserApprovalCardFrom(brokerParams("send", 'textbox "To" value="owner@fictional.example"\ntextbox "Subject" value="Levy notice copy"\ntextbox "Message" value="Please find the levy attached."\n@e1 button "Send"', 'button "Send"'))!;
    expect(send.facts).toEqual([
      { name: "to", value: "owner@fictional.example", confirmed: true },
      { name: "subject", value: "Levy notice copy", confirmed: true },
      { name: "bodyHash", value: null, confirmed: true },
      // A redacted, shortened excerpt so the person sees what is being sent.
      { name: "bodyExcerpt", value: "Please find the levy attached.", confirmed: true },
    ]);
    expect(JSON.stringify(send)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("shows a redacted value but never counts it as confirmed", () => {
    const params = brokerParams("pay", PAY_PAGE);
    params.approval.facts = params.approval.facts.map(fact => fact.name === "reference" ? { ...fact, value: "sk-fictionalfictionalfictional1234", confirmed: true } : fact);
    const reference = browserApprovalCardFrom(params)!.facts.find(fact => fact.name === "reference")!;
    expect(reference.confirmed).toBe(false);
    expect(reference.value).not.toContain("sk-fictionalfictional");
  });

  it("is absent for an ordinary step and refuses a consequential one it cannot show", () => {
    expect(browserApprovalCardFrom({ url: "https://portal.fictional-strata.example/", label: 'button "Show"' })).toBeUndefined();
    const damaged = brokerParams("pay", PAY_PAGE);
    expect(() => browserApprovalCardFrom({ ...damaged, approval: { ...damaged.approval, facts: damaged.approval.facts.slice(1) } })).toThrow();
    expect(() => browserApprovalCardFrom({ ...damaged, approval: { ...damaged.approval, kind: "transfer-all" } })).toThrow();
    expect(sanitizeBrowserApprovalCard({ kind: "pay" })).toBeNull();
  });
});

describe("Stop records a waiting approval as stopped", () => {
  it("settles only open browser approval cards on the stopped thread and returns their requests to forget", () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    const card = browserApprovalCardFrom(brokerParams("pay", PAY_PAGE))!;
    const approval = store.appendMessage("thread-stop", { role: "bot", kind: "options", card: { title: "Approval needed", subtitle: "Pay", options: ["Allow", "Deny"], requestId: "req-pay", tool: "browser_click_semantic", browserApproval: card } });
    const shell = store.appendMessage("thread-stop", { role: "bot", kind: "options", card: { title: "Approval needed", subtitle: "git status", options: ["Allow", "Deny"], requestId: "req-shell", tool: "shell" } });
    const other = store.appendMessage("thread-other", { role: "bot", kind: "options", card: { title: "Approval needed", subtitle: "Pay", options: ["Allow", "Deny"], requestId: "req-other", tool: "browser_click_semantic", browserApproval: card } });
    const open = new Map([["thread-stop:req-pay", approval.id], ["thread-stop:req-shell", shell.id], ["thread-other:req-other", other.id]]);
    const stopped = stopBrowserApprovalCards(store, open, "thread-stop");
    expect(stopped.map(row => [row.key, row.threadId, row.requestId])).toEqual([["thread-stop:req-pay", "thread-stop", "req-pay"]]);
    expect(store.messagesFor("thread-stop").find(m => m.id === approval.id)?.card).toMatchObject({ answered: "stopped", dismissed: false, browserApproval: card });
    expect(store.messagesFor("thread-stop").find(m => m.id === shell.id)?.card?.answered).toBeUndefined();
    expect(store.messagesFor("thread-other").find(m => m.id === other.id)?.card?.answered).toBeUndefined();
    // Once stopped it is settled: a later stop (or a late answer) finds nothing to change.
    expect(stopBrowserApprovalCards(store, open, "thread-stop")).toEqual([]);
    expect(stopBrowserApprovalCards(store, open).map(row => row.key)).toEqual(["thread-other:req-other"]);
  });

  it("stores a persisted card re-validated, once-only, and a damaged one as held", () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    const card = browserApprovalCardFrom(brokerParams("pay", PAY_PAGE))!;
    const kept = store.appendMessage("thread-card", { role: "bot", kind: "options", card: { title: "Approval needed", subtitle: "Pay", options: [], requestId: "r1", tool: "browser_click_semantic", allowKey: "browser:any", browserApproval: card } });
    expect(kept.card).toMatchObject({ browserApproval: card, approvalPolicy: "once" });
    expect(kept.card?.allowKey).toBeUndefined();
    const damaged = store.appendMessage("thread-card", { role: "bot", kind: "options", card: { title: "Approval needed", subtitle: "Pay", options: [], requestId: "r2", tool: "browser_click_semantic", browserApproval: { ...card, facts: [] } } });
    expect(damaged.card?.browserApproval).toBeNull();
  });
});
