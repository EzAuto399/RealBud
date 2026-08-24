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
        v3: emptyV3({ name: "", timezone: "Australia/Sydney", jurisdictions: [] }),
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
    this.data.revision += 1;
    this.flushV3();
    this.rotateBackup();
  }

  persistWithoutBump(): void {
    if (this.recovery.active) {
      throw Object.assign(new Error("desk is read-only in recovery mode"), { status: 409 });
    }
    this.flushV3();
  }

  private flushV3(): void {
    this.v3 = ensureDemoBreadth(syncWorkingV2IntoV3(this.v3, this.data, Date.now()), Date.now());
    validateDeskV3(this.v3);
    this.writeV3(this.v3);
  }

  private writeV3(v3: DeskFileV3): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(encryptJson(this.keyInfo.key, v3)));
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
