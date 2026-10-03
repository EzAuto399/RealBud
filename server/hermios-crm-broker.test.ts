import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowedHermiosRead, allowedHermiosWrite, callHermiosRead, CRM_RECORD_CHANGED, hermiosCrmScope, hermiosWriteOutcome,
  HERMIOS_MCP_URL, startHermiosCrmBroker, type HermiosCrmAccess,
} from "./hermios-crm-broker.ts";
import { CRM_RECORD_BUSY, InProcessCrmRecordLeases, memoryCrmWriteJournal, type CrmWriteJournal } from "./crm-record-lease.ts";
import { createHermiosConnectionService, HermiosConnectionError } from "./hermios-connection.ts";
import type { LoopbackToolServer } from "./web-research-broker.ts";

const TOKEN = "fictional-hermios-access-token";
const WORKSPACE = "0a0a0a0a-0000-4000-8000-00000000a11c";
const PROFILE = "0c0c0c0c-0000-4000-8000-0000000000c1";
const OPP_1 = "11111111-0000-4000-8000-000000000001";
const OPP_2 = "11111111-0000-4000-8000-000000000002";
const COMPANY = "22222222-0000-4000-8000-000000000001";
const UPDATED = "2026-10-02T00:00:00.000Z";
const headersOf = (broker: LoopbackToolServer) => Object.fromEntries(broker.descriptor.headers.map(row => [row.name, row.value]));

/** A stateful fake Hermios MCP following the published contract: native
 * records with `updatedAt`, 24-hour idempotency receipts (same key and payload
 * replay the original answer without mutating again), two-step creates. */
function fakeHermios() {
  const records = new Map<string, Record<string, any>>([
    [OPP_1, { id: OPP_1, name: "Fictional Renewal", stage: "PROPOSAL", updatedAt: UPDATED }],
    [OPP_2, { id: OPP_2, name: "Fictional Expansion", stage: "PROPOSAL", updatedAt: UPDATED }],
    [COMPANY, { id: COMPANY, name: "Fictional Pty Ltd", updatedAt: UPDATED }],
  ]);
  const created = new Map<string, Record<string, any>>(), links: Array<Record<string, any>> = [];
  const receipts = new Map<string, { fingerprint: string; result: Record<string, any> }>();
  const calls: Array<{ name: string; args: any; meta?: any; authorization: string | null }> = [];
  const hooks: {
    beforeUpdate?: () => Promise<void>;
    /** Apply the write, then lose the reply this many times for this tool. */
    lose?: { tool: string; times: number; before?: boolean };
    /** Answer a write with a 503 tool result this many times. */
    unknown?: { tool: string; times: number };
    failLink?: boolean;
  } = {};
  let inflight = 0, peak = 0, ids = 0;
  const reply = (id: unknown, result: unknown, session = false) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200,
    headers: { "content-type": "application/json", ...(session ? { "mcp-session-id": "fictional-session" } : {}) } });
  const ok = (value: Record<string, unknown>) => ({ isError: false, structuredContent: value });
  function mutate(tool: string, args: any): Record<string, any> {
    if (tool === "update_hermios_record") {
      const row = records.get(args.recordId);
      if (!row || row[args.field] !== args.expectedValue || (args.expectedUpdatedAt && args.expectedUpdatedAt !== row.updatedAt)) {
        return { isError: true, structuredContent: { saved: false, code: "conflict", status: 409 } };
      }
      row[args.field] = args.value; row.updatedAt = `2026-10-02T00:00:0${++ids % 10}.000Z`;
      return ok({ saved: true, record: { id: row.id, [args.field]: args.value, updatedAt: row.updatedAt } });
    }
    const inner = args.arguments;
    if (tool === "create_one_note_target" || tool === "create_one_task_target") {
      if (hooks.failLink) return { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, status: 400 }) }] };
      links.push({ ...inner }); return ok({ id: `33333333-0000-4000-8000-${String(++ids).padStart(12, "0")}` });
    }
    const id = `44444444-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
    created.set(id, { tool, ...inner });
    return ok({ id });
  }
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(HERMIOS_MCP_URL);
    const message = JSON.parse(String(init?.body));
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "initialize") return reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} } }, true);
    const { name, arguments: args, _meta } = message.params;
    calls.push({ name, args, meta: _meta, authorization: new Headers(init?.headers).get("authorization") });
    if (name === "search_hermios_mentions") return reply(message.id, ok({ results: [{ id: COMPANY, name: "Fictional Pty Ltd" }] }));
    if (name === "get_hermios_record") {
      const row = records.get(args.recordId);
      return reply(message.id, row ? ok({ view: args.view, record: { ...row } }) : { isError: true, content: [{ type: "text", text: "not found" }] });
    }
    const tool = name === "execute_tool" ? args.toolName : name;
    if (name === "update_hermios_record") { inflight++; peak = Math.max(peak, inflight); try { await hooks.beforeUpdate?.(); } finally { inflight--; } }
    if (hooks.unknown && hooks.unknown.tool === tool && hooks.unknown.times > 0) { hooks.unknown.times--; return reply(message.id, { isError: true, structuredContent: { saved: false, status: 503, statusText: "OutcomeUnknown" } }); }
    if (hooks.lose && hooks.lose.tool === tool && hooks.lose.before && hooks.lose.times > 0) { hooks.lose.times--; throw new TypeError("fictional connection reset"); }
    const key = name === "execute_tool" ? args.arguments.idempotencyKey : args.idempotencyKey;
    const fingerprint = JSON.stringify([name, args]);
    const prior = receipts.get(key);
    let result: Record<string, any>;
    if (prior) result = prior.fingerprint === fingerprint ? prior.result : { isError: true, structuredContent: { saved: false, code: "conflict", status: 409 } };
    else { result = mutate(tool, args); receipts.set(key, { fingerprint, result }); }
    if (hooks.lose && hooks.lose.tool === tool && !hooks.lose.before && hooks.lose.times > 0) { hooks.lose.times--; throw new TypeError("fictional connection reset"); }
    return reply(message.id, result);
  });
  return { records, created, links, calls, hooks, peak: () => peak, spy: fetchImpl, fetch: fetchImpl as unknown as typeof fetch,
    writes: () => calls.filter(row => row.name === "update_hermios_record" || row.name === "execute_tool") };
}

const brokers: LoopbackToolServer[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.close(); });
async function open(hermios: ReturnType<typeof fakeHermios>, options: {
  approve?: (summary: string) => Promise<boolean>; generation?: number; leases?: InProcessCrmRecordLeases; leaseWaitMs?: number;
  receipts?: unknown[]; journal?: CrmWriteJournal; access?: Partial<HermiosCrmAccess> | null; reads?: boolean;
} = {}) {
  const access: HermiosCrmAccess = { generation: options.generation ?? 1, accessToken: async () => TOKEN, workspace: WORKSPACE, profileId: PROFILE, memberName: "Dana Fictional", ...options.access };
  const broker = await startHermiosCrmBroker({ generation: 1, fetch: hermios.fetch, leases: options.leases ?? new InProcessCrmRecordLeases(), leaseWaitMs: options.leaseWaitMs,
    journal: options.journal ?? memoryCrmWriteJournal(), access: () => options.access === null ? undefined : access,
    ...(options.reads ? {} : { approve: options.approve ?? (async () => true) }), receipt: row => options.receipts?.push(row) });
  brokers.push(broker);
  let id = 0;
  const call = async (name: string, args: unknown) => ((await (await fetch(broker.descriptor.url, { method: "POST", headers: { "content-type": "application/json", ...headersOf(broker) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) })).json()) as any).result;
  const list = async () => ((await (await fetch(broker.descriptor.url, { method: "POST", headers: headersOf(broker), body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }) })).json()) as any).result.tools.map((tool: any) => tool.name);
  return { call, list };
}
const stage = (recordId = OPP_1, from = "PROPOSAL", to = "WON") => ({ view: "pipeline", recordId, field: "stage", from, to });

describe("Hermios allowlists (published contract)", () => {
  it("admits native reads by view and find/group reads with select and a bounded limit", () => {
    expect(allowedHermiosRead("get_hermios_record", { view: "pipeline", recordId: OPP_1 })).toBe(true);
    expect(allowedHermiosRead("execute_read_tool", { toolName: "find_many_note_targets", arguments: { targetOpportunityId: { eq: OPP_1 }, select: ["id", "noteId"], limit: 100 } })).toBe(true);
    expect(allowedHermiosRead("execute_read_tool", { toolName: "find_one_note", arguments: { id: OPP_1, select: ["id"] } })).toBe(true);
  });
  it.each([
    ["get_hermios_record", { objectNameSingular: "opportunity", recordId: OPP_1 }],
    ["get_hermios_record", { view: "deals", recordId: OPP_1 }],
    ["get_hermios_record", { view: "pipeline", recordId: "opp-1" }],
    ["execute_read_tool", { toolName: "find_many_notes", arguments: {} }],
    ["execute_read_tool", { toolName: "find_many_notes", arguments: { select: [] } }],
    ["execute_read_tool", { toolName: "find_many_notes", arguments: { select: ["id"], limit: 101 } }],
    ["execute_read_tool", { toolName: "delete_many_notes", arguments: { select: ["id"] } }],
    ["execute_tool", { toolName: "find_many_notes", arguments: { select: ["id"] } }],
    ["send_email", {}],
  ])("refuses read %s %j", (name, args) => expect(allowedHermiosRead(name, args)).toBe(false));

  it("admits execute_tool with exactly the four create tools, each with its own key", () => {
    const key = "realbud:crm-1:note";
    expect(allowedHermiosWrite("execute_tool", { toolName: "create_one_note", arguments: { title: "t", bodyV2: { markdown: "b" }, idempotencyKey: key } })).toBe(true);
    expect(allowedHermiosWrite("execute_tool", { toolName: "create_one_task", arguments: { title: "t", dueAt: UPDATED, idempotencyKey: key } })).toBe(true);
    expect(allowedHermiosWrite("execute_tool", { toolName: "create_one_note_target", arguments: { noteId: OPP_1, targetCompanyId: COMPANY, idempotencyKey: key } })).toBe(true);
    expect(allowedHermiosWrite("execute_tool", { toolName: "create_one_task_target", arguments: { taskId: OPP_1, targetPersonId: COMPANY, idempotencyKey: key } })).toBe(true);
    for (const toolName of ["delete_one_note", "send_email", "draft_email", "run_workflow", "update_one_opportunity", "create_one_person", "create_many_notes"]) {
      expect(allowedHermiosWrite("execute_tool", { toolName, arguments: { idempotencyKey: key } })).toBe(false);
    }
    expect(allowedHermiosWrite("execute_tool", { toolName: "create_one_note", arguments: { title: "t" } })).toBe(false);
    expect(allowedHermiosWrite("execute_tool", { toolName: "create_one_note", arguments: { title: "t", body: "x", idempotencyKey: key } })).toBe(false);
    expect(allowedHermiosWrite("execute_tool", { toolName: "create_one_note_target", arguments: { noteId: OPP_1, targetObject: "company", targetRecordId: COMPANY, idempotencyKey: key } })).toBe(false);
    expect(allowedHermiosWrite("execute_tool", { toolName: "create_one_note_target", arguments: { noteId: OPP_1, targetCompanyId: COMPANY, targetPersonId: COMPANY, idempotencyKey: key } })).toBe(false);
    expect(allowedHermiosWrite("update_hermios_record", { view: "pipeline", recordId: OPP_1, field: "stage", value: "WON", expectedValue: "PROPOSAL", idempotencyKey: key })).toBe(true);
    expect(allowedHermiosWrite("update_hermios_record", { view: "pipeline", recordId: OPP_1, field: "status", value: "WON", expectedValue: "PROPOSAL", idempotencyKey: key })).toBe(false);
    expect(allowedHermiosWrite("update_hermios_record", { objectNameSingular: "opportunity", recordId: OPP_1, field: "stage", value: "WON", expectedValue: "PROPOSAL", idempotencyKey: key })).toBe(false);
    expect(allowedHermiosRead("execute_tool", { toolName: "create_one_note", arguments: { title: "t", idempotencyKey: key } })).toBe(false);
  });

  it("reads conflict and unknown outcomes from the tool result, not the HTTP status", () => {
    expect(hermiosWriteOutcome({ isError: true, structuredContent: { saved: false, code: "conflict", status: 409 } })).toBe("conflict");
    expect(hermiosWriteOutcome({ isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, status: 409, statusText: "Conflict" }) }] })).toBe("conflict");
    expect(hermiosWriteOutcome({ isError: true, structuredContent: { status: 503 } })).toBe("uncertain");
    expect(hermiosWriteOutcome({ isError: true, content: [{ type: "text", text: "nope" }] })).toBe("failed");
    expect(hermiosWriteOutcome({ isError: false, structuredContent: { saved: true } })).toBe("ok");
  });

  it("refuses execute_tool before any request leaves RealBud", async () => {
    const hermios = fakeHermios();
    await expect(callHermiosRead({ fetch: hermios.fetch, accessToken: TOKEN, signal: new AbortController().signal }, "execute_tool", { toolName: "delete_one_person" })).rejects.toThrow(/not a permitted read/);
    expect(hermios.spy).not.toHaveBeenCalled();
  });
});

describe("Hermios CRM reads", () => {
  it("lists only the reads without an approval card and maps them to native reads with the member token", async () => {
    const hermios = fakeHermios(), receipts: unknown[] = [];
    const { call, list } = await open(hermios, { reads: true, receipts });
    expect(await list()).toEqual(["crm_search", "crm_get_record"]);
    const found = await call("crm_search", { query: "Fictional" });
    expect(found.content[0].text).toMatch(/\[untrusted CRM data begin [a-f0-9]{12}\][\s\S]*Fictional Pty Ltd[\s\S]*\[untrusted CRM data end [a-f0-9]{12}\]/);
    const opened = await call("crm_get_record", { view: "pipeline", recordId: OPP_1 });
    expect(opened.content[0].text).toContain(`Source: Hermios pipeline record ${OPP_1}.`);
    expect(hermios.calls.map(row => [row.name, row.args])).toEqual([["search_hermios_mentions", { query: "Fictional" }], ["get_hermios_record", { view: "pipeline", recordId: OPP_1 }]]);
    expect(hermios.calls.every(row => row.authorization === `Bearer ${TOKEN}` && row.meta === undefined)).toBe(true);
    expect(await call("crm_get_record", { object: "opportunity", id: OPP_1 })).toMatchObject({ isError: true });
    for (const name of ["crm_set_stage", "execute_tool", "send_email"]) expect(await call(name, {})).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("not available") }] });
    expect(hermios.calls).toHaveLength(2);
    expect(JSON.stringify(receipts)).not.toContain(TOKEN);
  });

  it("refuses a stale connection generation before any Hermios request", async () => {
    const companyId = "fictional-company", memberId = "fictional-member";
    const entry = `hermios-member-${createHash("sha256").update(JSON.stringify(["hermios-connection-v1", companyId, memberId])).digest("hex").slice(0, 48)}`;
    const store = new Map<string, unknown>([[entry, { version: 1, companyId, memberId, generation: 2, status: "connected", reason: null,
      account: { displayName: "Fictional", workspaceLabel: "Fictional", workspaceId: WORKSPACE, profileId: PROFILE, verifiedAt: 1 },
      tokens: { accessToken: TOKEN, refreshToken: null, expiresAt: Date.now() + 3_600_000, clientId: "fictional-client" } }]]);
    const service = createHermiosConnectionService({ vault: { read: async name => store.get(name), write: async (name, value) => { store.set(name, value); }, remove: async name => { store.delete(name); } },
      context: () => ({ companyId, memberId }), redirectUri: () => "http://127.0.0.1:1/api/hermios/oauth/callback", fetch: vi.fn() as unknown as typeof fetch });
    try {
      const hermios = fakeHermios(), receipts: unknown[] = [];
      const { call } = await open(hermios, { receipts, access: { accessToken: () => service.accessTokenFor({ companyId, memberId }, 1) } });
      expect(await call("crm_search", { query: "Fictional" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("connection changed") }] });
      expect(hermios.spy).not.toHaveBeenCalled();
      expect(receipts).toEqual([{ tool: "crm_search", generation: 1, outcome: "refused" }]);
      await expect(service.accessTokenFor({ companyId, memberId }, 2)).resolves.toBe(TOKEN);
    } finally { service.close(); }
  });

  it("refuses when the turn carries another generation or no access, and maps connection errors", async () => {
    const hermios = fakeHermios();
    expect(await (await open(hermios, { generation: 5 })).call("crm_search", { query: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("connection changed") }] });
    expect(await (await open(hermios, { access: null })).call("crm_search", { query: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("no longer working") }] });
    const reconnect = await open(hermios, { access: { accessToken: async () => { throw new HermiosConnectionError("needs_reconnect", "internal"); } } });
    expect(await reconnect.call("crm_search", { query: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("sign in again") }] });
    expect(hermios.spy).not.toHaveBeenCalled();
    await expect(startHermiosCrmBroker({ generation: 0, access: () => undefined })).rejects.toThrow(/unavailable/);
    expect(hermiosCrmScope({ companyId: "c", memberId: "a" })).not.toBe(hermiosCrmScope({ companyId: "c", memberId: "b" }));
  });
});

describe("Hermios CRM reviewed writes", () => {
  it("shows the card before any write; an approved stage change sends the full precondition, key and attribution", async () => {
    const hermios = fakeHermios(), summaries: string[] = [], receipts: any[] = [], journal = memoryCrmWriteJournal();
    let writesAtCard = -1;
    const { call, list } = await open(hermios, { receipts, journal, approve: async summary => { summaries.push(summary); writesAtCard = hermios.writes().length; return summaries.length > 1; } });
    expect(await list()).toEqual(["crm_search", "crm_get_record", "crm_set_stage", "crm_add_note", "crm_add_task"]);
    expect(await call("crm_set_stage", stage())).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("did not approve") }] });
    expect(summaries[0]).toContain(`Record: pipeline "Fictional Renewal" (id ${OPP_1})\nField: stage\nFrom: "PROPOSAL"\nTo: "WON"`);
    expect(writesAtCard).toBe(0);
    expect(hermios.writes()).toHaveLength(0);
    const done = await call("crm_set_stage", stage());
    expect(done.content[0].text).toContain('Hermios confirmed the change');
    const [update] = hermios.writes();
    const correlationId = receipts[1].correlationId;
    expect(update).toEqual({ name: "update_hermios_record", authorization: `Bearer ${TOKEN}`,
      args: { view: "pipeline", recordId: OPP_1, field: "stage", value: "WON", expectedValue: "PROPOSAL", expectedProfileId: PROFILE, expectedUpdatedAt: UPDATED, idempotencyKey: `realbud:${correlationId}:update` },
      meta: { "realbud.agent": "Bud", "realbud.onBehalfOf": "Dana Fictional" } });
    expect(receipts.map(row => row.outcome)).toEqual(["denied", "succeeded"]);
    expect(receipts[1]).toMatchObject({ tool: "crm_set_stage", generation: 1, record: { view: "pipeline", recordId: OPP_1 } });
    expect(summaries[1]).toContain(`Reference: ${correlationId}`);
    expect(await journal.list()).toEqual([expect.objectContaining({ correlationId, workspace: WORKSPACE, steps: [{ kind: "update", idempotencyKey: `realbud:${correlationId}:update`, status: "succeeded" }] })]);
    expect(JSON.stringify([receipts, await journal.list()])).not.toContain(TOKEN);
  });

  it("refuses a stale from before the card, a change during the card, and Hermios's own conflict", async () => {
    const hermios = fakeHermios();
    const approve = vi.fn(async () => true);
    const first = await open(hermios, { approve });
    expect(await first.call("crm_set_stage", stage(OPP_1, "LEAD", "WON"))).toEqual({ isError: true, content: [{ type: "text", text: CRM_RECORD_CHANGED }] });
    expect(approve).not.toHaveBeenCalled();
    let approvals = 0;
    const moved = await open(hermios, { approve: async () => { if (++approvals === 1) hermios.records.get(OPP_1)!.stage = "NEGOTIATION"; return true; } });
    expect(await moved.call("crm_set_stage", stage())).toEqual({ isError: true, content: [{ type: "text", text: CRM_RECORD_CHANGED }] });
    expect(hermios.writes()).toHaveLength(0);
    // Between RealBud's re-read and the update, someone else edits the record.
    hermios.records.get(OPP_1)!.stage = "PROPOSAL";
    hermios.hooks.beforeUpdate = async () => { hermios.records.get(OPP_1)!.updatedAt = "2026-10-02T09:09:09.000Z"; };
    expect(await moved.call("crm_set_stage", stage())).toEqual({ isError: true, content: [{ type: "text", text: CRM_RECORD_CHANGED }] });
    expect(hermios.records.get(OPP_1)!.stage).toBe("PROPOSAL");
  });

  it("admits one write per record across members of the workspace: the second waits, then is refused", async () => {
    const hermios = fakeHermios(), leases = new InProcessCrmRecordLeases();
    let release!: () => void;
    hermios.hooks.beforeUpdate = () => new Promise<void>(resolve => { release = resolve; });
    const first = (await open(hermios, { leases })).call("crm_set_stage", stage());
    await vi.waitFor(() => expect(hermios.writes()).toHaveLength(1));
    // Another member of the same Hermios workspace.
    const other = await open(hermios, { leases, leaseWaitMs: 50, access: { profileId: "0c0c0c0c-0000-4000-8000-0000000000c2", memberName: "Fictional Other" } });
    expect(await other.call("crm_set_stage", stage(OPP_1, "PROPOSAL", "LOST"))).toEqual({ isError: true, content: [{ type: "text", text: CRM_RECORD_BUSY }] });
    const waiting = (await open(hermios, { leases, leaseWaitMs: 5000 })).call("crm_set_stage", stage(OPP_1, "PROPOSAL", "LOST"));
    release();
    expect((await first).isError).toBeUndefined();
    hermios.hooks.beforeUpdate = undefined;
    // The waiter re-reads under the lease and finds the record moved on.
    expect(await waiting).toEqual({ isError: true, content: [{ type: "text", text: CRM_RECORD_CHANGED }] });
    expect(hermios.records.get(OPP_1)!.stage).toBe("WON");
  });

  it("runs writes on different records in parallel", async () => {
    const hermios = fakeHermios(), leases = new InProcessCrmRecordLeases(), gate: Array<() => void> = [];
    hermios.hooks.beforeUpdate = () => new Promise<void>(resolve => gate.push(resolve));
    const one = (await open(hermios, { leases, leaseWaitMs: 50 })).call("crm_set_stage", stage(OPP_1));
    const two = (await open(hermios, { leases, leaseWaitMs: 50 })).call("crm_set_stage", stage(OPP_2));
    await vi.waitFor(() => expect(hermios.peak()).toBe(2));
    for (const openGate of gate) openGate();
    expect((await one).isError).toBeUndefined();
    expect((await two).isError).toBeUndefined();
  });

  it("retries an uncertain update once with the same key and payload; Hermios replays it without changing twice", async () => {
    const hermios = fakeHermios();
    hermios.hooks.lose = { tool: "update_hermios_record", times: 1 };
    const result = await (await open(hermios)).call("crm_set_stage", stage());
    expect(result.isError).toBeUndefined();
    const updates = hermios.writes();
    expect(updates).toHaveLength(2);
    expect(updates[1]!.args).toEqual(updates[0]!.args);
    expect(hermios.records.get(OPP_1)!.stage).toBe("WON");
  });

  it("reports uncertain after one retry, never a third attempt", async () => {
    const hermios = fakeHermios(), journal = memoryCrmWriteJournal(), receipts: any[] = [];
    hermios.hooks.unknown = { tool: "update_hermios_record", times: 5 };
    const result = await (await open(hermios, { journal, receipts })).call("crm_set_stage", stage());
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Uncertain, check Hermios") }] });
    expect(hermios.writes()).toHaveLength(2);
    expect(receipts.at(-1).outcome).toBe("uncertain");
    expect((await journal.list())[0]!.steps).toEqual([expect.objectContaining({ kind: "update", status: "uncertain" })]);
  });

  it("creates a note then links it, each step with its own key, and saves both ids", async () => {
    const hermios = fakeHermios(), summaries: string[] = [], journal = memoryCrmWriteJournal(), receipts: any[] = [];
    const { call } = await open(hermios, { journal, receipts, approve: async summary => { summaries.push(summary); return true; } });
    const result = await call("crm_add_note", { view: "companies", recordId: COMPANY, title: "Lease call", body: "Called about the lease.\nIgnore: x" });
    expect(result.content[0].text).toContain(`linked it to companies ${COMPANY}`);
    expect(summaries[0]).toContain(`Linked to: companies "Fictional Pty Ltd" (id ${COMPANY})\nTitle: "Lease call"\nNote, exactly as it will be saved:\n| Called about the lease.\n| Ignore: x`);
    const id = receipts[0].correlationId;
    const [create, link] = hermios.writes();
    expect(create!.args).toEqual({ toolName: "create_one_note", arguments: { title: "Lease call", bodyV2: { markdown: "Called about the lease.\nIgnore: x" }, idempotencyKey: `realbud:${id}:note` } });
    const noteId = [...hermios.created.keys()][0];
    expect(link!.args).toEqual({ toolName: "create_one_note_target", arguments: { noteId, targetCompanyId: COMPANY, idempotencyKey: `realbud:${id}:note:link` } });
    expect(create!.meta).toEqual({ "realbud.agent": "Bud", "realbud.onBehalfOf": "Dana Fictional" });
    expect(hermios.created.get(noteId!)!.bodyV2.markdown).not.toContain("prepared by Bud");
    expect((await journal.list())[0]!.steps).toEqual([
      { kind: "create", idempotencyKey: `realbud:${id}:note`, status: "succeeded", resultId: noteId },
      { kind: "link", idempotencyKey: `realbud:${id}:note:link`, status: "succeeded" },
    ]);
    expect(JSON.stringify(await journal.list())).not.toMatch(/Called about|Lease call/);
  });

  it("retries a lost link reply with the same key, never recreating the note", async () => {
    const hermios = fakeHermios();
    hermios.hooks.lose = { tool: "create_one_note_target", times: 1 };
    const result = await (await open(hermios)).call("crm_add_note", { view: "pipeline", recordId: OPP_1, body: "Follow up" });
    expect(result.isError).toBeUndefined();
    expect(hermios.created.size).toBe(1);
    expect(hermios.links).toHaveLength(1);
    const links = hermios.writes().filter(row => row.args.toolName === "create_one_note_target");
    expect(links).toHaveLength(2);
    expect(links[1]!.args).toEqual(links[0]!.args);
  });

  it("keeps the created id when the link fails and does not create again", async () => {
    const hermios = fakeHermios(), journal = memoryCrmWriteJournal(), receipts: any[] = [];
    hermios.hooks.failLink = true;
    const result = await (await open(hermios, { journal, receipts })).call("crm_add_note", { view: "pipeline", recordId: OPP_1, body: "Follow up" });
    const noteId = [...hermios.created.keys()][0];
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(`created (id ${noteId})`) }] });
    expect(hermios.created.size).toBe(1);
    expect(receipts.at(-1).outcome).toBe("partial");
    expect((await journal.list())[0]!.steps.find(step => step.kind === "create")).toMatchObject({ status: "succeeded", resultId: noteId });
  });

  it("treats a lost create reply as one create after the same-key retry", async () => {
    const hermios = fakeHermios();
    hermios.hooks.lose = { tool: "create_one_task", times: 1 };
    const result = await (await open(hermios)).call("crm_add_task", { title: "Send the fictional lease", dueAt: "2026-10-05T09:00:00+10:00" });
    expect(result.isError).toBeUndefined();
    expect(hermios.created.size).toBe(1);
    const creates = hermios.writes();
    expect(creates).toHaveLength(2);
    expect(creates[0]!.args).toEqual(creates[1]!.args);
    expect(creates[0]!.args.arguments).toEqual({ title: "Send the fictional lease", dueAt: "2026-10-04T23:00:00.000Z", idempotencyKey: creates[0]!.args.arguments.idempotencyKey });
  });

  it("refuses a stale generation before showing a card", async () => {
    const hermios = fakeHermios(), approve = vi.fn(async () => true);
    expect(await (await open(hermios, { generation: 2, approve })).call("crm_set_stage", stage())).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("connection changed") }] });
    expect(approve).not.toHaveBeenCalled();
    expect(hermios.writes()).toHaveLength(0);
  });

  it("sends nothing when the receipt cannot be saved", async () => {
    const hermios = fakeHermios();
    const journal: CrmWriteJournal = { begin: async () => { throw new Error("disk"); }, step: async () => {}, list: async () => [] };
    expect(await (await open(hermios, { journal })).call("crm_set_stage", stage())).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("could not save a receipt") }] });
    expect(hermios.writes()).toHaveLength(0);
  });
});
