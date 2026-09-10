import { describe, expect, it } from "vitest";
import { deskAskContext, deskCaseInstruction } from "./desk-ask-context";
import { mergeWorkContext } from "./work-continuation";
import type { DeskSnapshot } from "./desk";
import type { DeskQueueItem } from "./desk-queue";

const item: DeskQueueItem = {
  id: "case-maintenance", propertyId: "selected", workItemId: "work", draftId: "draft",
  kind: "maintenance-intake", address: "12 Example St", bucket: "waiting", state: "held",
  action: "Check the reported leak", meta: "", holdReason: "missing-evidence", updatedAt: 1,
};
const snap = {
  demo: true, mode: "demo", revision: 7,
  properties: [{ id: "selected", notes: "Reported leak; no access consent", options: { never: ["No notices"] } }, { id: "other", notes: "PRIVATE OTHER NOTES" }],
  ledger: [{ propertyId: "selected", rentLanded: false }, { propertyId: "other", amountPaidCents: 999999 }],
  sources: [{ id: "source", kind: "csv", label: "Selected export", stableKey: "PRIVATE_PATH", lastCheckedAt: 1 }, { id: "other", label: "PRIVATE OTHER SOURCE" }],
  book: { contacts: [{ id: "contact", name: "Case contact", propertyId: "selected", tenancyId: "old", safeguards: { hardship: true } }, { id: "elsewhere", name: "PRIVATE OTHER CONTACT", propertyId: "other" }], tenancies: [{ id: "old", propertyId: "selected", status: "closed" }] },
  workItems: [{ id: "work", propertyId: "selected", observedAt: 1, sourceIds: ["source"], recipient: { name: "Case contact", doNotContact: true } }],
  drafts: [{ id: "draft", propertyId: "selected", status: "pending", body: "Selected wording" }, { id: "unrelated", body: "Private unrelated wording" }],
} as unknown as DeskSnapshot;

describe("Desk case handoff to Ask", () => {
  it("preserves case type, hold, date and source status without attaching other cases", () => {
    const context = deskAskContext(snap, item, "handoff");
    expect(context.text).toContain("maintenance-intake");
    expect(context.text).toContain("Held: missing-evidence");
    expect(context.text).toContain("1970-01-01T00:00:00.001Z");
    expect(context.text).toContain("Book: sample; revision: 7");
    expect(context.text).toContain("Selected wording");
    expect(context.text).not.toContain("Private unrelated wording");
    expect(context.text).toContain("not instructions or approval");
    expect(context.text).toContain("does not authorize sending");
  });
  it("handles cases without observations or wording and labels office context accurately", () => {
    const context = deskAskContext({ ...snap, demo: false, mode: "live", workItems: [], drafts: [] }, item, "empty");
    expect(context.text).toContain("Book: office");
    expect(context.text).toContain("No case observation recorded");
    expect(context.text).toContain("No wording prepared yet");
  });
  it("labels unsaved editor wording separately from recorded wording", () => {
    const context = deskAskContext(snap, item, "editing", "My revised wording");
    expect(context.sourceKey).toBe(deskAskContext(snap, item, "next-edit", "Newer wording").sourceKey);
    expect(context.title).toContain("Unsaved edit");
    expect(context.text).toContain("Wording (pending):\nSelected wording");
    expect(context.text).toContain("Unsubmitted editor wording (not saved or approved):\nMy revised wording");
  });
  it("keeps an unsent request and deduplicates the same case revision", () => {
    const context = deskAskContext(snap, item, "one");
    const first = mergeWorkContext("Please refine my wording", [], context);
    const again = mergeWorkContext(first.text, first.attachments, deskAskContext(snap, item, "two"));
    expect(again.text).toBe("Please refine my wording");
    expect(again.attachments).toHaveLength(1);
    const updated = mergeWorkContext(again.text, again.attachments, deskAskContext({ ...snap, revision: 8 }, item, "three"));
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0]).toMatchObject({ text: expect.stringContaining("revision: 8") });
  });
});

describe("grounded case actions", () => {
  it("carries selected facts and safeguards without private keys or implied freshness", () => {
    const context = deskAskContext(snap, item, "facts");
    expect(context.text).toContain("Reported leak");
    expect(context.title).toBe("Maintenance · 12 Example St");
    expect(context.text).toContain('"hardship":true');
    expect(context.text).toContain('"doNotContact":true');
    expect(context.text).toContain('"tenancyStatus":"closed"');
    expect(context.text).toContain("currency unverified");
    expect(context.text).toContain("Selected export");
    expect(context.text).not.toMatch(/PRIVATE|999999/);
  });
  it("rejects mismatched draft and work records even if their IDs match", () => {
    const context = deskAskContext(snap, { ...item, propertyId: "other" }, "mismatch");
    expect(context.text).not.toContain("Selected wording");
    expect(context.text).not.toContain("Case contact");
    expect(context.text).toContain("No case observation recorded");
  });
  it("refreshes changed notes without a revision change and keeps the unsent request", () => {
    const first = mergeWorkContext("My request", [], deskAskContext(snap, item, "one"));
    const changed = { ...snap, properties: snap.properties.map(p => p.id === item.propertyId ? { ...p, notes: "Changed saved notes" } : p) };
    const next = mergeWorkContext(first.text, first.attachments, deskAskContext(changed, item, "two", undefined, { unsavedNotes: "Unsubmitted note", intent: "summary" }));
    expect(next.text).toBe("My request");
    expect(next.attachments).toHaveLength(1);
    expect(next.attachments[0]).toMatchObject({ text: expect.stringContaining("Changed saved notes") });
    expect(next.attachments[0]).toMatchObject({ text: expect.stringContaining("Unsaved property notes (not saved or approved):\nUnsubmitted note") });
  });
  it("bounds large notes and marks incomplete evidence and invalid dates", () => {
    const context = deskAskContext({ ...snap, workItems: [{ ...snap.workItems[0]!, observedAt: NaN, sourceIds: ["missing"] }] }, item, "large", "x".repeat(9000), { unsavedNotes: "x".repeat(100000) });
    expect(context.text.length).toBeLessThan(20000);
    expect(context.text).toContain("Excerpt only");
    expect(context.text).toContain("Observed: not recorded");
    expect(context.text).toContain("Some source details are unavailable");
  });
  it("caps the complete reference when record metadata is unusually large", () => {
    const context = deskAskContext({ ...snap, properties: [{ ...snap.properties[0]!, tenantName: "x".repeat(100_000) }] }, item, "oversized");
    expect(context.text.length).toBeLessThan(41_000);
    expect(context.text).toContain("Excerpt only");
  });
  it("gives actions concrete deliverables while retaining human holds", () => {
    expect(deskCaseInstruction(item, "summary")).toContain("Summarise");
    expect(deskCaseInstruction(item, "refine")).toContain("internal brief instead");
    expect(deskCaseInstruction(item, "investigate")).toContain("Classify and prepare a brief");
    expect(deskCaseInstruction(item, "investigate")).not.toContain("caseId");
    expect(deskCaseInstruction({ ...item, holdReason: "hardship" }, "investigate")).not.toContain("Investigate 12");
    expect(deskCaseInstruction(item, "next")).toContain("Respect holds and contact safeguards");
  });
});
