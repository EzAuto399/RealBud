// Encrypted Desk store. On-disk authority is V3 after open; Desk mutates a V2 working copy.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DeskSnapshot, LedgerFacts, Property, RecoveryState } from "../shared/contracts.ts";
import type { DeskFileV2 } from "../shared/desk-v2.ts";
import { emptyV3, type DeskFileV3 } from "../shared/desk-v3.ts";
import { writeFileAtomic } from "./atomic.ts";
import { encryptJson } from "./desk-crypto.ts";
import { loadDeskKey, type DeskKey } from "./desk-key.ts";
import { commitOrRecover } from "./desk-v3-commit.ts";
import { migrateV2ToV3 } from "./desk-v3-migrate.ts";
import { projectWorkingV2 } from "./desk-v3-project.ts";
import { idleRecovery } from "./desk-v3-recovery.ts";
import { ensureDemoBreadth } from "./desk-v3-demo-breadth.ts";
import { syncWorkingV2IntoV3 } from "./desk-v3-sync.ts";
import { validateDeskV3 } from "./desk-v3-decode.ts";

export type { DeskFileV2 };

export interface LoadedDesk {
  data: DeskFileV2;
  v3: DeskFileV3;
  recovery: RecoveryState;
  key: DeskKey;
}

const MAX_BACKUPS = 5;

export const STORAGE_FULL_MESSAGE =
  "This Mac is out of space. Nothing was lost; the last good book is kept. Free space and try again.";

function isStorageFullCode(code: unknown): boolean {
  return code === "ENOSPC" || code === "EDQUOT";
}

function throwStorageWriteError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (isStorageFullCode(code)) {
    throw Object.assign(new Error(STORAGE_FULL_MESSAGE), { status: 507, code: "storage-full" });
  }
  throw error;
}

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

export class DeskStore {
  readonly file: string;
  readonly backupDir: string;
  private keyInfo: DeskKey;
  private batchDepth = 0;
  private batchNeedsBump = false;
  /** Tests replace this to simulate a full disk without filling the machine. */
  static atomicWrite: typeof writeFileAtomic = writeFileAtomic;

  /** Recovery escrow: the book's key as hex, for the You-page reveal/copy
   * and the unlock flow. Session-gated routes only. */
  get keyHex(): string {
    return this.keyInfo.key.toString("hex");
  }

  get keyFile(): string {
    return join(dirname(this.file), "desk.key");
  }
  data: DeskFileV2;
  v3: DeskFileV3;
  recovery: RecoveryState;

  constructor(opts: { file: string; book: { properties: Property[]; ledger: LedgerFacts[] }; key?: Buffer }) {
    this.file = opts.file;
    this.backupDir = join(dirname(opts.file), "desk-backups");
    this.keyInfo = loadDeskKey({ dir: dirname(opts.file), key: opts.key });
    const loaded = this.read(opts.book);
    this.data = loaded.data;
    this.v3 = loaded.v3;
    this.recovery = loaded.recovery;
  }

  private read(book: { properties: Property[]; ledger: LedgerFacts[] }): LoadedDesk {
    if (!existsSync(this.file)) {
      const fresh = emptyV2(book);
      const v3 = ensureDemoBreadth(migrateV2ToV3(fresh, Date.now()), Date.now());
      this.writeV3(v3);
      return { data: projectWorkingV2(v3), v3, recovery: idleRecovery(), key: this.keyInfo };
    }
    const result = commitOrRecover({
      file: this.file,
      key: this.keyInfo.key,
      migratedAt: Date.now(),
      book,
      timezone: "Australia/Sydney",
    });
    if (!result.ok) {
      const quarantined: string[] = [...result.recovery.quarantined];
      if (result.phase === "decode" || result.phase === "retain-bytes") {
        const quarantine = `${this.file}.quarantine-${Date.now()}`;
        try {
          renameSync(this.file, quarantine);
          quarantined.push(quarantine);
        } catch {
          /* already gone */
        }
      }
      const empty = emptyV2({ properties: [], ledger: [] });
      empty.mode = "live";
      empty.hands = "held";
      empty.handsDetail = "Desk is in recovery — the book was not replaced with Demo data.";
      return {
        data: empty,
        v3: emptyV3({ name: "", timezone: hostTimezone(), jurisdictions: [] }),
        recovery: { ...result.recovery, quarantined },
        key: this.keyInfo,
      };
    }
    const opened = result.v3.mode === "demo" ? ensureDemoBreadth(result.v3, Date.now()) : result.v3;
    if (opened !== result.v3 || opened.mode === "demo") {
      const before = result.v3.cases.length + result.v3.contacts.length + result.v3.tenancies.length;
      const after = opened.cases.length + opened.contacts.length + opened.tenancies.length;
      if (after !== before) this.writeV3(opened);
    }
    return { data: projectWorkingV2(opened), v3: opened, recovery: idleRecovery(), key: this.keyInfo };
  }

  persist(): void {
    if (this.recovery.active) {
      throw Object.assign(new Error("desk is read-only in recovery mode"), { status: 409 });
    }
    if (this.batchDepth > 0) {
      this.batchNeedsBump = true;
      return;
    }
    this.commitWithBump();
  }

  persistWithoutBump(): void {
    if (this.recovery.active) {
      throw Object.assign(new Error("desk is read-only in recovery mode"), { status: 409 });
    }
    if (this.batchDepth > 0) {
      this.batchNeedsBump = true;
      return;
    }
    this.flushV3();
  }

  /** One encrypt/fsync/backup at the end. Nested calls share the same write. */
  runBatch<T>(fn: () => T): T {
    this.batchDepth += 1;
    try {
      return fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.batchNeedsBump) {
        this.batchNeedsBump = false;
        if (!this.recovery.active) this.commitWithBump();
      }
    }
  }

  /** Replay only the sample book. Publish one complete replacement or keep
   * both in-memory projections and the durable book exactly as they were. */
  replaySample(book: { properties: Property[]; ledger: LedgerFacts[] }, now: number, prepare: () => void): void {
    if (this.recovery.active || this.data.mode !== "demo") {
      throw Object.assign(new Error("Sample replay is only available on the sample book. Your office book has been kept."), { status: 409 });
    }
    if (this.batchDepth !== 0) throw new Error("Sample replay cannot run inside another book operation");
    const previousData = this.data;
    const previousV3 = this.v3;
    const fresh = emptyV2(book);
    fresh.revision = previousData.revision;
    fresh.timezone = previousData.timezone;
    fresh.retentionDays = previousData.retentionDays;
    fresh.recipes = structuredClone(previousData.recipes);
    const ids = new Set(book.properties.map(property => property.id));
    fresh.portalBindings = structuredClone(previousData.portalBindings.filter(binding => ids.has(binding.propertyId)));
    this.data = fresh;
    this.v3 = ensureDemoBreadth(migrateV2ToV3(fresh, now), now);
    this.v3.agency = structuredClone(previousV3.agency);
    this.v3.office = structuredClone(previousV3.office);
    this.batchDepth = 1;
    try {
      prepare();
      this.batchDepth = 0;
      this.batchNeedsBump = false;
      this.commitWithBump();
    } catch (error) {
      this.data = previousData;
      this.v3 = previousV3;
      throw error;
    } finally {
      this.batchDepth = 0;
      this.batchNeedsBump = false;
    }
  }

  private commitWithBump(): void {
    const previousRevision = this.data.revision;
    const previousV3 = this.v3;
    this.data.revision += 1;
    try {
      this.flushV3();
    } catch (error) {
      this.data.revision = previousRevision;
      this.v3 = previousV3;
      throw error;
    }
    this.rotateBackup();
  }

  private flushV3(): void {
    this.v3 = ensureDemoBreadth(syncWorkingV2IntoV3(this.v3, this.data, Date.now()), Date.now());
    validateDeskV3(this.v3);
    this.writeV3(this.v3);
  }

  private writeV3(v3: DeskFileV3): void {
    mkdirSync(dirname(this.file), { recursive: true });
    try {
      DeskStore.atomicWrite(this.file, JSON.stringify(encryptJson(this.keyInfo.key, v3)));
    } catch (error) {
      throwStorageWriteError(error);
    }
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
