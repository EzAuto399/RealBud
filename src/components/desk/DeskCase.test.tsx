import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DeskSnapshot } from "@/lib/desk";
import type { DeskQueueItem } from "@/lib/desk-queue";
import { DeskCase } from "./DeskCase";

const now = 1_787_780_400_000;

function snapshot(hardship = false): DeskSnapshot {
  return {
    version: 2,
    revision: 4,
    mode: "live",
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Brisbane",
    retentionDays: 30,
    properties: [{
      id: "property-1",
      address: "12 Oak St, Dickson ACT",
      tenantName: "Sam Nguyen",
      tenantPhone: "0400 111 222",
      weeklyRentCents: 62_000,
      options: {
        rentSource: "csv",
        graceDays: 2,
        courtesyUntilDay: 6,
        levyFromRent: null,
        notifyChannel: "sms",
        never: [],
      },
    }],
    ledger: [{
      propertyId: "property-1",
      daysSinceDue: 3,
      rentLanded: false,
      levyPaid: true,
      daysSinceCourtesy: null,
    }],
    drafts: [{
      id: "draft-1",
      propertyId: "property-1",
      kind: "courtesy-rent",
      status: "pending",
      channel: "sms",
      to: "0400 111 222",
      body: "Hi Sam, our records do not yet show this week's rent.",
      periodDueAt: now - 86_400_000,
      createdAt: now,
      workItemId: "work-1",
    }],
    escalations: [],
    workItems: [{
      id: "work-1",
      kind: "money-arrears",
      state: "proposed",
      propertyId: "property-1",
      occurrenceKey: "2026-08-27",
      periodDueAt: now - 86_400_000,
      draftId: "draft-1",
      recipient: { name: "Sam Nguyen", phone: "0400 111 222", hardship },
      sourceIds: ["source-1"],
      observedAt: now,
      evidenceStatus: "current",
      proposalHash: "proposal-hash",
      createdAt: now,
      updatedAt: now,
    }],
    lastRunAt: now,
    results: [],
    hands: "csv",
    handsDetail: null,
    sources: [{ id: "source-1", kind: "csv", label: "PMS CSV export", stableKey: "pms" }],
    demo: false,
    book: {
      bookProposals: [],
      agency: { name: "RealBud Test", timezone: "Australia/Brisbane", jurisdictions: ["ACT"] },
      tenancies: [{ id: "tenancy-1", propertyId: "property-1", status: "current", weeklyRentCents: 62_000 }],
      contacts: [{
        id: "contact-1",
        role: "tenant",
        name: "Sam Nguyen",
        phone: "0400 111 222",
        propertyId: "property-1",
        safeguards: {
          hardship,
          dispute: false,
          paymentArrangement: false,
          doNotContact: false,
          preferredChannel: "sms",
        },
      }],
      archivedProperties: [],
      importIssues: [],
      cases: [],
      decisions: [{
        id: "decision-1",
        caseId: "previous-work",
        proposalId: "previous-draft",
        revisionId: "revision-previous-12345678",
        action: "allowed",
        actor: "pm",
        at: now - 604_800_000,
      }],
      reviewAssist: [{
        proposalId: "draft-1",
        mode: hardship ? "attention" : "familiar",
        priorAllowedCount: 1,
        evidence: "current",
        observedAt: now,
        recipient: "same",
        channel: "same",
        wording: "same",
        editedOnCard: false,
        safeguardAttention: hardship,
        moneyBoundary: false,
      }],
    },
  };
}

const item: DeskQueueItem = {
  id: "draft:draft-1",
  kind: "money-arrears",
  bucket: "needs-you",
  state: "proposed",
  propertyId: "property-1",
  address: "12 Oak St, Dickson ACT",
  action: "Allow wording",
  meta: "Courtesy · 0400 111 222",
  updatedAt: now,
  draftId: "draft-1",
  workItemId: "work-1",
};

function renderDeskCase(snap: DeskSnapshot): string {
  return renderToStaticMarkup(
    <DeskCase
      snap={snap}
      item={item}
      busy={null}
      emptyReason=""
      onAllow={() => undefined}
      onDeny={() => undefined}
      onEdit={() => undefined}
      onCopy={() => undefined}
      onPrepare={() => undefined}
      onWaiting={() => undefined}
      onClose={() => undefined}
      onSnooze={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

describe("Desk case review presentation", () => {
  it("compresses a familiar repeated review without weakening exact Allow", () => {
    const html = renderDeskCase(snapshot());

    expect(html).toContain("Ready for a quick review");
    expect(html).toContain("1 similar Allow");
    expect(html).toContain("Unchanged");
    expect(html).toContain("Checked · none active");
    expect(html).toContain("Allow approves this exact version once");
    expect(html).toContain("never automatically approved or sent");
    expect(html).toContain("Allow wording once");
    expect(html).not.toContain("Always approve");
    expect(html).not.toContain("Same as last allowed");
    expect(html).not.toContain(">Send<");
  });

  it("keeps an active safeguard expanded and visible", () => {
    const html = renderDeskCase(snapshot(true));

    expect(html).toContain("A recipient safeguard is active");
    expect(html).toContain("Hardship");
    expect(html).toContain("In force");
    expect(html).not.toContain("Checked · none active");
  });

  it("presents admitted inbound evidence, exact wording, and the external-send boundary", () => {
    const snap = snapshot();
    snap.mode = "demo";
    snap.demo = true;
    snap.sources = [{ id: "source-mail", kind: "mail", label: "Demo read-only inbox", stableKey: "demo:mail" }];
    snap.drafts = [{
      id: "draft-mail",
      propertyId: "property-1",
      kind: "inbound-reply",
      status: "pending",
      channel: "email",
      to: "sam@example.test",
      body: "Hi Sam,\n\nThanks for letting us know.",
      periodDueAt: now,
      createdAt: now,
      workItemId: "work-mail",
    }];
    snap.workItems = [{
      id: "work-mail",
      kind: "maintenance-intake",
      state: "proposed",
      propertyId: "property-1",
      occurrenceKey: "inbound:thread",
      periodDueAt: now,
      draftId: "draft-mail",
      recipient: { name: "Sam Nguyen", phone: "" },
      sourceIds: ["source-mail"],
      observedAt: now,
      proposalHash: "hash",
      createdAt: now,
      updatedAt: now,
      inbound: {
        category: "urgent-maintenance-review",
        priority: "urgent-review",
        senderName: "Sam Nguyen",
        senderAddress: "sam@example.test",
        subject: "Burst pipe",
        summary: "Sam reported a potentially urgent maintenance issue.",
        receivedAt: now,
        messageKey: "message-key",
        threadKey: "thread-key",
        attachmentCount: 1,
        messageCount: 2,
        flags: ["attachments-unopened"],
        waitingOn: "pm-send",
      },
    }];
    const inboundItem: DeskQueueItem = {
      ...item,
      id: "draft:draft-mail",
      kind: "maintenance-intake",
      draftId: "draft-mail",
      workItemId: "work-mail",
      meta: "Reply draft · sam@example.test",
    };
    const html = renderToStaticMarkup(
      <DeskCase
        snap={snap}
        item={inboundItem}
        busy={null}
        emptyReason=""
        onAllow={() => undefined}
        onDeny={() => undefined}
        onEdit={() => undefined}
        onCopy={() => undefined}
        onPrepare={() => undefined}
        onWaiting={() => undefined}
        onClose={() => undefined}
        onSnooze={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain("Read-only sample inbox");
    expect(html).toContain("Burst pipe");
    expect(html).toContain("2 messages");
    expect(html).toContain("1 unopened");
    expect(html).toContain("Attachments stay unopened");
    expect(html).toContain("Proposed wording");
    expect(html).toContain("Allow wording");
    expect(html).not.toContain(">Send<");
  });

  it("pulses Copy only when the parent marks the wording as copied", () => {
    const snap = snapshot();
    snap.drafts = [{ ...snap.drafts[0]!, status: "allowed" }];
    const allowed = {
      ...item,
      state: "approved" as const,
    };
    const idle = renderToStaticMarkup(
      <DeskCase
        snap={snap}
        item={allowed}
        busy={null}
        emptyReason=""
        onAllow={() => undefined}
        onDeny={() => undefined}
        onEdit={() => undefined}
        onCopy={() => undefined}
        onPrepare={() => undefined}
        onWaiting={() => undefined}
        onClose={() => undefined}
        onSnooze={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const pulsed = renderToStaticMarkup(
      <DeskCase
        snap={snap}
        item={allowed}
        busy={null}
        emptyReason=""
        copyPulse
        onAllow={() => undefined}
        onDeny={() => undefined}
        onEdit={() => undefined}
        onCopy={() => undefined}
        onPrepare={() => undefined}
        onWaiting={() => undefined}
        onClose={() => undefined}
        onSnooze={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(idle).toContain(">Copy<");
    expect(idle).not.toContain("copy-pulse");
    expect(pulsed).toContain("copy-pulse");
  });
});
