import { describe, expect, it } from "vitest";

import type { PortalSession } from "./desk";
import {
  AWAITING_REVIEW_COPY,
  latestSessionFor,
  nextRecipeStatus,
  recipeNeedsPlanApproval,
  recipeSavedLine,
  recipeSitesLine,
  recipeStatusChip,
  sessionSummaryLine,
} from "./portal-job";

function session(partial: Partial<PortalSession> = {}): PortalSession {
  return {
    id: "s1",
    recipeId: "r1",
    state: "done",
    shadow: true,
    allowedOrigins: ["propertyme.com.au"],
    submitLease: null,
    evidence: [
      { at: 1, note: "opened arrears" },
      { at: 2, note: "read late rows" },
      { at: 3, note: "held two" },
      { at: 4, note: "skipped one" },
      { at: 5, note: "closed" },
    ],
    detail: "Shadow run — nothing was browsed or clicked.",
    startedAt: 1_700_000_000_000,
    ...partial,
  };
}

describe("recipeSitesLine", () => {
  it("names the allowed sites", () => {
    expect(recipeSitesLine(["propertyme.com.au"])).toBe("Only these sites: propertyme.com.au");
    expect(recipeSitesLine(["propertyme.com.au", "portal.example.com"])).toBe(
      "Only these sites: propertyme.com.au, portal.example.com",
    );
  });

  it("says Bud narrates from words when no site was named", () => {
    expect(recipeSitesLine([])).toBe("No websites named — Bud narrates from your words only");
  });
});

describe("sessionSummaryLine", () => {
  it("formats a shadow run the way You → Bud's jobs shows it", () => {
    const now = 1_700_000_000_000 + 2 * 60_000;
    expect(sessionSummaryLine(session(), now)).toBe("Shadow run · done · 5 notes · 2 min ago");
  });

  it("uses Run when the session is not a shadow check", () => {
    const now = 1_700_000_000_000;
    expect(sessionSummaryLine(session({ shadow: false, evidence: [], state: "failed" }), now)).toBe(
      "Run · failed · 0 notes · just now",
    );
  });

  it("prefers endedAt for the relative stamp", () => {
    const now = 1_700_000_120_000;
    expect(sessionSummaryLine(session({ startedAt: 1_700_000_000_000, endedAt: 1_700_000_060_000, evidence: [] }), now)).toBe(
      "Shadow run · done · 0 notes · 1 min ago",
    );
  });
});

describe("latestSessionFor", () => {
  it("returns the newest session for that job", () => {
    const older = session({ id: "old", startedAt: 10 });
    const newer = session({ id: "new", startedAt: 20 });
    const other = session({ id: "other", recipeId: "r2", startedAt: 99 });
    expect(latestSessionFor([older, other, newer], "r1")?.id).toBe("new");
    expect(latestSessionFor([other], "r1")).toBeUndefined();
  });
});

describe("recipe status helpers", () => {
  it("uses hold / agency / muted chips and toggles pause", () => {
    expect(recipeStatusChip("shadow")).toMatchObject({ label: "Shadow" });
    expect(recipeStatusChip("active")).toMatchObject({ label: "Active" });
    expect(recipeStatusChip("paused")).toMatchObject({ label: "Paused" });
    expect(nextRecipeStatus("shadow")).toBe("active");
    expect(nextRecipeStatus("paused")).toBe("active");
    expect(nextRecipeStatus("active")).toBe("paused");
  });
});

describe("plan approval helpers", () => {
  it("holds an unapproved plan and stays calm once stamped", () => {
    expect(recipeNeedsPlanApproval({ planApprovedAt: null })).toBe(true);
    expect(recipeNeedsPlanApproval({ planApprovedAt: 12 })).toBe(false);
  });

  it("tells the PM a scheduled job waits on You after save", () => {
    expect(recipeSavedLine(false)).toBe("Saved on You → Bud's jobs");
    expect(recipeSavedLine(true)).toBe(
      "Saved. It joins the clock after you approve the plan on You → Bud's jobs.",
    );
  });
});

describe("awaiting-review copy", () => {
  it("tells the PM to submit themselves and does not mention a lease button", () => {
    expect(AWAITING_REVIEW_COPY).toMatch(/review and submit in the portal yourself/i);
    expect(AWAITING_REVIEW_COPY).toMatch(/Bud/);
    expect(AWAITING_REVIEW_COPY).not.toMatch(/Hermes|\bAI\b|Allow Bud to submit/i);
  });
});
