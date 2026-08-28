// Compatibility queue: V2 snapshot + V3 book → Desk case rows. Import holds are not wording cases.
import type { DeskSnapshot, Draft, WorkItem, WorkKind } from "../../shared/contracts";

export const QUEUE_FILTERS = ["needs-you", "waiting", "handling", "all"] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];
export type PmWorkState = "needs-you" | "waiting" | "handling";
export type QueueBucket = "needs-you" | "waiting" | "held" | "licensee" | "decided";
export type QueueKind =
  | "money-arrears"
  | "owner-update"
  | "inbound-triage"
  | "maintenance-intake"
  | "lease-review"
  | "inspection-prep"
  | "source-incident"
  | "licensee-required"
  | "import-issue";

export interface DeskQueueItem {
  id: string;
  kind: QueueKind;
  bucket: QueueBucket;
  pmState?: PmWorkState;
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
  nextCheckAt?: number;
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
  if (kind === "source-incident") return "source-incident";
  return "money-arrears";
}

function kindFromDraft(draft: Draft, work?: WorkItem): QueueKind {
  if (work) return kindFromWork(work.kind);
  if (draft.kind === "inbound-reply") return "inbound-triage";
  return draft.kind === "owner-letter" ? "owner-update" : "money-arrears";
}

function actionFor(bucket: QueueBucket, kind: QueueKind): string {
  if (bucket === "licensee") return "Licensee — do not draft";
  if (kind === "import-issue") return "Match this source row";
  if (kind === "source-incident") return "Reconnect or refresh this source";
  if (bucket === "waiting") return "Waiting for reply";
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
  const kind = kindFromDraft(draft, work);
  return {
    id: `draft:${draft.id}`,
    kind,
    bucket,
    state:
      work?.state === "waiting"
        ? "waiting"
        : draft.status === "pending"
        ? (work?.state ?? "proposed")
        : draft.status === "allowed"
          ? "approved"
          : draft.status === "stale"
            ? "stale"
            : "denied",
    propertyId: draft.propertyId,
    address,
    action: actionFor(bucket, kind),
    meta:
      draft.status === "stale"
        ? "Superseded by newer evidence · Recheck before drafting again"
        : `${draft.kind === "levy-from-rent" ? "Levy flag" : draft.kind === "owner-letter" ? "Owner update" : draft.kind === "inbound-reply" ? "Reply draft" : "Courtesy"} · ${draft.to}`,
    holdReason: work?.holdReason,
    updatedAt: draft.decidedAt ?? draft.createdAt,
    draftId: draft.id,
    workItemId: draft.workItemId ?? work?.id,
    nextCheckAt: work?.lifecycle?.nextCheckAt,
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
        nextCheckAt: work.lifecycle?.nextCheckAt,
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
          (addressById.get(draft.propertyId) ?? work.inbound?.senderName ?? work.inbound?.subject ?? draft.propertyId) || "Inbound message",
          work.state === "waiting" ? "waiting" : draft.status === "pending" ? "needs-you" : "decided",
        ),
      );
      continue;
    }
    if (work.state === "held" || !work.draftId) {
      const kind = kindFromWork(work.kind);
      const bucket: QueueBucket = work.state === "waiting" ? "waiting" : work.state === "held" ? "held" : "needs-you";
      seenWork.add(work.id);
      rows.push({
        id: `work:${work.id}`,
        kind,
        bucket,
        state: work.state,
        propertyId: work.propertyId,
        address: (addressById.get(work.propertyId) ?? work.inbound?.senderName ?? work.inbound?.subject ?? work.propertyId) || "Inbound message",
        action: actionFor(bucket, kind),
        meta: work.holdReason ?? work.state,
        holdReason: work.holdReason,
        updatedAt: work.updatedAt,
        workItemId: work.id,
        nextCheckAt: work.lifecycle?.nextCheckAt,
      });
    }
  }

  for (const draft of snap.drafts) {
    if (seenDrafts.has(draft.id)) continue;
    rows.push(
      draftRow(
        draft,
        snap.workItems.find((item) => item.id === draft.workItemId || item.draftId === draft.id),
        (addressById.get(draft.propertyId) ?? snap.workItems.find((item) => item.id === draft.workItemId || item.draftId === draft.id)?.inbound?.senderName ?? draft.propertyId) || "Inbound message",
        snap.workItems.find((item) => item.id === draft.workItemId || item.draftId === draft.id)?.state === "waiting" ? "waiting" : draft.status === "pending" ? "needs-you" : "decided",
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
    const bucket: QueueBucket = item.state === "held" ? "held" : item.state === "proposed" ? "needs-you" : item.state === "waiting" ? "waiting" : "decided";
    rows.push({
      id: `work:${item.id}`,
      kind,
      bucket,
      state: item.state,
      propertyId: item.propertyId,
      address: item.propertyId ? (addressById.get(item.propertyId) ?? item.propertyId) : item.inbound?.senderName || item.id,
      action: actionFor(bucket, kind),
      meta: item.state,
      updatedAt: 0,
      workItemId: item.id,
      nextCheckAt: item.lifecycle?.nextCheckAt,
    });
  }

  const order: Record<QueueBucket, number> = { "needs-you": 0, waiting: 1, held: 2, licensee: 3, decided: 4 };
  for (const row of rows) {
    row.pmState = row.bucket === "waiting"
      ? "waiting"
      : row.state === "preparing"
        ? "handling"
        : row.bucket === "decided"
          ? undefined
          : "needs-you";
  }
  return rows.sort((a, b) => {
    const stateOrder: Record<PmWorkState, number> = { "needs-you": 0, waiting: 1, handling: 2 };
    const rank = (row: DeskQueueItem) => row.bucket === "decided" ? 3 : stateOrder[row.pmState ?? "needs-you"];
    const stateDelta = rank(a) - rank(b);
    if (stateDelta) return stateDelta;
    if (a.pmState === "waiting" && b.pmState === "waiting") {
      const dueDelta = (a.nextCheckAt ?? Number.MAX_SAFE_INTEGER) - (b.nextCheckAt ?? Number.MAX_SAFE_INTEGER);
      if (dueDelta) return dueDelta;
    }
    return order[a.bucket] - order[b.bucket] || b.updatedAt - a.updatedAt;
  });
}

export function groupDeskQueue(rows: DeskQueueItem[]): Array<{ key: string; address: string; items: DeskQueueItem[] }> {
  const groups: Array<{ key: string; address: string; items: DeskQueueItem[] }> = [];
  const indexByKey = new Map<string, number>();
  for (const row of rows) {
    const key = row.propertyId || `solo:${row.id}`;
    const existing = indexByKey.get(key);
    if (existing !== undefined) {
      groups[existing]!.items.push(row);
      continue;
    }
    indexByKey.set(key, groups.length);
    groups.push({ key, address: row.address, items: [row] });
  }
  return groups;
}

export function filterDeskQueue(rows: DeskQueueItem[], filter: QueueFilter, query = ""): DeskQueueItem[] {
  const needle = query.trim().toLowerCase();
  const scoped = filter === "all" ? rows : rows.filter((row) => row.pmState === filter);
  if (!needle) return scoped;
  return scoped.filter((row) => `${row.address} ${row.meta} ${row.kind}`.toLowerCase().includes(needle));
}

export function queueCounts(rows: DeskQueueItem[]): Record<Exclude<QueueFilter, "all">, number> {
  return {
    "needs-you": rows.filter((row) => row.pmState === "needs-you").length,
    waiting: rows.filter((row) => row.pmState === "waiting").length,
    handling: rows.filter((row) => row.pmState === "handling").length,
  };
}
