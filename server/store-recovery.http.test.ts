// Real HTTP server over damaged Ask files: the office must still start, report
// what needs recovery behind the session, keep the damaged bytes and refuse
// Ask writes that would replace them. Fictional data only; network refused.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SERVER = dirname(fileURLToPath(import.meta.url));
let child: ChildProcess | undefined, home = "";

async function boot(files: Record<string, string>) {
  home = mkdtempSync(join(tmpdir(), "realbud-store-recovery-http-"));
  const data = join(home, ".realbud");
  mkdirSync(data, { mode: 0o700 });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(data, name), text);
  const preload = join(home, "no-network.mjs");
  writeFileSync(preload, `const original = globalThis.fetch;
globalThis.fetch = (url, init) => new URL(String(url)).hostname === "127.0.0.1" ? original(url, init) : Promise.reject(new Error("Fixture refuses external network"));\n`);
  const port = 18800 + Math.floor(Math.random() * 10_000), base = `http://127.0.0.1:${port}`;
  let stderr = "";
  child = spawn(process.execPath, ["--import", preload, join(SERVER, "index.ts")], { cwd: join(SERVER, ".."),
    env: { PATH: process.env.PATH, VITEST: "true", HOME: home, USERPROFILE: home, OMB_PORT: String(port), REALBUD_DATA_DIR: data }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", chunk => { stderr += chunk; });
  for (const until = Date.now() + 20_000; ;) {
    if (child.exitCode !== null) throw new Error(`server exited during boot: ${stderr.slice(-1500)}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* still starting */ }
    if (Date.now() > until) throw new Error(`server did not start: ${stderr.slice(-1500)}`);
    await new Promise(r => setTimeout(r, 150));
  }
  const session = String((await (await fetch(`${base}/api/session`)).json() as { token: string }).token);
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-realbud-session": session }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  return { data, api };
}

afterEach(async () => {
  if (child && child.exitCode === null) await new Promise<void>(r => { child!.once("close", () => r()); child!.kill(); setTimeout(() => { child?.kill("SIGKILL"); r(); }, 4000).unref(); });
  child = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
});

const selection = { instanceId: "hermes", model: "default" };
const bud = (tasks: string[]) => ({ id: "bud", threadId: tasks[0], name: "Bud", title: "", description: "", notifications: false, color: "green", unread: false,
  modelSelection: selection, resumeCursors: {}, createdAt: 1, tasks: tasks.map(threadId => ({ threadId, title: threadId, createdAt: 1, resumeCursors: {} })) });

describe.skipIf(process.platform === "win32")("Ask store recovery at boot (real server)", () => {
  it("starts past a damaged inactive transcript, reports it and keeps its bytes", async () => {
    const raw = "{fictional interrupted transcript";
    const { data, api } = await boot({
      "bots.json": JSON.stringify([bud(["fictional-active", "fictional-damaged"])]),
      "messages-fictional-active.json": JSON.stringify([{ id: "m1", role: "user", kind: "text", text: "kept", at: 1, parentId: null }]),
      "messages-fictional-damaged.json": raw,
    });
    expect((await api("GET", "/api/service/status")).body.askStore).toEqual({ held: false, threads: ["fictional-damaged"] });
    expect((await api("GET", "/api/desk")).status).toBe(200);
    const bots = await api("GET", "/api/bots");
    expect(bots.status).toBe(200);
    expect(bots.body.bots[0].messages.map((m: { text: string }) => m.text)).toEqual(["kept"]);
    expect(readFileSync(join(data, "messages-fictional-damaged.json"), "utf8")).toBe(raw);
  }, 40_000);

  it("starts in restricted mode over a damaged catalog, refuses Ask writes and keeps the file", async () => {
    const raw = "{fictional interrupted catalog";
    const { data, api } = await boot({ "bots.json": raw });
    expect((await api("GET", "/api/service/status")).body.askStore).toEqual({ held: true, threads: [] });
    expect((await api("GET", "/api/desk")).status).toBe(200);
    const send = await api("POST", "/api/bots/bud/messages", { text: "fictional question" });
    expect(send.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(send.body)).not.toContain(home);
    expect((await api("GET", "/api/bots")).body.bots).toEqual([]);
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe(raw);
  }, 40_000);
});
