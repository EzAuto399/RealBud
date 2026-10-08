import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Loop, LoopRun } from "@/lib/routines";
import { buildScheduleRows } from "@/lib/schedule-rows";
import { stageState, type FixtureStage } from "../setup-stages.fixture";

vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

import { FlaggedReceipt, JobDrawer, LoopDetail, NewMailSwitch, readNewMailState } from "./JobDrawer";
import { JobList } from "./JobList";

const NOW = Date.UTC(2026, 9, 0, 23, 0);
const loop = (patch: Partial<Loop> = {}): Loop => ({
  id: "weekly-bills", name: "Weekly bills review", description: "Fictional bills review", available: true, enabled: false,
  schedule: { type: "daily", time: "08:00", weekdays: [1] }, revision: 3, nextRunAt: null, evaluatorId: "fictional", evaluatorVersion: 1, ...patch,
});
const run = (patch: Partial<LoopRun> = {}): LoopRun => ({
  id: "run-1", loopId: "weekly-bills", loopName: "Weekly bills review", scheduledFor: NOW - 60_000, status: "completed", manual: true,
  createdAt: NOW - 60_000, detail: "Fictional prepared summary", ...patch,
});
const detail = (props: Partial<Parameters<typeof LoopDetail>[0]> = {}) => renderToStaticMarkup(createElement(LoopDetail, {
  loop: loop(), runs: [], next: "Paused", busy: false, disabled: false, recovery: false, nowMs: NOW, runStartedAt: null,
  timingOpen: false, deskCount: () => 0, onTimingOpen: () => {}, onRun: () => {}, onToggle: () => {}, onRetune: () => {},
  onOpenSetup: () => {}, onOpenDesk: () => {}, registerCloseGuard: () => () => {}, ...props,
}));

/** The opening tag of the first button whose text ends with `label`. */
const buttonTag = (html: string, label: string) => {
  const match = [...html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g)].find((item) => item[0].endsWith(`${label}</button>`));
  expect(match, label).toBeDefined();
  return match![0].slice(0, match![0].indexOf(">") + 1);
};
const firstSummary = (html: string) => /<summary[^>]*>([^<]*)/.exec(html)?.[1] ?? "";

describe("job list", () => {
  it("names the list and each row, with one attention word and one action and no healthy chip or quotation", () => {
    const rows = buildScheduleRows({
      loops: [loop({ id: "owner-letter", name: "Owner letter", enabled: true, nextRunAt: NOW + 86_400_000 })],
      recipes: [], jobRuns: [], nowMs: NOW, timeZone: "Australia/Brisbane",
      loopRuns: [run({ loopId: "owner-letter", loopName: "Owner letter", status: "failed", detail: "Fictional engine commentary" })],
    });
    const html = renderToStaticMarkup(createElement(JobList, { rows, nowMs: NOW, onOpen: () => {}, onAction: () => {} }));
    expect(html).toContain('aria-label="Jobs"');
    expect(html).toContain('aria-label="Open job: Owner letter"');
    expect(html).toContain('aria-label="Review failed run: Owner letter"');
    expect(html).toContain(">Next run<");
    expect(html).toContain("Last run 1 min ago");
    expect(html).not.toContain(">Timing<");
    expect(html).toContain(">Failed<");
    expect(html).not.toContain(">On<");
    expect(html).not.toContain("Fictional engine commentary");
    expect(html).not.toContain("“");
    expect(renderToStaticMarkup(createElement(JobList, { rows: buildScheduleRows({ loops: [loop({ id: "owner-letter", name: "Owner letter", enabled: true, nextRunAt: NOW + 86_400_000 })], recipes: [], jobRuns: [], loopRuns: [], nowMs: NOW, timeZone: "Australia/Brisbane" }), nowMs: NOW, onOpen: () => {}, onAction: () => {} }))).toContain("Never run");
  });

  it("names the review action after the row's status and keeps Review result for a plain waiting result", () => {
    const action = (status: LoopRun["status"]) => {
      const rows = buildScheduleRows({ loops: [loop()], recipes: [], jobRuns: [], nowMs: NOW, loopRuns: [run({ status })] });
      const html = renderToStaticMarkup(createElement(JobList, { rows, onOpen: () => {}, onAction: () => {} }));
      return /aria-label="((?!Open job)[^"]*): Weekly bills review"/.exec(html)?.[1];
    };
    expect(action("failed")).toBe("Review failed run");
    expect(action("missed")).toBe("Review missed run");
    expect(action("partial")).toBe("Review incomplete run");
    expect(action("interrupted")).toBe("Review interrupted run");
    expect(action("awaiting-approval")).toBe("Review result");
  });

  it("disables a changing row action during recovery", () => {
    const rows = buildScheduleRows({ loops: [loop({ id: "owner-letter", name: "Owner letter", enabled: true, nextRunAt: NOW + 3_600_000 })], recipes: [], loopRuns: [], jobRuns: [], nowMs: NOW, recovery: true });
    const html = renderToStaticMarkup(createElement(JobList, { rows, onOpen: () => {}, onAction: () => {} }));
    expect(buttonTag(html, "Run now")).toContain('disabled=""');
  });

  it("separates active work from decisions while retaining the exact job action", () => {
    const rows = buildScheduleRows({
      loops: [loop({ id: "owner-letter", name: "Inspection review", enabled: true }), loop()],
      recipes: [], jobRuns: [], nowMs: NOW, timeZone: "Australia/Brisbane",
      loopRuns: [run({ loopId: "owner-letter", status: "running" }), run({ status: "failed" })],
    });
    const html = renderToStaticMarkup(createElement(JobList, { rows, onOpen: () => {}, onAction: () => {} }));
    expect(html).toContain('data-section="running"');
    expect(html).toContain('data-section="attention"');
    expect(html.indexOf('data-section="running"')).toBeLessThan(html.indexOf('data-section="attention"'));
    expect(html).toContain('aria-label="View progress: Inspection review"');
    expect(html).toContain('aria-label="Review failed run: Weekly bills review"');
    expect(html).toContain("Review the failed run before trying again.");
    expect(html).not.toContain('data-section="paused"');
  });
});

describe("job drawer", () => {
  it("is a labelled modal dialog with a named close control", () => {
    const html = renderToStaticMarkup(createElement(JobDrawer, { title: "Owner letter", onClose: () => {}, children: "Body" }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Close Owner letter"');
  });

  it("keeps the weekly bills cadence editor and the paused run exception in the timing section", () => {
    const html = detail();
    expect(html).toContain('id="routine-weekly-bills"');
    expect(firstSummary(html)).toMatch(/^Timing · /);
    expect(html).toContain('aria-label="Weekly bills review cadence"');
    expect(html).toContain('aria-label="Weekly bills review time of day"');
    expect(html).toContain('aria-label="Weekly bills review days"');
    expect(html).not.toContain('aria-label="Weekly bills review first date"');
    expect(buttonTag(html, "Run now")).not.toContain('disabled=""');
    const interval = detail({ loop: loop({ schedule: { type: "daily", time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6], intervalDays: 3, anchorDate: "2026-10-05" } }) });
    expect(interval).toContain('aria-label="Weekly bills review first date"');
    expect(interval).not.toContain('aria-label="Weekly bills review days"');
  });

  it("does not offer Run now for another paused job and blocks changes in recovery", () => {
    expect(buttonTag(detail({ loop: loop({ id: "owner-letter", name: "Owner letter" }) }), "Run now")).toContain('disabled=""');
    const held = detail({ recovery: true, disabled: true });
    expect(held).toContain("Paused for recovery. Saved results are still available.");
    expect(buttonTag(held, "Run now")).toContain('disabled=""');
    expect(buttonTag(held, "Switch on")).toContain('disabled=""');
  });

  it("holds switching on with the host's reason and its fix, instead of a switch the host would refuse", () => {
    const switchGate = { on: false, reason: "Before Weekly bills review can switch on, finish Agency workflow setup and approve it there.", actionLabel: "Open Agency workflow setup", target: "schedule-agency" as const };
    const html = detail({ switchGate });
    const tag = buttonTag(html, "Switch on");
    expect(tag).toContain('disabled=""');
    const described = /aria-describedby="([^"]+)"/.exec(tag)?.[1];
    expect(described).toBeTruthy();
    expect(html).toContain(`<p id="${described}" class="text-[13px] text-hold">${switchGate.reason}</p>`);
    expect(html).toContain(">Open Agency workflow setup</button>");
    // Once on, the reason no longer holds Pause.
    const on = detail({ switchGate, loop: loop({ enabled: true }) });
    expect(buttonTag(on, "Pause")).not.toContain('disabled=""');
    expect(on).not.toContain(switchGate.reason);
  });

  it("reads setup's gates at each stage: link first, then the pack's own need, then an REI sign-out for the work that reads REI", () => {
    const gated = (stage: FixtureStage, id: Loop["id"] = "rei-supplier-check", name = "REI supplier check") => {
      const { gates } = stageState(stage);
      return detail({ loop: loop({ id, name }), switchGate: gates.switchOn(id), runGate: gates.runNow(id) });
    };
    // Stage 0, an unlinked computer: connect first, with the link-code fix and the owner request, never "Finish Bud's installation".
    const unlinked = gated(0);
    expect(buttonTag(unlinked, "Switch on")).toContain('disabled=""');
    expect(buttonTag(unlinked, "Run now")).toContain('disabled=""');
    expect(unlinked).toContain("Connect this computer to your office first.");
    expect(unlinked).toContain(">Enter link code</button>");
    expect(unlinked).toContain('aria-label="Copy request for your owner"');
    expect(unlinked).not.toContain("Finish Bud");
    // One sentence when both are held for the same reason.
    expect(unlinked.match(/Connect this computer to your office first\./g)).toHaveLength(1);
    // Stage 1, Bud still setting itself up: its progress is the fix.
    const installing = gated(1);
    expect(buttonTag(installing, "Switch on")).toContain('disabled=""');
    expect(installing).toContain("Bud is setting itself up — step 2 of 4");
    expect(installing).toContain(">See progress</button>");
    // Stage 3, REI never signed in: the pack's own need for this workflow holds its switch.
    const rei = gated(3);
    expect(buttonTag(rei, "Switch on")).toContain('disabled=""');
    expect(rei).toContain("Before REI supplier check: In Bills, Maintenance checks, choose Refresh from REI to save the supplier list.");
    // Mail work in the same pack is not held by REI.
    expect(buttonTag(gated(3, "weekly-bills", "Weekly bills"), "Switch on")).not.toContain('disabled=""');
    // Ready, then signed out of REI: only the run that reads REI waits, with REI's own sign-in as the fix.
    expect(buttonTag(gated("ready"), "Switch on")).not.toContain('disabled=""');
    const signedOut = detail({ loop: loop({ id: "rei-supplier-check", name: "REI supplier check", enabled: true }), runGate: stageState("reiSignedOut").gates.runNow("rei-supplier-check") });
    expect(buttonTag(signedOut, "Run now")).toContain('disabled=""');
    expect(signedOut).toContain("REI signed you out. Sign in so Bud can read REI today.");
    expect(signedOut).toContain(">Sign in to REI</button>");
    expect(buttonTag(signedOut, "Pause")).not.toContain('disabled=""');
  });

  it("keeps Pause/Resume focusable while its change is saving, so keyboard focus is not dropped", () => {
    // A focused button that becomes disabled loses focus to <body>; Escape then cannot close the drawer.
    for (const enabled of [false, true]) {
      const tag = buttonTag(detail({ loop: loop({ enabled }), busy: true, disabled: true }), enabled ? "Pause" : "Switch on");
      expect(tag).not.toContain('disabled=""');
      expect(tag).toContain('aria-disabled="true"');
    }
    expect(buttonTag(detail(), "Switch on")).not.toContain('aria-disabled="');
  });

  it("switches on a job the clock never ran, and resumes one it has run", () => {
    expect(detail()).toContain('title="Switch on this job"');
    expect(buttonTag(detail({ runs: [run()] }), "Switch on")).toBeTruthy();
    expect(buttonTag(detail({ runs: [run({ manual: false })] }), "Resume")).toBeTruthy();
    expect(detail({ runs: [run({ manual: false })] })).not.toContain(">Switch on</button>");
  });

  it("routes Morning priorities timing to agency setup instead of the generic timing editor", () => {
    const html = detail({ loop: loop({ id: "inbound-triage", name: "Morning priorities" }) });
    expect(html).toContain("Open agency workflow setup");
    expect(html).not.toContain('aria-label="Morning priorities time of day"');
  });

  it("shows a flagged receipt collapsed at the top and acknowledges it only when opened", () => {
    const onReviewed = vi.fn();
    const failed = run({ id: "older", status: "failed", detail: "Fictional failure detail" });
    const html = renderToStaticMarkup(createElement(FlaggedReceipt, { word: "Failed", loopRun: failed, onReviewed }));
    expect(html).toContain('aria-label="Result to review"');
    expect(html).toMatch(/<details>/);
    expect(html.replace(/<[^>]+>/g, "")).toContain("Review this result · Failed");
    expect(html).toContain("Fictional failure detail");
    expect(onReviewed).not.toHaveBeenCalled();
    const job = renderToStaticMarkup(createElement(FlaggedReceipt, { word: "Unverified", onReviewed, jobRun: {
      id: "job-1", jobId: "site", jobTitle: "Fictional site", jobRevision: 1, mode: "attended", status: "completed", trigger: "manual", scheduledFor: NOW,
      idempotencyKey: "k", attempt: 1, spec: { title: "Fictional site", description: "", steps: [], allowedOrigins: [], evidence: "", capabilities: ["portal-read"], limits: { maxRuntimeMinutes: 1, maxTurns: 1 } },
      evidence: [], approvalRequests: [], detail: "Fictional site detail", createdAt: NOW,
    } }));
    expect(job).toContain("Check the result on the website.");
    expect(job).toContain("Result unverified");
    expect(job).toContain("Check the website for any changes made during this run before trying again.");
    expect(job).not.toContain("Nothing was sent, submitted, or paid by this result.");
    expect(onReviewed).not.toHaveBeenCalled();
    const detailHtml = detail({ runs: [failed], flaggedRunId: "older" });
    expect(detailHtml).toContain("This result is at the top, waiting for your review.");
    expect(detailHtml).not.toContain("Fictional failure detail");
  });

  it("shows the exact flagged result immediately for an explicit review, without acknowledging during server rendering", () => {
    const onReviewed = vi.fn();
    const html = renderToStaticMarkup(createElement(FlaggedReceipt, {
      word: "Failed",
      loopRun: run({ id: "older-failed-result", status: "failed", detail: "Fictional exact result needing review" }),
      initiallyOpen: true,
      onReviewed,
    }));
    expect(html).toContain('<details open="">');
    expect(html).toContain("Fictional exact result needing review");
    expect(html).toContain("Nothing was sent, submitted, or paid.");
    expect(onReviewed).not.toHaveBeenCalled();
  });

  it("keeps bank review reachable as manual work without run, pause or timing", () => {
    const bank = loop({ id: "bank-references", name: "Bank reference review", available: false, schedule: { type: "daily", time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6], intervalDays: 2, anchorDate: "2026-10-02" } });
    const rows = buildScheduleRows({ loops: [bank], recipes: [], loopRuns: [], jobRuns: [], nowMs: NOW, timeZone: "Australia/Brisbane" });
    const list = renderToStaticMarkup(createElement(JobList, { rows, onOpen: () => {}, onAction: () => {} }));
    expect(list).toContain('aria-label="Review bank file: Bank reference review"');
    expect(list).toContain(">On demand<");
    const html = detail({ loop: bank, manualOnly: true, next: "On demand" });
    expect(html).toContain("Prepare bank references");
    expect(html).not.toContain("Run now");
    expect(html).not.toContain("Timing · ");
    expect(html).not.toContain("Resume");
  });
});

describe("new mail switch", () => {
  const html = (initial?: Parameters<typeof NewMailSwitch>[0]["initial"]) => renderToStaticMarkup(createElement(NewMailSwitch, { loopId: "inbound-triage", initial }));
  const switchTag = (markup: string) => /<button[^>]*role="switch"[^>]*>/.exec(markup)![0];

  it("shows only on Morning priorities, with its hint", () => {
    const triage = detail({ loop: loop({ id: "inbound-triage", name: "Morning priorities" }) });
    expect(triage).toContain('aria-label="New mail"');
    expect(triage).toContain("Also check when new mail arrives");
    expect(triage).toContain("Usually within 15 minutes. The morning run still happens.");
    // Before the saved setting loads, the switch cannot be pressed.
    expect(switchTag(triage)).toContain('disabled=""');
    expect(detail()).not.toContain("Also check when new mail arrives");
  });

  it("is available and off", () => {
    const tag = switchTag(html({ enabled: false, available: true }));
    expect(tag).toContain('aria-checked="false"');
    expect(tag).not.toContain('disabled=""');
    expect(tag).toContain('aria-labelledby="inbound-triage-new-mail-label"');
  });

  it("is unavailable with the plain reason", () => {
    const markup = html({ enabled: false, available: false, reason: "Connect Gmail in Connected apps first." });
    expect(switchTag(markup)).toContain('disabled=""');
    expect(markup).toContain("Connect Gmail in Connected apps first.");
  });

  it("is on, and stays pressable to turn off when it needs attention", () => {
    expect(switchTag(html({ enabled: true, available: true }))).toContain('aria-checked="true"');
    const markup = html({ enabled: true, available: false, reason: "Reconnect Gmail in Connected apps. The morning run still happens." });
    expect(switchTag(markup)).toContain('aria-checked="true"');
    expect(switchTag(markup)).not.toContain('disabled=""');
    expect(markup).toContain("Reconnect Gmail in Connected apps.");
  });

  it("treats a malformed answer as unreadable", () => {
    expect(readNewMailState({ enabled: "yes", available: true })).toBeNull();
    expect(readNewMailState({ enabled: true, available: true, reason: 7 })).toBeNull();
    expect(readNewMailState({ loopId: "inbound-triage", enabled: true, available: false, reason: "Fictional reason" })).toEqual({ enabled: true, available: false, reason: "Fictional reason" });
  });
});
