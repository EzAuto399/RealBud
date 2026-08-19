// Store persistence contract: bots.json + messages-<threadId>.json are
// the durable record — everything here must survive a process restart
// except `busy`, which never does (no turn survives one either).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelSelection } from "./contracts.ts";
import type { BotRecord } from "./store.ts";

// The Store writes under DATA_DIR — the same directory other parallel test
// workers use (permission sockets, transcripts). Give THIS file a private
// data dir before config.ts reads the env, so no worker ever deletes
// another's files. vi.hoisted runs before any module is imported, so build
// the path from globals only (no `join`/`tmpdir` in here).
const dataDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-store-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});

const { DATA_DIR } = await import("./config.ts");
const { Store } = await import("./store.ts");

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Store", () => {
  beforeEach(() => {
    // Remove only what the Store owns, so a leftover file from a previous
    // test can never leak into this one.
    mkdirSync(DATA_DIR, { recursive: true });
    for (const name of ["bots.json", "groups.json", "events", "native"]) {
      rmSync(join(DATA_DIR, name), { recursive: true, force: true });
    }
    for (const name of readdirSync(DATA_DIR)) {
      if (name.startsWith("messages-")) rmSync(join(DATA_DIR, name), { force: true });
    }
  });

  it("createBot seeds a greeting and an onboarding card", () => {
    const store = new Store(selection);
    const bot = store.createBot();

    const messages = store.messagesFor(bot.threadId);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "bot", kind: "text" });
    expect(messages[1].kind).toBe("options");
    expect(messages[1].card?.options.length).toBeGreaterThan(1);
    expect(bot.modelSelection).toEqual(selection());
  });

  it("rotates colors across created bots", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    expect(first.color).not.toBe(second.color);
  });

  it("defaults a room to its first member and repairs the lead when membership changes", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Team", [first.id, second.id]);

    expect(group.defaultResponder).toEqual({ kind: "member", botId: first.id });
    store.patchGroup(group.id, { memberIds: [second.id] });
    expect(group.defaultResponder).toEqual({ kind: "member", botId: second.id });

    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: second.id });
  });

  it("migrates old rooms without routing to their first member", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Legacy team", [first.id, second.id]);
    const groupsFile = join(DATA_DIR, "groups.json");
    const saved = JSON.parse(readFileSync(groupsFile, "utf8"));
    delete saved[0].defaultResponder;
    writeFileSync(groupsFile, JSON.stringify(saved));

    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: first.id });
  });

  it("persists bots and messages across a restart, resetting busy", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { name: "Testy", busy: true });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi there" });

    const reloaded = new Store(selection);
    const back = reloaded.bot(bot.id)!;
    expect(back.name).toBe("Testy");
    expect(back.busy).toBe(false);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.at(-1)).toMatchObject({ role: "user", text: "hi there" });
  });

  it("keeps exactly one persisted Chief of Staff and supports handoff", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();

    expect(store.setChiefOfStaff(first.id)?.map((bot) => bot.id)).toEqual([first.id]);
    expect(store.bot(first.id)?.chiefOfStaff).toBe(true);

    const changed = store.setChiefOfStaff(second.id)!;
    expect(changed.map((bot) => bot.id).sort()).toEqual([first.id, second.id].sort());
    expect(store.bot(first.id)?.chiefOfStaff).toBe(false);
    expect(store.bot(second.id)?.chiefOfStaff).toBe(true);

    const reloaded = new Store(selection);
    expect(reloaded.bots.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id)).toEqual([second.id]);
    expect(reloaded.setChiefOfStaff(null)?.map((bot) => bot.id)).toEqual([second.id]);
    expect(reloaded.bots.some((bot) => bot.chiefOfStaff)).toBe(false);
  });

  it("patchMessage merges card patches and returns null for unknown ids", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const card = store.messagesFor(bot.threadId)[1];

    const patched = store.patchMessage(bot.threadId, card.id, {
      card: { ...card.card!, answered: "Work & projects" },
    });
    expect(patched?.card?.answered).toBe("Work & projects");
    expect(store.patchMessage(bot.threadId, "nope", {})).toBeNull();
  });

  it("deleteBot removes the bot and its transcript file", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const file = join(DATA_DIR, `messages-${bot.threadId}.json`);
    expect(existsSync(file)).toBe(true);

    expect(store.deleteBot(bot.id)).toBe(true);
    expect(store.bot(bot.id)).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(store.deleteBot(bot.id)).toBe(false);
  });

  it("setResumeCursor persists per-instance continuations", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setResumeCursor(bot.id, "claude", "sess-abc");
    store.setResumeCursor(bot.id, "codex", "thread-xyz");

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.resumeCursors).toEqual({ claude: "sess-abc", codex: "thread-xyz" });
  });

  it("redacts credential-shaped text on bot messages, not user ones", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const secret = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const user = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `here is ${secret}` });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `got ${secret}` });
    expect(user.text).toContain("sk-ant");
    expect(reply.text).not.toContain("sk-ant");
    expect(reply.text).toMatch(/«redacted/);
  });

  it("seedIfEmpty does not create a starter bot", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(0);
  });

  it("chains appended messages and keeps the newest as active leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const user = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });

    const messages = store.messagesFor(bot.threadId);
    expect(user.parentId).toBe(messages[1].id); // follows the onboarding card
    expect(store.activeLeaf(bot.threadId)).toBe(user.id);
    expect(store.activePath(bot.threadId).map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  it("branchMessage forks at the edited message and hides the old tail", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });

    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;
    expect(edited.parentId).toBe(original.parentId); // sibling, not child
    expect(store.activeLeaf(bot.threadId)).toBe(edited.id);

    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v2");
    expect(path.map((m) => m.text)).not.toContain("v1");
    expect(path.map((m) => m.id)).not.toContain(reply.id);
    // the abandoned branch still exists in the tree
    expect(store.messagesFor(bot.threadId).map((m) => m.id)).toContain(original.id);

    expect(store.branchMessage(bot.threadId, "nope", "x")).toBeNull();
  });

  it("setActiveLeaf switches branches and descends to the newest leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });
    store.branchMessage(bot.threadId, original.id, "v2");
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v2" });

    // back to the original branch: the leaf is v1's reply, not v1 itself
    expect(store.setActiveLeaf(bot.threadId, original.id)).toBe(reply.id);
    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v1");
    expect(path.map((m) => m.text)).not.toContain("v2");

    expect(store.setActiveLeaf(bot.threadId, "nope")).toBeNull();
  });

  it("persists the branch tree and active leaf across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;

    const reloaded = new Store(selection);
    expect(reloaded.activeLeaf(bot.threadId)).toBe(edited.id);
    expect(reloaded.messagesFor(bot.threadId).map((m) => m.text)).toContain("v1");
    expect(reloaded.activePath(bot.threadId).map((m) => m.text)).not.toContain("v1");
  });

  it("migrates a pre-branching flat transcript file", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const legacy = [
      { id: "m1", role: "bot", kind: "text", text: "hello", at: 1 },
      { id: "m2", role: "user", kind: "text", text: "hi", at: 2 },
    ];
    writeFileSync(join(DATA_DIR, `messages-${bot.threadId}.json`), JSON.stringify(legacy));

    const reloaded = new Store(selection);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.map((m) => m.parentId)).toEqual([null, "m1"]);
    expect(reloaded.activeLeaf(bot.threadId)).toBe("m2");
    expect(reloaded.activePath(bot.threadId).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("tolerates a corrupt bots.json by starting empty", () => {
    const store = new Store(selection);
    store.createBot();
    writeFileSync(join(DATA_DIR, "bots.json"), "{not json");

    const reloaded = new Store(selection);
    expect(reloaded.bots).toEqual([]);
  });

  it("busy is wiped even when bots.json says otherwise", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const raw: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    raw.find((b) => b.id === bot.id)!.busy = true;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.busy).toBe(false);
  });
});
