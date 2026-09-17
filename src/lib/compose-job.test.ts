import { describe, expect, it } from "vitest";

import { applyWorkflowToDraft, composeJobText, JOB_PRESETS, normalizeWorkflowHost, workflowBlockReason } from "./compose-job.ts";
import type { Recipe } from "@shared/contracts";

function draft(patch?: Partial<Recipe>): Recipe {
  return {
    id: "rec-1",
    title: "Check arrears",
    description: "old",
    steps: ["Open the report"],
    allowedOrigins: ["evil.example"],
    evidence: "unpaid list",
    capabilities: ["web-research"],
    limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
    status: "shadow",
    createdAt: 1,
    schedule: null,
    planApprovedAt: null,
    revision: 1,
    updatedAt: 1,
    approvedRevision: null,
    attachment: null,
    submitAcknowledgedAt: null,
    ...patch,
  };
}

describe("compose-job", () => {
  it("normalises a bank or PMS URL to a bare host", () => {
    expect(normalizeWorkflowHost("https://www.PropertyMe.com.au/report")).toBe("propertyme.com.au");
    expect(normalizeWorkflowHost("commbank.com.au:443/login")).toBe("commbank.com.au");
    expect(normalizeWorkflowHost("not a host")).toBeNull();
  });

  it("blocks a portal job with no site and a desk job with a bad host", () => {
    expect(
      workflowBlockReason({
        outcome: "Check overnight receipts",
        time: "07:30",
        weekdays: [1, 2, 3, 4, 5],
        site: "",
        action: "portal-read",
      }),
    ).toMatch(/website or bank/i);
    expect(
      workflowBlockReason({
        outcome: "Check overnight receipts",
        time: "07:30",
        weekdays: [1],
        site: "nope",
        action: "desk",
      }),
    ).toMatch(/hostname/i);
  });

  it("writes schedule, site, action, and the never-line into the job text", () => {
    const text = composeJobText({
      outcome: "Match overnight deposits to the book",
      time: "07:30",
      weekdays: [1, 2, 3, 4, 5],
      site: "https://www.commbank.com.au/business",
      action: "portal-read",
    });
    expect(text).toContain("Every weekday at 07:30.");
    expect(text).toContain("Site: commbank.com.au");
    expect(text).toContain("open the named site and read it");
    expect(text).toContain("Never send, pay, sign, or issue a notice.");
  });

  it("lets the form win over a model draft for clock, origin, and capabilities", () => {
    const next = applyWorkflowToDraft(draft(), {
      outcome: "Prepare courtesy wording",
      time: "16:00",
      weekdays: [5],
      site: "propertyme.com.au",
      action: "portal-prefill",
    });
    expect(next.schedule).toEqual({ time: "16:00", weekdays: [5] });
    expect(next.allowedOrigins).toEqual(["propertyme.com.au"]);
    expect(next.capabilities).toEqual([
      "read-book",
      "read-files",
      "web-research",
      "analyse",
      "draft",
      "portal-read",
      "portal-prefill",
    ]);
    expect(next.capabilities).not.toContain("portal-submit");
  });

  it("treats a pasted host in the outcome as the site", () => {
    expect(
      workflowBlockReason({
        outcome: "Read arrears on https://www.propertyme.com.au/login",
        time: "07:30",
        weekdays: [1],
        site: "",
        action: "desk",
      }),
    ).toBeNull();
    expect(JOB_PRESETS.map((preset) => preset.id)).toEqual([
      "bank",
      "pms",
      "inspections",
      "renewals",
      "levy",
      "maintenance",
    ]);
  });
});
