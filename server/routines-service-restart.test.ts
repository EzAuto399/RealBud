// A supervised office service can be restarted during or after a scheduled run
// (the desktop watchdog brings a crashed service back). The restarted service
// must never run the same occurrence twice: the slot is claimed in the same
// durable write as its receipt, before the work starts, and a run that was
// open when the process died is marked interrupted, not resumed.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeFixture } from "./testing/private-fixture.ts";
import { LoopManager, type LoopManagerOptions } from "./routines.ts";

const dirs: string[] = [];
const managers: LoopManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of dirs.splice(0)) await removeFixture(dir);
});

function loopsFile() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-loops-restart-"));
  dirs.push(dir);
  return join(dir, "loops.json");
}

function open(options: LoopManagerOptions): LoopManager {
  const manager = new LoopManager(options);
  managers.push(manager);
  return manager;
}

/** A process death: timers stop and files close, nothing is settled or saved. */
function crash(manager: LoopManager) {
  manager.close();
  managers.splice(managers.indexOf(manager), 1);
}

// 2026-08-18 is a Tuesday; the morning check is due at 07:30 on weekdays.
const due = new Date(2026, 7, 18, 7, 30, 0).getTime();
const morningOnly = (manager: LoopManager) => manager.setEnabled("owner-letter", false);

describe("scheduled work across an office service restart", () => {
  it("does not run the occurrence again when the service dies mid-run", async () => {
    const file = loopsFile();
    let now = due - 60_000; // the service is up before the clock crosses 07:30
    // Never settles: the process dies while the work is in flight.
    const execute = vi.fn(() => new Promise<never>(() => {}));
    // The run deadline lets tick() return while the work stays open, as in production.
    const first = open({ file, now: () => now, execute, runDeadlineMs: 20 });
    morningOnly(first);
    await first.tick();
    now = due + 60_000;
    await first.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.listRuns()[0]).toMatchObject({ loopId: "morning-arrears", status: "running", scheduledFor: due });
    crash(first);

    now = due + 3 * 60_000; // the watchdog brings the service back a few minutes later
    const restarted = open({ file, now: () => now, execute });
    const [run] = restarted.listRuns().filter((item) => item.loopId === "morning-arrears");
    expect(run).toMatchObject({ status: "interrupted", scheduledFor: due });
    expect(run.detail).toMatch(/not resumed/i);
    await restarted.tick();
    await restarted.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(restarted.listRuns().filter((item) => item.loopId === "morning-arrears")).toHaveLength(1);
  });

  it("does not run a finished occurrence again after a restart, and still runs the next one", async () => {
    const file = loopsFile();
    let now = due - 60_000;
    const execute = vi.fn(async () => ({ ok: true, detail: "desk check done" }));
    const first = open({ file, now: () => now, execute });
    morningOnly(first);
    await first.tick();
    now = due + 60_000;
    await first.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    crash(first);

    now = due + 10 * 60_000;
    const restarted = open({ file, now: () => now, execute });
    await restarted.tick();
    expect(execute).toHaveBeenCalledTimes(1);

    now = due + 24 * 60 * 60_000 + 60_000; // Wednesday 07:31
    await restarted.tick();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(restarted.listRuns().filter((item) => item.loopId === "morning-arrears").map((item) => item.scheduledFor))
      .toEqual([due + 24 * 60 * 60_000, due]);
  });
});
