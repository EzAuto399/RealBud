// The desktop broker against the fake cua proxy answering in the real 0.22.1
// shape (Calculator). Every value is fictional.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_SERVER, PICK_NONE, PICK_TOO_LARGE, startDesktopBroker, type DesktopApprovalProjection, type DesktopBroker, type DesktopDecisions, type DesktopStep } from "./desktop-broker.ts";
import { CUA_NEVER_TOOLS } from "./cua-bounded.ts";
import { emptyRunUsage } from "./run-cost.ts";
import { MAX_IMAGE_BYTES, type JevRequest, type JevResult } from "./jev-client.ts";
import type { BrowserTaskGrant } from "../shared/browser-task.ts";

const FAKE = fileURLToPath(new URL("./testing/fake-cua-mcp.mjs", import.meta.url));
const FIXTURE = JSON.parse(readFileSync(new URL("./testing/fixtures/cua-0.22.1-calculator-window-state.json", import.meta.url), "utf8"));
const dir = () => mkdtempSync(join(tmpdir(), "rb-desk-broker-"));
const fixtureFile = (change: (raw: typeof FIXTURE) => unknown) => { const file = join(dir(), "state.json"); writeFileSync(file, JSON.stringify(change(structuredClone(FIXTURE)))); return file; };
const grant = (extra: Partial<BrowserTaskGrant> = {}): BrowserTaskGrant => ({
  version: 1, purpose: "browser-task-grant", id: "grant-fictional-1", runId: "run-fictional-1", route: "ask",
  request: { text: "Clear the fictional calculator", sha256: "a".repeat(64) }, sites: [],
  browser: { id: null, accountMarker: null }, actions: ["read", "click", "fill", "keys"],
  consequential: "ask-each", uploads: [], expiresAt: null, budget: 10,
  desktop: { appName: "Calculator", bundleId: "com.apple.calculator", pid: 1001, windowId: 2001, title: "Calculator" }, ...extra,
});
const answer = (choice: string, confidence: number, id = "fictional-decision-1"): JevResult =>
  ({ ok: true, id, model: "fictional-model", ms: 4, answers: { control: { type: "choice", choice, confidence } }, usage: { input_tokens: 9, output_tokens: 1 } });
// A fictional PNG header, 460x816: the window at 2x.
const PNG_SIZE = "460x816";

let broker: DesktopBroker | undefined;
afterEach(async () => { await broker?.stop(); broker = undefined; vi.restoreAllMocks(); });

async function start(options: { env?: Record<string, string>; grant?: BrowserTaskGrant; approve?: (...args: any[]) => Promise<boolean>; decisions?: Partial<DesktopDecisions> | null } = {}) {
  const record = join(dir(), "calls.jsonl");
  const approve = vi.fn(options.approve ?? (async () => true));
  const decide = vi.fn(async (_request: JevRequest, _options: Parameters<DesktopDecisions["decide"]>[1]): Promise<JevResult> => answer("none", 0.9));
  const binding: DesktopDecisions = { sameMember: () => true, ready: () => true, lunaReady: () => true, decide, ...options.decisions };
  const usage = emptyRunUsage();
  const steps: DesktopStep[] = [];
  broker = await startDesktopBroker({
    runId: "run-fictional-1", grant: options.grant ?? grant(), isActive: () => true, approve, usage, step: step => steps.push(step),
    ...(options.decisions === null ? {} : { decisions: () => binding }),
    connection: { command: process.execPath, args: [FAKE], env: { FAKE_CUA_RECORD: record, ...options.env } },
  });
  const calls = () => { try { return readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { approve, decide: (binding.decide as typeof decide), usage, steps, calls, record };
}
let id = 1;
const rpc = async (method: string, params: unknown) => ((await (await fetch(broker!.descriptor.url, { method: "POST",
  headers: { "content-type": "application/json", ...Object.fromEntries(broker!.descriptor.headers.map(r => [r.name, r.value])) },
  body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) })).json()) as any).result;
const call = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args });
const body = (result: any) => JSON.parse(result.content.find((item: any) => item.type === "text").text);
const actions = (rows: Array<{ name: string }>) => rows.filter(row => ["click", "type_text", "scroll", "press_key"].includes(row.name));

describe("desktop broker: tools", () => {
  it("offers only its typed tools; never-tools and unknown tools are absent and refused before reaching the driver", async () => {
    const { calls } = await start({ decisions: null });
    expect(broker!.descriptor.name).toBe(DESKTOP_SERVER);
    const names = (await rpc("tools/list", {})).tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(["get_window_state", "click", "type_text", "scroll", "press_key", "release"]);
    for (const name of [...CUA_NEVER_TOOLS, "invoke_menu", "set_value", "drag", "browser_click", "escalate_session", "kill_app", "launch_app", "list_windows", "start_session", "hotkey"]) {
      expect(names).not.toContain(name);
      expect(await call(name, { pid: 1001, window_id: 2001 })).toMatchObject({ isError: true, content: [{ text: "This tool is not available in Bud." }] });
    }
    expect(calls()).toEqual([]);
  });

  it("lists pick_control only with a decisions binding on the person's own Ask", async () => {
    await start();
    expect((await rpc("tools/list", {})).tools.map((tool: { name: string }) => tool.name)).toContain("pick_control");
    await broker!.stop();
    await start({ grant: grant({ route: "loop-read" }) });
    expect((await rpc("tools/list", {})).tools.map((tool: { name: string }) => tool.name)).not.toContain("pick_control");
  });

  it("starts one session per grant and injects pid, window and session into every call, whatever Bud sends", async () => {
    const { calls } = await start();
    const read = body(await call("get_window_state", { pid: 9999, window_id: 1, session: "other", target: { kind: "desktop", display_id: "primary" } }));
    const token = read.elements.find((row: any) => row.label === "All Clear").element_token;
    await call("click", { element_token: token, pid: 9999, window_id: 1, session: "other", modifier: ["cmd"] });
    const rows = calls();
    expect(rows[0]).toEqual({ name: "start_session", arguments: { session: "rb-desk-grant-fictional-1", capture_scope: "window" } });
    for (const row of rows.slice(1).filter(r => r.name !== "list_windows")) {
      expect(row.arguments).toMatchObject({ pid: 1001, window_id: 2001, session: "rb-desk-grant-fictional-1" });
      expect(row.arguments).not.toHaveProperty("target");
      expect(row.arguments).not.toHaveProperty("modifier");
    }
    expect(actions(rows)).toEqual([{ name: "click", arguments: { element_token: token, pid: 1001, window_id: 2001, session: "rb-desk-grant-fictional-1" } }]);
    expect(broker!.used).toBe(1);
  });

  it("sends a click as a token or a point, never both", async () => {
    const { calls } = await start();
    const token = body(await call("get_window_state")).elements.find((row: any) => row.label === "All Clear").element_token;
    expect((await call("click", { element_token: token, x: 5, y: 5 })).isError).toBeUndefined();
    expect(actions(calls())).toEqual([{ name: "click", arguments: { element_token: token, pid: 1001, window_id: 2001, session: "rb-desk-grant-fictional-1" } }]);
  });

  it("falls back to a session without capture_scope when the driver refuses it", async () => {
    const { calls } = await start({ env: { FAKE_CUA_MODE: "reject-capture-scope" } });
    await call("get_window_state");
    expect(calls().filter(row => row.name === "start_session").map(row => row.arguments)).toEqual([
      { session: "rb-desk-grant-fictional-1", capture_scope: "window" }, { session: "rb-desk-grant-fictional-1" }]);
  });

  it("refuses a stale token locally and never offers or presses the menu bar", async () => {
    const { calls } = await start();
    const first = body(await call("get_window_state"));
    expect(first.elements.map((row: any) => row.label)).not.toContain("About This Mac");
    expect(first.text).toContain("About This Mac"); // read-only text, never a control
    await call("get_window_state");
    const stale = await call("click", { element_token: first.elements.find((row: any) => row.label === "Add").element_token });
    expect(stale).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Read the window again") }] });
    expect(await call("click", { element_token: "s00000002:29" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("system menu bar") }] });
    expect(actions(calls())).toEqual([]);
  });
});

describe("desktop broker: cards and Stop", () => {
  const deleteToken = async () => body(await call("get_window_state")).elements.find((row: any) => row.label === "Delete").element_token;

  it("cards a consequential press once per instance, mirroring browser-broker's projection", async () => {
    const { approve, calls } = await start();
    const token = await deleteToken();
    expect((await call("click", { element_token: token })).isError).toBeUndefined();
    expect(approve).toHaveBeenCalledTimes(1);
    const [tool, params, summary, signal, projection] = approve.mock.calls[0] as [string, Record<string, unknown>, string, AbortSignal, DesktopApprovalProjection];
    expect(tool).toBe("click");
    expect(params).toEqual({ app: "Calculator", window: "Calculator", control: { role: "button", label: "Delete" } });
    expect(summary).toBe(`Press 'Delete' (button) in Calculator — window "Calculator". This deletes something. Once only.`);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(projection).toEqual({ fence: { surface: "portal-submit", origin: "Calculator", ruleOffer: null }, approvalPolicy: "once", remote: "desktop-only" });
    expect(await call("click", { element_token: token })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("already asked about this exact step once") }] });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(actions(calls())).toHaveLength(1);
  });

  it("presses nothing when the card is refused", async () => {
    const { calls } = await start({ approve: async () => false });
    expect(await call("click", { element_token: await deleteToken() })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("not approved") }] });
    expect(actions(calls())).toEqual([]);
  });

  it("Stop aborts a waiting card, ends the driver session and presses nothing", async () => {
    let asked!: () => void;
    const waiting = new Promise<void>(resolve => { asked = resolve; });
    const { calls } = await start({ approve: (_t, _p, _s, signal: AbortSignal) => new Promise<boolean>(resolve => { asked(); signal.addEventListener("abort", () => resolve(false)); }) });
    const token = await deleteToken();
    const pending = call("click", { element_token: token }).catch(() => null);
    await waiting;
    await broker!.stop();
    await pending;
    const rows = calls();
    expect(rows.at(-1)).toEqual({ name: "end_session", arguments: { session: "rb-desk-grant-fictional-1" } });
    expect(actions(rows)).toEqual([]);
  });

  it("ends the task when its step budget is spent", async () => {
    const { calls } = await start({ grant: grant({ budget: 2 }) });
    const tokens = body(await call("get_window_state")).elements;
    const tokenOf = (label: string) => tokens.find((row: any) => row.label === label).element_token;
    expect((await call("click", { element_token: tokenOf("All Clear") })).isError).toBeUndefined();
    expect((await call("click", { element_token: tokenOf("Add") })).isError).toBeUndefined();
    expect(await call("click", { element_token: tokenOf("Equals") })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("used all its allowed steps") }] });
    expect(actions(calls())).toHaveLength(2);
    expect(calls().at(-1)?.name).toBe("end_session");
  });

  it("fails closed when the proxy exits mid-step", async () => {
    await start({ env: { FAKE_CUA_MODE: "exit-on-click" } });
    const token = body(await call("get_window_state")).elements.find((row: any) => row.label === "Add").element_token;
    expect(await call("click", { element_token: token })).toMatchObject({ isError: true });
    expect(await call("get_window_state")).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("no longer working") }] });
  });
});

describe("desktop broker: proxy lifecycle", () => {
  const alive = (record: string) => { try { process.kill(Number(readFileSync(`${record}.pid`, "utf8")), 0); return true; } catch { return false; } };

  it("Stop while the session is starting ends it (best effort) and closes the proxy", async () => {
    const { calls, record } = await start({ env: { FAKE_CUA_MODE: "hang-start" } });
    const pending = call("get_window_state").catch(() => null); // Stop closes the tool server under the call
    await vi.waitFor(() => expect(calls().map(row => row.name)).toEqual(["start_session"]));
    await broker!.stop();
    await pending;
    expect(calls().map(row => row.name)).toEqual(["start_session", "end_session"]);
    await vi.waitFor(() => expect(alive(record)).toBe(false));
  });

  it("closes a proxy that exits while starting its session, and does nothing more", async () => {
    const { calls, record } = await start({ env: { FAKE_CUA_MODE: "exit-on-start" } });
    expect(await call("get_window_state")).toMatchObject({ isError: true });
    expect(await call("click", { x: 1, y: 1 })).toMatchObject({ isError: true });
    expect(calls().map(row => row.name)).toEqual(["start_session"]);
    await vi.waitFor(() => expect(alive(record)).toBe(false));
  });

  it("never starts a proxy after release, even when release came first", async () => {
    const { calls, record } = await start();
    expect((await call("release")).isError).toBeUndefined();
    expect(await call("get_window_state")).toMatchObject({ isError: true });
    await broker!.stop();
    expect(calls()).toEqual([]);
    expect(() => readFileSync(`${record}.pid`)).toThrow();
  });
});

describe("desktop broker: pick_control", () => {
  const complete = () => fixtureFile(raw => ({ ...raw, elements_complete: true, tree_markdown: raw.tree_markdown.replace(/\n\n⚠️.*$/s, "") }));

  it("returns Jev's confident pick from labels and roles only, counted in run cost", async () => {
    const { decide, usage, calls } = await start({ env: { FAKE_CUA_FIXTURE: complete() }, decisions: { decide: vi.fn(async () => answer("c0", 0.9)) } });
    const picked = body(await call("pick_control", { goal: "add the numbers" }));
    expect(picked).toMatchObject({ label: "Add", role: "button", confidence: 0.9, by: "jev", note: expect.stringContaining("Suggestion only") });
    expect(picked.element_token).toMatch(/^s00000001:16$/);
    const [request, options] = decide.mock.calls[0] as unknown as [JevRequest, Record<string, unknown>];
    expect(options).not.toHaveProperty("image");
    expect(JSON.stringify(request)).not.toMatch(/About This Mac|s0000|1270|"0"/);
    expect(Object.keys((request.questions.control as any).criteria)).toEqual(["c0", "c1", "c2", "c3", "c4", "none"]);
    expect(usage.decisions).toEqual([expect.objectContaining({ id: "fictional-decision-1" })]);
    expect(calls().find(row => row.name === "get_window_state")?.arguments.include_screenshot).toBe(false);
  });

  it("falls back to Luna with one window screenshot when Jev is below threshold; the image is never recorded or noted", async () => {
    const decide = vi.fn(async (_r: JevRequest, options: any) => options.image ? answer("c1", 0.85, "fictional-decision-2") : answer("c0", 0.5));
    const { usage, calls, steps, record } = await start({ env: { FAKE_CUA_FIXTURE: complete(), FAKE_CUA_PNG_SIZE: PNG_SIZE }, decisions: { decide } });
    const picked = body(await call("pick_control", { goal: "add the numbers" }));
    expect(picked).toMatchObject({ label: "Delete", by: "luna", confidence: 0.85 });
    const luna = decide.mock.calls[1][1];
    expect(luna).toMatchObject({ model: "gpt-6-luna-decisions", image: expect.stringMatching(/^iVBORw0KGgo/) });
    expect(calls().filter(row => row.name === "get_window_state").map(row => row.arguments.include_screenshot)).toEqual([false, true]);
    expect(usage.decisions?.map(row => row.id)).toEqual(["fictional-decision-1", "fictional-decision-2"]);
    for (const kept of [readFileSync(record, "utf8"), JSON.stringify(steps), JSON.stringify(usage)]) expect(kept).not.toContain(luna.image);
  });

  it("goes straight to Luna on a truncated tree, and offers a grid point when nothing is labelled", async () => {
    const unlabelled = fixtureFile(raw => ({ ...raw, elements: raw.elements.map(({ label: _label, ...row }: any) => row) }));
    const decide = vi.fn(async () => answer("r3c3", 0.9));
    await start({ env: { FAKE_CUA_FIXTURE: unlabelled, FAKE_CUA_PNG_SIZE: PNG_SIZE }, decisions: { decide } });
    const picked = body(await call("pick_control", { goal: "press equals" }));
    // Cell r3c3's centre in the 460x816 screenshot.
    expect(picked).toMatchObject({ x: 383, y: 680, cell: "r3c3", by: "luna" });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(Object.keys((decide.mock.calls[0] as any)[0].questions.control.criteria)).toEqual(["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3", "r3c1", "r3c2", "r3c3", "none"]);
    // Clicking the point is still fenced: an unlabelled point asks once.
    const approve = vi.fn(async () => false);
    await broker!.stop();
    const fresh = await start({ env: { FAKE_CUA_FIXTURE: unlabelled, FAKE_CUA_PNG_SIZE: PNG_SIZE }, approve });
    await call("get_window_state", { include_screenshot: true });
    await call("click", { x: 10, y: 10 });
    expect(fresh.approve.mock.calls[0]?.[2]).toBe("Bud could not tell what this control does. It asks once.");
  });

  it("asks Jev first on a truncated tree that has labelled controls, and says the list was partial", async () => {
    const { decide } = await start({ env: { FAKE_CUA_PNG_SIZE: PNG_SIZE }, decisions: { decide: vi.fn(async () => answer("c0", 0.9)) } });
    const picked = body(await call("pick_control", { goal: "press equals" }));
    expect(picked).toMatchObject({ label: "Equals", by: "jev", note: expect.stringContaining("partial list") });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0][1]).not.toHaveProperty("image");
  });

  it("asks the driver for a smaller capture when the screenshot is too large for Luna", async () => {
    const decide = vi.fn(async (_r: JevRequest, options: any) => options.image ? answer("c1", 0.85, "fictional-decision-2") : answer("c0", 0.5));
    const { calls } = await start({ env: { FAKE_CUA_FIXTURE: complete(), FAKE_CUA_PNG_SIZE: PNG_SIZE, FAKE_CUA_PNG_BYTES: String(MAX_IMAGE_BYTES + 1_000) }, decisions: { decide } });
    expect(body(await call("pick_control", { goal: "add the numbers" }))).toMatchObject({ label: "Delete", by: "luna" });
    const reads = calls().filter(row => row.name === "get_window_state").map(row => [row.arguments.include_screenshot, row.arguments.max_dimension]);
    expect(reads).toEqual([[false, undefined], [true, undefined], [true, 512]]);
    const image = Buffer.from((decide.mock.calls[1][1] as any).image, "base64");
    expect([image.length, image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([33, 289, 512]);
  });

  it("says the screenshot was too large when the driver cannot make a smaller one", async () => {
    const decide = vi.fn(async () => answer("c0", 0.5));
    await start({ env: { FAKE_CUA_FIXTURE: complete(), FAKE_CUA_PNG_SIZE: PNG_SIZE, FAKE_CUA_PNG_BYTES: String(MAX_IMAGE_BYTES + 1_000), FAKE_CUA_MODE: "reject-max-dimension" }, decisions: { decide } });
    expect((await call("pick_control", { goal: "add the numbers" })).content[0].text).toBe(PICK_TOO_LARGE);
    expect(decide).toHaveBeenCalledTimes(1); // Jev only: Luna never got an image it could not take
  });

  it("answers none — use screenshot when Jev is unsure and Luna is off", async () => {
    const decide = vi.fn(async () => answer("c0", 0.5));
    await start({ env: { FAKE_CUA_FIXTURE: complete(), FAKE_CUA_PNG_SIZE: PNG_SIZE }, decisions: { decide, lunaReady: () => false } });
    expect((await call("pick_control", { goal: "add the numbers" })).content[0].text).toBe(PICK_NONE);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("refuses credential-shaped goals before any read or model call", async () => {
    const { decide, calls } = await start();
    for (const goal of ["type the password", "paste sk-ant-fictional0123456789abcdef", "enter the one-time code"]) {
      expect(await call("pick_control", { goal })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Nothing was sent") }] });
    }
    expect(decide).not.toHaveBeenCalled();
    expect(calls().filter(row => row.name === "get_window_state")).toEqual([]);
  });
});
