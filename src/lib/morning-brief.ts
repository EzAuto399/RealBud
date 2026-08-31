import type { DeskSnapshot, Draft, Escalation, WorkItem } from "../../shared/contracts.ts";

export type MorningTone = "agency" | "hold" | "danger" | "muted";

export type MorningAttention = "unchecked" | "quiet" | "needs-you" | "held" | "licensee";

export interface MorningAddress {
  propertyId: string;
  address: string;
  attention: MorningAttention;
  label: string;
  tone: MorningTone;
}

export interface MorningBrief {
  lastRunAt: number | null;
  addresses: MorningAddress[];
  checkedCount: number;
  needsYou: number;
  held: number;
  licensee: number;
  inboxConnected: false;
  inboxLabel: string;
  inboxDetail: string;
  headline: string;
}

export type MorningSnap = Pick<
  DeskSnapshot,
  "properties" | "lastRunAt" | "results" | "drafts" | "escalations" | "workItems" | "hands" | "handsDetail"
>;

/** Live Recheck on the Demo book missed the worker. Training copy starts with "Demo book". */
export function isDemoWorkerMiss(hands: string | undefined, handsDetail: string | null | undefined): boolean {
  if (hands !== "demo" || !handsDetail) return false;
  return !/^Demo book/.test(handsDetail);
}

const INBOX_LABEL = "Inbox not connected";
const INBOX_DETAIL = "Overnight mail is Planned. This build does not read Gmail or Microsoft 365.";

const LABEL: Record<MorningAttention, string> = {
  unchecked: "Not checked",
  quiet: "Checked",
  "needs-you": "Needs you",
  held: "Waiting",
  licensee: "Licensee",
};

const TONE: Record<MorningAttention, MorningTone> = {
  unchecked: "muted",
  quiet: "muted",
  "needs-you": "agency",
  held: "hold",
  licensee: "danger",
};

function isPendingDraft(draft: Draft, propertyId: string): boolean {
  return draft.propertyId === propertyId && draft.status === "pending";
}

function isMoneyHold(work: WorkItem, propertyId: string): boolean {
  return work.propertyId === propertyId && work.state === "held" && work.kind === "money-arrears";
}

function attentionFor(
  propertyId: string,
  snap: MorningSnap,
): MorningAttention {
  if (snap.lastRunAt == null) return "unchecked";
  if (isDemoWorkerMiss(snap.hands, snap.handsDetail)) return "unchecked";
  if (snap.escalations.some((row: Escalation) => row.propertyId === propertyId)) return "licensee";
  if (snap.drafts.some((row) => isPendingDraft(row, propertyId))) return "needs-you";
  const result = snap.results.find((row) => row.propertyId === propertyId);
  if (result?.outcome === "hold") return "held";
  if (snap.workItems.some((row) => isMoneyHold(row, propertyId))) return "held";
  if (result) return "quiet";
  if (snap.hands === "held") return "held";
  return "unchecked";
}

function headlineFor(brief: Omit<MorningBrief, "headline">, snap: MorningSnap): string {
  if (brief.lastRunAt != null && isDemoWorkerMiss(snap.hands, snap.handsDetail)) {
    return "Recheck missed. The worker did not return live facts.";
  }
  const n = brief.addresses.length;
  if (brief.lastRunAt == null) {
    if (n === 0) return "The book is empty. Add a property or drop an export.";
    if (n === 1) return "One address on the book. Recheck has not run.";
    return `${n} addresses on the book. Recheck has not run.`;
  }
  const bits: string[] = [];
  if (brief.needsYou) bits.push(brief.needsYou === 1 ? "1 needs you" : `${brief.needsYou} need you`);
  if (brief.held) bits.push(brief.held === 1 ? "1 held" : `${brief.held} held`);
  if (brief.licensee) bits.push(brief.licensee === 1 ? "1 for the licensee" : `${brief.licensee} for the licensee`);
  if (bits.length === 0) return `${brief.checkedCount} addresses checked. Nothing waiting.`;
  return `${brief.checkedCount} addresses checked. ${bits.join(", ")}.`;
}

export function morningBrief(snap: MorningSnap): MorningBrief {
  const addresses = snap.properties.map((property) => {
    const attention = attentionFor(property.id, snap);
    return {
      propertyId: property.id,
      address: property.address,
      attention,
      label: LABEL[attention],
      tone: TONE[attention],
    };
  });
  const checkedCount = addresses.filter((row) => row.attention !== "unchecked").length;
  const draft: Omit<MorningBrief, "headline"> = {
    lastRunAt: snap.lastRunAt,
    addresses,
    checkedCount,
    needsYou: addresses.filter((row) => row.attention === "needs-you").length,
    held: addresses.filter((row) => row.attention === "held").length,
    licensee: addresses.filter((row) => row.attention === "licensee").length,
    inboxConnected: false,
    inboxLabel: INBOX_LABEL,
    inboxDetail: INBOX_DETAIL,
  };
  return { ...draft, headline: headlineFor(draft, snap) };
}

export function shortStreet(address: string): string {
  const street = address.split(",")[0]?.trim();
  return street || address;
}

const BRIEF_COLLAPSE_AFTER = 8;

export interface CollapsedBriefRows {
  expanded: MorningAddress[];
  collapsedCount: number;
  collapsedSummary: string | null;
}

function isExpandedAttention(attention: MorningAttention): boolean {
  return attention === "needs-you" || attention === "licensee";
}

function summarizeCollapsed(rows: readonly MorningAddress[]): string {
  const n = rows.length;
  const fine = rows.filter((row) => row.attention === "quiet").length;
  const held = rows.filter((row) => row.attention === "held").length;
  const unchecked = rows.filter((row) => row.attention === "unchecked").length;
  if (fine === n) return `and ${n} more — checked, nothing waiting`;
  const bits: string[] = [];
  if (fine) bits.push(`${fine} fine`);
  if (held) bits.push(`${held} held`);
  if (unchecked) bits.push(`${unchecked} not checked`);
  return `and ${n} more: ${bits.join(" · ")}`;
}

/** Render-only: at 9+ addresses, keep needs-you and licensee rows and fold the rest. */
export function collapseBriefRows(rows: readonly MorningAddress[]): CollapsedBriefRows {
  if (rows.length <= BRIEF_COLLAPSE_AFTER) {
    return { expanded: [...rows], collapsedCount: 0, collapsedSummary: null };
  }
  const expanded = rows.filter((row) => isExpandedAttention(row.attention));
  const rest = rows.filter((row) => !isExpandedAttention(row.attention));
  return {
    expanded,
    collapsedCount: rest.length,
    collapsedSummary: rest.length ? summarizeCollapsed(rest) : null,
  };
}
