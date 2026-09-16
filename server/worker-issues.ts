// Durable, PM-language record of worker / Ask / channel failures. Desk and
// You read the same file so random Telegram misses show up in RealBud.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { redactSecretsInText } from "./redact.ts";

const MAX_ENTRIES = 40;
const MAX_SUMMARY = 80;
const MAX_DETAIL = 280;
const DEDUP_MS = 120_000;

export type WorkerIssueSource = "ask" | "runtime" | "channel" | "hands" | "install";

export interface WorkerIssue {
  id: string;
  at: number;
  source: WorkerIssueSource;
  summary: string;
  detail: string;
}

export type WorkerIssueInput = {
  source: WorkerIssueSource;
  summary: string;
  detail: string;
  at?: number;
};

let issueListener: ((issue: WorkerIssue) => void) | null = null;

export function setWorkerIssueListener(listener: ((issue: WorkerIssue) => void) | null): void {
  issueListener = listener;
}

function issuesPath(): string {
  return join(DATA_DIR, "worker-issues.json");
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function asIssue(value: unknown): WorkerIssue | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const source = row.source;
  if (source !== "ask" && source !== "runtime" && source !== "channel" && source !== "hands" && source !== "install") {
    return null;
  }
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  if (typeof row.at !== "number" || !Number.isFinite(row.at)) return null;
  if (typeof row.summary !== "string" || typeof row.detail !== "string") return null;
  return {
    id: row.id,
    at: row.at,
    source,
    summary: row.summary,
    detail: row.detail,
  };
}

function persist(entries: WorkerIssue[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(issuesPath(), `${JSON.stringify({ issues: entries }, null, 2)}\n`, 0o600);
}

export function loadWorkerIssues(): WorkerIssue[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(issuesPath(), "utf8"));
    const list =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { issues?: unknown }).issues)
        ? (parsed as { issues: unknown[] }).issues
        : null;
    if (!list) return [];
    const out: WorkerIssue[] = [];
    for (const row of list) {
      const issue = asIssue(row);
      if (issue) out.push(issue);
    }
    return out.slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

/** Latest first. */
export function listWorkerIssues(limit = 20): WorkerIssue[] {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  return loadWorkerIssues()
    .slice(-cap)
    .reverse();
}

export function noteWorkerIssue(input: WorkerIssueInput): WorkerIssue | null {
  const summary = clip(redactSecretsInText(input.summary), MAX_SUMMARY);
  const detail = clip(redactSecretsInText(input.detail), MAX_DETAIL);
  if (!summary || !detail) return null;
  const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : Date.now();
  const prev = loadWorkerIssues().at(-1);
  if (
    prev &&
    prev.source === input.source &&
    prev.summary === summary &&
    prev.detail === detail &&
    at - prev.at < DEDUP_MS
  ) {
    return null;
  }
  const issue: WorkerIssue = {
    id: randomUUID(),
    at,
    source: input.source,
    summary,
    detail,
  };
  const next = [...loadWorkerIssues(), issue].slice(-MAX_ENTRIES);
  persist(next);
  issueListener?.(issue);
  return issue;
}
