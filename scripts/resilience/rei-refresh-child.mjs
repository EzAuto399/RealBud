// Child for the chaos harness and scripts/qa-rei-refresh.mjs: the REI morning refresh
// (server/rei-morning-refresh.ts) on the real LoopManager, Desk, BrowserRuntime, broker and
// recipe runner, against the FICTIONAL REI portal (server/testing/fictional-rei-portal.ts).
// Its files live under REALBUD_DATA_DIR (a marked or temp root), so a parent can SIGKILL it
// mid-read and reopen the same files. A fixture clock (`now`) drives Desk and the schedule; the
// browser grant's expiry uses the wall clock. No network, no REI account, no credentials.
// Messages: {op, ...} → {ok, result, state} | {ok:false, error}. Ops: portal, book, sign-out, timeout,
// enable, run, refresh, race, tick, settle, wait-observes, approve-all, add, edit, resolve, release, state, close.
import { join } from "node:path";

const dataDir = process.env.REALBUD_DATA_DIR;
if (!dataDir) throw new Error("REALBUD_DATA_DIR is required.");
const [{ LoopManager }, { Desk }, { BrowserRuntime }, { createReiMorningRefresh }, portal] = await Promise.all([
  import("../../server/routines.ts"), import("../../server/desk.ts"), import("../../server/browser-runtime.ts"),
  import("../../server/rei-morning-refresh.ts"), import("../../server/testing/fictional-rei-portal.ts")]);

let now = Number(process.env.REI_CHILD_NOW ?? Date.parse("2026-10-06T07:00:00Z"));
const clock = () => now;
// Live-shaped: the Tenants grid renders 90 rows and loads more as its content scrolls.
const options = { gridBlock: 90 };
const mock = portal.fictionalReiPortal(options);
const runtime = new BrowserRuntime({ root: join(dataDir, "browser"), command: mock.command, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
// After a SIGKILL the helper's saved session lease is still there: browser work waits for the person's release.
let startup = "connected";
try { await runtime.connect(); await runtime.select("work"); } catch (error) { startup = String(error?.message ?? error); }
const desk = new Desk({ file: join(dataDir, "desk.json"), now: clock });
if (desk.snapshot().mode === "demo") desk.startLiveBook();
let timeoutMs;
const deps = () => ({ desk, runtime, browserId: async () => "work", account: async () => ({ marker: portal.FICTIONAL_BUSINESS }), today: async () => "2026-09-25",
  load: async () => portal.fictionalReiPack(), now: clock, pollMs: 0, workroom: join(dataDir, "work"), ...(timeoutMs ? { timeoutMs } : {}) });
const executed = [];
const manager = new LoopManager({ file: join(dataDir, "loops.json"), now: clock, timezone: "UTC", hostTimezone: "UTC",
  execute: async (loop, run) => {
    if (loop.id !== "rei-morning-refresh") return { ok: true, detail: "fictional" };
    executed.push(run.scheduledFor);
    return createReiMorningRefresh(deps()).run();
  } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (verb) => mock.calls.filter((call) => call[0] === verb).length;
const state = () => {
  const snap = desk.snapshot();
  return {
    now, executed: [...executed], startup,
    runs: manager.listRuns().filter((run) => run.loopId === "rei-morning-refresh").map(({ id, scheduledFor, status, manual, detail }) => ({ id, scheduledFor, status, manual, detail })),
    stamps: Object.fromEntries(snap.sources.filter((source) => source.id.startsWith("src-rei-")).map((source) => [source.id, source.lastCheckedAt])),
    properties: snap.properties.map((p) => ({ id: p.id, code: p.propertyCode ?? p.address, tenantName: p.tenantName, weeklyRentCents: p.weeklyRentCents, amountOwingCents: p.amountOwingCents ?? null,
      owner: p.owner?.name ?? null, differs: p.differs ?? [], rei: p.rei ?? null })),
    proposals: (snap.book?.bookProposals ?? []).map((card) => ({ id: card.id, address: card.address, tenantName: card.tenantName, weeklyRentCents: card.weeklyRentCents, origin: card.origin })),
    issues: (snap.book?.importIssues ?? []).map((issue) => `${issue.kind} ${issue.rawIdentity}`),
    portal: { observes: count("observe"), borrows: mock.calls.filter((call) => call[0] === "tab" && call[1] === "borrow").length, fills: count("fill"), scrolls: count("scroll"), clicks: count("click"), helpRequests: count("request-help"), effects: [...mock.effects] },
    memory: process.memoryUsage(),
  };
};

process.on("message", async (msg) => {
  try {
    if (msg.now !== undefined) now = msg.now;
    let result;
    if (msg.op === "portal") for (const [key, value] of Object.entries(msg.set ?? {})) { if (value === null) delete options[key]; else options[key] = value; }
    if (msg.op === "book") Object.assign(options, portal.fictionalBook(msg.count));
    if (msg.op === "sign-out") mock.signOut();
    // The person presses Stop browser work after a crash: the stale lease is released, then the browser reconnects.
    if (msg.op === "release") { await runtime.stop(); await runtime.connect(); await runtime.select("work"); startup = "released by the person"; }
    if (msg.op === "timeout") timeoutMs = msg.ms;
    if (msg.op === "enable") manager.patchClock("rei-morning-refresh", { enabled: true });
    if (msg.op === "run") result = manager.runNow("rei-morning-refresh");
    if (msg.op === "refresh") { const t = performance.now(); result = { ...(await createReiMorningRefresh(deps()).run()), ms: Math.round(performance.now() - t) }; }
    if (msg.op === "race") result = await Promise.all([createReiMorningRefresh(deps()).run(), createReiMorningRefresh(deps()).run()]);
    if (msg.op === "tick") await manager.tick();
    if (msg.op === "settle") while (manager.activeRun("rei-morning-refresh")) await sleep(10);
    if (msg.op === "wait-observes") while (count("observe") < msg.n) await sleep(5);
    if (msg.op === "approve-all") { const t = performance.now(); for (const card of desk.snapshot().book?.bookProposals ?? []) desk.allowBookProposal(card.id); result = { ms: Math.round(performance.now() - t) }; }
    if (msg.op === "edit") { const p = desk.snapshot().properties.find((item) => item.propertyCode === msg.code || item.address === msg.code); desk.editPropertyFacts(p.id, msg.facts); }
    if (msg.op === "add") desk.addProperty(msg.property);
    if (msg.op === "resolve") { const p = desk.snapshot().properties.find((item) => item.propertyCode === msg.code || item.address === msg.code); desk.resolveReiDiffer(p.id, msg.field, msg.pick); }
    if (msg.op === "close") { manager.close(); process.send({ ok: true }); process.exit(0); }
    process.send({ ok: true, result, state: state() });
  } catch (error) { process.send({ ok: false, error: String(error?.stack ?? error).split("\n").slice(0, 4).join(" | ") }); }
});
process.on("disconnect", () => { try { manager.close(); } catch { /* gone */ } process.exit(0); });
process.send({ ready: true });
