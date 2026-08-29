// Compatibility queue: V2 snapshot + V3 book → Desk case rows. Import holds are not wording cases.
import type { DeskSnapshot, Draft, WorkItem, WorkKind } from "../../shared/contracts";

export const QUEUE_FILTERS = ["needs-you", "held", "licensee", "all"] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];
export type QueueBucket = "needs-you" | "held" | "licensee" | "decided" | "on-book";

/** Seeded demo kinds. Recheck does not create them. They stay on the book. */
const BOOK_ONLY_KINDS = new Set<QueueKind>([
  "maintenance-intake",
  "lease-review",
  "inspection-prep",
  "inbound-triage",
]);

function morningBucket(kind: QueueKind, bucket: QueueBucket): QueueBucket {
  if (BOOK_ONLY_KINDS.has(kind) && bucket === "held") return "on-book";
  return bucket;
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
  if (bucket === "licensee") return "Licensee — do not draft";
  if (bucket === "on-book") return "On the book — not this check";
  if (kind === "import-issue") return "Match this source row";
  if (bucket === "held") return "Held — no wording yet";
  if (bucket === "decided") return "Recorded decision";
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

  for (const item of snap.escalations) {
    rows.push({
      id: `esc:${item.id}`,
      kind: "licensee-required",
      bucket: "licensee",
      state: "held",
      propertyId: item.propertyId,
      address: addressById.get(item.propertyId) ?? item.propertyId,
      action: actionFor("licensee", "licensee-required"),
      meta: item.detail,
      holdReason: item.reason,
      updatedAt: item.createdAt,
      escalationId: item.id,
    });
    seenWork.add(item.id);
  }

  for (const work of snap.workItems) {
    if (isImportHold(work.holdReason)) {
      seenImport.add(work.id);
      rows.push({
        id: `import:${work.id}`,
        kind: "import-issue",
        bucket: "held",
        state: work.state,
        propertyId: work.propertyId || undefined,
        address: work.propertyId ? (addressById.get(work.propertyId) ?? work.propertyId) : work.holdReason ?? "Unmatched source",
        action: actionFor("held", "import-issue"),
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
        draftRow(
          draft,
          work,
          addressById.get(draft.propertyId) ?? draft.propertyId,
          draft.status === "pending" ? "needs-you" : "decided",
        ),
      );
      continue;
    }
    if (work.state === "held" || !work.draftId) {
      const kind = kindFromWork(work.kind);
      const bucket = morningBucket(kind, work.state === "held" ? "held" : "needs-you");
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
        draft.status === "pending" ? "needs-you" : "decided",
      ),
    );
  }

  for (const issue of snap.book?.importIssues ?? []) {
    if (seenImport.has(issue.id) || issue.status !== "open") continue;
    rows.push({
      id: `import:${issue.id}`,
      kind: "import-issue",
      bucket: "held",
      state: issue.status,
      address: issue.rawIdentity,
      action: actionFor("held", "import-issue"),
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
        bucket: "licensee",
        state: item.state,
        propertyId: item.propertyId,
        address: item.propertyId ? (addressById.get(item.propertyId) ?? item.propertyId) : item.id,
        action: actionFor("licensee", "licensee-required"),
        meta: item.state,
        updatedAt: 0,
        workItemId: item.id,
      });
      continue;
    }
    const kind = kindFromWork(item.kind);
    const bucket = morningBucket(
      kind,
      item.state === "held" ? "held" : item.state === "proposed" ? "needs-you" : "decided",
    );
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

  const order: Record<QueueBucket, number> = { "needs-you": 0, held: 1, licensee: 2, "on-book": 3, decided: 4 };
  return rows.sort((a, b) => order[a.bucket] - order[b.bucket] || b.updatedAt - a.updatedAt);
}

export function filterDeskQueue(rows: DeskQueueItem[], filter: QueueFilter, query = ""): DeskQueueItem[] {
  const needle = query.trim().toLowerCase();
  const scoped = needle || filter === "all" ? rows : rows.filter((row) => row.bucket === filter);
  if (!needle) return scoped;
  return scoped.filter((row) => `${row.address} ${row.meta} ${row.kind}`.toLowerCase().includes(needle));
}

export function queueCounts(rows: DeskQueueItem[]): Record<Exclude<QueueFilter, "all">, number> & { "on-book": number } {
  return {
    "needs-you": rows.filter((row) => row.bucket === "needs-you").length,
    held: rows.filter((row) => row.bucket === "held").length,
    licensee: rows.filter((row) => row.bucket === "licensee").length,
    "on-book": rows.filter((row) => row.bucket === "on-book").length,
  };
}
