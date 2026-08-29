/** Per-tool API keys. Metadata is public; keys live in the secret store. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { appSecretStore, DATA_DIR, type ConfigIoOptions } from "./config.ts";
import { isSafeToolkitSlug } from "./office-sources.ts";

const FILE = "linked-tools.json";

export type LinkedToolMethod = "direct-api" | "composio";

export interface LinkedToolRecord {
  slug: string;
  label: string;
  method: LinkedToolMethod;
  linkedAt: number;
  account?: string;
  lastPeekAt?: number;
  lastPeekTitles?: string[];
}

export interface LinkedToolStatus {
  slug: string;
  label: string;
  method: LinkedToolMethod;
  connected: boolean;
  account?: string;
  lastPeekTitles?: string[];
}

function filePath(dir: string): string {
  return join(dir, FILE);
}

function secretName(slug: string): string {
  return `tools.${slug}.key`;
}

function prettyLabel(slug: string, label?: string): string {
  const named = (label ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (named && named.length <= 40) return named;
  return slug.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function readRecords(dir: string): LinkedToolRecord[] {
  const path = filePath(dir);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { tools?: unknown };
    if (!Array.isArray(raw.tools)) return [];
    const out: LinkedToolRecord[] = [];
    for (const item of raw.tools) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Partial<LinkedToolRecord>;
      if (typeof row.slug !== "string" || !isSafeToolkitSlug(row.slug)) continue;
      const account = typeof row.account === "string" ? prettyLabel(row.slug, row.account) : undefined;
      const lastPeekTitles = Array.isArray(row.lastPeekTitles)
        ? row.lastPeekTitles.filter((title): title is string => typeof title === "string").slice(0, 8)
        : undefined;
      const lastPeekAt = typeof row.lastPeekAt === "number" && Number.isFinite(row.lastPeekAt) ? row.lastPeekAt : undefined;
      out.push({
        slug: row.slug,
        label: prettyLabel(row.slug, typeof row.label === "string" ? row.label : undefined),
        method: row.method === "composio" ? "composio" : "direct-api",
        linkedAt: typeof row.linkedAt === "number" && Number.isFinite(row.linkedAt) ? row.linkedAt : 0,
        ...(account ? { account } : {}),
        ...(lastPeekAt ? { lastPeekAt } : {}),
        ...(lastPeekTitles?.length ? { lastPeekTitles } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function writeRecords(dir: string, tools: LinkedToolRecord[]): void {
  writeFileAtomic(filePath(dir), `${JSON.stringify({ tools }, null, 2)}\n`);
}

export function hasComposioConnectKey(opts?: ConfigIoOptions): boolean {
  return appSecretStore(opts).has("config.composio.key");
}

export function listLinkedTools(opts?: ConfigIoOptions): LinkedToolStatus[] {
  const dir = opts?.dir ?? DATA_DIR;
  const secrets = appSecretStore(opts);
  return readRecords(dir)
    .filter((row) => (
      row.method === "composio"
        ? hasComposioConnectKey(opts)
        : secrets.has(secretName(row.slug))
    ))
    .map((row) => ({
      slug: row.slug,
      label: row.label,
      method: row.method,
      connected: true,
      ...(row.account ? { account: row.account } : {}),
      ...(row.lastPeekTitles?.length ? { lastPeekTitles: row.lastPeekTitles } : {}),
    }));
}

export function hasLinkedToolKey(slug: string, opts?: ConfigIoOptions): boolean {
  if (!isSafeToolkitSlug(slug)) return false;
  return appSecretStore(opts).has(secretName(slug));
}

/** Server-only. Never put this value in a transcript, card, or prompt. */
export function readLinkedToolKey(slug: string, opts?: ConfigIoOptions): string | null {
  if (!isSafeToolkitSlug(slug)) return null;
  const key = appSecretStore(opts).get(secretName(slug));
  return key && key.length >= 8 ? key : null;
}

export function saveLinkedToolKey(
  input: { slug: string; label?: string; key: string; method?: LinkedToolMethod; account?: string },
  opts?: ConfigIoOptions,
): LinkedToolStatus {
  const slug = input.slug.trim().toLowerCase();
  if (!isSafeToolkitSlug(slug)) {
    throw Object.assign(new Error("That tool name is not usable."), { status: 400, code: "INVALID_TOOL" });
  }
  const key = input.key.trim();
  if (key.length < 8 || key.length > 4096) {
    throw Object.assign(new Error("Paste a current API key for this tool."), { status: 400, code: "INVALID_KEY" });
  }
  const dir = opts?.dir ?? DATA_DIR;
  appSecretStore(opts).set(secretName(slug), key);
  const label = prettyLabel(slug, input.label);
  const method = input.method ?? "direct-api";
  const tools = readRecords(dir).filter((row) => row.slug !== slug);
  const account = input.account?.trim() ? prettyLabel(slug, input.account) : undefined;
  tools.push({ slug, label, method, linkedAt: Date.now(), ...(account ? { account } : {}) });
  writeRecords(dir, tools);
  return { slug, label, method, connected: true, ...(account ? { account } : {}) };
}

/** Composio OAuth — no per-app key. The Connect key stays in the secret store. */
export function saveLinkedComposioTool(
  input: { slug: string; label?: string; account?: string },
  opts?: ConfigIoOptions,
): LinkedToolStatus {
  const slug = input.slug.trim().toLowerCase();
  if (!isSafeToolkitSlug(slug)) {
    throw Object.assign(new Error("That tool name is not usable."), { status: 400, code: "INVALID_TOOL" });
  }
  const dir = opts?.dir ?? DATA_DIR;
  const previous = readRecords(dir).find((row) => row.slug === slug);
  const tools = readRecords(dir).filter((row) => row.slug !== slug);
  const label = prettyLabel(slug, input.label);
  const account = input.account?.trim() ? prettyLabel(slug, input.account) : previous?.account;
  tools.push({
    slug,
    label,
    method: "composio",
    linkedAt: Date.now(),
    ...(account ? { account } : {}),
    ...(previous?.lastPeekAt ? { lastPeekAt: previous.lastPeekAt } : {}),
    ...(previous?.lastPeekTitles?.length ? { lastPeekTitles: previous.lastPeekTitles } : {}),
  });
  writeRecords(dir, tools);
  return { slug, label, method: "composio", connected: true, ...(account ? { account } : {}) };
}

export function saveLinkedToolPeek(slug: string, titles: string[], opts?: ConfigIoOptions): void {
  if (!isSafeToolkitSlug(slug)) return;
  const dir = opts?.dir ?? DATA_DIR;
  const tools = readRecords(dir);
  const row = tools.find((item) => item.slug === slug);
  if (!row) return;
  row.lastPeekAt = Date.now();
  row.lastPeekTitles = titles.map((title) => title.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8);
  writeRecords(dir, tools);
}

export function removeLinkedTool(slug: string, opts?: ConfigIoOptions): void {
  if (!isSafeToolkitSlug(slug)) {
    throw Object.assign(new Error("That tool name is not usable."), { status: 400, code: "INVALID_TOOL" });
  }
  const dir = opts?.dir ?? DATA_DIR;
  appSecretStore(opts).delete(secretName(slug));
  writeRecords(dir, readRecords(dir).filter((row) => row.slug !== slug));
}
