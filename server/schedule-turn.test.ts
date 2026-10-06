import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOP_CATALOG, LoopManager } from "./routines.ts";
import { scheduleJobsTurnContext } from "./schedule-turn.ts";
import type { Loop } from "../shared/contracts.ts";

const ZONE = "Australia/Brisbane";
const NOW = Date.parse("2026-10-07T00:00:00Z");

function officeLoops(): Loop[] {
  const manager = new LoopManager({ file: join(mkdtempSync(join(tmpdir(), "schedule-turn-")), "loops.json"), now: () => NOW,
    timezone: ZONE, hostTimezone: ZONE, execute: async () => ({ ok: true, detail: "" }) });
  return manager.listLoops();
}

describe("schedule jobs in the Work turn", () => {
  it("lists every Schedule job with its state, cadence and purpose", () => {
    const loops = officeLoops();
    const text = scheduleJobsTurnContext(loops, { timeZone: ZONE });
    for (const loop of LOOP_CATALOG) expect(text).toContain(`- ${loop.name}: `);
    expect(text).toContain("- Morning money check: on; weekdays at 7:30 am; next run");
    expect(text).toContain("- Weekly bills review: off (paused); Mondays at 8:00 am. Collects the reviewed Gmail scope, prepares saved bill reviews and checks expected arrivals.");
    expect(text).toContain("- Inspection draft: off (paused); first weekday of each month at 9:00 am.");
    expect(text).toContain("Supplier list check: off (paused); every 14 days at 8:15 am.");
    expect(text).toMatch(/Work cannot do any of that: never say a job was switched on/);
    expect(text).not.toContain("off (paused); Mondays at 8:00 am; next run");
  });

  it("is truthful when the office has no jobs", () => {
    const text = scheduleJobsTurnContext([], { timeZone: ZONE });
    expect(text).toContain("this office has no jobs on Schedule yet");
    expect(text).not.toMatch(/^- /m);
  });

  it("states plan approval, recovery and hidden placeholders like Schedule does", () => {
    const [base] = officeLoops();
    const loops: Loop[] = [
      { ...base!, id: "recipe-a", name: "Arrears letters", enabled: true, waitingForPlan: true },
      { ...base!, id: "recipe-unused", name: "Hidden placeholder", available: false },
    ];
    const text = scheduleJobsTurnContext(loops, { timeZone: ZONE, recovery: true });
    expect(text).toContain("Arrears letters: on, but waiting for its plan to be approved on Schedule");
    expect(text).toContain("paused for recovery");
    expect(text).not.toContain("next run");
    expect(text).not.toContain("Hidden placeholder");
  });

  it("stays bounded and redacts secret-shaped names", () => {
    const [base] = officeLoops();
    const many = Array.from({ length: 60 }, (_, i) => ({ ...base!, id: `recipe-${i}` as Loop["id"], name: `Job ${i} ${"x".repeat(500)}`, description: "y".repeat(5_000) }));
    const text = scheduleJobsTurnContext(many, { timeZone: ZONE });
    expect(text).toContain("…and 40 more on Schedule.");
    expect(text.length).toBeLessThan(10_000);
    const secret = scheduleJobsTurnContext([{ ...base!, name: "Key sk-ant-api03-fictionalfictionalfictionalfictional" }], { timeZone: ZONE });
    expect(secret).not.toContain("fictionalfictionalfictional");
  });
});
