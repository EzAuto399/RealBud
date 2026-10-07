// Re-read the official tenancy Acts against the shop reference.
// Bud reports drift; a person confirms before the reference is appended.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readPrivateFileSync, writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { LAW_REFERENCE_FILE } from "./law-reference.ts";
import { deleteRecipe, getRecipe, listRecipes, saveRecipe } from "./recipes.ts";
import { seedVault } from "./vault.ts";

export const LAW_WATCH_ID = "law-watch";

/** What a check answers. No public search provider is configured, a one-shot
 * worker cannot mount RealBud's page reader (Hermes safe mode loads no MCP
 * server), and there are no reviewed section-level URLs for RealBud to read
 * itself, so nothing could re-read the Acts: no worker is started. */
export const LAW_WATCH_UNAVAILABLE = "Search provider not configured: Bud can't re-read the legislation sites yet, so the shop reference was not checked. Nothing was changed.";

const MAX_FIELD = 300;
const MAX_SOURCE = 200;

export type DriftItem = {
  jurisdiction: string;
  topic: string;
  reference: string;
  current: string;
  note: string;
};

export type LawWatchState = {
  lastCheckedAt: number;
  drift: DriftItem[];
  checkedSources: string[];
};

export type LawWatchView = LawWatchState & { scheduled: boolean };

function lawWatchPath(): string {
  return join(DATA_DIR, "law-watch.json");
}

function bad(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function asString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function asDriftItem(value: unknown): DriftItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const jurisdiction = asString(row.jurisdiction, MAX_FIELD);
  const topic = asString(row.topic, MAX_FIELD);
  const reference = asString(row.reference, MAX_FIELD);
  const current = asString(row.current, MAX_FIELD);
  const note = asString(row.note, MAX_FIELD);
  if (!jurisdiction || !topic || !reference || !current || !note) return null;
  return { jurisdiction, topic, reference, current, note };
}

function asSources(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const source = asString(item, MAX_SOURCE);
    if (!source) return null;
    if (!out.includes(source)) out.push(source);
  }
  return out;
}

function asState(value: unknown): LawWatchState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.drift)) return null;
  const drift: DriftItem[] = [];
  for (const item of row.drift) {
    const parsed = asDriftItem(item);
    if (parsed) drift.push(parsed);
  }
  const checkedSources = asSources(row.checkedSources) ?? [];
  const lastCheckedAt =
    typeof row.lastCheckedAt === "number" && Number.isFinite(row.lastCheckedAt) ? row.lastCheckedAt : 0;
  return { lastCheckedAt, drift, checkedSources };
}

function persist(state: LawWatchState): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(lawWatchPath(), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export function loadLawWatch(): LawWatchState {
  try {
    const parsed = asState(JSON.parse(readFileSync(lawWatchPath(), "utf8")));
    return parsed ?? { lastCheckedAt: 0, drift: [], checkedSources: [] };
  } catch {
    return { lastCheckedAt: 0, drift: [], checkedSources: [] };
  }
}

export function lawWatchView(): LawWatchView {
  return { ...loadLawWatch(), scheduled: Boolean(getRecipe(LAW_WATCH_ID)) };
}

export function persistLawWatchResult(result: { drift: DriftItem[]; checkedSources: string[] }): LawWatchState {
  const state: LawWatchState = {
    lastCheckedAt: Date.now(),
    drift: result.drift,
    checkedSources: result.checkedSources,
  };
  persist(state);
  return state;
}

function appendConfirmedDrift(item: DriftItem): void {
  const vault = seedVault();
  const path = join(vault, LAW_REFERENCE_FILE);
  // The workroom is worker-writable: never follow a planted link or alias.
  const existing = readPrivateFileSync(path);
  if (existing === null) throw new Error("The law reference note is missing.");
  const day = new Date().toISOString().slice(0, 10);
  const block =
    `\n## Confirmed drift — ${day}\n\n` +
    `- ${item.jurisdiction} · ${item.topic}: ${item.current} (reference said: ${item.reference}) — ${item.note}\n`;
  writeFileAtomic(path, `${existing}${block}`, 0o600);
}

export function applyLawDrift(index: number): LawWatchState {
  if (!Number.isInteger(index) || index < 0) {
    bad("That finding is not on the current list.");
  }
  const saved = loadLawWatch();
  const item = saved.drift[index];
  if (!item) bad("That finding is not on the current list.");
  appendConfirmedDrift(item);
  const next: LawWatchState = {
    ...saved,
    drift: saved.drift.filter((_, i) => i !== index),
  };
  persist(next);
  return next;
}

export function setLawWatchScheduled(on: boolean) {
  if (on) {
    saveRecipe({
      id: LAW_WATCH_ID,
      title: "Law watch",
      steps: [
        "Read the current tenancy Acts for the book's jurisdictions on the official legislation sites.",
        "Compare them against AU-RENTAL-LAW.md in the workroom.",
        "Report any drift — never edit the reference yourself.",
      ],
      allowedOrigins: [
        "legislation.gov.au",
        "legislation.nsw.gov.au",
        "legislation.vic.gov.au",
        "legislation.qld.gov.au",
      ],
      evidence: "Drift findings, each with its source URL.",
      schedule: { time: "08:00", weekdays: [1] },
      status: "shadow",
      planApprovedAt: null,
    });
  } else if (getRecipe(LAW_WATCH_ID)) {
    deleteRecipe(LAW_WATCH_ID);
  }
  return listRecipes();
}
