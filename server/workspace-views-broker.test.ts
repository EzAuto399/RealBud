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
import { startWorkspaceViewsBroker, VIEWS_CONFLICT, type BudWorkspaceViews } from "./workspace-views-broker.ts";
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
  const start = async (views: BudWorkspaceViews, approve: (summary: string) => Promise<boolean>) => {
    const cards: string[] = [];
    broker = await startWorkspaceViewsBroker({ turnId: () => "turn-1", views: () => views, approve: async summary => { cards.push(summary); return approve(summary); } });
    return cards;
  };

  it("lists views with no card", async () => {
    const { views } = await service();
    const approve = vi.fn(async () => true);
    const cards = await start(views, approve);
    const result = await call("views_list", {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.views).toEqual([{ id: "view-waiting", name: "Waiting work", kind: "tasks", filter: "waiting", visible: true }]);
    expect(result.content[0].text).toContain("Desk shows: Morning brief");
    expect(cards).toEqual([]);
    expect(approve).not.toHaveBeenCalled();
  });

  it("shows one plain card before each change, and a denial changes nothing", async () => {
    const { views, get } = await service();
    const cards = await start(views, async () => false);
    const before = await get();
    const attempts: Array<[string, unknown, string]> = [
      ["views_create", { name: "Arrears", kind: "bills", sections: defaultDeskSections().map(section => ({ ...section, visible: ["bills", "mail", "queue"].includes(section.id) })) },
        "Create view 'Arrears' with Bills and show Mail priorities, Bills and calendar, Needs you on Desk"],
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
    expect(await call("views_create", { name: "X", kind: "bills", sections: [{ id: "queue", visible: true }] })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Choose every Desk section once") }] });
    expect(await call("views_create", { name: "X", kind: "bills", sections: defaultDeskSections().map(section => ({ ...section, visible: section.id !== "queue" })) }))
      .toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Needs you always stays") }] });
    expect(await call("views_create", { name: "a‮b", kind: "tasks" })).toMatchObject({ isError: true });
    expect(await call("views_create", { name: "x".repeat(41), kind: "tasks" })).toMatchObject({ isError: true });
    expect(await call("views_rename", { id: "view-missing", name: "X" })).toMatchObject({ isError: true });
    expect(await call("views_reorder", { ids: [] })).toMatchObject({ isError: true });
    expect(await call("views_delete", { id: "view-waiting", extra: true })).toMatchObject({ isError: true });
    expect(cards).toEqual([]);
    expect(views.save).not.toHaveBeenCalled();
    expect((await get()).tabs).toEqual([seed]);
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
