export type SourceCheckKind = "hermes" | "csv" | "portal" | "demo" | string;

export interface SourceCheckInput {
  kind: SourceCheckKind;
  lastCheckedAt?: number | null;
}

export interface LastRecheck {
  ok: boolean;
  kind: "ping" | "recheck";
}

/** Worker source after a failed Recheck is a miss, even if Test hands later passed. */
export function sourceCheckFailed(source: SourceCheckInput, lastRecheck: LastRecheck | null | undefined): boolean {
  if (!source.lastCheckedAt) return false;
  if (source.kind !== "hermes") return false;
  return lastRecheck?.kind === "recheck" && lastRecheck.ok === false;
}

export function sourceCheckCopy(
  source: SourceCheckInput,
  lastRecheck: LastRecheck | null | undefined,
  formatTime: (at: number) => string,
): string {
  if (!source.lastCheckedAt) return "Not checked yet";
  const when = formatTime(source.lastCheckedAt);
  return sourceCheckFailed(source, lastRecheck) ? `Missed ${when}` : `Checked ${when}`;
}
