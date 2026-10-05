// Child for the chaos harness: the real LoopManager (server/routines.ts) on a
// file under the marked root, driven by a fixture clock the parent moves
// over IPC. The running service has no injectable clock; this is the
// clock seam the code offers.
// Env from the parent: REALBUD_DATA_DIR. Messages: {op:"open"|"tick"|"set"|"restart"|"state"|"close", now?}
import { join } from "node:path";

const { LoopManager } = await import("../../server/routines.ts");
const file = join(process.env.REALBUD_DATA_DIR, "loops.json");
let now = 0;
const executed = [];
let manager = null;
const open = () => new LoopManager({ file, now: () => now, timezone: "UTC", hostTimezone: "UTC",
  execute: async (loop, run) => { executed.push({ loopId: loop.id, scheduledFor: run.scheduledFor, manual: run.manual, at: now }); return { ok: true, detail: "Prepared (fictional)" }; } });
const state = () => ({ now, executed: [...executed],
  runs: manager.listRuns().map((r) => ({ loopId: r.loopId, scheduledFor: r.scheduledFor, status: r.status, manual: r.manual })),
  loops: manager.listLoops().map((l) => ({ id: l.id, enabled: l.enabled, nextRunAt: l.nextRunAt, schedule: l.schedule })),
  recovery: manager.recovery?.active ?? false });

process.on("message", async (msg) => {
  try {
    if (msg.now !== undefined) now = msg.now;
    if (msg.op === "open") { manager = open(); for (const id of msg.enable ?? []) manager.patchClock(id, { enabled: true }); }
    if (msg.op === "restart") { manager.close(); manager = open(); }
    if (msg.op === "tick") await manager.tick();
    if (msg.op === "close") { manager.close(); process.send({ ok: true }); process.exit(0); }
    process.send({ ok: true, state: state() });
  } catch (e) { process.send({ ok: false, error: String(e?.message ?? e), status: e?.status }); }
});
process.on("disconnect", () => { try { manager?.close(); } catch {} process.exit(0); });
process.send({ ready: true });
