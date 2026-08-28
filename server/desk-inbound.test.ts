import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Desk } from "./desk.ts";
import type { InboundBatchInput } from "./inbound-triage.ts";

const dirs: string[] = [];
const start = new Date(2026, 7, 27, 9, 0, 0).getTime();

function makeDesk() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-inbound-"));
  dirs.push(dir);
  let now = start;
  const file = join(dir, "desk.json");
  return {
    file,
    desk: new Desk({ file, now: () => now }),
    advance(ms: number) { now += ms; },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function threadBatch(): InboundBatchInput {
  return {
    accountKey: "test-inbox",
    messages: [
      {
        providerMessageId: "thread-message-1",
        providerThreadId: "shared-thread",
        receivedAt: start - 2_000,
        from: { name: "Sam Nguyen", address: "sam@example.test" },
        subject: "Tap at 12 Oak St, Dickson ACT",
        body: "The kitchen tap needs repair.",
      },
      {
        providerMessageId: "thread-message-2",
        providerThreadId: "shared-thread",
        receivedAt: start - 1_000,
        from: { name: "Sam Nguyen", address: "sam@example.test" },
        subject: "Re: Tap at 12 Oak St, Dickson ACT",
        body: "It is now a burst pipe and an active leak.",
        attachmentNames: ["photo.jpg"],
      },
    ],
  };
}

describe("Desk inbound interrupt pipeline", () => {
  it("triages a sample inbox into one card per thread and makes replay idempotent", () => {
    const { desk } = makeDesk();
    const first = desk.ingestInboundFixture(threadBatch(), desk.revision);
    const rows = first.workItems.filter((item) => item.inbound?.threadKey);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "maintenance-intake", state: "proposed", propertyId: "prop-oak" });
    expect(rows[0]?.inbound).toMatchObject({ category: "urgent-maintenance-review", messageCount: 2, attachmentCount: 1 });
    expect(rows[0]?.evidenceIds).toHaveLength(2);
    expect(first.drafts.find((draft) => draft.id === rows[0]?.draftId)).toMatchObject({ kind: "inbound-reply", status: "pending", channel: "email" });

    const replay = desk.ingestInboundFixture(threadBatch(), desk.revision);
    expect(replay.revision).toBe(first.revision);
    expect(replay.workItems.filter((item) => item.inbound?.threadKey)).toHaveLength(1);
  });

  it("requires exact Allow before waiting, then survives restart and closes", () => {
    const fixture = makeDesk();
    let snap = fixture.desk.ingestDemoInbox(fixture.desk.revision);
    const work = snap.workItems.find((item) => item.inbound?.category === "bdm-lead")!;
    const draft = snap.drafts.find((item) => item.id === work.draftId)!;

    expect(() => fixture.desk.markInboundWaiting(work.id, fixture.desk.revision)).toThrow(/Allow the exact reply wording/i);
    fixture.desk.allowDraft(draft.id, fixture.desk.revision);
    snap = fixture.desk.markInboundWaiting(work.id, fixture.desk.revision);
    expect(snap.workItems.find((item) => item.id === work.id)).toMatchObject({
      state: "waiting",
      inbound: { waitingOn: "sender" },
      lifecycle: { waitingParty: "sender", dueAt: start + 2 * 24 * 60 * 60 * 1_000, nextCheckAt: start + 2 * 24 * 60 * 60 * 1_000 },
    });
    expect(snap.workItems.find((item) => item.id === work.id)?.inbound?.followUpAt).toBe(start + 2 * 24 * 60 * 60 * 1_000);

    const tomorrow = start + 24 * 60 * 60 * 1_000;
    snap = fixture.desk.snoozeCase(work.id, fixture.desk.revision, tomorrow);
    expect(snap.workItems.find((item) => item.id === work.id)?.lifecycle).toMatchObject({ reminderSuppressedUntil: tomorrow, nextCheckAt: tomorrow });
    expect(() => fixture.desk.snoozeCase(work.id, fixture.desk.revision - 1, tomorrow + 1)).toThrow(/stale desk revision/i);

    const restarted = new Desk({ file: fixture.file, now: () => start });
    expect(restarted.snapshot().workItems.find((item) => item.id === work.id)).toMatchObject({ state: "waiting", inbound: { category: "bdm-lead", waitingOn: "sender" } });
    const closed = restarted.closeInboundCase(work.id, restarted.revision);
    expect(closed.workItems.find((item) => item.id === work.id)?.state).toBe("confirmed");
    expect(closed.workItems.find((item) => item.id === work.id)?.lifecycle).toMatchObject({ closedBy: "pm", closureKind: "resolved-externally", closedAt: start });
  });

  it("records cancellation as a closure receipt and never leaves pending wording active", () => {
    const { desk } = makeDesk();
    let snap = desk.ingestDemoInbox(desk.revision);
    const work = snap.workItems.find((item) => item.inbound?.category === "bdm-lead")!;
    const draft = snap.drafts.find((item) => item.id === work.draftId)!;
    desk.allowDraft(draft.id, desk.revision);
    desk.markInboundWaiting(work.id, desk.revision);
    snap = desk.cancelCase(work.id, desk.revision, "not-needed");
    expect(snap.workItems.find((item) => item.id === work.id)).toMatchObject({
      state: "cancelled",
      lifecycle: { closedBy: "pm", closureKind: "not-needed", closedAt: start },
    });
    expect(() => desk.cancelCase(work.id, desk.revision)).toThrow(/illegal work transition/i);
  });

  it("holds licensed content, rejects stale revisions, and refuses the fixture path on a live book", () => {
    const { desk } = makeDesk();
    const licensed: InboundBatchInput = {
      accountKey: "test-inbox",
      messages: [{
        providerMessageId: "licensed-1",
        receivedAt: start - 1_000,
        from: { name: "Sam Nguyen", address: "sam@example.test" },
        subject: "Notice to leave — 12 Oak St, Dickson ACT",
        body: "Please draft the statutory notice.",
      }],
    };
    const snap = desk.ingestInboundFixture(licensed, desk.revision);
    const work = snap.workItems.find((item) => item.inbound?.category === "licensed-matter")!;
    expect(work).toMatchObject({ state: "held", draftId: undefined });
    expect(snap.drafts.some((draft) => draft.workItemId === work.id)).toBe(false);
    expect(() => desk.ingestInboundFixture(threadBatch(), desk.revision - 1)).toThrow(/stale desk revision/i);

    const live = makeDesk().desk;
    live.importCsv([
      "propertyId,daysSinceDue,rentLanded,levyPaid,daysSinceCourtesy",
      "prop-oak,0,true,true,",
    ].join("\n"), start, live.revision);
    expect(() => live.ingestInboundFixture(threadBatch(), live.revision)).toThrow(/pilot-gated/i);
  });

  it("restores both compatibility and V3 state when the encrypted commit does not land", () => {
    const { desk } = makeDesk();
    const before = desk.snapshot();
    const internal = desk as unknown as { store: { authorityWriter: (path: string, data: string) => void } };
    internal.store.authorityWriter = () => {
      throw new Error("injected write failure");
    };

    expect(() => desk.ingestInboundFixture(threadBatch(), desk.revision)).toThrow(/injected write failure/i);
    const after = desk.snapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.workItems.some((item) => item.inbound)).toBe(false);
    expect(after.sources.some((source) => source.kind === "mail")).toBe(false);
  });
});
