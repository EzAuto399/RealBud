// REI reads for an office with no bank connected, through the real server in the
// test lab (REALBUD_TEST_LAB=1 + REALBUD_TEST_W1_FICTIONAL_REI=1: the FICTIONAL
// REI-style portal behind the real BrowserRuntime, broker and recipe runner) with
// a fake Ask worker. Saving the REI business code is enough for the REI morning
// refresh to read, and a read question in Ask becomes a read-only REI task card
// whose Start returns the portal's rows. A pass proves RealBud's wiring and guards,
// never REI Cloud behaviour.
import { readSessionToken } from "./testing/local-session.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REI_ACCOUNT_NEEDED } from "./rei-account.ts";
import { FICTIONAL_BUSINESS } from "./testing/fictional-rei-portal.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const ARREARS_QUESTION = "check REI Cloud and tell me which tenants are more than 14 days in arrears. Read only.";

describe.skipIf(process.platform === "win32")("REI reads with no bank connected (test lab, fake worker)", () => {
  let child: ChildProcess;
  let home = "", session = "", stderr = "", threadId = "";

  const api = async (method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth && session) headers["x-realbud-session"] = session;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, ms = 30_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 1500)}\nstderr: ${stderr.slice(-2000)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  type Msg = { id: string; role: string; kind: string; text?: string };
  const messages = async () => ((await api("GET", "/api/bots")).body.bots as Array<{ id: string; messages?: Msg[] }>).find(bot => bot.id === "bud")!.messages ?? [];
  /** `replies`: 2 waits for the user's message and Bud's reply (written before any model turn); 1 for the message only. */
  const ask = async (text: string, replies = 2) => {
    const before = (await messages()).length;
    expect((await api("POST", "/api/bots/bud/messages", { text })).status).toBeLessThan(300);
    return (await waitFor(messages, list => list.length >= before + replies, "Bud's reply")).slice(before);
  };
  const tasks = async () => (await api("GET", `/api/browser/tasks?threadId=${encodeURIComponent(threadId)}`)).body.tasks as Array<{ id: string; status: string; request: string; actions: string[]; messageId: string }>;
  const lab = async (action: string) => (await api("POST", "/api/w1/lab", { action })).body as { effects: string[] };
  const runRefresh = async () => {
    const loop = ((await api("GET", "/api/loops")).body.loops as Array<{ id: string; revision: number }>).find(row => row.id === "rei-morning-refresh")!;
    const accepted = await api("POST", "/api/loops/rei-morning-refresh/run", { requestId: randomUUID(), expectedRevision: loop.revision });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    return (await waitFor(async () => ((await api("GET", "/api/loops")).body.runs as Array<{ id: string; status: string; detail?: string }>).find(run => run.id === accepted.body.run.id),
      run => Boolean(run && !["queued", "running"].includes(run.status)), "the REI refresh"))!;
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "realbud-rei-read-"));
    mkdirSync(join(home, ".realbud"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".realbud", "config.json"), JSON.stringify({
      instances: { hermes: { driver: "hermesAgent", config: { cli: FAKE_CLI }, environment: { FAKE_ACP_MODE: "hang" } } },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        VITEST: "true", HOME: home, USERPROFILE: home, OMB_PORT: String(PORT),
        // The fictional portal stands in for REI; no Redbark base, so no bank is connected.
        REALBUD_TEST_LAB: "1", REALBUD_TEST_W1_FICTIONAL_REI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", chunk => (stderr += chunk));
    const deadline = Date.now() + 25_000;
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    session = await readSessionToken(join(home, ".realbud"));
    threadId = ((await api("GET", "/api/bots")).body.bots as Array<{ id: string; threadId: string }>).find(bot => bot.id === "bud")!.threadId;
  }, 40_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>(resolve => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("saves the REI business code with no bank, and the REI morning refresh then reads REI with nothing pressed", async () => {
    expect((await api("GET", "/api/rei/account", undefined, false)).status).toBe(401);
    expect((await api("PUT", "/api/rei/account", { marker: FICTIONAL_BUSINESS, expectedRevision: 0 }, false)).status).toBe(401);
    expect((await api("GET", "/api/w1/status")).body.settings).toBeNull();
    // Before the code is saved: the refresh and Ask both name the one place to save it, and no task is offered.
    expect(await runRefresh()).toMatchObject({ status: "failed", detail: expect.stringContaining("Save the REI business code (Schedule → Bank reference review → Refresh from REI)") });
    const [, needed] = await ask(ARREARS_QUESTION);
    expect(needed.text).toBe(REI_ACCOUNT_NEEDED);
    expect(await tasks()).toEqual([]);
    expect(await api("PUT", "/api/rei/account", { marker: FICTIONAL_BUSINESS, expectedRevision: 0 })).toMatchObject({ status: 200, body: { account: { marker: FICTIONAL_BUSINESS, revision: 1 } } });
    expect(await api("PUT", "/api/rei/account", { marker: "FICT2", expectedRevision: 0 })).toMatchObject({ status: 409 });
    expect((await api("GET", "/api/rei/account")).body.account).toMatchObject({ marker: FICTIONAL_BUSINESS, revision: 1 });
    await lab("sign-in"); // the person signs in; Bud never does
    const run = await runRefresh();
    expect(run.status, run.detail).toBe("completed");
    const desk = (await api("GET", "/api/desk")).body as { sources: Array<{ id: string }> };
    expect(desk.sources.map(source => source.id).filter(id => id.startsWith("src-rei-")).sort()).toEqual(["src-rei-arrears", "src-rei-owners", "src-rei-tenants"]);
    expect((await lab("status")).effects).toEqual([]);
    expect((await api("GET", "/api/w1/status")).body.settings).toBeNull(); // still no bank import set up
  }, 90_000);

  it("turns an arrears question in Ask into a read-only REI task whose Start returns the portal's rows", async () => {
    const [, offer] = await ask(ARREARS_QUESTION);
    expect(offer.text).toContain(`I can read the arrears list (15+ days) from REI Cloud now for ${FICTIONAL_BUSINESS}, read only`);
    const card = (await tasks()).find(task => task.messageId === offer.id)!;
    expect(card).toMatchObject({ status: "proposed" });
    expect(card.request).toMatch(/read recipes \(open-session, arrears-review\) for the account FICT1\. Read only/);
    expect([...card.actions].sort()).toEqual(["click", "fill", "navigate", "read"]);
    const before = (await messages()).length;
    expect((await api("POST", `/api/browser/tasks/${card.id}/start`, { threadId })).status).toBe(202);
    const reply = (await waitFor(messages, list => list.slice(before).some(message => /\*\*arrears-review\*\*/.test(message.text ?? "")), "the read's reply"))
      .slice(before).find(message => /\*\*arrears-review\*\*/.test(message.text ?? ""))!.text!;
    expect(reply).toContain("The portal read finished.");
    expect(reply).toContain("Nothing was saved, sent or paid.");
    expect(reply).toMatch(/\*\*arrears-review\*\*: [1-9]\d* rows? over \d+ pages?, kept from \d+ read/);
    expect(reply).toMatch(/Source: page Process › Arrears, all (\d+) of the \1 records it lists\./);
    expect(reply).toMatch(/\n- Fictional Tenant/);
    expect((await waitFor(tasks, list => list.find(task => task.id === card.id)?.status !== "active", "the task to end")).find(task => task.id === card.id)!.status).toBe("finished");
    expect((await lab("status")).effects).toEqual([]);

    // A write asked the same way never becomes an REI task: it goes to Bud's ordinary turn, which has no REI grant.
    const count = (await tasks()).length;
    await ask("Send arrears notices from REI to everyone more than 14 days behind", 1);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect((await tasks()).length).toBe(count);
    expect((await messages()).some(message => /I can read .* from REI Cloud/.test(message.text ?? "") && message.text !== offer.text)).toBe(false);
    await api("POST", "/api/bots/bud/interrupt", {});
  }, 90_000);
});
