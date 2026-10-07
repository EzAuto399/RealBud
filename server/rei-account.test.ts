// The office's REI account on its own (server/rei-account.ts): saved without any
// bank, compare-and-set on its revision, read from the older W1 bank settings until
// saved here, behind the per-boot session, and proposable by Bud on the review card.
import type { IncomingMessage } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { handleReiAccount, readReiAccount, readReiAccountRef, saveReiAccount } from "./rei-account.ts";
import { writePrivateJson } from "./private-json.ts";
import { needsSession, sessionOk, SESSION_TOKEN } from "./session-auth.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { bindWorkflowSettings, startWorkflowSettingsBroker } from "./workflow-settings-broker.ts";
import type { LoopbackToolServer } from "./web-research-broker.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => removeFixture(root))); });
const root = () => { const dir = privateTempRoot(join(tmpdir(), "rb-rei-account-")); roots.push(dir); return dir; };
const put = (dir: string, body: unknown) => handleReiAccount(dir, "PUT", async () => body);

describe("the REI account store", () => {
  it("saves the business code with no bank, refuses a stale revision or a bad code, and keeps a reicid only when given", async () => {
    const dir = root();
    expect(await handleReiAccount(dir, "GET", async () => ({}))).toEqual({ status: 200, body: { account: null } });
    const saved = await put(dir, { marker: " FICT1 ", expectedRevision: 0 });
    expect(saved).toMatchObject({ status: 200, body: { account: { marker: "FICT1", revision: 1 } } });
    expect((saved.body as { account: object }).account).not.toHaveProperty("urlValue");
    expect(await put(dir, { marker: "FICT2", expectedRevision: 0 })).toMatchObject({ status: 409, body: { error: "The REI business code changed. Reload it and try again." } });
    expect(await put(dir, { marker: "FICT 2", expectedRevision: 1 })).toMatchObject({ status: 400 });
    expect(await put(dir, { marker: "FICT2", urlValue: "fictional/../x", expectedRevision: 1 })).toMatchObject({ status: 400 });
    expect(await put(dir, { marker: "FICT2", expectedRevision: 1, extra: true })).toMatchObject({ status: 400 });
    expect(await put(dir, { marker: "FICT2", urlValue: "fictional-reicid-0001", expectedRevision: 1 })).toMatchObject({ status: 200, body: { account: { marker: "FICT2", urlValue: "fictional-reicid-0001", revision: 2 } } });
    expect(await readReiAccountRef(dir)).toEqual({ marker: "FICT2", urlValue: "fictional-reicid-0001" });
    // A conflict from the store carries the code the review card turns into "ask again".
    await expect(saveReiAccount(dir, { marker: "FICT3" }, 1)).rejects.toMatchObject({ status: 409, code: "settings_changed" });
  });

  it("reads the account from the older W1 bank settings until it is saved on its own, and holds a damaged file", async () => {
    const dir = root();
    await writePrivateJson(join(dir, "w1", "settings.json"), { version: 1, kind: "w1-settings", account: "acct_fictional", rei: { marker: "FICT1" }, bankFormat: "ANZ(csv file)", revision: 3, savedAt: "2026-10-01T00:00:00.000Z" });
    expect(await readReiAccount(dir)).toEqual({ marker: "FICT1", revision: 0, savedAt: null });
    expect(await put(dir, { marker: "FICT1", expectedRevision: 0 })).toMatchObject({ status: 200, body: { account: { revision: 1 } } });
    expect(await readReiAccount(dir)).toMatchObject({ marker: "FICT1", revision: 1 });
    writeFileSync(join(dir, "rei", "account.json"), JSON.stringify({ version: 1, kind: "rei-account", marker: "FICT 1", revision: 2, savedAt: "x" }), { mode: 0o600 });
    await expect(readReiAccount(dir)).rejects.toMatchObject({ status: 503 });
    await expect(put(dir, { marker: "FICT1", expectedRevision: 2 })).rejects.toMatchObject({ status: 503 });
  });

  it("needs the per-boot session on /api/rei/account", () => {
    for (const method of ["GET", "PUT"]) {
      const path = "/api/rei/account";
      expect(needsSession(path, method)).toBe(true);
      const req = { url: path, method, headers: { host: "127.0.0.1:8799" } } as unknown as IncomingMessage;
      expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 401 });
      req.headers["x-realbud-session"] = SESSION_TOKEN;
      expect(sessionOk(req, 8799)).toEqual({ ok: true });
    }
  });
});

describe("Bud proposes the REI business code on the review card", () => {
  let broker: LoopbackToolServer | undefined;
  afterEach(() => { broker?.close(); broker = undefined; });
  const call = async (name: string, args: unknown) => ((await (await fetch(broker!.descriptor.url, { method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(broker!.descriptor.headers.map(row => [row.name, row.value])) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()) as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;

  it("saves only after the person allows the card, and a declined card saves nothing", async () => {
    const dir = root();
    const unused = { read: async () => { throw new Error("not used"); } };
    const settings = bindWorkflowSettings({ maintenance: unused as never, inspection: unused as never, agency: unused as never, loops: { listLoops: () => [], patchClock: () => {} }, writable: () => null,
      reiAccount: { read: () => readReiAccount(dir), save: (account, revision) => saveReiAccount(dir, account, revision) } });
    const cards: string[] = [];
    let allow = false;
    broker = await startWorkflowSettingsBroker({ turnId: () => "turn-1", settings: () => settings, approve: async summary => { cards.push(summary); return allow; } });
    expect((await call("workflow_settings_read", { target: "rei_account" })).content[0].text).toContain("rei_account (revision 0): marker none; urlValue none");
    const propose = () => call("workflow_settings_propose", { target: "rei_account", values: { marker: "FICT1" }, reason: "Kevin said REI shows FICT1 at the top." });
    expect(await propose()).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("chose Don't allow") }] });
    expect(await readReiAccount(dir)).toBeNull();
    expect(cards[0]).toBe("Change REI business code\nREI business code (shown at the top of REI): none → FICT1\nBud reads REI, and bank imports go to REI, only for this business.\nWhy: Kevin said REI shows FICT1 at the top.");
    allow = true;
    expect((await propose()).isError).toBeUndefined();
    expect(await readReiAccount(dir)).toMatchObject({ marker: "FICT1", revision: 1 });
    expect(await call("workflow_settings_propose", { target: "rei_account", values: { marker: "FICT 1" }, reason: "Typo." })).toMatchObject({ isError: true });
    expect(cards).toHaveLength(2);
  });
});
