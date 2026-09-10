import { relativeAgo } from "./au";

export type WorkerIssueSource = "ask" | "runtime" | "channel" | "hands" | "install";

export type WorkerIssue = {
  id: string;
  at: number;
  source: WorkerIssueSource;
  summary: string;
  detail: string;
};

const SOURCE_LABEL: Record<WorkerIssueSource, string> = {
  ask: "Ask",
  runtime: "Worker",
  channel: "Phone",
  hands: "Hands",
  install: "Install",
};

export function readWorkerIssues(body: unknown): WorkerIssue[] {
  if (!body || typeof body !== "object") return [];
  const issues = (body as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  const out: WorkerIssue[] = [];
  for (const row of issues) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const source = rec.source;
    if (source !== "ask" && source !== "runtime" && source !== "channel" && source !== "hands" && source !== "install") {
      continue;
    }
    if (typeof rec.id !== "string" || typeof rec.at !== "number" || typeof rec.summary !== "string" || typeof rec.detail !== "string") {
      continue;
    }
    out.push({ id: rec.id, at: rec.at, source, summary: rec.summary, detail: rec.detail });
  }
  return out;
}

export function workerIssueLabel(source: WorkerIssueSource): string {
  return SOURCE_LABEL[source];
}

export function workerIssueLine(issue: WorkerIssue, now = Date.now()): string {
  return `${workerIssueLabel(issue.source)} · ${relativeAgo(issue.at, now)} — ${issue.detail}`;
}

/** Show the latest issue when it is still relevant (default 6h). */
export function latestWorkerIssue(issues: WorkerIssue[] | null | undefined, maxAgeMs = 6 * 60 * 60_000, now = Date.now()): WorkerIssue | null {
  const latest = issues?.[0];
  if (!latest) return null;
  return now - latest.at <= maxAgeMs ? latest : null;
}
