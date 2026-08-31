import { relativeAgo } from "./au";

export type DriftItem = {
  jurisdiction: string;
  topic: string;
  reference: string;
  current: string;
  note: string;
};

export type LawWatch = {
  lastCheckedAt: number | null;
  drift: DriftItem[];
  checkedSources: string[];
  scheduled: boolean;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readDriftItem(raw: unknown): DriftItem | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  return {
    jurisdiction: asString(rec.jurisdiction),
    topic: asString(rec.topic),
    reference: asString(rec.reference),
    current: asString(rec.current),
    note: asString(rec.note),
  };
}

export function readLawWatch(body: unknown): LawWatch {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const last = rec.lastCheckedAt;
  return {
    lastCheckedAt: typeof last === "number" && Number.isFinite(last) ? last : null,
    drift: Array.isArray(rec.drift)
      ? rec.drift.map(readDriftItem).filter((item): item is DriftItem => item != null)
      : [],
    checkedSources: Array.isArray(rec.checkedSources)
      ? rec.checkedSources.filter((source): source is string => typeof source === "string")
      : [],
    scheduled: rec.scheduled === true,
  };
}

export function lastCheckedLine(lastCheckedAt: number | null, now = Date.now()): string {
  if (lastCheckedAt == null) return "Never checked";
  return `Last checked ${relativeAgo(lastCheckedAt, now)}`;
}

/** Empty-drift line after a check. Names how many sources were read. */
export function noDriftLine(sourceCount: number): string {
  const n = Math.max(0, Math.floor(sourceCount));
  const base = "No drift found — the reference matches the current Acts";
  if (n === 0) return `${base}.`;
  return `${base} across ${n} ${n === 1 ? "source" : "sources"}.`;
}
