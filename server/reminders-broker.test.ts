import { afterEach, describe, expect, it, vi } from "vitest";
import { formatReminderTime, reminderInstant, startRemindersBroker, type BudReminders } from "./reminders-broker.ts";
import type { LoopbackToolServer } from "./web-research-broker.ts";

const NOW = Date.UTC(2026, 9, 2, 0, 0); // 2 Oct 2026 10:00 in Brisbane

describe("reminder times", () => {
  it("reads an offset as given and a bare time as office wall time", () => {
    expect(reminderInstant("2026-10-03T09:00:00+10:00", null)).toBe(Date.UTC(2026, 9, 2, 23, 0));
    expect(reminderInstant("2026-10-03T09:00", "Australia/Brisbane")).toBe(Date.UTC(2026, 9, 2, 23, 0));
    for (const bad of ["2026-02-30T09:00", "2026-10-03", "tomorrow", "2026-10-03T25:00", 5]) expect(reminderInstant(bad, "Australia/Brisbane")).toBeNull();
    expect(formatReminderTime(Date.UTC(2026, 9, 2, 23, 0), "Australia/Brisbane")).toMatch(/3 Oct 2026.*9:00.*\(Australia\/Brisbane\)/);
  });
});

describe("set_reminder broker", () => {
  let broker: LoopbackToolServer | undefined;
  afterEach(() => { broker?.close(); broker = undefined; });
  const call = async (args: unknown, id = 1) => ((await (await fetch(broker!.descriptor.url, { method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(broker!.descriptor.headers.map(row => [row.name, row.value])) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "set_reminder", arguments: args } }) })).json()) as any).result;

  it("creates a private reminder for the bound member and thread with no card, in office time", async () => {
    const create = vi.fn(async (input: { title: string; note?: string; dueAt: number }) => ({ id: "rem-fictional-1", dueAt: input.dueAt }));
    const reminders: BudReminders = { create, timeZone: async () => "Australia/Brisbane" };
    const receipts: unknown[] = [];
    broker = await startRemindersBroker({ turnId: () => "turn-1", reminders: () => reminders, now: () => NOW, receipt: row => receipts.push(row) });
    const result = await call({ title: "Call the fictional landlord", note: "About the bond", dueAt: "2026-10-03T09:00" });
    expect(result.isError).toBeUndefined();
    expect(create).toHaveBeenCalledWith({ title: "Call the fictional landlord", note: "About the bond", dueAt: Date.UTC(2026, 9, 2, 23, 0) });
    expect(result.content[0].text).toContain("Reminder id: rem-fictional-1");
    expect(result.content[0].text).toContain("(Australia/Brisbane)");
    expect(result.structuredContent).toEqual({ reminderId: "rem-fictional-1", dueAt: "2026-10-02T23:00:00.000Z", timeZone: "Australia/Brisbane" });
    expect(receipts).toEqual([{ tool: "set_reminder", outcome: "succeeded", reminderId: "rem-fictional-1" }]);
  });

  it("validates input, refuses the past and caps reminders per turn", async () => {
    let turn: string | null = "turn-1";
    const create = vi.fn(async (input: { dueAt: number }) => ({ id: `rem-${create.mock.calls.length}`, dueAt: input.dueAt }));
    broker = await startRemindersBroker({ turnId: () => turn, reminders: () => ({ create, timeZone: async () => null }), now: () => NOW, maxPerTurn: 2 });
    expect(await call({ title: "", dueAt: "2026-10-03T09:00" })).toMatchObject({ isError: true });
    expect(await call({ title: "x", dueAt: "2026-10-01T09:00:00Z" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("already passed") }] });
    expect(await call({ title: "x", dueAt: "next week" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("ISO 8601") }] });
    expect(await call({ title: "x", dueAt: "2026-10-03T09:00:00Z", extra: 1 })).toMatchObject({ isError: true });
    expect(create).not.toHaveBeenCalled();
    expect((await call({ title: "a", dueAt: "2026-10-03T09:00:00Z" })).content[0].text).toContain("this computer's time");
    await call({ title: "b", dueAt: "2026-10-03T09:00:00Z" });
    expect(await call({ title: "c", dueAt: "2026-10-03T09:00:00Z" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("set 2 reminders") }] });
    turn = "turn-2";
    expect((await call({ title: "d", dueAt: "2026-10-03T09:00:00Z" })).isError).toBeUndefined();
    turn = null;
    expect(await call({ title: "e", dueAt: "2026-10-03T09:00:00Z" })).toMatchObject({ isError: true });
    expect(create).toHaveBeenCalledTimes(3);
  });
});
