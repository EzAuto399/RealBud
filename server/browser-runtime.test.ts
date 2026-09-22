import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserRuntime, browserStepFailure, type BrowserJson } from "./browser-runtime.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => removeFixture(p))); });
export async function browserFixture() {
  const root = privateTempRoot(join(tmpdir(), "rb-browser-test-")); roots.push(root);
  const sessions = new Set<string>(); let counter = 0;
  const browser = { instance_id: "chrome-work", browser_name: "Chrome", label: "Work", extension_version: "0.3.0", extension_protocol_version: "1.3" };
  let browsers: BrowserJson[] = [browser]; let borrowPolicy = "always"; let stopFails = false; let startUnknown = false;
  const command = vi.fn(async (args: string[]): Promise<BrowserJson> => {
    if (args[0] === "status") return { daemon_version: "0.3.0", protocol_version: "1.3", browsers, sessions: [...sessions].map(session_id => ({ session_id, browser_instance_id: "chrome-work", interaction: { borrow_confirmation: borrowPolicy, request_help: "enabled" } })) };
    if (args[0] === "session" && args[1] === "start") {
      const session_id = `session-${++counter}`; sessions.add(session_id);
      if (startUnknown) throw new Error("Lost reply");
      return { session_id, browser_instance_id: "chrome-work", interaction: { borrow_confirmation: borrowPolicy, request_help: "enabled" } };
    }
    if (args[0] === "session" && args[1] === "stop") {
      if (stopFails) return { stopped: [], failed: [args[2]], return_failures: [{ tab_id: 1 }] };
      sessions.delete(args[2]); return { stopped: [args[2]], failed: [], return_failures: [] };
    }
    throw new Error(`Unexpected command ${args[0]}`);
  });
  const options = { root, command, executable: async () => "/fixture/bsk", startDaemon: async () => {} };
  const runtime = new BrowserRuntime(options);
  await runtime.connect(); await runtime.select("chrome-work");
  return { root, runtime, command, options, sessions, browser,
    browsers: (next: BrowserJson[]) => { browsers = next; },
    borrowPolicy: (next: string) => { borrowPolicy = next; },
    stopFails: (next: boolean) => { stopFails = next; },
    startUnknown: (next: boolean) => { startUnknown = next; },
  };
}
describe("private browser connection", () => {
  it("explains an unavailable confirmation without exposing upstream data or disabling consent", () => {
    expect(browserStepFailure({ data: { reason: "confirmation_ui_unavailable" }, hint: "private diagnostic" }).message).toMatch(/Select the job's website tab/);
    expect(browserStepFailure({ message: "private page contents", hint: "disable confirmation" }).message).not.toMatch(/private page contents|disable confirmation/);
  });
  it("requires a selected profile and never switches when it disconnects", async () => {
    const f = await browserFixture(); expect((await f.runtime.status()).state).toBe("ready");
    f.browsers([{ ...f.browser, instance_id: "someone-else" }]);
    expect((await f.runtime.status()).state).toBe("disconnected");
    await expect(f.runtime.acquire("job-1")).rejects.toThrow(/Connect/);
    expect(f.command.mock.calls.filter(([args]) => args[0] === "session")).toHaveLength(0);
  });
  it("grants one job at a time and returns only its session", async () => {
    const f = await browserFixture(); await f.runtime.acquire("job-1");
    await expect(f.runtime.acquire("job-2")).rejects.toThrow(/Another/);
    await f.runtime.release("job-2"); expect(f.sessions.size).toBe(1);
    await f.runtime.release("job-1"); expect(f.sessions.size).toBe(0);
    expect((await f.runtime.status()).state).toBe("ready");
  });
  it("keeps a restarted or uncertain session held until explicit recovery", async () => {
    const f = await browserFixture(); await f.runtime.acquire("job-1");
    const restarted = new BrowserRuntime(f.options);
    expect((await restarted.status()).state).toBe("recovery_required");
    await expect(restarted.acquire("job-2")).rejects.toThrow();
    await restarted.stop(); expect(f.sessions.size).toBe(0);
    expect((await restarted.status()).state).toBe("ready");
  });
  it("recovers a lost session-start reply without creating another session", async () => {
    const f = await browserFixture(); f.startUnknown(true);
    await expect(f.runtime.acquire("job-1")).rejects.toThrow();
    expect((await f.runtime.status()).state).toBe("recovery_required");
    await f.runtime.stop(); expect(f.sessions.size).toBe(0);
    expect(f.command.mock.calls.filter(([a]) => a[0] === "session" && a[1] === "start")).toHaveLength(1);
  });
  it("fails closed when tab confirmation is disabled", async () => {
    const f = await browserFixture(); f.borrowPolicy("never");
    await expect(f.runtime.acquire("job-1")).rejects.toThrow(/confirmation/);
    expect(f.sessions.size).toBe(0);
    expect(f.runtime.isOwner("job-1")).toBe(false);
  });
  it("does not report release when returning a tab failed", async () => {
    const f = await browserFixture(); await f.runtime.acquire("job-1"); f.stopFails(true);
    await expect(f.runtime.stop()).rejects.toThrow(/unconfirmed/);
    expect((await f.runtime.status()).state).toBe("recovery_required");
    f.stopFails(false); await f.runtime.stop(); expect((await f.runtime.status()).active).toBe(false);
  });
  it("rechecks confirmation settings during an active job", async () => {
    const f = await browserFixture(); await f.runtime.acquire("job-1");
    await expect(f.runtime.checkSession("job-1")).resolves.toBeUndefined();
    f.borrowPolicy("never");
    await expect(f.runtime.checkSession("job-1")).rejects.toThrow(/settings changed/);
    await f.runtime.release("job-1");
    await expect(f.runtime.checkSession("job-1")).rejects.toThrow(/stopped/);
  });
  it.each(["match", "wrong-account", "password", "tab-returned"])("checks a signed-in tab and releases it: %s", async mode => {
    const f = await browserFixture(); const original = f.command.getMockImplementation()!; let borrowed = false;
    f.command.mockImplementation(async args => {
      if (args[0] === "tab" && args[1] === "list") return { tabs: [{ tab_id: 4, url: "https://bank.example/history", scope: borrowed && mode !== "tab-returned" ? "agent" : "user" }] };
      if (args[0] === "tab" && args[1] === "borrow") { borrowed = true; return {}; }
      if (args[0] === "observe") return { tab_id: 4, text: `${mode === "wrong-account" ? "Other account" : "Office account"}\nTransaction history${mode === "password" ? '\n@e1 textbox "Password"' : ''}` };
      return original(args);
    });
    const checked = await f.runtime.verifyLogin({ browserId: "chrome-work", tabId: 4, origin: "https://bank.example", accountMarker: "Office account", readyMarker: "Transaction history" });
    expect(checked).toBe(mode === "match"); expect(f.sessions.size).toBe(0);
    if (mode === "tab-returned") expect(f.command.mock.calls.some(([args]) => args[0] === "observe")).toBe(false);
  });
  it("revokes access immediately and persists off across restart", async () => {
    const f = await browserFixture(); await f.runtime.acquire("job-1"); await f.runtime.stop(true);
    expect(f.runtime.isOwner("job-1")).toBe(false);
    expect((await new BrowserRuntime(f.options).status()).state).toBe("off");
    const saved = await readFile(join(f.root, "connection.json"), "utf8");
    expect(saved).not.toContain("cookie"); expect(saved).not.toContain("password");
  });
});
