import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { ModelSelection } from "./contracts.ts";

const state = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-store-recovery-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return { dir, deniedPath: "", code: "", attempts: 0, failWritePath: "", writeFailure: "" };
});
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (String(args[0]) === state.deniedPath) {
      state.attempts++;
      throw Object.assign(new Error("fictional private path and content must stay private"), { code: state.code });
    }
    return actual.readFileSync(...args);
  } };
});
vi.mock("./atomic.ts", async original => {
  const actual = await original<typeof import("./atomic.ts")>();
  return { ...actual, writeFileAtomic: (...args: Parameters<typeof actual.writeFileAtomic>) => {
    const mode = args[0] === state.failWritePath ? state.writeFailure : "";
    if (mode === "before") throw new Error("fictional private path: disk write refused");
    actual.writeFileAtomic(...args);
    if (mode === "after") throw new Error("fictional private path: publication reply unavailable");
  } };
});

const { Store, StoreRecoveryError } = await import("./store.ts");
const selection = (): ModelSelection => ({ instanceId: "hermes", model: "default" });
const threadId = "fictional-recovery-thread";
const transcript = () => join(state.dir, `messages-${threadId}.json`);
const message = (id = "m1", parentId: string | null = null) => ({ id, role: "user", kind: "text", text: "preserved history", at: 1, parentId });
const bot = () => ({ id: "bud", threadId, name: "Bud", title: "", description: "", notifications: false, color: "green", unread: false,
  modelSelection: selection(), resumeCursors: {}, createdAt: 1, tasks: [{ threadId, title: "Existing task", createdAt: 1, resumeCursors: {} }] });
const group = () => ({ id: "fictional-group", threadId: "fictional-group-thread", name: "Team", memberIds: ["bud"], bulletin: "", unread: false, createdAt: 1 });
const recovery = (work: () => unknown) => {
  let error: unknown;
  try { work(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(StoreRecoveryError);
  expect(error).toMatchObject({ status: 503, code: "store_recovery_required", message: expect.stringContaining("need recovery") });
  expect(String(error)).not.toContain("fictional private");
};

beforeEach(() => {
  state.deniedPath = ""; state.code = ""; state.attempts = 0; state.failWritePath = ""; state.writeFailure = "";
  rmSync(state.dir, { recursive: true, force: true }); mkdirSync(state.dir, { recursive: true });
});
afterAll(() => { rmSync(state.dir, { recursive: true, force: true }); });

it("treats missing catalogs and transcripts as fresh and persists their first real records", () => {
  const store = new Store(selection);
  expect(store.bots).toEqual([]); expect(store.groups).toEqual([]);
  expect(store.messagesFor(threadId)).toEqual([]); expect(store.activePath(threadId)).toEqual([]);
  expect(readdirSync(state.dir)).toEqual([]);
  store.appendMessage(threadId, { role: "user", kind: "text", text: "first selected instruction" });
  expect(new Store(selection).messagesFor(threadId)).toMatchObject([{ text: "first selected instruction" }]);
});

it.each(["bots.json", "groups.json"])("preserves malformed %s and allows a clean retry only after correction", name => {
  const path = join(state.dir, name), raw = "{fictional interrupted catalog";
  writeFileSync(path, raw);
  recovery(() => new Store(selection)); recovery(() => new Store(selection));
  expect(readFileSync(path, "utf8")).toBe(raw);
  writeFileSync(path, "[]");
  expect(new Store(selection).bots).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("[]");
});

it.each([
  ["bots.json", null], ["bots.json", {}], ["bots.json", [null]], ["bots.json", [{}]],
  ["bots.json", [{ ...bot(), tasks: {} }]], ["bots.json", [{ ...bot(), tasks: [null] }]],
  ["bots.json", [{ ...bot(), resumeCursors: [] }]], ["bots.json", [bot(), bot()]],
  ["groups.json", {}], ["groups.json", [null]], ["groups.json", [{}]],
  ["groups.json", [{ ...group(), memberIds: {} }]], ["groups.json", [group(), group()]],
] as const)("preserves structurally invalid %s: %j", (name, value) => {
  const path = join(state.dir, name), raw = JSON.stringify(value);
  writeFileSync(path, raw);
  recovery(() => new Store(selection));
  expect(readFileSync(path, "utf8")).toBe(raw);
});

it("checks both catalogs before writing any legacy metadata migration", () => {
  const botsPath = join(state.dir, "bots.json"), groupsPath = join(state.dir, "groups.json");
  const original = JSON.stringify([{ ...bot(), chiefOfStaff: true, hidden: true }]);
  writeFileSync(botsPath, original); writeFileSync(groupsPath, "{interrupted");
  recovery(() => new Store(selection));
  expect(readFileSync(botsPath, "utf8")).toBe(original);
  expect(readFileSync(groupsPath, "utf8")).toBe("{interrupted");
});

it("holds a corrupt transcript before append, preserves it, and never caches an empty replacement", () => {
  const store = new Store(selection), raw = "{fictional interrupted transcript";
  writeFileSync(transcript(), raw);
  recovery(() => store.appendMessage(threadId, { role: "user", kind: "text", text: "must not replace history" }));
  recovery(() => store.messagesFor(threadId));
  expect(readFileSync(transcript(), "utf8")).toBe(raw);
  writeFileSync(transcript(), JSON.stringify([message()]));
  expect(store.activePath(threadId)).toMatchObject([{ id: "m1", text: "preserved history" }]);
  store.appendMessage(threadId, { role: "bot", kind: "text", text: "after deliberate correction" });
  expect(new Store(selection).activePath(threadId).map(row => row.text)).toEqual(["preserved history", "after deliberate correction"]);
});

it.each([
  ["null", null], ["missing messages", {}], ["non-array messages", { messages: {} }], ["invalid row", [null]],
  ["invalid text", [{ ...message(), text: {} }]], ["invalid parent", [{ ...message(), parentId: 1 }]],
  ["duplicate ids", [message(), message()]], ["dangling parent", [message("m1", "absent")]],
  ["dangling leaf", { messages: [message()], activeLeafId: "absent" }],
  ["invalid leaf type", { messages: [message()], activeLeafId: [] }],
  ["self cycle", [message("m1", "m1")]],
  ["inactive cycle", { messages: [message(), message("m2", "m3"), message("m3", "m2")], activeLeafId: "m1" }],
] as const)("rejects %s before traversal or mutation without changing the transcript", (_name, value) => {
  const store = new Store(selection), raw = JSON.stringify(value);
  writeFileSync(transcript(), raw);
  recovery(() => store.activePath(threadId));
  recovery(() => store.appendMessage(threadId, { role: "bot", kind: "text", text: "blocked" }));
  expect(readFileSync(transcript(), "utf8")).toBe(raw);
});

it.each(["EACCES", "EIO", "ENOTDIR", "EISDIR"])("preserves unreadable catalogs and transcripts on %s instead of caching fresh data", code => {
  for (const name of ["bots.json", "groups.json", `messages-${threadId}.json`]) {
    const path = join(state.dir, name), raw = name.startsWith("messages-") ? JSON.stringify([message()]) : "[]";
    writeFileSync(path, raw);
    const store = new Store(selection);
    state.deniedPath = path; state.code = code;
    const read = name.startsWith("messages-") ? () => store.messagesFor(threadId) : () => new Store(selection);
    recovery(read); recovery(read);
    expect(state.attempts).toBeGreaterThanOrEqual(2);
    state.deniedPath = "";
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(read()).toBeDefined();
  }
});

it("preserves flat legacy messages, missing task metadata, room routing, and unknown fields", () => {
  const legacy = { ...bot(), tasks: undefined, extraFutureMetadata: { preserved: true } };
  writeFileSync(join(state.dir, "bots.json"), JSON.stringify([legacy]));
  writeFileSync(join(state.dir, "groups.json"), JSON.stringify([group()]));
  writeFileSync(transcript(), JSON.stringify([
    { ...message("m1"), parentId: undefined, text: "Name from legacy history", extraFutureMetadata: { preserved: true } },
    { ...message("m2"), parentId: undefined, role: "bot", text: "Legacy answer" },
  ]));
  const store = new Store(selection);
  expect(store.tasks("bud")).toMatchObject([{ threadId, title: "Name from legacy history" }]);
  expect(store.group("fictional-group")?.defaultResponder).toEqual({ kind: "member", botId: "bud" });
  expect(store.activePath(threadId).map(row => row.parentId)).toEqual([null, "m1"]);
  store.appendMessage(threadId, { role: "user", kind: "text", text: "next" });
  expect(new Store(selection).messagesFor(threadId)[0]).toHaveProperty("extraFutureMetadata", { preserved: true });
  expect(store.bot("bud")).toHaveProperty("extraFutureMetadata", { preserved: true });
});

it.each([null, undefined, []])("keeps the existing legacy task migration for tasks=%j", tasks => {
  writeFileSync(join(state.dir, "bots.json"), JSON.stringify([{ ...bot(), tasks, resumeCursors: null }]));
  writeFileSync(transcript(), JSON.stringify([message()]));
  const store = new Store(selection);
  expect(store.tasks("bud")).toMatchObject([{ threadId, title: "preserved history", createdAt: 1, resumeCursors: {} }]);
});

it.each(["before", "after"])("evicts mutated thread state when failure occurs %s publication and reports an unconfirmed save", mode => {
  const store = new Store(selection);
  store.appendMessage(threadId, { role: "user", kind: "text", text: "confirmed history" });
  const original = readFileSync(transcript(), "utf8");
  state.failWritePath = transcript(); state.writeFailure = mode;
  let error: unknown;
  try { store.appendMessage(threadId, { role: "bot", kind: "text", text: "new uncertain answer" }); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(StoreRecoveryError);
  expect(error).toMatchObject({ status: 503, message: expect.stringContaining("save was not confirmed") });
  expect(String(error)).not.toContain("fictional private");
  state.writeFailure = "";
  const expected = mode === "before" ? ["confirmed history"] : ["confirmed history", "new uncertain answer"];
  if (mode === "before") expect(readFileSync(transcript(), "utf8")).toBe(original);
  expect(store.activePath(threadId).map(row => row.text)).toEqual(expected);
  expect(new Store(selection).activePath(threadId).map(row => row.text)).toEqual(expected);
});

it("does not mistake an existing directory for a missing transcript", () => {
  const store = new Store(selection); mkdirSync(transcript());
  recovery(() => store.appendMessage(threadId, { role: "user", kind: "text", text: "blocked" }));
  expect(existsSync(transcript())).toBe(true); expect(readdirSync(transcript())).toEqual([]);
});
