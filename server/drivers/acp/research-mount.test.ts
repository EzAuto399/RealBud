// core.ts mounts Bud's page reader and the read-only Hermios CRM as private
// loopback brokers, and binds warm-session reuse to the CRM member scope and
// connection generation. Runs against the scripted fake ACP CLI.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeFixture } from "../../testing/private-fixture.ts";
import { HermesAgentDriver } from "./hermes.ts";
import { HermiosConnectionError } from "../../hermios-connection.ts";

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("../../managed-service.ts", () => ({ managedService: { assertCapability } }));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
delete process.env.NODE_V8_COVERAGE;
const TOKEN = "fictional-hermios-mount-token";

describe("ACP research and CRM mounts", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  const create = async (mode?: string) => {
    if (mode) process.env.FAKE_ACP_MODE = mode;
    instance = await HermesAgentDriver.create({ instanceId: "acp-research", displayName: "ACP Research", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
  };
  const dump = () => JSON.parse(readFileSync(join(scratch, "mount.json"), "utf8"));
  const crm = (generation: number, scope = "a".repeat(64), accessToken = vi.fn(async () => TOKEN)) => ({ scope, generation, accessToken });

  beforeEach(() => {
    assertCapability.mockReset();
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-research-"));
    process.env.FAKE_ACP_DUMP = join(scratch, "mount.json");
  });
  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    recorder?.stop();
    await instance?.dispose();
    await removeFixture(scratch);
  });

  it("mounts both brokers on loopback with a private bearer and never serializes the token", async () => {
    await create();
    const turn = await instance.adapter.sendTurn({ threadId: "t-research", text: "look it up", integrations: { webPages: { allowedUrls: [] }, hermiosCrm: crm(2) } });
    await recorder.until(event => event.type === "turn.completed" && event.turnId === turn.turnId);
    const servers = dump().mcpServers;
    for (const name of ["web-pages", "hermios-crm"]) {
      expect(servers).toEqual(expect.arrayContaining([{ type: "http", name, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
        headers: [{ name: "authorization", value: expect.stringMatching(/^Bearer [a-f0-9]{64}$/) }] }]));
    }
    expect(JSON.stringify(dump())).not.toContain(TOKEN);
    expect(readFileSync(join(NATIVE_DIR, "t-research.ndjson"), "utf8")).not.toContain(TOKEN);
  });

  it("does not mount the CRM without a connected Hermios binding", async () => {
    await create();
    const turn = await instance.adapter.sendTurn({ threadId: "t-no-crm", text: "read", integrations: { webPages: { allowedUrls: [] } } });
    await recorder.until(event => event.type === "turn.completed" && event.turnId === turn.turnId);
    expect(dump().mcpServers.map((row: any) => row.name)).toEqual(["web-pages"]);
  });

  it("mounts the sign-in helper on loopback with a private bearer, and refuses a malformed binding", async () => {
    await create();
    const turn = await instance.adapter.sendTurn({ threadId: "t-sign-in", text: "open the portal", integrations: { signIn: { personUrls: ["https://portal.fictional.example/"], approvedSites: [] } } });
    await recorder.until(event => event.type === "turn.completed" && event.turnId === turn.turnId);
    expect(dump().mcpServers).toEqual([{ type: "http", name: "sign-in", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
      headers: [{ name: "authorization", value: expect.stringMatching(/^Bearer [a-f0-9]{64}$/) }] }]);
    await expect(instance.adapter.sendTurn({ threadId: "t-bad-sign-in", text: "open", integrations: { signIn: { personUrls: [42 as unknown as string], approvedSites: [] } } }))
      .rejects.toThrow(/sign-in helper is unavailable/);
  });

  it("refuses a malformed CRM binding before starting a worker", async () => {
    await create();
    await expect(instance.adapter.sendTurn({ threadId: "t-bad-crm", text: "read", integrations: { hermiosCrm: crm(0) } })).rejects.toThrow(/Hermios connection is unavailable/);
  });

  it("keeps a warm session for the same generation and replaces it when the generation or member changes", async () => {
    await create();
    const send = async (integrations: SendTurnInput["integrations"]) => {
      const turn = await instance.adapter.sendTurn({ threadId: "t-generation", text: "read", resumeCursor: "fake-acp-session", integrations });
      await recorder.until(event => event.type === "turn.completed" && event.turnId === turn.turnId);
      return dump().pid as number;
    };
    const first = await send({ webPages: { allowedUrls: [] }, hermiosCrm: crm(1) });
    expect(await send({ webPages: { allowedUrls: [] }, hermiosCrm: crm(1) })).toBe(first);
    const reconnected = await send({ webPages: { allowedUrls: [] }, hermiosCrm: crm(2) });
    expect(reconnected).not.toBe(first);
    const otherMember = await send({ webPages: { allowedUrls: [] }, hermiosCrm: crm(2, "b".repeat(64)) });
    expect(otherMember).not.toBe(reconnected);
    expect(await send({ webPages: { allowedUrls: [] } })).not.toBe(otherMember);
  });

  it("answers CRM calls with the current turn's access and refuses once the turn ends", async () => {
    await create("hang");
    const accessToken = vi.fn(async () => { throw new HermiosConnectionError("stale", "fixture"); });
    await instance.adapter.sendTurn({ threadId: "t-crm-call", text: "find", integrations: { webPages: { allowedUrls: [] }, hermiosCrm: crm(3, "c".repeat(64), accessToken) } });
    await vi.waitFor(() => expect(dump().promptCount).toBe(1));
    const descriptor = dump().mcpServers.find((row: any) => row.name === "hermios-crm");
    const call = async (id: number) => ((await (await fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map((row: any) => [row.name, row.value])),
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "crm_search", arguments: { query: "Fictional" } } }) })).json()) as any).result;
    expect(await call(1)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("connection changed") }] });
    expect(accessToken).toHaveBeenCalledTimes(1);
    await instance.adapter.interruptTurn("t-crm-call");
    const after = await fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map((row: any) => [row.name, row.value])),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "crm_search", arguments: { query: "Fictional" } } }) }).then(r => r.ok ? r.json() : null).catch(() => null) as any;
    if (after) expect(after.result.isError).toBe(true);
    expect(accessToken).toHaveBeenCalledTimes(1);
  });
  it("mounts set_reminder for the current turn with no card", async () => {
    await create("hang");
    const createReminder = vi.fn(async (input: { dueAt: number }) => ({ id: "rem-fictional", dueAt: input.dueAt }));
    await instance.adapter.sendTurn({ threadId: "t-reminder", text: "remind me", integrations: { reminders: { create: createReminder, timeZone: async () => "Australia/Brisbane" } } });
    await vi.waitFor(() => expect(dump().promptCount).toBe(1));
    const descriptor = dump().mcpServers.find((row: any) => row.name === "reminders");
    const result: any = await (await fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map((row: any) => [row.name, row.value])),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_reminder", arguments: { title: "Fictional follow-up", dueAt: "2099-01-05T09:00" } } }) })).json();
    expect(result.result.content[0].text).toContain("rem-fictional");
    expect(createReminder).toHaveBeenCalledTimes(1);
    expect(recorder.events.some(event => event.type === "request.opened")).toBe(false);
    await instance.adapter.interruptTurn("t-reminder");
  });

  it("shows RealBud's connected-app card for a CRM write and writes nothing when denied", async () => {
    const realFetch = globalThis.fetch;
    const hermiosCalls: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (!String(input).startsWith("https://api.hermios.app/")) return realFetch(input, init);
      const message = JSON.parse(String(init?.body));
      if (message.id === undefined) return new Response(null, { status: 202 });
      hermiosCalls.push(message.method === "tools/call" ? message.params.name : message.method);
      const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        : { isError: false, structuredContent: { view: "pipeline", record: { id: "11111111-0000-4000-8000-000000000001", name: "Fictional Renewal", stage: "PROPOSAL", updatedAt: "2026-10-02T00:00:00.000Z" } } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "application/json", "mcp-session-id": "fictional-session" } });
    });
    try {
      await create("hang");
      await instance.adapter.sendTurn({ threadId: "t-crm-write", text: "move it", integrations: { hermiosCrm: crm(1) } });
      await vi.waitFor(() => expect(dump().promptCount).toBe(1));
      const descriptor = dump().mcpServers.find((row: any) => row.name === "hermios-crm");
      const response = realFetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map((row: any) => [row.name, row.value])),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "crm_set_stage", arguments: { view: "pipeline", recordId: "11111111-0000-4000-8000-000000000001", field: "stage", from: "PROPOSAL", to: "WON" } } }) });
      const opened = await recorder.until(event => event.type === "request.opened");
      expect(opened).toMatchObject({ tool: "bud_connected_app_action", summary: expect.stringContaining('From: "PROPOSAL"\nTo: "WON"') });
      expect(hermiosCalls).not.toContain("update_hermios_record");
      await instance.adapter.respondToRequest("t-crm-write", opened.requestId!, { behavior: "deny" });
      expect(((await (await response).json()) as any).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("did not approve") }] });
      expect(hermiosCalls).not.toContain("update_hermios_record");
      await instance.adapter.interruptTurn("t-crm-write");
    } finally { spy.mockRestore(); }
  });
});
