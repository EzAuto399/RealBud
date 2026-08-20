// Encrypted Desk v2 ledger. Binary captures stay outside this file.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  BookMode,
  CheckResult,
  DeskSnapshot,
  Draft,
  Escalation,
  HandsSource,
  LedgerFacts,
  Observation,
  PortalCapability,
  PortalRecipe,
  Property,
  PropertyPortalBinding,
  RecoveryState,
  SourceIdentity,
  WorkItem,
} from "../shared/contracts.ts";
import { writeFileAtomic } from "./atomic.ts";
import { decryptJson, encryptJson, isEncryptedEnvelope } from "./desk-crypto.ts";
import { loadDeskKey, type DeskKey } from "./desk-key.ts";
import { workStateFromV1Draft } from "./desk-work.ts";

export interface DeskFileV2 {
  version: 2;
  revision: number;
  mode: BookMode;
  timezone: string;
  retentionDays: number | null;
  properties: Property[];
  ledger: LedgerFacts[];
  drafts: Draft[];
  escalations: Escalation[];
  workItems: WorkItem[];
  lastRunAt: number | null;
  results: CheckResult[];
  hands: HandsSource;
  handsDetail: string | null;
  sources: SourceIdentity[];
  observations: Observation[];
  portalBindings: PropertyPortalBinding[];
  recipes: PortalRecipe[];
  capabilities: PortalCapability[];
}

export interface LoadedDesk {
  data: DeskFileV2;
  recovery: RecoveryState;
  key: DeskKey;
}

const MAX_BACKUPS = 5;

function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Sydney";
}

export function emptyV2(book: { properties: Property[]; ledger: LedgerFacts[] }): DeskFileV2 {
  return {
    version: 2,
    revision: 1,
    mode: "demo",
    timezone: hostTimezone(),
    retentionDays: 90,
    properties: book.properties,
    ledger: book.ledger,
    drafts: [],
    escalations: [],
    workItems: [],
    lastRunAt: null,
    results: [],
    hands: "demo",
    handsDetail: null,
    sources: [
      {
        id: "src-demo",
        kind: "demo",
        label: "Demo training book",
        stableKey: "demo:training-book",
      },
    ],
    observations: [],
    portalBindings: [],
    recipes: [],
    capabilities: [],
  };
}

function isProperty(value: unknown): value is Property {
  if (!value || typeof value !== "object") return false;
  const p = value as Property;
  return typeof p.id === "string" && typeof p.address === "string" && p.options != null;
}

function migrateV1(parsed: Record<string, unknown>, book: { properties: Property[]; ledger: LedgerFacts[] }): DeskFileV2 {
  const properties = Array.isArray(parsed.properties) && parsed.properties.every(isProperty) ? parsed.properties : book.properties;
  const ledgerRaw = Array.isArray(parsed.ledger) ? (parsed.ledger as LedgerFacts[]) : book.ledger;
  const drafts = Array.isArray(parsed.drafts) ? (parsed.drafts as Draft[]) : [];
  const workItems: WorkItem[] = drafts.map((draft) => ({
    id: draft.workItemId ?? `work-${draft.id}`,
    kind: "money-arrears",
    state: workStateFromV1Draft(draft.status),
    propertyId: draft.propertyId,
    occurrenceKey: `${draft.propertyId}:${draft.kind}:${draft.periodDueAt}`,
    periodDueAt: draft.periodDueAt,
    draftId: draft.id,
    recipient: { name: "", phone: "" },
    sourceIds: ["src-demo"],
    observedAt: draft.createdAt,
    proposalHash: `migrated-${draft.id}`,
    createdAt: draft.createdAt,
    updatedAt: draft.decidedAt ?? draft.createdAt,
  }));
  // Discard courtesy clocks that were inferred from an old approval.
  const ledger = ledgerRaw.map((row) => ({ ...row, daysSinceCourtesy: null }));
  return {
    version: 2,
    revision: 1,
    mode: "demo",
    timezone: hostTimezone(),
    retentionDays: 90,
    properties,
    ledger,
    drafts,
    escalations: Array.isArray(parsed.escalations) ? (parsed.escalations as Escalation[]) : [],
    workItems,
    lastRunAt: typeof parsed.lastRunAt === "number" ? parsed.lastRunAt : null,
    results: Array.isArray(parsed.results) ? (parsed.results as CheckResult[]) : [],
    hands: parsed.hands === "hermes" ? "hermes" : "demo",
    handsDetail: typeof parsed.handsDetail === "string" ? parsed.handsDetail : null,
    sources: [
      { id: "src-demo", kind: "demo", label: "Demo training book", stableKey: "demo:training-book" },
    ],
    observations: [],
    portalBindings: [],
    recipes: [],
    capabilities: [],
  };
}

function parsePlain(parsed: unknown, book: { properties: Property[]; ledger: LedgerFacts[] }): DeskFileV2 | null {
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.version === 2 && Array.isArray(rec.properties) && rec.properties.every(isProperty)) {
    const base = emptyV2(book);
    return {
      ...base,
      ...rec,
      version: 2,
      revision: typeof rec.revision === "number" ? rec.revision : 1,
      mode: rec.mode === "live" ? "live" : "demo",
      timezone: typeof rec.timezone === "string" ? rec.timezone : base.timezone,
      retentionDays: typeof rec.retentionDays === "number" ? rec.retentionDays : base.retentionDays,
      properties: rec.properties as Property[],
      ledger: Array.isArray(rec.ledger) ? (rec.ledger as LedgerFacts[]) : base.ledger,
      drafts: Array.isArray(rec.drafts) ? (rec.drafts as Draft[]) : [],
      escalations: Array.isArray(rec.escalations) ? (rec.escalations as Escalation[]) : [],
      workItems: Array.isArray(rec.workItems) ? (rec.workItems as WorkItem[]) : [],
      lastRunAt: typeof rec.lastRunAt === "number" ? rec.lastRunAt : null,
      results: Array.isArray(rec.results) ? (rec.results as CheckResult[]) : [],
      hands:
        rec.hands === "hermes" || rec.hands === "held" || rec.hands === "csv" || rec.hands === "fixture" || rec.hands === "demo"
          ? rec.hands
          : "demo",
      handsDetail: typeof rec.handsDetail === "string" ? rec.handsDetail : null,
      sources: Array.isArray(rec.sources) ? (rec.sources as SourceIdentity[]) : base.sources,
      observations: Array.isArray(rec.observations) ? (rec.observations as Observation[]) : [],
      portalBindings: Array.isArray(rec.portalBindings) ? (rec.portalBindings as PropertyPortalBinding[]) : [],
      recipes: Array.isArray(rec.recipes) ? (rec.recipes as PortalRecipe[]) : [],
      capabilities: Array.isArray(rec.capabilities) ? (rec.capabilities as PortalCapability[]) : [],
    };
  }
  if (rec.version === 1 && Array.isArray(rec.properties) && rec.properties.every(isProperty)) {
    return migrateV1(rec, book);
  }
  return null;
}

export class DeskStore {
  readonly file: string;
  readonly backupDir: string;
  private keyInfo: DeskKey;
  data: DeskFileV2;
  recovery: RecoveryState;

  constructor(opts: { file: string; book: { properties: Property[]; ledger: LedgerFacts[] }; key?: Buffer }) {
    this.file = opts.file;
    this.backupDir = join(dirname(opts.file), "desk-backups");
    this.keyInfo = loadDeskKey({ dir: dirname(opts.file), key: opts.key });
    const loaded = this.read(opts.book);
    this.data = loaded.data;
    this.recovery = loaded.recovery;
  }

  private read(book: { properties: Property[]; ledger: LedgerFacts[] }): LoadedDesk {
    if (!existsSync(this.file)) {
      const fresh = emptyV2(book);
      this.write(fresh);
      return { data: fresh, recovery: { active: false, reason: null, quarantined: [] }, key: this.keyInfo };
    }
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const inner = isEncryptedEnvelope(parsed) ? decryptJson(this.keyInfo.key, parsed) : parsed;
      const data = parsePlain(inner, book);
      if (!data) throw new Error("unrecognised desk ledger");
      return { data, recovery: { active: false, reason: null, quarantined: [] }, key: this.keyInfo };
    } catch (error) {
      const stamp = Date.now();
      const quarantine = `${this.file}.quarantine-${stamp}`;
      try {
        renameSync(this.file, quarantine);
      } catch {
        /* already gone */
      }
      const empty = emptyV2({ properties: [], ledger: [] });
      empty.mode = "live";
      empty.hands = "held";
      empty.handsDetail = "Desk is in recovery — the book was not replaced with Demo data.";
      return {
        data: empty,
        recovery: {
          active: true,
          reason: error instanceof Error ? error.message : "desk ledger could not be read",
          quarantined: [quarantine],
        },
        key: this.keyInfo,
      };
    }
  }

  persist(): void {
    if (this.recovery.active) {
      throw Object.assign(new Error("desk is read-only in recovery mode"), { status: 409 });
    }
    this.data.revision += 1;
    this.write(this.data);
    this.rotateBackup();
  }

  persistWithoutBump(): void {
    if (this.recovery.active) {
      throw Object.assign(new Error("desk is read-only in recovery mode"), { status: 409 });
    }
    this.write(this.data);
  }

  private write(data: DeskFileV2): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const envelope = encryptJson(this.keyInfo.key, data);
    writeFileAtomic(this.file, JSON.stringify(envelope));
  }

  private rotateBackup(): void {
    try {
      mkdirSync(this.backupDir, { recursive: true });
      const dest = join(this.backupDir, `desk-${this.data.revision}.json`);
      writeFileAtomic(dest, readFileSync(this.file, "utf8"));
      const files = readdirSync(this.backupDir)
        .filter((name) => name.startsWith("desk-"))
        .sort();
      while (files.length > MAX_BACKUPS) {
        const oldest = files.shift();
        if (oldest) renameSync(join(this.backupDir, oldest), join(this.backupDir, `purged-${oldest}`));
      }
    } catch {
      /* backup is best-effort */
    }
  }

  snapshotExtras(): Pick<DeskSnapshot, "version" | "revision" | "mode" | "recovery" | "timezone" | "retentionDays" | "workItems" | "sources" | "demo"> {
    return {
      version: 2,
      revision: this.data.revision,
      mode: this.data.mode,
      recovery: this.recovery,
      timezone: this.data.timezone,
      retentionDays: this.data.retentionDays,
      workItems: this.data.workItems,
      sources: this.data.sources,
      demo: this.data.mode === "demo",
    };
  }
}
