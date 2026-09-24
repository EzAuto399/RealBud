import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBrowserTaskUpload, browserDownloadTarget, browserTaskWorkroom, BrowserRuntime, browserStepFailure, grantedUploadPath, saveBrowserDownload, sniffContentType, type BrowserJson } from "./browser-runtime.ts";
import { windowsFilePrivacy } from "./windows-file-privacy.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";

// The real helper by default; one test watches the order of protection.
vi.mock("./windows-file-privacy.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./windows-file-privacy.ts")>();
  return { ...actual, windowsFilePrivacy: vi.fn(actual.windowsFilePrivacy) };
});

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

describe("browser task files", () => {
  const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const workroom = () => { const root = privateTempRoot(join(tmpdir(), "rb-browser-files-")); roots.push(root); return browserTaskWorkroom(root, "grant-fictional-1"); };
  afterEach(() => { vi.mocked(windowsFilePrivacy).mockRestore(); });

  it("protects a new download before writing its bytes, then removes the helper's copy", async () => {
    const room = workroom(); const staged = await browserDownloadTarget(room);
    const bytes = Buffer.from("%PDF-1.7\nFictional statement\n"); await writeFile(staged, bytes);
    const seen: Array<[string, string, boolean | undefined, number | null]> = [];
    vi.mocked(windowsFilePrivacy).mockImplementation(async (path, kind, restrict) => {
      seen.push([path, kind, restrict, kind === "file" ? (await readFile(path)).length : null]);
    });
    const receipt = await saveBrowserDownload(room, staged, "../../Fictional statement.pdf");
    expect(receipt).toEqual({ name: "Fictional statement.pdf", size: bytes.length, sha256: sha256(bytes), contentType: "application/pdf" });
    const saved = join(room, "downloads", receipt.name);
    // The new folder is restricted as it is created and verified before use; the file is restricted while still empty.
    expect(seen.filter(([path]) => path === saved || path === join(room, "downloads")).map(([path, kind, restrict, size]) => [path === saved ? "file" : "folder", kind, restrict, size]))
      .toEqual([["folder", "directory", true, null], ["folder", "directory", undefined, null], ["file", "file", true, 0]]);
    expect(await readFile(saved)).toEqual(bytes);
    if (process.platform !== "win32") expect((await stat(saved)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(room, "incoming"))).toEqual([]);
  });

  it("keeps nothing when the new file cannot be protected", async () => {
    const room = workroom(); const staged = await browserDownloadTarget(room); await writeFile(staged, "fictional");
    vi.mocked(windowsFilePrivacy).mockImplementation(async (_path, kind) => { if (kind === "file") throw new Error("ACL verification failed"); });
    await expect(saveBrowserDownload(room, staged, "fictional.txt")).rejects.toThrow("ACL verification failed");
    expect(await readdir(join(room, "downloads"))).toEqual([]);
    expect(await readdir(join(room, "incoming"))).toEqual([]);
  });

  it("refuses a missing or linked capture and names files by their bytes, not the site's claim", async () => {
    const room = workroom();
    await expect(saveBrowserDownload(room, join(room, "incoming", "never-written.part"), "x.pdf")).rejects.toThrow("The browser did not deliver a file.");
    const staged = await browserDownloadTarget(room); await writeFile(staged, "<!doctype html><p>Fictional sign-in page</p>");
    expect(await saveBrowserDownload(room, staged, "CON.pdf")).toMatchObject({ name: "download.html", contentType: "text/html" });
    expect(sniffContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffContentType(Buffer.from([0xff, 0xfe, 0x00, 0x41]))).toBe("application/octet-stream");
    expect(sniffContentType(Buffer.from("Date,Amount\n20 Sep,120.00\n"))).toBe("text/plain");
  });

  it("resolves a granted upload only while it is private and unchanged", async () => {
    const room = workroom();
    const granted = await addBrowserTaskUpload(room, "fictional-lease.pdf", Buffer.from("fictional lease"));
    expect(granted).toEqual({ name: "fictional-lease.pdf", sha256: sha256("fictional lease") });
    await expect(addBrowserTaskUpload(room, "fictional-lease.pdf", Buffer.from("other"))).rejects.toThrow(/already has a file with that name/);
    await expect(addBrowserTaskUpload(room, "../escape.pdf", Buffer.from("x"))).rejects.toThrow(/plain file name/);
    expect(await grantedUploadPath(room, granted)).toBe(join(room, "uploads", "fictional-lease.pdf"));
    await expect(grantedUploadPath(room, { name: "fictional-lease.pdf", sha256: sha256("something else") })).rejects.toThrow(/missing or has changed/);
    await expect(grantedUploadPath(room, { name: "../../connection.json", sha256: granted.sha256 })).rejects.toThrow(/missing or has changed/);
    await writeFile(join(room, "uploads", "fictional-lease.pdf"), "fictional lease", { mode: 0o644 });
    if (process.platform !== "win32") {
      const { chmod } = await import("node:fs/promises"); await chmod(join(room, "uploads", "fictional-lease.pdf"), 0o644);
      await expect(grantedUploadPath(room, granted)).rejects.toThrow(/missing or has changed/);
    }
  });
});
