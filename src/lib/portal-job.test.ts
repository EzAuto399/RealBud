import { describe, expect, it } from "vitest";

import type { PortalSession } from "./desk";
import {
  AWAITING_REVIEW_COPY,
  latestSessionFor,
  findRecipeForLoop,
  isLiveCapableHost,
  nextRecipeStatus,
  recipeAttachment,
  recipeCanAttach,
  recipeHasPortalCapability,
  recipeNeedsPlanApproval,
  recipePlanApproved,
  recipePortalSiteLine,
  recipeSavedLine,
  recipeSourceLine,
  recipeSitesLine,
  recipeStatusChip,
  recipeHasSubmitCapability,
  recipeSubmitAcknowledged,
  alwaysAllowOfferLabel,
  portalRuleLabel,
  isPortalSiteRule,
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

  it("does not imply a live website when none was authorised", () => {
    expect(recipeSitesLine([])).toBe("No website is authorised");
    expect(recipeSourceLine({ allowedOrigins: [], capabilities: ["read-book", "read-files"] })).toBe(
      "Reads: current Desk book, private workroom files; no website login is authorised",
    );
    expect(recipeSourceLine({ allowedOrigins: ["propertyme.com.au"], capabilities: ["read-book"] })).toBe(
      "Reads only: propertyme.com.au",
    );
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
    expect(recipeNeedsPlanApproval({ planApprovedAt: null, revision: 1, approvedRevision: null })).toBe(true);
    expect(recipeNeedsPlanApproval({ planApprovedAt: 12, revision: 1, approvedRevision: 1 })).toBe(false);
    expect(recipeNeedsPlanApproval({ planApprovedAt: 12, revision: 2, approvedRevision: 1 })).toBe(true);
  });

  it("tells the PM a scheduled job waits on You after save", () => {
    expect(recipeSavedLine(false)).toBe("Saved on You → Bud's jobs");
    expect(recipeSavedLine(true)).toBe(
      "Saved. It joins the clock after you approve the plan on You → Bud's jobs.",
    );
  });
});

describe("portal site line and attach gate", () => {
  it("names the portal site and whether Bud only reads or also prefills", () => {
    expect(recipePortalSiteLine({ allowedOrigins: [], capabilities: ["read-book"] })).toBe(
      "No portal site on this job",
    );
    expect(
      recipePortalSiteLine({ allowedOrigins: ["strata.example.com"], capabilities: ["read-book"] }),
    ).toBe("No portal site on this job");
    expect(
      recipePortalSiteLine({
        allowedOrigins: ["strata.example.com"],
        capabilities: ["portal-read"],
      }),
    ).toBe("Site: strata.example.com · read-only");
    expect(
      recipePortalSiteLine({
        allowedOrigins: ["strata.example.com", "bank.example.com"],
        capabilities: ["portal-read", "portal-prefill"],
      }),
    ).toBe("Site: strata.example.com, bank.example.com · reads and prefills");
  });

  it("requires origins plus a portal capability before attach", () => {
    expect(recipeHasPortalCapability({ capabilities: ["read-book"] })).toBe(false);
    expect(recipeHasPortalCapability({ capabilities: ["portal-submit"] })).toBe(true);
    expect(recipeHasPortalCapability({ capabilities: ["portal-read"] })).toBe(true);
    expect(recipeHasSubmitCapability({ capabilities: ["portal-read"] })).toBe(false);
    expect(recipeHasSubmitCapability({ capabilities: ["portal-read", "portal-submit"] })).toBe(true);
    expect(recipeSubmitAcknowledged({})).toBeNull();
    expect(recipeSubmitAcknowledged({ submitAcknowledgedAt: 12 })).toBe(12);
    expect(alwaysAllowOfferLabel("Reading on vantagestrata.com.au")).toBe(
      "Always allow reading on vantagestrata.com.au",
    );
    expect(portalRuleLabel({ label: "old", surface: "portal-prefill", origin: "strata.example.com" })).toBe(
      "Prefill on strata.example.com",
    );
    expect(isPortalSiteRule({ surface: "portal-read", origin: "vantagestrata.com.au" })).toBe(true);
    expect(recipeCanAttach({ allowedOrigins: [], capabilities: ["portal-read"] })).toBe(false);
    expect(recipeCanAttach({ allowedOrigins: ["strata.example.com"], capabilities: ["portal-read"] })).toBe(true);
    expect(recipePlanApproved({ planApprovedAt: 1, revision: 2, approvedRevision: 1 })).toBe(false);
    expect(recipePlanApproved({ planApprovedAt: 1, revision: 2, approvedRevision: 2 })).toBe(true);
    expect(recipeAttachment({})).toBeNull();
    expect(
      recipeAttachment({ attachment: { attachedAt: 1_700_000_000_000, acknowledged: "human-login-and-submit" } }),
    ).toEqual({ attachedAt: 1_700_000_000_000, acknowledged: "human-login-and-submit" });
    expect(findRecipeForLoop([{ id: "job-1" } as never], "recipe-job-1")?.id).toBe("job-1");
    expect(isLiveCapableHost("darwin")).toBe(true);
    expect(isLiveCapableHost("linux")).toBe(false);
  });
});

describe("awaiting-review copy", () => {
  it("tells the PM to submit themselves and does not mention a lease button", () => {
    expect(AWAITING_REVIEW_COPY).toMatch(/review and submit in the portal yourself/i);
    expect(AWAITING_REVIEW_COPY).toMatch(/Bud/);
    expect(AWAITING_REVIEW_COPY).not.toMatch(/Hermes|\bAI\b|Allow Bud to submit/i);
  });
});
