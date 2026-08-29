import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AskActionProposal } from "../shared/ask-actions.ts";
import { decideAskAction, parseWorkerAskAction, stageDirectAskRoutineIntent, stageDirectAskSetupIntent, stageWorkerAskAction } from "./ask-action-broker.ts";
import { Desk } from "./desk.ts";
import { LoopManager } from "./routines.ts";
import { currentBookWorkRoutingPlan } from "./work-routing.ts";

const dirs: string[] = [];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-ask-actions-"));
  dirs.push(dir);
  let now = new Date(2026, 7, 26, 9, 0).getTime();
  const desk = new Desk({ file: join(dir, "desk.json"), now: () => now });
  const loops = new LoopManager({
    file: join(dir, "loops.json"),
    now: () => now,
    execute: async () => ({ ok: true, detail: "done" }),
  });
  return {
    desk,
    loops,
    now: () => now,
    setNow(value: number) { now = value; },
  };
}

function action(proposal: Record<string, unknown>): string {
  return JSON.stringify({ action: "realbud.propose-action.v1", proposal });
}

function staged(
  text: string,
  context: ReturnType<typeof harness>,
): AskActionProposal {
  const result = stageWorkerAskAction(text, context);
  expect(result.matched).toBe(true);
  if (!("proposal" in result)) throw new Error("expected a staged proposal");
  return result.proposal;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Ask action protocol", () => {
  it("accepts only the closed RealBud envelope", () => {
    expect(parseWorkerAskAction(action({ kind: "run-routine", routineId: "morning-arrears" })).value?.proposal).toEqual({
      kind: "run-routine",
      routineId: "morning-arrears",
    });
    expect(parseWorkerAskAction(action({ kind: "send-email", to: "tenant@example.com" }))).toMatchObject({ matched: true, error: expect.any(String) });
    expect(parseWorkerAskAction(action({ kind: "open-setup", target: "connections", token: "secret" }))).toMatchObject({ matched: true, error: expect.any(String) });
    expect(parseWorkerAskAction(action({ kind: "open-setup", target: "connections", service: `sk-live-${"a".repeat(24)}` }))).toMatchObject({ matched: true, error: expect.any(String) });
    expect(parseWorkerAskAction(action({ kind: "open-setup", target: "connections", service: "https://example.com/connect" }))).toMatchObject({ matched: true, error: expect.any(String) });
    expect(parseWorkerAskAction(action({ kind: "prepare-handoff", draftRef: "draft-1" })).value?.proposal).toEqual({
      kind: "prepare-handoff",
      draftRef: "draft-1",
    });
    expect(parseWorkerAskAction(action({ kind: "prepare-handoff", draftRef: "draft-1", command: "open https://example.test" }))).toMatchObject({ matched: true, error: expect.any(String) });
    expect(parseWorkerAskAction('{"proposal":{"kind":"run-routine","routineId":"morning-arrears"}}')).toEqual({ matched: false });
    expect(parseWorkerAskAction("A normal helpful answer.")).toEqual({ matched: false });
  });

  it("resolves and applies a routine change only after Allow", async () => {
    const context = harness();
    const proposal = staged(action({
      kind: "change-routine",
      routineId: "morning-arrears",
      time: "08:05",
      weekdays: [1, 2, 3, 4, 5],
    }), context);
    expect(context.loops.listLoops().find((loop) => loop.id === "morning-arrears")?.schedule.time).toBe("07:30");

    const allowed = await decideAskAction(proposal, "allow", context);
    expect(allowed.proposal.status).toBe("allowed");
    expect(allowed.loop?.schedule.time).toBe("08:05");

    // A response retry after the owner command committed is acknowledged,
    // not applied a second time.
    const retried = await decideAskAction(proposal, "allow", context);
    expect(retried.proposal.status).toBe("allowed");
    expect(retried.loop?.revision).toBe(allowed.loop?.revision);
  });

  it("fails stale instead of overwriting a newer routine edit", async () => {
    const context = harness();
    const proposal = staged(action({ kind: "change-routine", routineId: "owner-letter", time: "15:00" }), context);
    context.loops.patchClock("owner-letter", { time: "14:30" });
    await expect(decideAskAction(proposal, "allow", context)).rejects.toThrow(/changed after Bud prepared/i);
    expect(context.loops.listLoops().find((loop) => loop.id === "owner-letter")?.schedule.time).toBe("14:30");
  });

  it("uses the action id to deduplicate a manual routine run", async () => {
    const context = harness();
    const proposal = staged(action({ kind: "run-routine", routineId: "morning-arrears" }), context);
    expect(proposal).toMatchObject({
      kind: "run-routine",
      executionPlan: {
        kind: "realbud.work-routing.v1",
        selectedMode: "local-standard",
        propertyCount: context.desk.snapshot().properties.length,
        lanes: [{ kind: "structured-batch", state: "ready", batchCount: 1, concurrency: 1 }],
        boundaries: { cloudRequired: false, personalBrowserAccess: false, personalHermesAccess: false },
      },
    });
    const first = await decideAskAction(proposal, "allow", context);
    const second = await decideAskAction(proposal, "allow", context);
    expect(first.run?.requestId).toBe(proposal.id);
    expect(second.run?.id).toBe(first.run?.id);
    await context.loops.tick();
    expect(context.loops.listRuns().filter((run) => run.requestId === proposal.id)).toHaveLength(1);
  });

  it("carries the PM's saved route hint into Ask without bypassing local fallback", async () => {
    const context = harness();
    const routedContext = {
      ...context,
      workRoutingPlan: (snapshot: Parameters<typeof currentBookWorkRoutingPlan>[0]) => currentBookWorkRoutingPlan(
        snapshot,
        { cpuCores: 8, freeMemoryMb: 8_192 },
        undefined,
        "cloud-accelerated",
        true,
      ),
    };
    const proposal = staged(action({ kind: "run-routine", routineId: "morning-arrears" }), routedContext);
    expect(proposal).toMatchObject({
      kind: "run-routine",
      executionPlan: {
        preferenceConfigured: true,
        requestedMode: "cloud-accelerated",
        selectedMode: "local-standard",
        fallbackReasons: [expect.stringMatching(/cloud acceleration is not connected/i)],
      },
    });
    expect((await decideAskAction(proposal, "allow", routedContext)).run?.requestId).toBe(proposal.id);
  });

  it("does not attach placeholder routes to non-structured routine work", () => {
    const context = harness();
    context.loops.setEnabled("owner-letter", true);
    const ownerLetter = staged(action({ kind: "run-routine", routineId: "owner-letter" }), context);
    expect(ownerLetter.kind).toBe("run-routine");
    if (ownerLetter.kind !== "run-routine") throw new Error("wrong proposal kind");
    expect(ownerLetter.executionPlan).toBeUndefined();

    const scheduleChange = staged(action({ kind: "change-routine", routineId: "morning-arrears", time: "08:00" }), context);
    expect(scheduleChange).not.toHaveProperty("executionPlan");
  });

  it("rejects an unknown or stale route before starting bulk work", async () => {
    const unknownContext = harness();
    const planned = staged(action({ kind: "run-routine", routineId: "morning-arrears" }), unknownContext);
    if (planned.kind !== "run-routine") throw new Error("wrong proposal kind");
    const unknown = {
      ...planned,
      executionPlan: { ...planned.executionPlan, kind: "realbud.work-routing.v2" },
    } as unknown as AskActionProposal;
    await expect(decideAskAction(unknown, "allow", unknownContext)).rejects.toMatchObject({
      code: "ROUTE_PLAN_INVALID",
    });
    expect(unknownContext.loops.listRuns()).toHaveLength(0);

    const staleContext = harness();
    const stale = staged(action({ kind: "run-routine", routineId: "morning-arrears" }), staleContext);
    staleContext.desk.proposeBook({
      items: [{
        address: "77 Route Street, Braddon ACT",
        tenantName: "Route Tenant",
        tenantPhone: "0400 777 888",
        weeklyRentCents: 64_000,
      }],
    });
    const current = staleContext.desk.snapshot();
    staleContext.desk.allowBookProposals(current.book!.bookProposals.map((proposal) => proposal.id), current.revision);
    await expect(decideAskAction(stale, "allow", staleContext)).rejects.toMatchObject({
      code: "ROUTE_PLAN_STALE",
    });
    expect(staleContext.loops.listRuns()).toHaveLength(0);
  });

  it("keeps a valid route plan after an unrelated Desk revision", async () => {
    const context = harness();
    const proposal = staged(action({ kind: "run-routine", routineId: "morning-arrears" }), context);
    context.desk.updateAgencyName("Same Portfolio Realty", context.desk.snapshot().revision);
    const allowed = await decideAskAction(proposal, "allow", context);
    expect(allowed.run?.requestId).toBe(proposal.id);
  });

  it("stages a property on Desk, then atomically allows or denies it", async () => {
    const context = harness();
    const add = staged(action({
      kind: "add-property",
      address: "77 Pilot Lane, Dickson ACT",
      tenantName: "Jamie Pilot",
      tenantPhone: "0400 111 222",
      weeklyRentCents: 63000,
    }), context);
    expect(add.kind).toBe("add-property");
    expect(context.desk.snapshot().properties.some((property) => property.address.includes("77 Pilot"))).toBe(false);
    expect(context.desk.snapshot().book?.bookProposals).toHaveLength(1);

    const allowed = await decideAskAction(add, "allow", context);
    expect(allowed.snapshot?.properties.some((property) => property.address === "77 Pilot Lane, Dickson ACT")).toBe(true);
    expect((await decideAskAction(add, "allow", context)).snapshot?.properties.filter((property) => property.address === "77 Pilot Lane, Dickson ACT")).toHaveLength(1);

    const denyContext = harness();
    const deny = staged(action({
      kind: "add-property",
      address: "88 Review Road, Braddon ACT",
      tenantName: "Riley Review",
      tenantPhone: "0400 333 444",
      weeklyRentCents: 59000,
    }), denyContext);
    const denied = await decideAskAction(deny, "deny", denyContext);
    expect(denied.proposal.status).toBe("denied");
    expect(denied.snapshot?.book?.bookProposals).toHaveLength(0);
    expect(denied.snapshot?.properties.some((property) => property.address.includes("88 Review"))).toBe(false);
  });

  it("revalidates property intake after unrelated Desk work instead of failing stale", async () => {
    const context = harness();
    const proposal = staged(action({
      kind: "add-property",
      address: "9 Concurrent Court, Turner ACT",
      tenantName: "Casey Current",
      tenantPhone: "0400 555 777",
      weeklyRentCents: 61000,
    }), context);
    context.desk.updateAgencyName("Concurrent Realty", context.desk.snapshot().revision);
    const allowed = await decideAskAction(proposal, "allow", context);
    expect(allowed.snapshot?.properties.some((property) => property.address === "9 Concurrent Court, Turner ACT")).toBe(true);
  });

  it("resolves a unique property but never lets a stale card overwrite it", async () => {
    const context = harness();
    const proposal = staged(action({
      kind: "configure-property",
      propertyRef: "12 Oak St",
      changes: { graceDays: 4, notifyChannel: "desk" },
    }), context);
    expect(proposal.kind).toBe("configure-property");
    if (proposal.kind !== "configure-property") throw new Error("wrong proposal kind");
    expect(context.desk.snapshot().properties.find((property) => property.id === proposal.propertyId)?.options.graceDays).not.toBe(4);

    context.desk.patchProperty(proposal.propertyId, { graceDays: 5 });
    await expect(decideAskAction(proposal, "allow", context)).rejects.toThrow(/book changed/i);
    const current = context.desk.snapshot().properties.find((property) => property.id === proposal.propertyId)!;
    expect(current.options.graceDays).toBe(5);
  });

  it("rejects an internally invalid property option combination before review", () => {
    const context = harness();
    const result = stageWorkerAskAction(action({
      kind: "configure-property",
      propertyRef: "12 Oak St",
      changes: { graceDays: 10, courtesyUntilDay: 5 },
    }), context);
    expect(result).toMatchObject({ matched: true, error: expect.stringMatching(/courtesy window/i) });
    const oak = context.desk.snapshot().properties.find((property) => property.address.includes("12 Oak"))!;
    expect(oak.options.graceDays).not.toBe(10);
  });

  it("allows a property option change after an unrelated Desk revision", async () => {
    const context = harness();
    const proposal = staged(action({
      kind: "configure-property",
      propertyRef: "12 Oak St",
      changes: { graceDays: 4 },
    }), context);
    context.desk.updateAgencyName("Safe Concurrent Change", context.desk.snapshot().revision);
    const allowed = await decideAskAction(proposal, "allow", context);
    expect(allowed.snapshot?.properties.find((property) => property.address.includes("12 Oak"))?.options.graceDays).toBe(4);
  });

  it("opens human-owned setup without claiming a connection exists", async () => {
    const context = harness();
    const before = context.desk.snapshot().revision;
    const stagedResult = stageWorkerAskAction(action({ kind: "open-setup", target: "connections", service: "Gmail" }), context);
    expect(stagedResult).toMatchObject({
      matched: true,
      navigation: "connections",
      proposal: { kind: "open-setup", status: "allowed", service: "Gmail" },
    });
    if (!("proposal" in stagedResult)) throw new Error("expected a staged proposal");
    const result = await decideAskAction(stagedResult.proposal, "allow", context);
    expect(result.proposal.status).toBe("allowed");
    expect(context.desk.snapshot().revision).toBe(before);
    expect(result).not.toHaveProperty("connected");
  });

  it("turns an explicit PM Pocket request into the same navigation-only setup card", async () => {
    const context = harness();
    const before = context.desk.snapshot().revision;
    const whatsapp = stageDirectAskSetupIntent("Can you connect WhatsApp to Bud?", context);
    expect(whatsapp).toMatchObject({
      matched: true,
      deskChanged: false,
      proposal: {
        kind: "open-setup",
        target: "connections",
        service: "WhatsApp Business",
        status: "allowed",
      },
      navigation: "connections",
    });
    expect(context.desk.snapshot().revision).toBe(before);

    const telegram = stageDirectAskSetupIntent("Set up Telegram for my phone", context);
    expect(telegram).toMatchObject({
      matched: true,
      proposal: { kind: "open-setup", target: "connections", service: "Telegram", status: "allowed" },
      navigation: "connections",
    });

    expect(stageDirectAskSetupIntent("What is WhatsApp Business?", context)).toEqual({ matched: false });
    expect(stageDirectAskSetupIntent("I use WhatsApp for work", context)).toEqual({ matched: false });
    expect(stageDirectAskSetupIntent("Please do not connect WhatsApp", context)).toEqual({ matched: false });
    expect(stageDirectAskSetupIntent("Connect WhatsApp so Bud can send a tenant a notice", context)).toEqual({ matched: false });

    const calendar = stageDirectAskSetupIntent("connect me to google clandar", context);
    expect(calendar).toMatchObject({
      matched: true,
      navigation: "connections",
      proposal: { kind: "open-setup", target: "connections", service: "Google Calendar", title: "Connect Google Calendar", status: "allowed" },
    });
    expect(stageDirectAskSetupIntent("connect me to google claendar", context)).toMatchObject({
      matched: true,
      navigation: "connections",
      proposal: { kind: "open-setup", target: "connections", service: "Google Calendar", title: "Connect Google Calendar", status: "allowed" },
    });

    expect(stageDirectAskSetupIntent("connect me to instagram", context)).toMatchObject({
      matched: true,
      navigation: "connections",
      proposal: { kind: "open-setup", target: "connections", service: "Instagram", title: "Connect Instagram", status: "allowed" },
    });
    expect(stageDirectAskSetupIntent("connect me to slack", context)).toMatchObject({
      matched: true,
      navigation: "connections",
      proposal: { kind: "open-setup", service: "Slack", title: "Connect Slack", status: "allowed" },
    });
    expect(stageDirectAskSetupIntent("connect me to notion", context)).toMatchObject({
      matched: true,
      navigation: "connections",
      proposal: { kind: "open-setup", service: "Notion", title: "Connect Notion", status: "allowed" },
    });
    expect(stageDirectAskSetupIntent("what can you see inside of notion", context)).toMatchObject({
      matched: true,
      navigation: "connections",
      proposal: { kind: "open-setup", service: "Notion", title: "Connect Notion", status: "allowed" },
    });
    expect(stageDirectAskSetupIntent("what can you see inside of notion", {
      ...context,
      linkedTools: [{ slug: "notion", label: "Notion", connected: true, account: "Northside workspace" }],
    })).toMatchObject({
      matched: true,
      proposal: {
        kind: "open-setup",
        service: "Notion",
        title: "Notion on this device",
        detail: "Northside workspace is on this device. Ask still cannot send.",
        status: "allowed",
      },
    });
    expect(stageDirectAskSetupIntent("what can you see inside of notion", {
      ...context,
      linkedTools: [{ slug: "notion", label: "Notion", connected: true, account: "Northside workspace" }],
    })).not.toHaveProperty("navigation");
    expect(stageDirectAskSetupIntent("connect me to notion", {
      ...context,
      linkedTools: [{ slug: "notion", label: "Notion", connected: true, account: "Northside workspace" }],
    })).toMatchObject({
      matched: true,
      proposal: { title: "Notion on this device", status: "allowed" },
    });
    const workerInstagram = stageWorkerAskAction(action({
      kind: "open-setup",
      target: "connections",
      service: "Instagram",
    }), context);
    expect(workerInstagram).toMatchObject({
      matched: true,
      proposal: { kind: "open-setup", service: "Instagram", title: "Connect Instagram" },
    });
    expect("error" in workerInstagram).toBe(false);

    const gmail = stageDirectAskSetupIntent("connect me to gmail", context);
    expect(gmail).toMatchObject({
      matched: true,
      navigation: "connections",
      proposal: { kind: "open-setup", target: "connections", service: "Gmail", title: "Connect Gmail", status: "allowed" },
    });

    const composio = stageDirectAskSetupIntent("Connect Composio to Bud", context);
    expect(composio).toMatchObject({
      matched: true,
      proposal: {
        kind: "open-setup",
        target: "composio-account",
        service: "Composio account",
        title: "Link Composio",
      },
    });

    const picker = stageDirectAskSetupIntent("Set up connections", context);
    expect(picker).toMatchObject({ matched: true, proposal: { kind: "choose-connection" } });
    if (!("proposal" in picker) || picker.proposal.kind !== "choose-connection") throw new Error("expected a picker");
    expect(picker.proposal.options[0]?.id).toBe("property-book");
    expect(picker.proposal.options.at(-1)?.id).toBe("composio-account");
    const chosen = await decideAskAction(picker.proposal, "allow", { ...context, selection: "incoming-mail" });
    expect(chosen.navigation).toBe("connections");
    expect(chosen.proposal).toMatchObject({ status: "allowed", selectedId: "incoming-mail" });
  });

  it("honours morning and Friday speech as Allow cards without a model", async () => {
    const context = harness();
    const run = stageDirectAskRoutineIntent("Run the morning money check now.", context);
    expect(run).toMatchObject({
      matched: true,
      deskChanged: false,
      proposal: { kind: "run-routine", loopId: "morning-arrears", status: "pending" },
    });
    if (!("proposal" in run)) throw new Error("expected a run card");
    const allowed = await decideAskAction(run.proposal, "allow", context);
    expect(allowed.proposal.status).toBe("allowed");
    expect(allowed.run?.loopId).toBe("morning-arrears");

    const retune = stageDirectAskRoutineIntent("Run it at 8", context);
    expect(retune).toMatchObject({
      matched: true,
      proposal: { kind: "change-routine", loopId: "morning-arrears", after: { time: "08:00" } },
    });

    const friday = stageDirectAskRoutineIntent("Run the Friday owner letter now.", context);
    expect(friday).toMatchObject({
      matched: true,
      proposal: { kind: "change-routine", loopId: "owner-letter", after: { enabled: true } },
    });
    if (!("proposal" in friday)) throw new Error("expected an enable card");
    await decideAskAction(friday.proposal, "allow", context);
    const fridayRun = stageDirectAskRoutineIntent("Run the Friday owner letter now.", context);
    expect(fridayRun).toMatchObject({
      matched: true,
      proposal: { kind: "run-routine", loopId: "owner-letter" },
    });

    expect(stageDirectAskRoutineIntent("Check rent every morning", context)).toEqual({ matched: false });
    expect(stageDirectAskRoutineIntent("Text them every morning", context)).toEqual({ matched: false });
    expect(stageDirectAskRoutineIntent("Send the owner letter", context)).toEqual({ matched: false });
    expect(stageDirectAskRoutineIntent("What time is morning money?", context)).toEqual({ matched: false });
  });

  it("prepares one approved case-bound handoff only after Allow and deduplicates a retry", async () => {
    const context = harness();
    context.desk.patchProperty("prop-oak", { notifyChannel: "portal" });
    context.desk.runMorningCheck();
    const draft = context.desk.snapshot().drafts.find((item) => item.propertyId === "prop-oak" && item.kind === "courtesy-rent")!;
    context.desk.allowDraft(draft.id);

    const proposal = staged(action({ kind: "prepare-handoff", draftRef: "12 Oak St" }), context);
    expect(proposal).toMatchObject({
      kind: "prepare-handoff",
      status: "pending",
      address: "12 Oak St, Dickson ACT",
      mode: "practice",
    });
    const before = context.desk.snapshot().workItems.find((item) => item.draftId === draft.id);
    expect(before?.state).toBe("approved");

    let calls = 0;
    const execute = async (draftId: string) => {
      calls += 1;
      return context.desk.command({ type: "prepare-portal", draftId, expectedRevision: context.desk.revision });
    };
    const first = await decideAskAction(proposal, "allow", { ...context, prepareHandoff: execute });
    expect(first.proposal.status).toBe("allowed");
    expect(first.snapshot?.workItems.find((item) => item.draftId === draft.id)?.state).toBe("handoff-ready");
    const retry = await decideAskAction(proposal, "allow", { ...context, prepareHandoff: execute });
    expect(retry.proposal.status).toBe("allowed");
    expect(calls).toBe(1);
  });

  it("refuses a stale or failed computer handoff instead of widening or retrying it", async () => {
    const context = harness();
    context.desk.patchProperty("prop-oak", { notifyChannel: "portal" });
    context.desk.runMorningCheck();
    const draft = context.desk.snapshot().drafts.find((item) => item.propertyId === "prop-oak" && item.kind === "courtesy-rent")!;
    context.desk.allowDraft(draft.id);
    const proposal = staged(action({ kind: "prepare-handoff", draftRef: draft.id }), context);
    context.desk.updateAgencyName("Changed after review", context.desk.revision);
    await expect(decideAskAction(proposal, "allow", {
      ...context,
      prepareHandoff: async () => { throw new Error("must not run"); },
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const fresh = harness();
    fresh.desk.patchProperty("prop-oak", { notifyChannel: "portal" });
    fresh.desk.runMorningCheck();
    const freshDraft = fresh.desk.snapshot().drafts.find((item) => item.propertyId === "prop-oak" && item.kind === "courtesy-rent")!;
    fresh.desk.allowDraft(freshDraft.id);
    const failed = staged(action({ kind: "prepare-handoff", draftRef: freshDraft.id }), fresh);
    await expect(decideAskAction(failed, "allow", {
      ...fresh,
      prepareHandoff: async () => { throw Object.assign(new Error("portal read failed"), { status: 502 }); },
    })).rejects.toMatchObject({ code: "HANDOFF_FAILED", status: 502 });
    expect(fresh.desk.snapshot().workItems.find((item) => item.draftId === freshDraft.id)?.state).toBe("approved");
  });
});
