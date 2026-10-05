#!/usr/bin/env node
// Local macOS chaos harness (resilience packet F). Runs fault cases against a
// fresh marked temp root with the real server, a fake ACP worker, the real Ask
// model relay and loopback fakes. Each case reports PASS, FAIL or N/A with the
// exact observed behaviour; FAIL is a result, not an error.
//
//   ~/.nvm/versions/node/v24.21.0/bin/node scripts/resilience/chaos.mjs [--seed N] [--only 1,3,7] [--out DIR]
//
// Proof layer: local tests (source + loopback fakes). Never customer evidence.
import { execFileSync, fork } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FICTIONAL_MODELVIA_KEY, fakeModelvia, severProxy } from "./fakes.mjs";
import { readSessionToken } from "../local-session.mjs";
import { DescendantWatch, Owned, ROOT, alive, assertMarked, freePort, http, imagesUnder, markedRoot, processesMentioning, readJsonl, removeRoot, sleep, tempLeftovers, until, writeLoopbackGuard } from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const seed = Number(flag("--seed", "20261005"));
const only = flag("--only", "")?.split(",").filter(Boolean);
const date = new Date().toISOString().slice(0, 10);
const out = resolve(flag("--out", join(ROOT, "outputs", `chaos-${date}`)));
if (existsSync(join(out, "receipt.json"))) throw new Error(`${out}/receipt.json exists; earlier evidence is never overwritten. Pass --out.`);
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Run with Node 24 (~/.nvm/versions/node/v24.21.0/bin/node).");
if (process.platform !== "darwin") throw new Error("This harness uses macOS hdiutil and ps -E.");

const NODE = process.execPath;
const FAKE_CLI = join(ROOT, "server", "testing", "fake-acp-cli.ts");
let rng = seed >>> 0;
const random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 2 ** 32);

const root = markedRoot();
const deniedLog = join(root, "denied.jsonl");
const guard = pathToFileURL(writeLoopbackGuard(root, deniedLog)).href;
const owned = new Owned();
const results = [];

// ── service + worker helpers ──────────────────────────────────────────────
function writeWorkerConfig(dataDir) {
  const dump = join(dataDir, "vault", "bud-work", "fake-acp-dump.json");
  mkdirSync(dirname(dump), { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: { hermes: { driver: "hermesAgent", config: { cli: FAKE_CLI },
    // wrap-up with no tool calls: each prompt is held 4 s, then ends normally.
    environment: { FAKE_ACP_MODE: "wrap-up", FAKE_ACP_TOOL_CALLS: "0", FAKE_ACP_WRAP_WAIT_MS: "4000", FAKE_ACP_DUMP: dump } } } }, null, 2));
  return dump;
}

async function startServer(caseDir, dataDir) {
  assertMarked(root, dataDir);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const home = join(caseDir, "home"); mkdirSync(home, { recursive: true });
  const child = owned.spawn("server", NODE, ["--experimental-strip-types", "--import", guard, join(ROOT, "server", "index.ts")], { cwd: ROOT, env: {
    PATH: `${dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, USERPROFILE: home, TMPDIR: join(caseDir, "tmp"),
    OMB_PORT: String(port), REALBUD_DATA_DIR: dataDir, REALBUD_HERMES_HOME: join(dataDir, "hermes"),
  } });
  mkdirSync(join(caseDir, "tmp"), { recursive: true });
  const t = Date.now();
  const up = await until(async () => { if (child.exitCode !== null) throw new Error("exited"); return (await http(base, "/api/health", { timeout: 1000 })).status === 200; }, 40000, 150);
  if (!up) throw new Error(`server did not become healthy (exit ${child.exitCode}): ${child.log.slice(-1500)}`);
  // The per-boot token comes from the service's private session file, never over HTTP.
  const session = await readSessionToken(dataDir);
  const api = (path, method = "GET", body, timeout = 10000) => http(base, path, { method, body, timeout, headers: { "x-realbud-session": session } });
  return { child, base, api, bootMs: Date.now() - t };
}

const bud = async (s) => (await s.api("/api/bots")).body?.bots?.find((b) => b.id === "bud");
const readDump = (dump) => { try { return JSON.parse(readFileSync(dump, "utf8")); } catch { return null; } };
const commandOf = (pid) => { try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim(); } catch { return ""; } };
async function workerInFlight(dump, minPrompts) {
  return until(() => { const d = readDump(dump); return d && d.promptCount >= minPrompts && alive(d.pid) && commandOf(d.pid).includes("fake-acp-cli") ? d : null; }, 20000);
}
async function replyAfter(s, count, ms) {
  return until(async () => { const b = await bud(s); const fresh = b?.messages?.slice(count) ?? []; return !b?.busy && fresh.some((m) => m.role === "bot") ? { b, fresh } : null; }, ms, 200);
}
const shownMessage = (m) => ({ role: m.role, kind: m.kind, ...(m.text ? { text: m.text.slice(0, 160) } : {}), ...(m.tool ? { tool: m.tool.name?.slice(0, 160), ok: m.tool.ok } : {}) });
const lastText = (msgs) => [...msgs].reverse().find((m) => m.role === "bot")?.text?.slice(0, 200) ?? null;

// ── relay helpers (cases 4 and 7) ─────────────────────────────────────────
async function startRelay(caseDir, gatewayPort, { idleMs } = {}) {
  const dataDir = join(caseDir, "data"); mkdirSync(join(dataDir, "hermes"), { recursive: true });
  const child = fork(join(ROOT, "scripts", "resilience", "relay-child.mjs"), [], { execArgv: ["--import", guard], stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
    PATH: `${dirname(NODE)}:/usr/bin:/bin`, HOME: join(caseDir, "home"), REALBUD_DATA_DIR: dataDir, REALBUD_HERMES_HOME: join(dataDir, "hermes"),
    CHAOS_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}/v1`, CHAOS_MODEL_KEY: FICTIONAL_MODELVIA_KEY, ...(idleMs ? { CHAOS_RELAY_IDLE_MS: String(idleMs) } : {}) } });
  child.label = "relay"; child.log = ""; child.closed = new Promise((r) => child.once("close", r));
  for (const st of [child.stdout, child.stderr]) st.on("data", (b) => { child.log = (child.log + b).slice(-20000); });
  owned.children.push(child);
  const info = await Promise.race([new Promise((r) => child.once("message", r)), child.closed.then(() => { throw new Error(`relay child exited: ${child.log.slice(-1500)}`); })]);
  if (info.refusal) throw new Error(`relay refused its own fixture grant: ${info.refusal}`);
  return { child, ...info };
}
function chat(relay, { stream = false, timeout = 15000 } = {}) {
  return fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${relay.token}` },
    body: JSON.stringify({ model: relay.model, stream, messages: [{ role: "user", content: "fictional chaos question" }] }), signal: AbortSignal.timeout(timeout) });
}
async function chatOnce(relay, opts) {
  const t = Date.now();
  try { const r = await chat(relay, opts); const text = await r.text(); return { status: r.status, retryAfter: r.headers.get("retry-after"), text: text.slice(0, 300), ms: Date.now() - t }; }
  catch (e) { return { status: 0, error: e?.name === "TimeoutError" ? "timeout" : String(e?.cause?.code ?? e?.message), ms: Date.now() - t }; }
}
/** Read a stream; returns per-frame arrival times and how it ended. */
async function readStream(relay, { stallMs = 10000, onFirst } = {}) {
  const t = Date.now(), frames = [];
  let ended = "complete", status = 0;
  try {
    const r = await chat(relay, { stream: true, timeout: 60000 }); status = r.status;
    const reader = r.body.getReader(); const dec = new TextDecoder();
    for (;;) {
      let timer; const next = await Promise.race([reader.read(), new Promise((res) => { timer = setTimeout(() => res("stall"), stallMs); })]); clearTimeout(timer);
      if (next === "stall") { ended = `still-open-after-${stallMs}ms`; await reader.cancel().catch(() => {}); break; }
      if (next.done) break;
      for (const part of dec.decode(next.value).split("\n\n").filter((p) => p.startsWith("data:"))) { frames.push({ ms: Date.now() - t, done: part.includes("[DONE]") }); if (frames.length === 1) onFirst?.(); }
    }
  } catch (e) { ended = `error:${e?.cause?.code ?? e?.code ?? e?.name ?? e?.message}`; }
  return { status, frames: frames.length, sawDone: frames.some((f) => f.done), firstMs: frames[0]?.ms ?? null, lastMs: frames.at(-1)?.ms ?? null, totalMs: Date.now() - t, ended };
}
const upstreamAudit = (mv, since = 0) => {
  const rows = mv.seen.slice(since);
  const keys = rows.map((r) => r.idem);
  return { upstreamRequests: rows.length, foreignAuth: rows.filter((r) => r.auth !== `Bearer ${FICTIONAL_MODELVIA_KEY}`).length, duplicateIdempotencyKeys: keys.length - new Set(keys).size };
};

// ── disk image helpers (case 3) ───────────────────────────────────────────
function attachImage(caseDir) {
  const image = join(caseDir, "chaos-128m.dmg"), mount = join(caseDir, "vol");
  assertMarked(root, image); mkdirSync(mount, { recursive: true });
  execFileSync("hdiutil", ["create", "-size", "128m", "-fs", "APFS", "-volname", "RBCHAOS", "-type", "UDIF", "-layout", "NONE", image], { stdio: "pipe" });
  const plist = execFileSync("hdiutil", ["attach", "-plist", "-nobrowse", "-noverify", "-noautoopen", "-owners", "on", "-mountpoint", mount, image], { encoding: "utf8" });
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: plist, encoding: "utf8" }));
  const entity = info["system-entities"].find((e) => e["mount-point"] === mount);
  if (!entity) throw new Error("image attached without the expected mount point");
  // Mount identity: the filesystem at `mount` is the device this attach returned.
  const df = execFileSync("df", ["-kP", mount], { encoding: "utf8" }).trim().split("\n").at(-1).split(/\s+/);
  if (df[0] !== entity["dev-entry"] || df.at(-1) !== mount) throw new Error(`mount identity mismatch: ${df.join(" ")}`);
  const disk = info["system-entities"].map((e) => e["dev-entry"]).sort((a, b) => a.length - b.length)[0];
  return { image, mount, device: entity["dev-entry"], disk, sizeKiB: Number(df[1]) };
}
function detachImage(img) {
  if (!img) return "not-attached";
  for (const extra of [[], ["-force"]]) {
    try { execFileSync("hdiutil", ["detach", img.mount, ...extra], { stdio: "pipe" }); return extra.length ? "detached-force" : "detached"; } catch { /* try force */ }
  }
  return imagesUnder(root).includes(img.image) ? "STILL-ATTACHED" : "detached";
}
/** Fill with filler files until even a new file takes nothing (APFS frees reservations on close). */
function fillVolume(dir) {
  mkdirSync(dir, { recursive: true });
  let bytes = 0, files = 0, code = null;
  for (let i = 0; i < 500; i++) {
    let fd; try { fd = openSync(join(dir, `filler-${i}`), "w"); files++; } catch (e) { code = e.code; break; }
    let wrote = 0;
    for (const size of [1 << 20, 1 << 14, 1 << 10, 64, 1]) {
      const buf = Buffer.alloc(size);
      for (;;) { try { writeSync(fd, buf); bytes += size; wrote += size; } catch (e) { code = e.code; break; } }
    }
    try { closeSync(fd); } catch { /* full */ }
    if (wrote === 0) break;
  }
  let probe = "ok";
  try { writeFileSync(join(dir, "probe"), Buffer.alloc(4096)); } catch (e) { probe = e.code; }
  return { bytes, files, code, probe4KiB: probe };
}

// ── the cases ─────────────────────────────────────────────────────────────
const cases = [
  { id: "1", name: "SIGKILL the fake worker mid-turn", deadlineMs: 30000, async run(dir, check) {
    const data = join(dir, "data"); const dump = writeWorkerConfig(data);
    const s = await startServer(dir, data);
    const before = (await bud(s))?.messages?.length ?? 0;
    check("message accepted", (await s.api("/api/bots/bud/messages", "POST", { text: "chaos one: hold this turn" })).status < 300);
    const w = await workerInFlight(dump, 1);
    if (!w) return check("worker turn in flight", false, "no fake worker prompt observed in 20 s");
    process.kill(w.pid, "SIGKILL"); const t = Date.now();
    const settled = await until(async () => { const b = await bud(s); return b && !b.busy && b.messages.length > before + 1 ? b : null; }, this.deadlineMs, 200);
    check("turn settled after worker death within deadline", Boolean(settled), settled ? `${Date.now() - t}ms; shown: ${JSON.stringify(settled.messages.slice(before + 1).map(shownMessage))}` : `bud still busy after ${this.deadlineMs}ms`);
    check("killed worker is gone", !alive(w.pid));
    const b1 = await bud(s);
    check("user message preserved", b1?.messages?.some((m) => m.role === "user" && m.text?.includes("chaos one")));
    const n = b1?.messages?.length ?? 0;
    await s.api("/api/bots/bud/messages", "POST", { text: "chaos two: are you back?" });
    const next = await replyAfter(s, n + 1, this.deadlineMs);
    const fresh = readDump(dump);
    check("next turn answered by a new worker (usable)", Boolean(next) && fresh?.pid !== w.pid, next ? `reply ${JSON.stringify(lastText(next.fresh))}, new pid ${fresh?.pid !== w.pid}` : "no reply");
  } },
  { id: "2", name: "Kill and restart the server mid-write", deadlineMs: 40000, async run(dir, check, observe) {
    const data = join(dir, "data"); writeWorkerConfig(data);
    let s = await startServer(dir, data);
    const killAfter = 4 + Math.floor(random() * 8), acked = [], unknown = [];
    let killed = false, i = 0;
    const writer = async () => {
      while (!killed && i < 60) {
        const address = `${++i} Chaos St, Fictional ACT`;
        const r = await s.api("/api/desk/properties", "POST", { address, tenantName: "Fictional Tenant", tenantPhone: "0400 000 000", weeklyRentCents: 50_000 }, 5000);
        if (r.status === 201) acked.push(address); else unknown.push({ address, status: r.status, error: r.error ?? r.body?.error });
        if (!killed && acked.length >= killAfter) { killed = true; process.kill(s.child.pid, "SIGKILL"); }
      }
    };
    await Promise.all([writer(), writer(), writer(), writer()]);
    await s.child.closed;
    observe({ killAfterAcks: killAfter, acknowledged: acked.length, unacknowledgedAtKill: unknown.length });
    const t = Date.now();
    s = await startServer(dir, data);
    check("server restarts healthy within deadline", Date.now() - t < this.deadlineMs, `${Date.now() - t}ms`);
    const desk = await s.api("/api/desk");
    check("desk readable after restart", desk.status === 200, desk.status === 200 ? "" : `${desk.status} ${JSON.stringify(desk.body)?.slice(0, 200)}`);
    const addresses = desk.body?.properties?.map((p) => p.address) ?? [];
    const lost = acked.filter((a) => !addresses.includes(a));
    check("every acknowledged write preserved", lost.length === 0, lost.length ? `lost ${JSON.stringify(lost)}` : `${acked.length}/${acked.length}`);
    check("no duplicate records", addresses.length === new Set(addresses).size);
    observe({ unacknowledgedPresentAfterRestart: unknown.filter((u) => addresses.includes(u.address)).length });
    const add = await s.api("/api/desk/properties", "POST", { address: "99 After Restart Rd, Fictional ACT", tenantName: "Fictional Tenant", tenantPhone: "0400 000 000", weeklyRentCents: 50_000 });
    check("writes work after restart", add.status === 201, String(add.status));
    const tmp = tempLeftovers(data);
    check("no interrupted temp files left in the data dir", tmp.length === 0, tmp.join(", "));
  } },
  { id: "3", name: "Disk full (128 MiB APFS image) then freed", deadlineMs: 20000, async run(dir, check, observe) {
    let img = null, s = null;
    try {
      img = attachImage(dir);
      observe({ image: { device: img.device, sizeKiB: img.sizeKiB } });
      const data = join(img.mount, "data"); writeWorkerConfig(data);
      s = await startServer(dir, data);
      const prop = (address) => s.api("/api/desk/properties", "POST", { address, tenantName: "Fictional Tenant", tenantPhone: "0400 000 000", weeklyRentCents: 50_000 });
      check("seed write before fill", (await prop("1 Before Full St, Fictional ACT")).status === 201);
      const filled = fillVolume(join(img.mount, "filler"));
      observe({ fill: filled });
      check("volume full: a 4 KiB probe write gets ENOSPC", filled.probe4KiB === "ENOSPC", String(filled.probe4KiB));
      const full = await prop("2 While Full St, Fictional ACT");
      observe({ writeWhileFull: { status: full.status, error: full.body?.error ?? full.error, code: full.body?.code, serverLog: s.child.log.split("\n").filter((l) => /ENOSPC|rror/.test(l)).slice(-4).map((l) => l.slice(0, 300)) } });
      check("desk write while full: 507 storage-full repair state (or accepted and durable)", full.status === 507 || full.status === 201, `${full.status} ${JSON.stringify(full.body?.error ?? full.error ?? "")}`);
      const nAsk = (await bud(s))?.messages?.length ?? 0;
      const askPost = await s.api("/api/bots/bud/messages", "POST", { text: "chaos full: can you answer?" });
      const askSettled = await until(async () => { const b = await bud(s); return b && !b.busy && b.messages.length > nAsk + 1 ? b : null; }, this.deadlineMs, 250);
      observe({ askWhileFull: { post: askPost.status, postError: askPost.body?.error ?? askPost.error, shown: askSettled?.messages.slice(nAsk).map(shownMessage) ?? "still busy or no reply" } });
      check("Ask while full: 507 storage repair state or a settled reply (no raw error)", askPost.status === 507 || (askPost.status < 300 && Boolean(askSettled)), `POST ${askPost.status} ${JSON.stringify(askPost.body?.error ?? askPost.error ?? "").slice(0, 120)}`);
      check("server alive while full", s.child.exitCode === null && (await http(s.base, "/api/health", { timeout: 3000 })).status === 200);
      const read = await s.api("/api/desk");
      check("earlier record readable while full", read.status === 200 && read.body?.properties?.some((p) => p.address.startsWith("1 Before Full")), String(read.status));
      rmSync(join(img.mount, "filler"), { recursive: true, force: true });
      const t = Date.now();
      const after = await until(async () => (await prop("3 After Free St, Fictional ACT")).status === 201, this.deadlineMs, 500);
      check("write succeeds after space freed within deadline", Boolean(after), `${Date.now() - t}ms`);
      const nFree = (await bud(s))?.messages?.length ?? 0;
      await s.api("/api/bots/bud/messages", "POST", { text: "chaos freed: are you back?" });
      const askFree = await replyAfter(s, nFree + 1, this.deadlineMs);
      check("Ask answers after space freed", Boolean(askFree), askFree ? JSON.stringify(lastText(askFree.fresh)) : "no reply");
      await owned.stop(s.child);
      s = await startServer(dir, data);
      const desk = (await s.api("/api/desk")).body?.properties?.map((p) => p.address) ?? [];
      const fullAcked = full.status === 201;
      check("records preserved across restart", desk.some((a) => a.startsWith("1 Before")) && desk.some((a) => a.startsWith("3 After")) && (!fullAcked || desk.some((a) => a.startsWith("2 While"))), JSON.stringify(desk.filter((a) => /Full|Free/.test(a))));
      const tmp = tempLeftovers(data);
      check("no interrupted temp files left on the volume", tmp.length === 0, tmp.join(", "));
    } finally {
      if (s) await owned.stop(s.child);
      const detached = detachImage(img);
      observe({ detach: detached });
      check("image detached", detached !== "STILL-ATTACHED" && imagesUnder(root).length === 0, detached);
    }
  } },
  { id: "4", name: "Network severed through a socket-dropping proxy, then restored", deadlineMs: 10000, async run(dir, check, observe) {
    const mv = await fakeModelvia(), proxy = await severProxy(mv.port);
    try {
      const relay = await startRelay(dir, proxy.port);
      const base = await chatOnce(relay);
      check("baseline answer through relay", base.status === 200, JSON.stringify(base));
      mv.state.mode = "slow";
      const inflight = readStream(relay, { stallMs: this.deadlineMs, onFirst: () => proxy.sever() });
      const s1 = await inflight;
      observe({ inflightStreamWhenSevered: s1 });
      check("in-flight stream ends (not hung) when the link drops", !s1.ended.startsWith("still-open"), s1.ended);
      mv.state.mode = "ok";
      const severed = await chatOnce(relay, { timeout: this.deadlineMs + 5000 });
      observe({ requestWhileSevered: severed, proxyDropped: proxy.dropped });
      check("request while severed fails bounded (502/504) within deadline", [502, 504].includes(severed.status) && severed.ms < this.deadlineMs, `${severed.status} in ${severed.ms}ms`);
      proxy.restore();
      const t = Date.now();
      const healed = await until(async () => (await chatOnce(relay)).status === 200, this.deadlineMs, 250);
      check("usable again after restore", Boolean(healed), `${Date.now() - t}ms`);
      const audit = upstreamAudit(mv);
      observe({ upstream: audit });
      check("no foreign key, no duplicate upstream effect", audit.foreignAuth === 0 && audit.duplicateIdempotencyKeys === 0, JSON.stringify(audit));
    } finally { await proxy.close(); await mv.close(); }
  } },
  { id: "5", name: "Sleep/wake: SIGSTOP service and worker 5 s, then SIGCONT", deadlineMs: 30000, async run(dir, check, observe) {
    const data = join(dir, "data"); const dump = writeWorkerConfig(data);
    const s = await startServer(dir, data);
    const before = (await bud(s))?.messages?.length ?? 0;
    await s.api("/api/bots/bud/messages", "POST", { text: "chaos sleep: hold this turn" });
    const w = await workerInFlight(dump, 1);
    if (!w) return check("worker turn in flight", false, "no fake worker prompt observed");
    for (const pid of [s.child.pid, w.pid]) process.kill(pid, "SIGSTOP");
    const asleep = await http(s.base, "/api/health", { timeout: 1500 });
    observe({ healthWhileStopped: asleep.status || asleep.error });
    await sleep(5000);
    for (const pid of [s.child.pid, w.pid]) process.kill(pid, "SIGCONT");
    const t = Date.now();
    const healthy = await until(async () => (await http(s.base, "/api/health", { timeout: 1000 })).status === 200, this.deadlineMs);
    check("service answers after wake", Boolean(healthy), `${Date.now() - t}ms`);
    const done = await replyAfter(s, before + 1, this.deadlineMs);
    check("held turn finishes after wake", Boolean(done), done ? `${Date.now() - t}ms: ${JSON.stringify(lastText(done.fresh))}` : "no reply");
    check("same worker survived the pause", alive(w.pid), `pid ${w.pid}`);
    const n = (await bud(s))?.messages?.length ?? 0;
    await s.api("/api/bots/bud/messages", "POST", { text: "chaos sleep two" });
    check("next turn usable", Boolean(await replyAfter(s, n + 1, this.deadlineMs)));
  } },
  { id: "6", name: "±24 h wall-clock jump (LoopManager fixture clock)", deadlineMs: 10000, async run(dir, check, observe) {
    const data = join(dir, "data"); mkdirSync(data, { recursive: true });
    const child = fork(join(ROOT, "scripts", "resilience", "clock-child.mjs"), [], { execArgv: ["--import", guard], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: `${dirname(NODE)}:/usr/bin:/bin`, HOME: join(dir, "home"), REALBUD_DATA_DIR: data } });
    child.label = "clock"; child.log = ""; child.closed = new Promise((r) => child.once("close", r)); owned.children.push(child);
    for (const st of [child.stdout, child.stderr]) st.on("data", (b) => { child.log = (child.log + b).slice(-20000); });
    await new Promise((r) => child.once("message", r));
    const ask = (m) => new Promise((r, j) => { const t = setTimeout(() => j(new Error(`clock child silent: ${child.log.slice(-500)}`)), this.deadlineMs); child.once("message", (v) => { clearTimeout(t); v.ok ? r(v.state) : j(new Error(v.error)); }); child.send(m); });
    const H = 3600_000, t0 = Date.parse("2026-10-05T06:00:00Z"); // Monday 06:00 UTC; morning-arrears runs weekdays 07:30
    await ask({ op: "open", now: t0, enable: ["morning-arrears"] });
    const steps = [];
    const step = async (label, op, now) => { const st = await ask({ op, now }); steps.push({ label, now: new Date(now).toISOString(), executed: st.executed.length, nextRunAt: st.loops.find((l) => l.id === "morning-arrears")?.nextRunAt }); return st; };
    await step("Mon 08:00", "tick", t0 + 2 * H);
    await step("+24h Tue 08:00", "tick", t0 + 26 * H);
    const back = await step("-24h Mon 08:00", "tick", t0 + 2 * H);
    await step("+24h Tue 08:00 again", "tick", t0 + 26 * H);
    await step("restart at Tue 08:00", "restart", t0 + 26 * H);
    await step("tick after restart", "tick", t0 + 26 * H);
    const end = await step("+48h Thu 08:00", "tick", t0 + 74 * H);
    await ask({ op: "close" }).catch(() => {});
    observe({ steps });
    const slots = end.executed.map((e) => e.scheduledFor);
    check("no scheduled slot executed twice", slots.length === new Set(slots).size, slots.map((x) => new Date(x).toISOString()).join(", "));
    check("backward jump replays nothing", back.executed.length === 2 && steps[3].executed === 2 && steps[5].executed === 2, `executed counts ${steps.map((x) => x.executed).join("/")}`);
    check("nextRunAt stays in the future after the backward jump", (steps[2].nextRunAt ?? 0) > t0 + 2 * H, steps[2].nextRunAt ? new Date(steps[2].nextRunAt).toISOString() : "null");
    check(">12 h gap compresses to one explicit missed receipt, then today runs", end.runs.some((r) => r.status === "missed") && end.executed.length === 3, `runs ${JSON.stringify(end.runs.map((r) => `${new Date(r.scheduledFor).toISOString().slice(5, 16)} ${r.status}`))}`);
    return { note: "The running service has no injectable clock; this drives the real LoopManager + its file store in a child. Approval expiry and browser effect holds under clock jumps are not exercised here." };
  } },
  ...[["7a", "429 with Retry-After", "429"], ["7b", "401 rejected key", "401"], ["7c", "5xx outage", "503"]].map(([id, label, mode]) => ({ id, name: `Fake Modelvia ${label}`, deadlineMs: 10000, async run(dir, check, observe) {
    const mv = await fakeModelvia();
    try {
      const relay = await startRelay(dir, mv.port);
      mv.state.mode = mode;
      const r = await chatOnce(relay);
      observe({ relayAnswer: r });
      check(`relay returns the upstream ${mode} promptly`, String(r.status) === mode && r.ms < this.deadlineMs, `${r.status} in ${r.ms}ms: ${r.text}`);
      if (mode === "429") check("Retry-After guidance reaches the worker", r.retryAfter === "7", `retry-after header: ${r.retryAfter ?? "absent"}`);
      const faultCalls = upstreamAudit(mv);
      check("exactly one upstream call for the failed request (no blind retry, no key swap)", faultCalls.upstreamRequests === 1 && faultCalls.foreignAuth === 0, JSON.stringify(faultCalls));
      mv.state.mode = "ok";
      const ok = await chatOnce(relay);
      check("relay usable once upstream recovers", ok.status === 200, `${ok.status}`);
    } finally { await mv.close(); }
  } })),
  { id: "7d", name: "Fake Modelvia slow stream, then stalled stream", deadlineMs: 10000, async run(dir, check, observe) {
    const mv = await fakeModelvia();
    try {
      // Injected idle timeout (product default 60 s) so the stall is ended inside the deadline.
      const relay = await startRelay(dir, mv.port, { idleMs: 3000 });
      mv.state.mode = "slow";
      const slow = await readStream(relay, { stallMs: this.deadlineMs });
      observe({ slow });
      check("slow stream delivered incrementally and completely", slow.status === 200 && slow.sawDone && slow.frames >= 5 && slow.firstMs < slow.lastMs - 1500, JSON.stringify(slow));
      mv.state.mode = "stall";
      const stall = await readStream(relay, { stallMs: this.deadlineMs });
      observe({ stall });
      check(`stalled stream ended by the relay within ${this.deadlineMs}ms`, !stall.ended.startsWith("still-open") && !stall.sawDone, `${stall.ended} after ${stall.totalMs}ms (injected relay idle timeout 3000ms)`);
      check("one upstream call per request", upstreamAudit(mv).upstreamRequests === 2 && upstreamAudit(mv).duplicateIdempotencyKeys === 0, JSON.stringify(upstreamAudit(mv)));
    } finally { await mv.close(); }
  } },
];

// ── runner ────────────────────────────────────────────────────────────────
console.log(`chaos root ${root} (seed ${seed})`);
try {
  for (const c of cases) {
    if (only?.length && !only.some((o) => c.id === o || c.id.startsWith(o))) continue;
    const dir = join(root, `case-${c.id}`); mkdirSync(dir, { recursive: true });
    const checks = [], observed = {};
    const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) }); return ok; };
    const t = Date.now();
    const watch = new DescendantWatch(); watch.start();
    let result, error, extra;
    try { extra = await c.run.call(c, dir, check, (o) => Object.assign(observed, o)); }
    catch (e) { error = String(e?.stack ?? e).split("\n").slice(0, 3).join(" | "); }
    finally { watch.sample(); watch.stop(); await owned.stopAll(); }
    await until(() => watch.survivors().length === 0 && processesMentioning(dir).length === 0, 5000);
    const leftover = [...watch.survivors(), ...processesMentioning(dir).map((pid) => ({ pid, byCommandLine: true }))];
    observed.descendantsSeen = watch.seen.size;
    for (const l of leftover) { try { process.kill(l.pid, "SIGKILL"); l.killedByHarness = true; } catch { /* gone */ } }
    check("no processes left behind", leftover.length === 0, leftover.length ? JSON.stringify(leftover) : `${watch.seen.size} descendants seen, all gone`);
    if (extra?.na) result = "N/A";
    else if (error) result = "FAIL";
    else result = checks.every((x) => x.ok) ? "PASS" : "FAIL";
    const denied = readJsonl(deniedLog);
    results.push({ id: c.id, name: c.name, result, deadlineMs: c.deadlineMs, elapsedMs: Date.now() - t, ...(error ? { error } : {}), ...(extra?.note ? { note: extra.note } : {}), ...(extra?.na ? { reason: extra.na } : {}), observed, checks, nonLoopbackAttempts: denied.length });
    console.log(`${result.padEnd(4)} ${c.id} ${c.name} (${Date.now() - t}ms)`);
    for (const x of checks) console.log(`     ${x.ok ? "ok  " : "FAIL"} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`);
    if (error) console.log(`     error: ${error}`);
  }
} finally {
  await owned.stopAll();
  const images = imagesUnder(root);
  for (const image of images) { try { execFileSync("hdiutil", ["detach", "-force", image], { stdio: "pipe" }); } catch { /* reported below */ } }
  const processes = processesMentioning(root);
  const denied = readJsonl(deniedLog);
  removeRoot(root);
  const head = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return null; } })();
  const receipt = {
    at: new Date().toISOString(), proofLayer: "local tests — source tree, real server/relay/LoopManager, fake ACP worker, loopback fakes",
    source: { head, node: process.version, seed }, command: `node scripts/resilience/chaos.mjs --seed ${seed}${only?.length ? ` --only ${only.join(",")}` : ""}`,
    summary: Object.fromEntries(["PASS", "FAIL", "N/A"].map((k) => [k, results.filter((r) => r.result === k).map((r) => r.id)])),
    cases: results,
    cleanup: { imagesAttachedAtEnd: imagesUnder(root).length, imagesForceDetached: images.length, processesMentioningRootAtEnd: processes.length, rootRemoved: !existsSync(root), nonLoopbackAttempts: denied },
    limits: [
      "Fixture-only: fake ACP worker (not Hermes), fictional Modelvia, no website or managed gateway process, no live account.",
      "Relay cases run server/ask-model-relay.ts in a child with a fictional grant; its per-request entitlement check is replaced (no signed entitlement), every other relay check is real.",
      "The service has no injectable wall clock; case 6 drives the real LoopManager in a child. Approval/browser-hold expiry under clock jumps is not covered.",
      "SIGSTOP/SIGCONT simulates sleep; physical laptop sleep, network interface changes and Electron watchdog behaviour remain device tests.",
      "Disk-full runs on a 128 MiB APFS image; host disk quotas and Windows are not covered.",
      "macOS only. Not packaged-build, installed-device or customer evidence.",
    ],
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`receipt ${join(out, "receipt.json")}`);
  console.log(`summary ${JSON.stringify(receipt.summary)} cleanup ${JSON.stringify({ ...receipt.cleanup, nonLoopbackAttempts: denied.length })}`);
}
