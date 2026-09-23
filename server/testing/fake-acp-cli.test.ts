import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url));

function fixture(home: string, dump: string) {
  const child = spawn(process.execPath, [CLI], {
    env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home,
      FAKE_ACP_DUMP: dump, FAKE_ACP_MODE: "happy",
      // Keep both the first publication and later updates large enough to
      // exercise concurrent reads without inheriting the test runner's env.
      FICTIONAL_PADDING: "fictional-".repeat(1_000),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let closed = false;
  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  child.stdout.on("data", chunk => (stdout += chunk));
  child.stderr.on("data", chunk => (stderr += chunk));
  child.on("error", error => (spawnError = error));
  const done = new Promise<void>(resolve => child.once("close", () => { closed = true; resolve(); }));
  const send = (id: number, method: string, params = {}) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  const stop = async () => {
    if (!closed) child.kill("SIGKILL");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([done, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("fake ACP child did not close")), 5_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  return { child, send, stop, get closed() { return closed; }, get stdout() { return stdout; },
    get stderr() { return stderr; }, get spawnError() { return spawnError; } };
}

describe("fake ACP dump publication", () => {
  it("keeps initial and changing snapshots parseable to a concurrent reader", async () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-fake-acp-dump-"));
    const dump = join(home, "dump.json");
    // A replacement worker publishes to the same path, as the route tests do.
    writeFileSync(dump, JSON.stringify({ pid: 0, promptCount: 0 }));
    const peer = fixture(home, dump);
    const servers = [{ name: "fictional-observer", command: "fictional-command",
      env: [{ name: "FICTIONAL_DATA", value: "fictional-".repeat(8_000) }] }];
    const updates = 128;
    let sentUpdates = false;
    let reads = 0;
    peer.send(1, "initialize");
    try {
      const deadline = Date.now() + 10_000;
      while (!peer.closed) {
        if (Date.now() > deadline) throw new Error("fake ACP snapshot exercise timed out");
        for (let batch = 0; batch < 8; batch += 1) {
          // A malformed snapshot is a failure, never a polling retry.
          const snapshot = JSON.parse(readFileSync(dump, "utf8")) as { pid: number; promptCount: number };
          reads += 1;
          if (snapshot.pid !== 0 && snapshot.pid !== peer.child.pid) throw new Error("unexpected snapshot writer");
          if (!sentUpdates && snapshot.pid === peer.child.pid) {
            expect(snapshot.promptCount).toBe(0);
            sentUpdates = true;
            peer.send(2, "session/new", { mcpServers: servers });
            for (let index = 0; index < updates; index += 1) {
              peer.send(index + 3, "session/set_mode", { modeId: `fictional-mode-${index}` });
            }
            peer.send(updates + 3, "session/prompt");
            peer.child.stdin.end();
          }
        }
        await setImmediate();
      }
      expect(peer.spawnError).toBeUndefined();
      expect(peer.child.exitCode, peer.stderr).toBe(0);
      expect(sentUpdates).toBe(true);
      expect(reads).toBeGreaterThan(8);
      const responses = peer.stdout.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.id !== undefined);
      expect(responses.map(row => row.id)).toEqual(Array.from({ length: updates + 3 }, (_, index) => index + 1));
      expect(responses.some(row => row.error !== undefined)).toBe(false);
      const final = JSON.parse(readFileSync(dump, "utf8"));
      expect(final).toMatchObject({ pid: peer.child.pid, promptCount: 1, mcpServers: servers,
        sessionMode: `fictional-mode-${updates - 1}` });
      expect(readdirSync(home)).toEqual(["dump.json"]);
    } finally {
      try { await peer.stop(); } finally { rmSync(home, { recursive: true, force: true }); }
    }
  }, 20_000);

  it("fails a refused publication without leaving its temporary file or replacing the target", async () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-fake-acp-dump-refused-"));
    const dump = join(home, "dump.json");
    mkdirSync(dump);
    writeFileSync(join(dump, "fictional-marker"), "keep");
    const peer = fixture(home, dump);
    peer.child.stdin.end();
    try {
      const deadline = Date.now() + 5_000;
      while (!peer.closed) {
        if (Date.now() > deadline) throw new Error("fake ACP refused publication did not close");
        await setImmediate();
      }
      expect(peer.spawnError).toBeUndefined();
      expect(peer.child.exitCode).not.toBe(0);
      expect(peer.stderr).toMatch(/EISDIR|EEXIST|EACCES|EPERM/);
      expect(readFileSync(join(dump, "fictional-marker"), "utf8")).toBe("keep");
      expect(readdirSync(home)).toEqual(["dump.json"]);
    } finally {
      try { await peer.stop(); } finally { rmSync(home, { recursive: true, force: true }); }
    }
  }, 15_000);
});
