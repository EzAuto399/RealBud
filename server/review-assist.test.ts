import { describe, expect, it } from "vitest";

import { emptyV3, tenantContactIdFromProperty, tenancyIdFromProperty, type DeskFileV3 } from "../shared/desk-v3.ts";
import { shopDefaults } from "./desk-evaluate.ts";
import { deriveProposalReviewAssist, wordingPattern } from "./review-assist.ts";

const NOW = new Date(2026, 7, 24, 8, 0, 0).getTime();

function reviewBook(): DeskFileV3 {
  const book = emptyV3({ name: "Test agency", timezone: "Australia/Brisbane", jurisdictions: ["QLD"] });
  book.mode = "live";
  book.properties.push({
    id: "prop-oak",
    address: "12 Oak St, Dickson ACT",
    status: "active",
    options: shopDefaults(),
  });
  book.tenancies.push({ id: tenancyIdFromProperty("prop-oak"), propertyId: "prop-oak", status: "current", weeklyRentCents: 62_000 });
  book.contacts.push({
    id: tenantContactIdFromProperty("prop-oak"),
    propertyId: "prop-oak",
    tenancyId: tenancyIdFromProperty("prop-oak"),
    role: "tenant",
    name: "Sam Nguyen",
    phone: "0400 111 222",
    safeguards: {
      hardship: false,
      dispute: false,
      paymentArrangement: false,
      doNotContact: false,
      preferredChannel: "sms",
    },
  });
  book.sources.push({ id: "src-pms", authority: "pms", collector: "csv", label: "PMS export", stableKey: "pms", freshnessMs: 43_200_000 });
  book.evidence.push({
    id: "ev-current",
    authority: "pms",
    collector: "csv",
    sourceId: "src-pms",
    sourceRecordKey: "oak-current",
    observedAt: NOW - 60_000,
    ingestedAt: NOW - 60_000,
    staleAt: NOW + 60_000,
    propertyId: "prop-oak",
    tenancyId: tenancyIdFromProperty("prop-oak"),
    payload: { coverage: "observed", daysSinceDue: 3, rentLanded: false, levyPaid: false },
  });
  book.cases.push(
    {
      id: "case-prior",
      kind: "money-arrears",
      state: "approved",
      propertyId: "prop-oak",
      tenancyId: tenancyIdFromProperty("prop-oak"),
      proposalId: "proposal-prior",
      createdAt: NOW - 8 * 86_400_000,
      updatedAt: NOW - 7 * 86_400_000,
    },
    {
      id: "case-current",
      kind: "money-arrears",
      state: "proposed",
      propertyId: "prop-oak",
      tenancyId: tenancyIdFromProperty("prop-oak"),
      proposalId: "proposal-current",
      evidenceIds: ["ev-current"],
      evidenceStatus: "current",
      evidenceStaleAt: NOW + 60_000,
      observedAt: NOW - 60_000,
      createdAt: NOW,
      updatedAt: NOW,
    },
  );
  book.proposals.push(
    {
      id: "proposal-prior",
      caseId: "case-prior",
      kind: "courtesy-rent",
      currentRevisionId: "revision-prior",
      periodDueAt: NOW - 10 * 86_400_000,
      createdAt: NOW - 8 * 86_400_000,
    },
    {
      id: "proposal-current",
      caseId: "case-current",
      kind: "courtesy-rent",
      currentRevisionId: "revision-current",
      periodDueAt: NOW - 3 * 86_400_000,
      createdAt: NOW,
    },
  );
  book.proposalRevisions.push(
    {
      id: "revision-prior",
      proposalId: "proposal-prior",
      channel: "sms",
      to: "Sam Nguyen · 0400 111 222",
      body: "Hi Sam, rent for 12 Oak St, Dickson ACT was due 17 Aug 2026 at $620.00/wk. This is not a formal notice and does not start any notice period.",
      hash: "prior",
      createdAt: NOW - 8 * 86_400_000,
    },
    {
      id: "revision-current",
      proposalId: "proposal-current",
      channel: "sms",
      to: "Sam Nguyen · 0400 111 222",
      body: "Hi Sam, rent for 12 Oak St, Dickson ACT was due 24 Aug 2026 at $620.00/wk. This is not a formal notice and does not start any notice period.",
      hash: "current",
      createdAt: NOW,
    },
  );
  book.decisions.push({
    id: "decision-prior",
    proposalId: "proposal-prior",
    revisionId: "revision-prior",
    kind: "allow",
    actorId: "pm",
    at: NOW - 7 * 86_400_000,
  });
  return book;
}

describe("proposal review assist", () => {
  it("recognises only a prior explicit Allow with the same conservative wording pattern", () => {
    const book = reviewBook();
    expect(wordingPattern(book.proposalRevisions[0]!.body, book, "prop-oak")).toBe(
      wordingPattern(book.proposalRevisions[1]!.body, book, "prop-oak"),
    );
    expect(deriveProposalReviewAssist(book, NOW)).toEqual([
      expect.objectContaining({
        proposalId: "proposal-current",
        mode: "familiar",
        priorAllowedCount: 1,
        evidence: "current",
        recipient: "same",
        channel: "same",
        wording: "same",
        editedOnCard: false,
      }),
    ]);
  });

  it("never learns from a denial or from another property or draft kind", () => {
    const denied = reviewBook();
    denied.decisions[0]!.kind = "deny";
    expect(deriveProposalReviewAssist(denied, NOW)[0]).toMatchObject({ mode: "first-time", priorAllowedCount: 0 });

    const differentKind = reviewBook();
    differentKind.proposals[0]!.kind = "owner-letter";
    expect(deriveProposalReviewAssist(differentKind, NOW)[0]).toMatchObject({ mode: "first-time", priorAllowedCount: 0 });
  });

  it("expands review when wording, safeguards or the current card changed", () => {
    const wordingChanged = reviewBook();
    wordingChanged.proposalRevisions[1]!.body = "A materially different message.";
    expect(deriveProposalReviewAssist(wordingChanged, NOW)[0]).toMatchObject({ mode: "attention", wording: "changed" });

    const safeguarded = reviewBook();
    safeguarded.contacts[0]!.safeguards.paymentArrangement = true;
    expect(deriveProposalReviewAssist(safeguarded, NOW)[0]).toMatchObject({ mode: "attention", safeguardAttention: true });

    const edited = reviewBook();
    edited.proposalRevisions.push({
      ...edited.proposalRevisions[1]!,
      id: "revision-current-edit",
      body: "PM edit",
      hash: "edited",
    });
    edited.proposals[1]!.currentRevisionId = "revision-current-edit";
    expect(deriveProposalReviewAssist(edited, NOW)[0]).toMatchObject({ mode: "attention", editedOnCard: true });
  });

  it("never fast-tracks stale evidence or a levy/trust-boundary flag", () => {
    const stale = reviewBook();
    stale.cases[1]!.evidenceStaleAt = NOW - 1;
    expect(deriveProposalReviewAssist(stale, NOW)[0]).toMatchObject({ mode: "attention", evidence: "attention" });

    const levy = reviewBook();
    levy.proposals[0]!.kind = "levy-from-rent";
    levy.proposals[1]!.kind = "levy-from-rent";
    expect(deriveProposalReviewAssist(levy, NOW)[0]).toMatchObject({ mode: "attention", moneyBoundary: true });
  });
});
