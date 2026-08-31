// Capped log of what Bud actually did. Tool name + ok + a short detail —
// never permission text, never message bodies.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { redactSecretsInText } from "./redact.ts";

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
}

export type HistoryInput = {
  kind: HistoryKind;
  name: string;
  ok: boolean;
  detail?: string;
  threadId?: string;
  turnId?: string;
  durationMs?: number;
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
  const next = [...loadHistory(), entry].slice(-MAX_ENTRIES);
  persist(next);
  return next;
}

/** Latest first. */
export function listHistory(limit = 50): HistoryEntry[] {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  return loadHistory().slice(-cap).reverse();
}
