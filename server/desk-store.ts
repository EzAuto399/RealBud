// Encrypted Desk store. The committed authority is always V3; the V2 shape is
// a compatibility projection used by command reducers between transactions.
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DeskSnapshot, LedgerFacts, Property, RecoveryState } from "../shared/contracts.ts";
import type { DeskFileV2 } from "../shared/desk-v2.ts";
import { emptyV3, type DeskFileV3 } from "../shared/desk-v3.ts";
import { AtomicWriteError, writeFileAtomic } from "./atomic.ts";
import { encryptJson } from "./desk-crypto.ts";
import { loadDeskKey, type DeskKey } from "./desk-key.ts";
import { commitOrRecover } from "./desk-v3-commit.ts";
import { migrateV2ToV3 } from "./desk-v3-migrate.ts";
import { projectWorkingV2 } from "./desk-v3-project.ts";
import { failClosedRecovery, idleRecovery } from "./desk-v3-recovery.ts";
import { ensureDemoBreadth } from "./desk-v3-demo-breadth.ts";
import { syncWorkingV2IntoV3 } from "./desk-v3-sync.ts";
import { validateDeskV3 } from "./desk-v3-decode.ts";
import { applyRetentionPolicy, pruneDeskBackups } from "./desk-retention.ts";

export type { DeskFileV2 };

export interface LoadedDesk {
  data: DeskFileV2;
  v3: DeskFileV3;
  recovery: RecoveryState;
  key: DeskKey;
}

type AuthorityWriter = (path: string, data: string) => void;

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
    importIssues: [],
  };
}

export class DeskStore {
  readonly file: string;
  readonly backupDir: string;
  private keyInfo: DeskKey;
  private now: () => number;
  private authorityWriter: AuthorityWriter;
  private committedV3: DeskFileV3;
  private committedData: DeskFileV2;

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

  constructor(opts: {
    file: string;
    book: { properties: Property[]; ledger: LedgerFacts[] };
    key?: Buffer;
    now?: () => number;
    /** Fault-injection seam for transaction tests. Production uses the
     * classified, fsynced atomic writer. */
    authorityWriter?: AuthorityWriter;
  }) {
    this.file = opts.file;
    this.backupDir = join(dirname(opts.file), "desk-backups");
    this.now = opts.now ?? Date.now;
    this.authorityWriter = opts.authorityWriter ?? writeFileAtomic;
    this.keyInfo = loadDeskKey({ dir: dirname(opts.file), key: opts.key });
    const loaded = this.read(opts.book);
    this.data = loaded.data;
    this.v3 = loaded.v3;
    this.committedV3 = structuredClone(loaded.v3);
    this.committedData = structuredClone(loaded.data);
    this.recovery = loaded.recovery;
    if (!this.recovery.active) {
      try {
        pruneDeskBackups(this.backupDir, this.v3.retentionDays, this.now(), MAX_BACKUPS);
      } catch {
        this.recovery = {
          active: true,
          reason: "RealBud could not enforce the configured retention policy. The book is read-only until storage permissions are repaired.",
          quarantined: [],
        };
      }
    }
  }

  private read(book: { properties: Property[]; ledger: LedgerFacts[] }): LoadedDesk {
    if (!existsSync(this.file)) {
      const fresh = emptyV2(book);
      const now = this.now();
      const v3 = ensureDemoBreadth(migrateV2ToV3(fresh, now), now);
      this.writeV3(v3);
      return { data: projectWorkingV2(v3), v3, recovery: idleRecovery(), key: this.keyInfo };
    }
    const result = commitOrRecover({
      file: this.file,
      key: this.keyInfo.key,
      migratedAt: this.now(),
      book,
      timezone: "Australia/Sydney",
    });
    if (!result.ok) {
      if (result.landedV3) {
        return {
          data: projectWorkingV2(result.landedV3),
          v3: result.landedV3,
          recovery: result.recovery,
          key: this.keyInfo,
        };
      }
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
    const beforeOpen = JSON.stringify(result.v3);
    let opened = result.v3.mode === "demo" ? ensureDemoBreadth(result.v3, this.now()) : result.v3;
    const retained = applyRetentionPolicy(opened, this.now());
    opened = retained.book;
    if (JSON.stringify(opened) !== beforeOpen) this.writeV3(opened);
    return { data: projectWorkingV2(opened), v3: opened, recovery: idleRecovery(), key: this.keyInfo };
  }

  persist(): void {
    this.commitWorkingCopy({ bumpRevision: true, backup: true });
  }

  persistWithoutBump(): void {
    this.commitWorkingCopy({ bumpRevision: false, backup: false });
  }

  /** Pure, validated V3 view of the current working copy. Evaluation and
   * approval checks use this before a commit so V2 compatibility state can
   * never bypass evidence authority. */
  previewV3(now = this.now()): DeskFileV3 {
    const preview = ensureDemoBreadth(syncWorkingV2IntoV3(this.v3, this.data, now), now);
    validateDeskV3(preview);
    return preview;
  }

  private commitWorkingCopy(opts: { bumpRevision: boolean; backup: boolean }): void {
    if (this.recovery.active) {
      throw Object.assign(new Error("desk is read-only in recovery mode"), { status: 409 });
    }
    if (opts.bumpRevision) this.data.revision += 1;

    const now = this.now();
    const workingData = structuredClone(this.data);
    let candidate: DeskFileV3 | null = null;
    let ciphertext: string | null = null;
    try {
      const synced = ensureDemoBreadth(syncWorkingV2IntoV3(this.v3, this.data, now), now);
      candidate = applyRetentionPolicy(synced, now).book;
      validateDeskV3(candidate);
      ciphertext = JSON.stringify(encryptJson(this.keyInfo.key, candidate));
      mkdirSync(dirname(this.file), { recursive: true });
      this.authorityWriter(this.file, ciphertext);
    } catch (error) {
      const disposition = candidate && ciphertext ? this.failedWriteDisposition(error, ciphertext) : "not-landed";
      if (candidate && disposition === "landed-uncertain") {
        this.installCommitted(candidate, workingData);
        const message = "RealBud may have saved the change, but final storage durability could not be confirmed. The book is read-only until RealBud is restarted and reconciles the encrypted file.";
        this.recovery = failClosedRecovery(message);
        throw Object.assign(new Error(message), { status: 503, code: "commit-outcome-unknown", cause: error });
      }
      this.restoreCommitted();
      if (error instanceof AtomicWriteError) {
        throw Object.assign(new Error("RealBud could not save the change. Nothing was committed; retry is safe."), {
          status: 503,
          code: "commit-not-landed",
          cause: error,
        });
      }
      throw error;
    }

    this.installCommitted(candidate, workingData);
    this.finishCommitMaintenance(opts.backup);
  }

  private failedWriteDisposition(error: unknown, ciphertext: string): "not-landed" | "landed-uncertain" {
    if (error instanceof AtomicWriteError) return error.disposition;
    try {
      return readFileSync(this.file, "utf8") === ciphertext ? "landed-uncertain" : "not-landed";
    } catch {
      return "landed-uncertain";
    }
  }

  private installCommitted(candidate: DeskFileV3, workingData: DeskFileV2): void {
    // Keep the exact reducer result for the current process. V3 is still the
    // only durable authority, but the compatibility projection intentionally
    // does not persist derived run results and can normalise optional ledger
    // fields. Replacing a successful reducer with that lossy projection made
    // visible state change immediately after save. Retention-owned evidence is
    // taken back from V3 so a later commit cannot resurrect pruned records.
    const projected = projectWorkingV2(candidate);
    const installed = structuredClone(workingData);
    installed.observations = projected.observations;
    installed.importIssues = projected.importIssues;
    this.v3 = candidate;
    this.committedV3 = structuredClone(candidate);
    this.data = installed;
    this.committedData = structuredClone(installed);
  }

  private restoreCommitted(): void {
    this.v3 = structuredClone(this.committedV3);
    this.data = structuredClone(this.committedData);
  }

  private writeV3(v3: DeskFileV3): void {
    mkdirSync(dirname(this.file), { recursive: true });
    this.authorityWriter(this.file, JSON.stringify(encryptJson(this.keyInfo.key, v3)));
  }

  private finishCommitMaintenance(backup: boolean): void {
    if (backup) {
      try {
        mkdirSync(this.backupDir, { recursive: true });
        const dest = join(this.backupDir, `desk-${this.data.revision}.json`);
        writeFileAtomic(dest, readFileSync(this.file, "utf8"));
      } catch {
        /* The encrypted authority is already durable; backup is best-effort. */
      }
    }
    try {
      pruneDeskBackups(this.backupDir, this.v3.retentionDays, this.now(), MAX_BACKUPS);
    } catch (error) {
      const message = "RealBud saved the change, but could not enforce backup retention. The book is read-only until storage permissions are repaired and RealBud is restarted.";
      this.recovery = failClosedRecovery(message);
      throw Object.assign(new Error(message), { status: 503, code: "retention-cleanup-failed", cause: error });
    }
  }

  snapshotExtras(): Pick<DeskSnapshot, "version" | "revision" | "mode" | "recovery" | "timezone" | "retentionDays" | "workItems" | "sources" | "demo"> {
    const activePropertyIds = new Set(
      this.v3.properties.filter((property) => property.status === "active").map((property) => property.id),
    );
    const sources = this.data.sources.map((source) => {
      const rows = this.v3.evidence.filter((item) => item.sourceId === source.id && item.observedAt != null);
      if (!rows.length) return source;
      const observedAt = Math.max(...rows.map((item) => item.observedAt!));
      const latest = rows.filter((item) => item.observedAt === observedAt);
      const staleAt = Math.min(...latest.map((item) => item.staleAt));
      let coverage: "complete" | "incomplete" | "unknown" = "unknown";
      if (source.kind === "csv") {
        const rowsByProperty = new Map<string, typeof latest>();
        for (const item of latest) {
          if (!item.propertyId) continue;
          const bucket = rowsByProperty.get(item.propertyId) ?? [];
          bucket.push(item);
          rowsByProperty.set(item.propertyId, bucket);
        }
        coverage = [...activePropertyIds].every((propertyId) => {
          const matches = rowsByProperty.get(propertyId) ?? [];
          return matches.length === 1 && matches[0]?.payload.coverage === "observed";
        }) ? "complete" : "incomplete";
      }
      return { ...source, observedAt, staleAt, coverage };
    });
    return {
      version: 2,
      revision: this.data.revision,
      mode: this.data.mode,
      recovery: this.recovery,
      timezone: this.data.timezone,
      retentionDays: this.data.retentionDays,
      workItems: this.data.workItems,
      sources,
      demo: this.data.mode === "demo",
    };
  }
}
