import type { DeskBookView } from "../shared/contracts.ts";
import type { DeskFileV3, ProposalRevision } from "../shared/desk-v3.ts";

type ReviewAssistList = NonNullable<DeskBookView["reviewAssist"]>;
type ReviewAssist = ReviewAssistList[number];

interface AllowedHistory {
  proposalId: string;
  revision: ProposalRevision;
  at: number;
}

function historyKey(propertyId: string | undefined, kind: string): string | null {
  return propertyId ? `${propertyId}\u0000${kind}` : null;
}

function replaceKnownValue(body: string, value: string | undefined, token: string): string {
  const clean = value?.trim().toLocaleLowerCase("en-AU");
  if (!clean || clean.length < 2) return body;
  return body.split(clean).join(token);
}

/** Compare structure, not live facts. The mask is intentionally conservative:
 * it removes only the current property's known identity plus explicit AU dates
 * and currency values. Unrecognised changes remain changed. */
export function wordingPattern(body: string, book: DeskFileV3, propertyId: string): string {
  const property = book.properties.find((item) => item.id === propertyId);
  const tenant = book.contacts.find((item) => item.propertyId === propertyId && item.role === "tenant");
  let pattern = String(body ?? "").normalize("NFKC").toLocaleLowerCase("en-AU");
  pattern = replaceKnownValue(pattern, property?.address, "{address}");
  pattern = replaceKnownValue(pattern, tenant?.phone, "{phone}");
  pattern = replaceKnownValue(pattern, tenant?.name, "{name}");
  pattern = replaceKnownValue(pattern, tenant?.name.trim().split(/\s+/)[0], "{first-name}");
  pattern = pattern
    .replace(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/g, "{money}")
    .replace(/\b(?:[0-3]?\d)\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}\b/g, "{date}")
    .replace(/\s+/g, " ")
    .trim();
  return pattern;
}

function fieldState(previous: string | undefined, current: string): ReviewAssist["recipient"] {
  if (previous === undefined) return "first-time";
  return previous === current ? "same" : "changed";
}

function evidenceState(book: DeskFileV3, caseId: string, now: number): Pick<ReviewAssist, "evidence" | "observedAt"> {
  if (book.mode === "demo") return { evidence: "practice" };
  const item = book.cases.find((candidate) => candidate.id === caseId);
  const evidenceId = item?.evidenceIds?.[0];
  const evidence = evidenceId ? book.evidence.find((candidate) => candidate.id === evidenceId) : undefined;
  const current =
    item?.evidenceStatus === "current" &&
    (item.evidenceStaleAt ?? 0) > now &&
    evidence?.authority === "pms" &&
    evidence.observedAt != null &&
    evidence.staleAt > now;
  return {
    evidence: current ? "current" : "attention",
    ...(evidence?.observedAt != null ? { observedAt: evidence.observedAt } : item?.observedAt != null ? { observedAt: item.observedAt } : {}),
  };
}

/**
 * Derive a bounded review aid from existing authority records. This function
 * does not write preferences or alter a Proposal. Denials never teach it, and
 * the result never carries an approval or execution flag.
 */
export function deriveProposalReviewAssist(book: DeskFileV3, now: number): ReviewAssistList {
  const proposalById = new Map(book.proposals.map((proposal) => [proposal.id, proposal]));
  const caseById = new Map(book.cases.map((item) => [item.id, item]));
  const revisionById = new Map(book.proposalRevisions.map((revision) => [revision.id, revision]));
  const revisionCountByProposal = new Map<string, number>();
  for (const revision of book.proposalRevisions) {
    revisionCountByProposal.set(revision.proposalId, (revisionCountByProposal.get(revision.proposalId) ?? 0) + 1);
  }
  const historyByKey = new Map<string, AllowedHistory[]>();

  for (const decision of book.decisions) {
    if (decision.kind !== "allow") continue;
    const proposal = proposalById.get(decision.proposalId);
    const item = proposal ? caseById.get(proposal.caseId) : undefined;
    const revision = revisionById.get(decision.revisionId);
    const key = proposal ? historyKey(item?.propertyId, proposal.kind) : null;
    if (!proposal || !revision || !key) continue;
    const entries = historyByKey.get(key) ?? [];
    if (!entries.some((entry) => entry.proposalId === proposal.id)) {
      entries.push({ proposalId: proposal.id, revision, at: decision.at });
      historyByKey.set(key, entries);
    }
  }
  for (const entries of historyByKey.values()) entries.sort((a, b) => b.at - a.at);

  const output: ReviewAssistList = [];
  for (const proposal of book.proposals) {
    const item = caseById.get(proposal.caseId);
    if (item?.state !== "proposed" || !item.propertyId) continue;
    const current = revisionById.get(proposal.currentRevisionId);
    if (!current) continue;
    const history = historyByKey.get(historyKey(item.propertyId, proposal.kind) ?? "") ?? [];
    const previous = history[0];
    const recipient = fieldState(previous?.revision.to, current.to);
    const channel = fieldState(previous?.revision.channel, current.channel);
    const wording = previous
      ? wordingPattern(previous.revision.body, book, item.propertyId) === wordingPattern(current.body, book, item.propertyId)
        ? "same"
        : "changed"
      : "first-time";
    const editedOnCard = (revisionCountByProposal.get(proposal.id) ?? 0) > 1;
    const tenant = book.contacts.find((contact) => contact.propertyId === item.propertyId && contact.role === "tenant");
    const safeguardAttention = proposal.kind === "courtesy-rent" && Boolean(
      tenant?.safeguards.hardship ||
      tenant?.safeguards.dispute ||
      tenant?.safeguards.paymentArrangement ||
      tenant?.safeguards.doNotContact,
    );
    const moneyBoundary = proposal.kind === "levy-from-rent";
    const evidence = evidenceState(book, item.id, now);
    const familiar =
      history.length > 0 &&
      recipient === "same" &&
      channel === "same" &&
      wording === "same" &&
      !editedOnCard &&
      !safeguardAttention &&
      !moneyBoundary &&
      evidence.evidence !== "attention";
    const mode: ReviewAssist["mode"] =
      evidence.evidence === "attention" || editedOnCard || safeguardAttention || moneyBoundary || (history.length > 0 && !familiar)
        ? "attention"
        : familiar
          ? "familiar"
          : "first-time";
    output.push({
      proposalId: proposal.id,
      mode,
      priorAllowedCount: history.length,
      ...(previous ? { lastAllowedAt: previous.at } : {}),
      ...evidence,
      recipient,
      channel,
      wording,
      editedOnCard,
      safeguardAttention,
      moneyBoundary,
    });
  }
  return output;
}
