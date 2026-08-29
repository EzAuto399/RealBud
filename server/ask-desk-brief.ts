import type { DeskSnapshot } from "../shared/contracts.ts";

export type AskDeskBriefItem = {
  kind: "licensee-hold" | "pending-allow" | "held" | "recovery";
  address: string;
  detail: string;
};

export type AskDeskBrief = {
  mode: "demo" | "live";
  recovery: boolean;
  items: AskDeskBriefItem[];
};

function clean(value: string | null | undefined, fallback: string): string {
  const next = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return next || fallback;
}

/** Current Desk queue for Hermes. Addresses and shop reasons only — no wording, phones or keys. */
export function currentAskDeskBrief(snapshot: DeskSnapshot): AskDeskBrief {
  const addressById = new Map(snapshot.properties.map((property) => [property.id, property.address]));
  const items: AskDeskBriefItem[] = [];

  if (snapshot.recovery.active) {
    items.push({
      kind: "recovery",
      address: "book",
      detail: clean(snapshot.recovery.reason, "Writes and routines are paused."),
    });
  }

  for (const escalation of snapshot.escalations.slice(0, 8)) {
    items.push({
      kind: "licensee-hold",
      address: clean(addressById.get(escalation.propertyId), "Unknown property"),
      detail: clean(escalation.detail || escalation.reason, "Licensee decision required"),
    });
  }

  const pendingDraftIds = new Set<string>();
  for (const draft of snapshot.drafts) {
    if (draft.status !== "pending") continue;
    pendingDraftIds.add(draft.id);
    items.push({
      kind: "pending-allow",
      address: clean(addressById.get(draft.propertyId), "Unknown property"),
      detail: clean(`${draft.kind} is waiting for Allow on Desk. No send.`, "Wording is waiting for Allow"),
    });
  }

  for (const work of snapshot.workItems) {
    if (work.state !== "held") continue;
    if (work.draftId && pendingDraftIds.has(work.draftId)) continue;
    items.push({
      kind: "held",
      address: clean(addressById.get(work.propertyId), "Unknown property"),
      detail: clean(work.holdReason ?? `${work.kind} is held`, "Held on Desk"),
    });
  }

  const unique: AskDeskBriefItem[] = [];
  for (const item of items) {
    if (unique.some((row) => row.kind === item.kind && row.address === item.address && row.detail === item.detail)) continue;
    unique.push(item);
  }

  return {
    mode: snapshot.mode === "live" ? "live" : "demo",
    recovery: Boolean(snapshot.recovery.active),
    items: unique.slice(0, 16),
  };
}

export function askDeskVoice(brief: AskDeskBrief): string {
  if (brief.recovery) {
    const reason = brief.items.find((item) => item.kind === "recovery")?.detail;
    return reason
      ? `Desk is in recovery. ${reason} Open You to repair. I cannot send.`
      : "Desk is in recovery. Writes and routines are paused. Open You to repair. I cannot send.";
  }
  if (brief.items.length === 0) {
    return `Desk has no exceptions waiting. This is the ${brief.mode} book. Open Desk to Recheck. I cannot send.`;
  }
  const lines = brief.items.map((item) => `${item.address} — ${item.detail.replace(/\.+$/, "")}`);
  return `On Desk now (${brief.mode}): ${lines.join(". ")}. Open Desk to Allow. I cannot send.`;
}
