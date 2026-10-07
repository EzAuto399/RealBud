import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Loop, LoopRun } from "@/lib/routines";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("@/state/store", () => ({
  api: vi.fn(() => new Promise(() => {})),
  useStore: () => ({ state: store.state, dispatch: vi.fn(), refreshHermes: vi.fn() }),
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: vi.fn() }));

import { RoutinesPage } from "./RoutinesPage";
import { EMPTY_JOB_DRAFT } from "@/lib/job-plan";

const loop = (id: string, name: string, enabled = false): Loop => ({
  id: id as Loop["id"], name, description: "Fictional job", available: true, enabled,
  schedule: { type: "daily", time: "08:00", weekdays: [1] }, revision: 1, nextRunAt: null, evaluatorId: "fictional", evaluatorVersion: 1,
});
const ran = (loopId: string, loopName: string): LoopRun => ({
  id: `run-${loopId}`, loopId: loopId as LoopRun["loopId"], loopName, scheduledFor: 1, status: "completed", manual: true, createdAt: 1, finishedAt: 2,
});

/** First paint: /api/austin-pack has not answered yet. */
function firstPaint(loops: Loop[], loopRuns: LoopRun[] = []) {
  store.state = { loops, loopRuns, jobRuns: [], jobDraft: EMPTY_JOB_DRAFT, jobDraftBusy: false, scheduleRecovery: { active: false, detail: "" }, desk: null, bots: [], connected: true };
  return renderToStaticMarkup(createElement(RoutinesPage));
}

describe("Schedule before the Auston pack view is read", () => {
  it("leaves out off, never-run Auston jobs and shows a quiet loading line instead of rows that jump", () => {
    const html = firstPaint([
      loop("owner-letter", "Fictional owner letter", true),
      loop("weekly-bills", "Fictional weekly bills"),
      loop("maintenance-review", "Fictional maintenance checks", true),
      loop("inspection-draft", "Fictional inspection draft"),
    ], [ran("inspection-draft", "Fictional inspection draft")]);
    expect(html).toContain('aria-label="Open job: Fictional owner letter"');
    // On, or with run history: always shown, even before the read.
    expect(html).toContain('aria-label="Open job: Fictional maintenance checks"');
    expect(html).toContain('aria-label="Open job: Fictional inspection draft"');
    expect(html).not.toContain("Fictional weekly bills");
    expect(html).toContain('<p role="status" class="py-3 text-[14px] text-ink-muted">Loading jobs…</p>');
  });

  it("shows no loading line when no job is waiting on the read", () => {
    const html = firstPaint([loop("owner-letter", "Fictional owner letter", true), loop("weekly-bills", "Fictional weekly bills", true)]);
    expect(html).toContain('aria-label="Open job: Fictional weekly bills"');
    expect(html).not.toContain("Loading jobs…");
  });
});
