// Capped log of what Bud actually did. Tool name + ok + a short detail —
// never permission text, never message bodies.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { redactSecretsInText } from "./redact.ts";
import { cleanRunUsage } from "./run-cost.ts";
import type { RunUsage } from "../shared/contracts.ts";

const MAX_ENTRIES = 200;
const MAX_DETAIL = 160;
const MAX_NAME = 80;

export type HistoryKind = "tool" | "turn";

export interface HistoryEntry {
  id: string;
  at: number;
  kind: HistoryKind;
  name: string;
  ok: boolean;
  detail: string;
  threadId?: string;
  turnId?: string;
  durationMs?: number;
  /** An Ask turn's Modelvia requests and, when ACP reported them, its tokens. */
  usage?: RunUsage;
}

export type HistoryInput = {
  kind: HistoryKind;
  name: string;
  ok: boolean;
  detail?: string;
  threadId?: string;
  turnId?: string;
  durationMs?: number;
  usage?: RunUsage;
  at?: number;
};

function historyPath(): string {
  return join(DATA_DIR, "computer-history.json");
}

function isKind(value: unknown): value is HistoryKind {
  return value === "tool" || value === "turn";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function asEntry(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  if (typeof row.at !== "number" || !Number.isFinite(row.at)) return null;
  if (!isKind(row.kind)) return null;
  if (typeof row.name !== "string") return null;
  if (typeof row.ok !== "boolean") return null;
  if (typeof row.detail !== "string") return null;
  const threadId = typeof row.threadId === "string" && row.threadId ? row.threadId : undefined;
  const turnId = typeof row.turnId === "string" && row.turnId ? row.turnId : undefined;
  const durationMs =
    typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0
      ? row.durationMs
      : undefined;
  const usage = cleanRunUsage(row.usage);
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    name: row.name,
    ok: row.ok,
    detail: row.detail,
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(usage ? { usage } : {}),
  };
}

function persist(entries: HistoryEntry[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(historyPath(), `${JSON.stringify({ entries }, null, 2)}\n`, 0o600);
}

export function loadHistory(): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(historyPath(), "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
        ? (parsed as { entries: unknown[] }).entries
        : null;
    if (!list) return [];
    const out: HistoryEntry[] = [];
    for (const row of list) {
      const entry = asEntry(row);
      if (entry) out.push(entry);
    }
    return out.slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function appendHistory(input: HistoryInput): HistoryEntry[] {
  const detail = clip(redactSecretsInText(String(input.detail ?? "")), MAX_DETAIL);
  const name = clip(String(input.name || "tool"), MAX_NAME);
  const entry: HistoryEntry = {
    id: randomUUID(),
    at: typeof input.at === "number" && Number.isFinite(input.at) ? input.at : Date.now(),
    kind: input.kind,
    name,
    ok: Boolean(input.ok),
    detail,
  };
  if (input.threadId) entry.threadId = input.threadId;
  if (input.turnId) entry.turnId = input.turnId;
  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0) {
    entry.durationMs = input.durationMs;
  }
  const usage = cleanRunUsage(input.usage);
  if (usage) entry.usage = usage;
  const next = [...loadHistory(), entry].slice(-MAX_ENTRIES);
  persist(next);
  return next;
}

/** An AI call whose work keeps no record of its own: its Modelvia requests as
 * a history row, so the run cost can still attribute them. Nothing when it made
 * none; a failed write never fails the work that made the call. */
export function recordUsage(name: string, usage: RunUsage, options: { ok?: boolean; threadId?: string } = {}): void {
  if (!usage.calls) return;
  try { appendHistory({ kind: "tool", name, ok: options.ok ?? true, detail: "", threadId: options.threadId, usage }); }
  catch { /* history must not take the work down */ }
}

/** Latest first. */
export function listHistory(limit = 50): HistoryEntry[] {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  return loadHistory().slice(-cap).reverse();
}
