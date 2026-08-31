// Compatibility queue: V2 snapshot + V3 book → Desk case rows. Import holds are not wording cases.
import type { DeskSnapshot, Draft, DraftStatus, WorkItem, WorkKind, WorkState } from "../../shared/contracts";
import { startOfDay } from "./au";

/** The four states of the day. Not navigation — every row lands in exactly one.
 *  now      needs a person this sitting
 *  next     the routine knows the step; nobody is needed yet
 *  waiting  blocked on something outside this sitting
 *  done     a decision is recorded */
export const QUEUE_STATES = ["now", "next", "waiting", "done"] as const;
export type QueueBucket = (typeof QUEUE_STATES)[number];

export const QUEUE_FILTERS = [...QUEUE_STATES, "all"] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];

/** Seeded demo kinds. Recheck does not create them. They stay on the book. */
const BOOK_ONLY_KINDS = new Set<QueueKind>([
  "maintenance-intake",
  "lease-review",
  "inspection-prep",
  "inbound-triage",
]);

/** The one place a work state becomes a place in the day. A new WorkState
 * cannot compile until someone says where in the day it belongs, so a case
 * can never fall through and render in no bucket at all. */
export function bucketForWork(state: WorkState): QueueBucket {
  switch (state) {
    case "proposed":
    case "handoff-ready":
      return "now";
    case "preparing":
      return "next";
    case "held":
    case "stale":
    case "failed":
    case "effect-unknown":
    case "handoff-expired":
      return "waiting";
    case "approved":
    case "denied":
    case "confirmed":
    case "superseded":
    case "cancelled":
      return "done";
    default: {
      const unmapped: never = state;
      return unmapped;
    }
  }
}

function bucketForDraft(status: DraftStatus): QueueBucket {
  return status === "pending" ? "now" : "done";
}

/** Seeded book kinds are not this morning's work. They wait in Next rather
 * than reading as something blocked. */
function onBook(kind: QueueKind, bucket: QueueBucket): QueueBucket {
  return BOOK_ONLY_KINDS.has(kind) && bucket === "waiting" ? "next" : bucket;
}
export type QueueKind =
  | "money-arrears"
  | "owner-update"
  | "inbound-triage"
  | "maintenance-intake"
  | "lease-review"
  | "inspection-prep"
  | "licensee-required"
  | "import-issue";

export interface DeskQueueItem {
  id: string;
  kind: QueueKind;
  bucket: QueueBucket;
  state: string;
  propertyId?: string;
  address: string;
  action: string;
  meta: string;
  holdReason?: string;
  updatedAt: number;
  draftId?: string;
  workItemId?: string;
  escalationId?: string;
}

function isImportHold(reason: string | undefined): boolean {
  return reason === "unmatched" || Boolean(reason?.startsWith("ambiguous-match"));
}

export function kindFromWork(kind: WorkKind | string): QueueKind {
  if (kind === "owner-letter" || kind === "owner-update") return "owner-update";
  if (kind === "maintenance-intake") return "maintenance-intake";
  if (kind === "lease-review") return "lease-review";
  if (kind === "inspection-prep") return "inspection-prep";
  if (kind === "inbound-triage") return "inbound-triage";
  if (kind === "licensee-required") return "licensee-required";
  return "money-arrears";
}

function kindFromDraft(draft: Draft): QueueKind {
  return draft.kind === "owner-letter" ? "owner-update" : "money-arrears";
}

function actionFor(bucket: QueueBucket, kind: QueueKind): string {
  if (kind === "licensee-required") return "Licensee — do not draft";
  if (kind === "import-issue") return "Match this source row";
  if (bucket === "next") return "On the book — not this check";
  if (bucket === "waiting") return "Waiting — no wording yet";
  if (bucket === "done") return "Recorded decision";
  if (kind === "owner-update") return "Allow owner wording";
  if (kind === "maintenance-intake") return "Classify intake";
  if (kind === "lease-review") return "Review dates";
  if (kind === "inspection-prep") return "Prep checklist";
  if (kind === "inbound-triage") return "Triage inbound";
  return "Allow wording";
}

function draftRow(
  draft: Draft,
  work: WorkItem | undefined,
  address: string,
  bucket: QueueBucket,
): DeskQueueItem {
  const kind = kindFromDraft(draft);
  return {
    id: `draft:${draft.id}`,
    kind,
    bucket,
    state: draft.status === "pending" ? (work?.state ?? "proposed") : draft.status === "allowed" ? "approved" : "denied",
    propertyId: draft.propertyId,
    address,
    action: actionFor(bucket, kind),
    meta: `${draft.kind === "levy-from-rent" ? "Levy flag" : draft.kind === "owner-letter" ? "Owner update" : "Courtesy"} · ${draft.to}`,
    holdReason: work?.holdReason,
    updatedAt: draft.decidedAt ?? draft.createdAt,
    draftId: draft.id,
    workItemId: draft.workItemId ?? work?.id,
  };
}

export function buildDeskQueue(snap: DeskSnapshot): DeskQueueItem[] {
  const addressById = new Map(snap.properties.map((property) => [property.id, property.address]));
  for (const archived of snap.book?.archivedProperties ?? []) {
    addressById.set(archived.id, archived.address);
  }
  const rows: DeskQueueItem[] = [];
  const seenDrafts = new Set<string>();
  const seenWork = new Set<string>();
  const seenImport = new Set<string>();

  // A licensee escalation needs a person this sitting, so it belongs in Now.
  // The kind keeps it identifiable and sorts it to the top of that bucket.
  for (const item of snap.escalations) {
    rows.push({
      id: `esc:${item.id}`,
      kind: "licensee-required",
      bucket: "now",
      state: "held",
      propertyId: item.propertyId,
      address: addressById.get(item.propertyId) ?? item.propertyId,
      action: actionFor("now", "licensee-required"),
      meta: item.detail,
      holdReason: item.reason,
      updatedAt: item.createdAt,
      escalationId: item.id,
    });
    seenWork.add(item.id);
  }

  for (const work of snap.workItems) {
    // An unmatched row is not blocked on anyone else — the PM matches it.
    if (isImportHold(work.holdReason)) {
      seenImport.add(work.id);
      rows.push({
        id: `import:${work.id}`,
        kind: "import-issue",
        bucket: "now",
        state: work.state,
        propertyId: work.propertyId || undefined,
        address: work.propertyId ? (addressById.get(work.propertyId) ?? work.propertyId) : work.holdReason ?? "Unmatched source",
        action: actionFor("now", "import-issue"),
        meta: `${work.holdReason ?? "unmatched"} · ${work.sourceIds.join(", ")}`,
        holdReason: work.holdReason,
        updatedAt: work.updatedAt,
        workItemId: work.id,
      });
      continue;
    }
    const draft =
      (work.draftId ? snap.drafts.find((item) => item.id === work.draftId) : undefined) ??
      snap.drafts.find((item) => item.workItemId === work.id);
    if (draft) {
      seenDrafts.add(draft.id);
      seenWork.add(work.id);
      rows.push(
        draftRow(draft, work, addressById.get(draft.propertyId) ?? draft.propertyId, bucketForDraft(draft.status)),
      );
      continue;
    }
    if (work.state === "held" || !work.draftId) {
      const kind = kindFromWork(work.kind);
      const bucket = onBook(kind, bucketForWork(work.state));
      seenWork.add(work.id);
      rows.push({
        id: `work:${work.id}`,
        kind,
        bucket,
        state: work.state,
        propertyId: work.propertyId,
        address: addressById.get(work.propertyId) ?? work.propertyId,
        action: actionFor(bucket, kind),
        meta: work.holdReason ?? work.state,
        holdReason: work.holdReason,
        updatedAt: work.updatedAt,
        workItemId: work.id,
      });
    }
  }

  for (const draft of snap.drafts) {
    if (seenDrafts.has(draft.id)) continue;
    rows.push(
      draftRow(
        draft,
        snap.workItems.find((item) => item.id === draft.workItemId || item.draftId === draft.id),
        addressById.get(draft.propertyId) ?? draft.propertyId,
        bucketForDraft(draft.status),
      ),
    );
  }

  for (const issue of snap.book?.importIssues ?? []) {
    if (seenImport.has(issue.id) || issue.status !== "open") continue;
    rows.push({
      id: `import:${issue.id}`,
      kind: "import-issue",
      bucket: "now",
      state: issue.status,
      address: issue.rawIdentity,
      action: actionFor("now", "import-issue"),
      meta: `${issue.kind} · ${issue.rawIdentity}`,
      holdReason: issue.kind,
      updatedAt: 0,
      workItemId: issue.id,
    });
  }

  for (const item of snap.book?.cases ?? []) {
    if (seenWork.has(item.id)) continue;
    if (item.kind === "licensee-required") {
      rows.push({
        id: `esc:${item.id}`,
        kind: "licensee-required",
        bucket: "now",
        state: item.state,
        propertyId: item.propertyId,
        address: item.propertyId ? (addressById.get(item.propertyId) ?? item.propertyId) : item.id,
        action: actionFor("now", "licensee-required"),
        meta: item.state,
        updatedAt: 0,
        workItemId: item.id,
      });
      continue;
    }
    const kind = kindFromWork(item.kind);
    const bucket = onBook(kind, bucketForWork(item.state));
    rows.push({
      id: `work:${item.id}`,
      kind,
      bucket,
      state: item.state,
      propertyId: item.propertyId,
      address: item.propertyId ? (addressById.get(item.propertyId) ?? item.propertyId) : item.id,
      action: actionFor(bucket, kind),
      meta: item.state,
      updatedAt: 0,
      workItemId: item.id,
    });
  }

  const order: Record<QueueBucket, number> = { now: 0, next: 1, waiting: 2, done: 3 };
  const licenseeFirst = (row: DeskQueueItem) => (row.kind === "licensee-required" ? 0 : 1);
  return rows.sort(
    (a, b) =>
      order[a.bucket] - order[b.bucket] || licenseeFirst(a) - licenseeFirst(b) || b.updatedAt - a.updatedAt,
  );
}

export function filterDeskQueue(rows: DeskQueueItem[], filter: QueueFilter, query = ""): DeskQueueItem[] {
  const needle = query.trim().toLowerCase();
  const scoped = needle || filter === "all" ? rows : rows.filter((row) => row.bucket === filter);
  if (!needle) return scoped;
  return scoped.filter((row) => `${row.address} ${row.meta} ${row.kind}`.toLowerCase().includes(needle));
}

export interface QueueCounts extends Record<QueueBucket, number> {
  /** The part of Now that a licensed person must take. Not a separate bucket. */
  licensee: number;
}

/** Done counts today only. A running total of every decision ever made is a
 * vanity number, not a day's work. The Done list still holds the history. */
export function queueCounts(rows: DeskQueueItem[], now = Date.now()): QueueCounts {
  const today = startOfDay(now);
  const inBucket = (bucket: QueueBucket) => rows.filter((row) => row.bucket === bucket);
  return {
    now: inBucket("now").length,
    next: inBucket("next").length,
    waiting: inBucket("waiting").length,
    done: inBucket("done").filter((row) => row.updatedAt >= today).length,
    licensee: inBucket("now").filter((row) => row.kind === "licensee-required").length,
  };
}
