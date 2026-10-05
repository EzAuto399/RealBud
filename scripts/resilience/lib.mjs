// Shared plumbing for the local chaos harness: a marked disposable root,
// owned child processes, loopback-only HTTP, and leftover checks.
// Dev tooling only. Never points at ~/.realbud or any live account.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MARKER = ".realbud-chaos-root";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh temp root carrying a marker; refuses anything near the real data dir. */
export function markedRoot(prefix = "realbud-chaos-") {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  const live = resolve(homedir(), ".realbud");
  if (root === live || root.startsWith(live + "/")) throw new Error("Refusing a root inside ~/.realbud.");
  writeFileSync(join(root, MARKER), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
  return root;
}

export function assertMarked(root, path = root) {
  if (!existsSync(join(root, MARKER))) throw new Error(`Not a marked chaos root: ${root}`);
  if (resolve(path) !== root && !resolve(path).startsWith(root + "/")) throw new Error(`Path escapes the chaos root: ${path}`);
}

/**
 * Preload for every child: fetch and raw sockets may reach loopback only. A
 * refused attempt is appended to `deniedLog` so a case can prove no
 * non-loopback call was even tried.
 */
export function writeLoopbackGuard(root, deniedLog) {
  assertMarked(root, deniedLog);
  const file = join(root, "bin", "loopback-guard.mjs");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `import net from "node:net";
import { appendFileSync } from "node:fs";
const ok = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const deny = (where, host) => { try { appendFileSync(${JSON.stringify(deniedLog)}, JSON.stringify({ at: Date.now(), pid: process.pid, where, host }) + "\\n"); } catch {} return new Error("chaos harness denied non-loopback " + where + " to " + host); };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(input instanceof Request ? input.url : String(input));
  if (!ok.has(u.hostname)) throw deny("fetch", u.hostname);
  return realFetch(input, init);
};
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = args[0];
  const host = typeof o === "object" && o !== null ? (o.path ? null : (o.host ?? "localhost")) : (typeof args[1] === "string" ? args[1] : (typeof o === "string" ? null : "localhost"));
  if (host !== null && !ok.has(host)) { const e = deny("socket", host); queueMicrotask(() => this.destroy(e)); return this; }
  return realConnect.apply(this, args);
};
`);
  return file;
}

/** Child processes this harness started; every case tears them down. */
export class Owned {
  children = [];
  spawn(name, command, args, opts = {}) {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe", ...(opts.ipc ? ["ipc"] : [])], ...opts });
    child.label = name;
    child.log = "";
    child.closed = new Promise((r) => child.once("close", r));
    for (const s of [child.stdout, child.stderr]) s?.on("data", (b) => { child.log = (child.log + b).slice(-20000); });
    this.children.push(child);
    return child;
  }
  async stop(child, grace = 5000) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    try { process.kill(child.pid, "SIGCONT"); } catch { /* gone */ }
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), grace);
    try { await child.closed; } finally { clearTimeout(t); }
  }
  async stopAll() { for (const c of this.children.splice(0).reverse()) await this.stop(c); }
}

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Processes whose command line mentions the root (every child loads the guard from it). */
export function processesMentioning(root) {
  let out = "";
  try { out = execFileSync("ps", ["-ax", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); } catch { return []; }
  return out.split("\n").filter((l) => l.includes(root)).map((l) => Number(l.trim().split(/\s+/)[0])).filter((pid) => pid && pid !== process.pid);
}

/**
 * Samples every descendant of this harness (workers are grandchildren) so a
 * process that outlives or detaches from its parent is still on record.
 */
export class DescendantWatch {
  seen = new Map();
  sample() {
    let rows = [];
    try { rows = execFileSync("ps", ["-ax", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean).map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], command: m[3] }; }).filter(Boolean); } catch { return; }
    const kids = new Map(); for (const r of rows) (kids.get(r.ppid) ?? kids.set(r.ppid, []).get(r.ppid)).push(r);
    const stack = [process.pid];
    while (stack.length) for (const r of kids.get(stack.pop()) ?? []) { if (r.command.startsWith("ps ")) continue; this.seen.set(r.pid, r.command); stack.push(r.pid); }
  }
  start(ms = 250) { this.sample(); this.timer = setInterval(() => this.sample(), ms); this.timer.unref(); }
  stop() { clearInterval(this.timer); }
  /** Seen descendants still alive with the same command (guards against pid reuse). */
  survivors() {
    let live = new Map();
    try { for (const l of execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n")) { const m = l.trim().match(/^(\d+)\s+(.*)$/); if (m) live.set(+m[1], m[2]); } } catch { return []; }
    return [...this.seen].filter(([pid, cmd]) => live.get(pid) === cmd).map(([pid, cmd]) => ({ pid, command: cmd.slice(0, 200) }));
  }
}

/** Disk images attached from inside the root. */
export function imagesUnder(root) {
  let out = "";
  try { out = execFileSync("hdiutil", ["info"], { encoding: "utf8" }); } catch { return []; }
  return out.split("\n").filter((l) => l.startsWith("image-path") && l.includes(root)).map((l) => l.split(":").slice(1).join(":").trim());
}

export async function freePort() {
  const s = createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const p = s.address().port; await new Promise((r) => s.close(r)); return p;
}

export async function until(fn, ms, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

/** JSON over loopback with a hard per-request deadline; never throws. */
export async function http(base, path, { method = "GET", body, headers = {}, timeout = 10000 } = {}) {
  if (new URL(base).hostname !== "127.0.0.1") throw new Error("Harness requests stay on loopback.");
  const started = Date.now();
  try {
    const res = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout), redirect: "error" });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, headers: Object.fromEntries(res.headers), ms: Date.now() - started };
  } catch (e) {
    return { status: 0, error: e?.name === "TimeoutError" ? "timeout" : String(e?.cause?.code ?? e?.message ?? e), ms: Date.now() - started };
  }
}

/** Files left by interrupted atomic writes (`*.tmp`, `*.tmp-*`, `.*.tmp`). */
export function tempLeftovers(dir) {
  const found = [];
  const walk = (d) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tmp($|[-.])|\.partial$/.test(e.name)) found.push(p.slice(dir.length + 1));
    }
  };
  walk(dir);
  return found;
}

export function readJsonl(path) {
  try { return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

export function removeRoot(root) {
  assertMarked(root);
  rmSync(root, { recursive: true, force: true });
}
