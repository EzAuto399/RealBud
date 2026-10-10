// Bud's saved-view tools: a read with no card, every change behind the one-time
// card, the service's revision check, and the shared parser as the only judge.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "./config.ts";
import type { ProviderInstance } from "./contracts.ts";
import { HermesAgentDriver } from "./drivers/acp/hermes.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";
import { removeFixture } from "./testing/private-fixture.ts";
import type { LoopbackToolServer } from "./web-research-broker.ts";
import { createWorkspaceTabsHandler } from "./workspace-tabs.ts";
import { DESK_CONFLICT, startWorkspaceViewsBroker, VIEWS_CONFLICT, type BudWorkspaceViews } from "./workspace-views-broker.ts";
import { defaultDeskSections, parseWorkspaceTabsResponse } from "../shared/workspace-tabs.ts";

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("./managed-service.ts", () => ({ managedService: { assertCapability } }));

const directories: string[] = [];
const seed = { id: "view-waiting", label: "Waiting work", visible: true, view: { kind: "tasks", filter: "waiting" } };
async function service(tabs: unknown[] = [seed]) {
  const directory = await mkdtemp(join(tmpdir(), "realbud-bud-views-")); directories.push(directory);
  const handler = createWorkspaceTabsHandler({ directory, workspaceId: randomUUID() });
  if (tabs.length) expect((await handler.handle("/api/workspace-tabs", "PUT", { version: 1, expectedRevision: 0, tabs }))?.status).toBe(200);
  const views: BudWorkspaceViews = {
    read: async () => (await handler.handle("/api/workspace-tabs", "GET"))!,
    save: vi.fn(async body => (await handler.handle("/api/workspace-tabs", "PUT", body))!),
  };
  // The Desk's own GET, as the sidebar reads it.
  const get = async () => parseWorkspaceTabsResponse((await handler.handle("/api/workspace-tabs", "GET"))!.body).state!;
  return { handler, views, get };
}

describe("saved views broker", () => {
  let broker: LoopbackToolServer | undefined;
  afterEach(async () => { broker?.close(); broker = undefined; await Promise.all(directories.splice(0).map(path => removeFixture(path))); });
  const call = async (name: string, args: unknown, id = 1) => ((await (await fetch(broker!.descriptor.url, { method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(broker!.descriptor.headers.map(row => [row.name, row.value])) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) })).json()) as any).result;
  const start = async (views: BudWorkspaceViews, approve: (summary: string) => Promise<boolean>, turnId: () => string | null = () => "turn-1") => {
    const cards: string[] = [];
    broker = await startWorkspaceViewsBroker({ turnId, views: () => views, approve: async summary => { cards.push(summary); return approve(summary); } });
    return cards;
  };

  it("lists views with no card", async () => {
    const { views } = await service();
    const approve = vi.fn(async () => true);
    const cards = await start(views, approve);
    const result = await call("views_list", {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.views).toEqual([{ id: "view-waiting", name: "Waiting work", kind: "tasks", filter: "waiting", visible: true }]);
    // Bud reads the revision, every section in order with its name, and what always shows, before it arranges Desk.
    expect(result.structuredContent).toMatchObject({ revision: 1, locked: ["queue"] });
    expect(result.structuredContent.desk).toEqual(defaultDeskSections().map(section => ({ id: section.id, name: expect.any(String), visible: true })));
    expect(result.structuredContent.desk[0].name).toBe("Morning brief");
    expect(result.content[0].text).toContain("Desk layout (revision 1), in order:\n- brief: Morning brief (shown)");
    expect(result.content[0].text).toContain("Always shown: queue.");
    expect(cards).toEqual([]);
    expect(approve).not.toHaveBeenCalled();
  });

  it("shows one plain card before each change, and a denial changes nothing", async () => {
    const { views, get } = await service();
    const cards = await start(views, async () => false);
    const before = await get();
    const attempts: Array<[string, unknown, string]> = [
      ["views_create", { name: "Arrears", kind: "bills" }, "Create view 'Arrears' with Bills"],
      ["views_rename", { id: "view-waiting", name: "Old" }, "Rename view 'Waiting work' to 'Old'"],
      ["views_set_visible", { id: "view-waiting", visible: false }, "Hide view 'Waiting work' from the sidebar"],
      ["views_delete", { id: "view-waiting" }, "Delete view 'Waiting work'"],
    ];
    for (const [name, args, card] of attempts) {
      expect(await call(name, args)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("did not approve") }] });
      expect(cards.at(-1)).toBe(card);
      expect(card).not.toContain("\n");
    }
    expect(cards).toHaveLength(4);
    expect(views.save).not.toHaveBeenCalled();
    expect(await get()).toEqual(before);
  });

  it("applies an approved change through the service so the Desk's GET sees it at once", async () => {
    const { views, get } = await service();
    const cards = await start(views, async () => true);
    const created = await call("views_create", { name: "Arrears", kind: "bills", filter: "due-soon" });
    expect(created.isError).toBeUndefined();
    expect(cards).toEqual(["Create view 'Arrears' with Bills (due-soon)"]);
    const id = created.structuredContent.viewId;
    expect((await get()).tabs).toEqual([seed, { id, label: "Arrears", visible: true, view: { kind: "bills", filter: "due-soon" } }]);
    expect((await call("views_reorder", { ids: [id, "view-waiting"] })).isError).toBeUndefined();
    expect((await call("views_delete", { id: "view-waiting" })).isError).toBeUndefined();
    expect((await get()).tabs.map(tab => tab.id)).toEqual([id]);
    expect(cards.slice(1)).toEqual(["Reorder views: 'Arrears', 'Waiting work'", "Delete view 'Waiting work'"]);
  });

  it("reports a conflict when views changed while the card was open", async () => {
    const { views, handler, get } = await service();
    await start(views, async () => {
      // Another window saves while the person is reading the card.
      await handler.handle("/api/workspace-tabs", "PUT", { version: 1, expectedRevision: 1, tabs: [{ ...seed, label: "Changed elsewhere" }] });
      return true;
    });
    expect(await call("views_rename", { id: "view-waiting", name: "Mine" })).toMatchObject({ isError: true, content: [{ text: VIEWS_CONFLICT }] });
    expect((await get()).tabs[0]!.label).toBe("Changed elsewhere");
  });

  it("refuses kinds, filters, sections and names the shared parser rejects, before any card", async () => {
    const { views, get } = await service();
    const approve = vi.fn(async () => true);
    const cards = await start(views, approve);
    expect(await call("views_create", { name: "Script", kind: "scripts" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Choose a saved view kind") }] });
    expect(await call("views_create", { name: "X", kind: "bills", filter: "waiting" })).toMatchObject({ isError: true });
    // The Desk layout is desk_arrange's alone; it refuses what the shared parser rejects.
    expect(await call("views_create", { name: "X", kind: "bills", sections: defaultDeskSections() })).toMatchObject({ isError: true, content: [{ text: "views_create takes name, kind, optional filter." }] });
    expect(await call("desk_arrange", { revision: 1, sections: [{ id: "queue", visible: true }] })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Choose every Desk section once") }] });
    expect(await call("desk_arrange", { revision: 1, sections: defaultDeskSections().map(section => ({ ...section, visible: section.id !== "queue" })) }))
      .toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Needs you always stays") }] });
    expect(await call("desk_arrange", { revision: -1, sections: defaultDeskSections() })).toMatchObject({ isError: true });
    expect(await call("desk_arrange", { sections: defaultDeskSections() })).toMatchObject({ isError: true });
    expect(await call("views_create", { name: "a‮b", kind: "tasks" })).toMatchObject({ isError: true });
    expect(await call("views_create", { name: "x".repeat(41), kind: "tasks" })).toMatchObject({ isError: true });
    expect(await call("views_rename", { id: "view-missing", name: "X" })).toMatchObject({ isError: true });
    expect(await call("views_reorder", { ids: [] })).toMatchObject({ isError: true });
    expect(await call("views_delete", { id: "view-waiting", extra: true })).toMatchObject({ isError: true });
    expect(cards).toEqual([]);
    expect(views.save).not.toHaveBeenCalled();
    expect((await get()).tabs).toEqual([seed]);
    expect((await get()).desk.sections).toEqual(defaultDeskSections());
  });

  it("arranges Desk at once with no card, through the same revision-checked PUT, and says what changed", async () => {
    const { views, get } = await service();
    const approve = vi.fn(async () => true);
    const cards = await start(views, approve);
    const before = await get();
    const sections = [{ id: "queue", visible: true }, ...defaultDeskSections().filter(section => section.id !== "queue").map(section => ({ ...section, visible: section.id !== "activity" }))];
    const result = await call("desk_arrange", { revision: before.revision, sections });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Arranged Desk: hid Activity; changed the order. Desk now shows Needs you, Morning brief, Mail priorities, Bills and calendar, Shared work, Get started. The person can Undo it on Desk (previous revision 1, now 2).");
    expect(result.structuredContent).toEqual({ revision: 2, previousRevision: 1 });
    expect(cards).toEqual([]);
    expect(approve).not.toHaveBeenCalled();
    expect(views.save).toHaveBeenCalledWith({ expectedRevision: 1, version: 2, tabs: before.tabs, desk: { sections } });
    const after = await get();
    expect(after.desk.sections).toEqual(sections);
    expect(after.tabs).toEqual(before.tabs);
    // History keeps the earlier layout, so Desk's Undo can restore it.
    expect(after.history.map(entry => entry.revision)).toEqual([2, 1]);
    expect(await call("desk_arrange", { revision: 2, sections })).toMatchObject({ content: [{ text: "Desk already looks like that. Nothing was changed." }] });
    expect(views.save).toHaveBeenCalledTimes(1);
  });

  it("never overwrites a Desk changed after Bud read it", async () => {
    const { views, handler, get } = await service();
    await start(views, async () => true);
    const hidden = defaultDeskSections().map(section => ({ ...section, visible: section.id !== "mail" }));
    // A stale revision is refused before any write.
    expect(await call("desk_arrange", { revision: 0, sections: hidden })).toMatchObject({ isError: true, content: [{ text: DESK_CONFLICT }] });
    expect(views.save).not.toHaveBeenCalled();
    // Another window saves between Bud's read and its write: the compare-and-set refuses it.
    const save = views.save as ReturnType<typeof vi.fn>;
    save.mockImplementationOnce(async body => {
      await handler.handle("/api/workspace-tabs", "PUT", { version: 2, expectedRevision: 1, tabs: [seed], desk: { sections: defaultDeskSections().map(section => ({ ...section, visible: section.id !== "bills" })) } });
      return (await handler.handle("/api/workspace-tabs", "PUT", body))!;
    });
    expect(await call("desk_arrange", { revision: 1, sections: hidden })).toMatchObject({ isError: true, content: [{ text: DESK_CONFLICT }] });
    expect((await get()).desk.sections.find(section => section.id === "bills")?.visible).toBe(false);
    expect((await get()).desk.sections.find(section => section.id === "mail")?.visible).toBe(true);
  });

  it("re-checks the turn and the member before arranging Desk", async () => {
    const { views, get } = await service();
    let turn: string | null = "turn-1";
    const read = views.read;
    views.read = async () => { const answer = await read(); turn = "turn-2"; return answer; };
    await start(views, async () => true, () => turn);
    const hidden = defaultDeskSections().map(section => ({ ...section, visible: section.id !== "mail" }));
    expect(await call("desk_arrange", { revision: 1, sections: hidden })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("no longer working") }] });
    expect(views.save).not.toHaveBeenCalled();
    views.read = read; turn = "turn-1";
    (views.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("The RealBud member changed, so no views were changed."), { code: "member_changed" }));
    expect(await call("desk_arrange", { revision: 1, sections: hidden })).toMatchObject({ isError: true, content: [{ text: "The RealBud member changed, so no views were changed." }] });
    expect((await get()).desk.sections).toEqual(defaultDeskSections());
  });
});

describe("saved views mount in an ACP turn", () => {
  const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
  let instance: ProviderInstance | undefined, recorder: EventRecorder | undefined, scratch = "";
  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE; delete process.env.FAKE_ACP_DUMP;
    recorder?.stop(); await instance?.dispose();
    if (scratch) await removeFixture(scratch);
    await Promise.all(directories.splice(0).map(path => removeFixture(path)));
  });

  it("mounts the views tools for the current turn and shows RealBud's card before a change", async () => {
    delete process.env.NODE_V8_COVERAGE;
    ensureDirs(); chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-views-"));
    process.env.FAKE_ACP_DUMP = join(scratch, "mount.json"); process.env.FAKE_ACP_MODE = "hang";
    instance = await HermesAgentDriver.create({ instanceId: "acp-views", displayName: "ACP Views", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    const { views, get } = await service();
    await instance.adapter.sendTurn({ threadId: "t-views", text: "hide it", integrations: { workspaceViews: views } });
    const dump = () => JSON.parse(readFileSync(join(scratch, "mount.json"), "utf8"));
    await vi.waitFor(() => expect(dump().promptCount).toBe(1));
    const descriptor = dump().mcpServers.find((row: any) => row.name === "workspace-views");
    expect(descriptor).toEqual({ type: "http", name: "workspace-views", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
      headers: [{ name: "authorization", value: expect.stringMatching(/^Bearer [a-f0-9]{64}$/) }] });
    const post = (id: number, name: string, args: unknown) => fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map((row: any) => [row.name, row.value])),
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) }).then(r => r.json() as Promise<any>);
    expect((await post(1, "views_list", {})).result.isError).toBeUndefined();
    expect(recorder.events.some(event => event.type === "request.opened")).toBe(false);
    const pending = post(2, "views_set_visible", { id: "view-waiting", visible: false });
    const opened = await recorder.until(event => event.type === "request.opened");
    expect(opened).toMatchObject({ summary: "Hide view 'Waiting work' from the sidebar" });
    expect(views.save).not.toHaveBeenCalled();
    await instance.adapter.respondToRequest("t-views", opened.requestId!, { behavior: "allow", scope: "once" });
    expect((await pending).result.isError).toBeUndefined();
    expect((await get()).tabs[0]!.visible).toBe(false);
    await instance.adapter.interruptTurn("t-views");
  });
});
