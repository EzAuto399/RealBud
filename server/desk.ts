import { propertyPortalView } from "./property-portals.ts";
// Desk spine: evaluate → proposal → human decision. Encrypted v2 store.
// snapshot() is side-effect free. Approval never means sent.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { decryptJson } from "./desk-crypto.ts";
import { basename, dirname, join } from "node:path";

import type {
  DeskBookView,
  DeskSnapshot,
  CsvColumnMapping,
  CsvImportPreview,
  Draft,
  DraftKind,
  HandsSource,
  LedgerFacts,
  Property,
  PropertyOptions,
  WorkItem,
  WorkState,
} from "../shared/contracts.ts";
import { DATA_DIR } from "./config.ts";
import { persistArtifact } from "./audit-artifacts.ts";
import { parsePmsExport, resolveExportRows } from "./csv-ledger.ts";
import { runBoundedPrefill } from "./portal-handoff.ts";
import {
  applyOptions,
  composeDraft,
  dueDate,
  fixtureBook,
  shopDefaults,
  withCourtesyDisclaimer,
} from "./desk-evaluate.ts";
import { DeskStore, type DeskFileV2 } from "./desk-store.ts";
import { assertTransition, occurrenceKey, proposalHash } from "./desk-work.ts";
import { tryHermesLedger, uncoveredPropertyIds, type HermesLedgerAttempt } from "./hermes-hands.ts";
import { writeHandsLast } from "./hands-last.ts";
import { ambiguousMatchException, classifyMoneyRow, unmatchedException } from "./morning-money.ts";
import { composeOwnerLetter, ownerLetterWeekStart } from "./owner-letter.ts";
import { parseIntakeText, type IntakeItem } from "./intake.ts";
import { assertRoutineCannotMint, freezeAuthorization, withPresentation, type BrowserPresentation } from "./handoff-auth.ts";
import type { RoutineOrigin } from "../shared/contracts.ts";
import { emptyOffice, parseJurisdictions, parseOfficePatch } from "../shared/office.ts";
import { FAKE_PORTAL_RECIPE } from "./portal-recipe.ts";
import { CSV_FRESH_MS, isFresh } from "./source-gate.ts";
import {
  appendAllowedLine,
  appendAllowedLines,
  archivePropertyNote,
  readPropertyNote,
  seedVault,
  vaultDirFromDeskFile,
  writePropertyNote,
} from "./vault.ts";

const DENY_REASON_MAX = 280;

function normalizeDenyReason(reason?: string): string | undefined {
  if (typeof reason !== "string") return undefined;
  const trimmed = reason.trim().slice(0, DENY_REASON_MAX);
  return trimmed || undefined;
}

export {
  COURTESY_DISCLAIMER,
  NEVER_ACTIONS,
  applyOptions,
  aud,
  composeDraft,
  evaluateProperty,
  fixtureBook,
  shopDefaults,
  withCourtesyDisclaimer,
} from "./desk-evaluate.ts";

export type {
  BookMode,
  CheckOutcome,
  CheckReason,
  CheckResult,
  DeskSnapshot,
  Draft,
  DraftKind,
  DraftStatus,
  Escalation,
  HandsSource,
  LedgerFacts,
  LevyFromRent,
  NotifyChannel,
  Property,
  PropertyOptions,
  RentSource,
  WorkItem,
  WorkState,
} from "../shared/contracts.ts";

export interface NewPropertyInput {
  address: string;
  tenantName: string;
  tenantPhone: string;
  propertyCode?: string;
  weeklyRentCents: number;
  options?: Partial<PropertyOptions>;
}

export const MAX_BOOK_PROPERTIES = 1_000;

interface PreparedProperty {
  property: Property;
  facts: LedgerFacts;
}

export type DeskCommand =
  | { type: "allow"; draftId: string; expectedRevision: number; approver?: string; via?: string }
  | { type: "deny"; draftId: string; expectedRevision: number; via?: string }
  | { type: "edit"; draftId: string; expectedRevision: number; body: string }
  | { type: "check-demo"; expectedRevision?: number }
  | { type: "import-csv"; expectedRevision: number; csv: string; observedAt?: number; mapping?: CsvColumnMapping }
  | { type: "propose"; expectedRevision?: number; propertyId: string; kind?: DraftKind; body?: string }
  | { type: "prepare-portal"; expectedRevision: number; draftId: string }
  | { type: "handoff-ready"; expectedRevision: number; workItemId: string }
  | { type: "confirm"; expectedRevision: number; workItemId: string; attestation?: boolean }
  | { type: "effect-unknown"; expectedRevision: number; workItemId: string };

export class Desk {
  private store: DeskStore;
  private now: () => number;
  private hermes: (ids: string[]) => Promise<HermesLedgerAttempt>;
  private memberKey: string;
  private onCommit: ((snap: DeskSnapshot) => void) | null;
  private portalUrl: string | null;
  private vaultRoot: string;
  private presentation: BrowserPresentation = "side-by-side";
  private pendingOrigin?: RoutineOrigin;

  /**
   * Adopt a seat identity learned after boot (a member signing in to an office
   * host). Empty means the shared base worker profile. The value is the member
   * id — never a display or login name, which are mutable and reassignable.
   */
  setMemberKey(memberKey: string): void {
    this.memberKey = (memberKey ?? "").trim();
  }

  /**
   * The seat identity this desk serves, for anything that must be bound per seat
   * rather than per office — currently the Composio `user_id`, so two PMs in one
   * office do not share one set of connected accounts. Empty for a single-seat desk.
   */
  memberKeyForWorker(): string {
    return this.memberKey;
  }

  constructor(opts?: {
    file?: string;
    now?: () => number;
    key?: Buffer;
    hermes?: (ids: string[]) => Promise<HermesLedgerAttempt>;
    onCommit?: (snap: DeskSnapshot) => void;
    portalUrl?: string;
    vaultDir?: string;
    /**
     * The seat this desk serves. Empty/omitted means the shared base worker
     * profile, which is every single-seat install. See `server/config.ts`
     * MEMBER_KEY for why this is a uuid and not a display name.
     */
    memberKey?: string;
  }) {
    this.now = opts?.now ?? Date.now;
    this.memberKey = (opts?.memberKey ?? "").trim();
    this.hermes = opts?.hermes ?? ((ids) => tryHermesLedger(ids, { memberKey: this.memberKey }));
    this.onCommit = opts?.onCommit ?? null;
    this.portalUrl = opts?.portalUrl ?? process.env.FAKE_PORTAL_URL ?? null;
    const file = opts?.file ?? join(DATA_DIR, "desk.json");
    this.vaultRoot = opts?.vaultDir ?? vaultDirFromDeskFile(file);
    seedVault(this.vaultRoot);
    this.store = new DeskStore({
      file,
      book: fixtureBook(),
      key: opts?.key,
    });
    if (this.store.data.recipes.length === 0 && !this.store.recovery.active) {
      this.store.data.recipes.push({ ...FAKE_PORTAL_RECIPE });
      this.store.data.portalBindings.push({
        propertyId: "prop-oak",
        recipeId: FAKE_PORTAL_RECIPE.id,
        recipeVersion: FAKE_PORTAL_RECIPE.version,
        remotePropertyId: "oak-1",
      });
      this.store.persistWithoutBump();
    }
  }

  get revision(): number {
    return this.store.data.revision;
  }

  get recovery() {
    return this.store.recovery;
  }

  snapshot(): DeskSnapshot {
    const d = this.store.data;
    const extras = this.store.snapshotExtras();
    return {
      ...extras,
      properties: d.properties.map((p) => ({ ...p, notes: readPropertyNote(p.id, this.vaultRoot) })),
      ledger: d.ledger,
      drafts: d.drafts,
      escalations: d.escalations,
      lastRunAt: d.lastRunAt,
      results: d.results,
      hands: d.hands,
      handsDetail: d.handsDetail,
      book: this.bookView(),
    };
  }

  async withRoutineOrigin<T>(origin: RoutineOrigin, fn: () => T | Promise<T>): Promise<T> {
    this.pendingOrigin = origin;
    try {
      return await fn();
    } finally {
      this.pendingOrigin = undefined;
    }
  }

  setPresentation(presentation: BrowserPresentation): DeskSnapshot {
    if (presentation !== "side-by-side" && presentation !== "inspector" && presentation !== "window") {
      throw Object.assign(new Error("unknown browser presentation"), { status: 400 });
    }
    this.presentation = presentation;
    return this.snapshot();
  }

  private bookView(): DeskBookView {
    const v3 = this.store.v3;
    const live = v3.handoffs.find((item) => !item.usedAt && !item.invalidatedAt);
    let handoff: DeskBookView["handoff"];
    if (live) {
      try {
        const frozen = freezeAuthorization(live.authorization);
        const auth = withPresentation(frozen, this.presentation);
        handoff = {
          caseId: auth.caseId,
          origin: auth.allowedOrigins[0] ?? "",
          allowedActions: auth.allowedActions,
          expiresAt: auth.expiresAt,
          presentation: this.presentation,
        };
      } catch {
        handoff = undefined;
      }
    }
    return {
      agency: {
        name: v3.agency.name,
        timezone: v3.agency.timezone,
        jurisdictions: v3.agency.jurisdictions,
      },
      office: { ...(v3.office ?? emptyOffice()) },
      propertyPortals: propertyPortalView(new Set(this.store.data.properties.map(p => p.id)), this.store.data.portalBindings, this.store.data.recipes),
      tenancies: v3.tenancies.map((item) => ({
        id: item.id,
        propertyId: item.propertyId,
        status: item.status,
        weeklyRentCents: item.weeklyRentCents,
        closedAt: item.closedAt,
      })),
      contacts: v3.contacts.map((item) => ({
        id: item.id,
        role: item.role,
        name: item.name,
        phone: item.phone,
        propertyId: item.propertyId,
        tenancyId: item.tenancyId,
        safeguards: item.safeguards,
      })),
      archivedProperties: v3.properties
        .filter((item) => item.status === "archived")
        .map((item) => ({ id: item.id, address: item.address, archivedAt: item.archivedAt })),
      importIssues: v3.importIssues.map((item) => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        rawIdentity: item.rawIdentity,
      })),
      bookProposals: v3.bookProposals.map((item) => ({
        id: item.id,
        address: item.fields.address,
        tenantName: item.fields.tenantName,
        tenantPhone: item.fields.tenantPhone,
        weeklyRentCents: item.fields.weeklyRentCents,
        origin: item.origin,
      })),
      cases: v3.cases.map((item) => ({
        id: item.id,
        kind: item.kind,
        state: item.state,
        propertyId: item.propertyId,
        origin: item.origin,
      })),
      decisions: v3.decisions.map((item) => ({
        id: item.id,
        caseId: v3.proposals.find((proposal) => proposal.id === item.proposalId)?.caseId ?? "",
        proposalId: item.proposalId,
        revisionId: item.revisionId,
        action: item.kind,
        actor: item.actorId,
        at: item.at,
      })),
      handoff,
    };
  }

  /** Training / Demo book only. Never counts as a live check. */
  runMorningCheck(): DeskSnapshot {
    this.assertWritable();
    return this.evaluateBook("demo", "Demo book — Recheck asks Bud or a CSV for live facts.");
  }

  /** Live recheck. A miss never fabricates rows or a finished morning. */
  async runMorningCheckLive(): Promise<DeskSnapshot> {
    this.assertWritable();
    const startedAtRevision = this.store.data.revision;
    const ids = this.store.data.properties.map((p) => p.id);
    const attempt = await this.hermes(ids);
    // The provider is the only await inside a Desk check. A PM may keep
    // working (or explicitly choose the sample book) while it is away; never
    // let that older response overwrite a newer durable Desk decision.
    if (this.store.data.revision !== startedAtRevision) {
      throw Object.assign(new Error("Desk changed while Bud was checking. The newer work was kept; run Recheck again."), {
        status: 409,
      });
    }
    if (attempt.rows) {
      const requested = new Set(ids);
      const covered = attempt.rows.filter((row) => requested.has(row.propertyId));
      const missing = uncoveredPropertyIds(ids, covered);
      for (const row of covered) {
        const idx = this.store.data.ledger.findIndex((item) => item.propertyId === row.propertyId);
        if (idx >= 0) this.store.data.ledger[idx] = row;
        else this.store.data.ledger.push(row);
      }
      this.observe("src-hermes", "hermes", "Worker ledger", covered);
      if (missing.length) {
        const now = this.now();
        for (const propertyId of missing) {
          this.holdWork({
            propertyId,
            reason: "uncovered-by-worker",
            daysLate: this.facts(propertyId).daysSinceDue,
            observedAt: now,
            sourceId: "src-hermes",
            detail: "the worker did not return live facts for this property",
          });
        }
        const snap = this.evaluateBook(
          "held",
          `Worker answered ${covered.length} of ${ids.length} properties. Uncovered stay held.`,
          new Set(missing),
        );
        this.recordHandsLast(false, snap.handsDetail ?? "held");
        return snap;
      }
      const snap = this.evaluateBook("hermes", attempt.detail);
      this.recordHandsLast(true, snap.handsDetail ?? attempt.detail);
      return snap;
    }
    if (this.store.data.mode === "demo") {
      return this.recordDemoMiss(attempt.detail);
    }
    this.stampSource("src-hermes", "hermes", "Worker ledger");
    this.holdBook(attempt.detail);
    this.recordHandsLast(false, attempt.detail);
    return this.snapshot();
  }

  batch<T>(fn: () => T): T {
    return this.store.runBatch(fn);
  }

  patchAgency(input: { name?: string; jurisdictions?: string[]; office?: unknown; expectedRevision?: unknown }): DeskSnapshot {
    this.assertWritable();
    // Validate the complete patch before changing any in-memory field.
    const name = input.name !== undefined ? String(input.name).trim() : undefined;
    if (name !== undefined) {
      if (!name) throw Object.assign(new Error("agency name required"), { status: 400 });
      if (name.length > 80) throw Object.assign(new Error("agency name is too long"), { status: 400 });
    }
    const jurisdictions = input.jurisdictions ? parseJurisdictions(input.jurisdictions) : undefined;
    const office = input.office !== undefined ? parseOfficePatch(input.office) : undefined;
    if (office && !office.ok) throw Object.assign(new Error(office.error), { status: 400 });
    const editsWorkflow = office?.ok && office.value.rentWorkflow !== undefined;
    if ((editsWorkflow || input.expectedRevision !== undefined) &&
      (typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) {
      throw Object.assign(new Error("A valid book revision is required to save these office settings."), { status: 400 });
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== this.revision) {
      throw Object.assign(new Error("The book changed while you were editing. Your edits are kept. Reload saved settings before applying them again."), { status: 409, code: "revision-conflict" });
    }
    const previousAgency = this.store.v3.agency;
    const previousOffice = this.store.v3.office;
    this.store.v3.agency = { ...previousAgency, ...(name !== undefined ? { name } : {}), ...(jurisdictions ? { jurisdictions } : {}) };
    if (office?.ok) this.store.v3.office = { ...(this.store.v3.office ?? emptyOffice()), ...office.value };
    try {
      this.store.persist();
    } catch (error) {
      this.store.v3.agency = previousAgency;
      this.store.v3.office = previousOffice;
      throw error;
    }
    this.emit();
    return this.snapshot();
  }

  allowAllBookProposals(): DeskSnapshot {
    this.assertWritable();
    const proposals = this.store.v3.bookProposals.filter((proposal) => proposal.status === "open");
    if (!proposals.length) return this.snapshot();
    const capacity = MAX_BOOK_PROPERTIES - this.store.data.properties.length;
    if (proposals.length > capacity) {
      throw Object.assign(
        new Error(`This book can add ${Math.max(0, capacity)} more properties (limit ${MAX_BOOK_PROPERTIES}). No proposals were added.`),
        { status: 400 },
      );
    }
    const addresses = new Set(this.store.data.properties.map((property) => property.address.toLowerCase()));
    const codes = new Set(
      this.store.data.properties.map((property) => property.propertyCode?.toLowerCase()).filter((code): code is string => Boolean(code)),
    );
    const ids = new Set(this.store.data.properties.map((property) => property.id));
    const prepared = proposals.map((proposal) =>
      this.prepareProperty(
        {
          address: proposal.fields.address,
          tenantName: proposal.fields.tenantName,
          tenantPhone: proposal.fields.tenantPhone,
          weeklyRentCents: proposal.fields.weeklyRentCents,
        },
        addresses,
        codes,
        ids,
      ),
    );
    const proposalIds = new Set(proposals.map((proposal) => proposal.id));
    this.store.runBatch(() => {
      for (const row of prepared) this.insertProperty(row);
      this.store.v3.bookProposals = this.store.v3.bookProposals.filter((proposal) => !proposalIds.has(proposal.id));
      if (this.store.data.lastRunAt != null) {
        this.reevaluateOrKeepMiss({ stampRun: false });
      } else {
        this.store.persist();
      }
    });
    try {
      appendAllowedLines(
        prepared.map((row, index) => ({
          id: row.property.id,
          address: row.property.address,
          line: `added from ${proposals[index]?.origin === "ask" ? "Bud intake" : "intake"} — ${row.property.address}, ${row.property.tenantName}`,
        })),
        this.vaultRoot,
      );
    } catch (cause) {
      console.warn("RealBud saved the bulk intake but could not append every private intake note", {
        count: prepared.length,
        error: cause instanceof Error ? cause.name : "UnknownError",
      });
    }
    this.emit();
    return this.snapshot();
  }

  previewCsv(csv: string, observedAt = this.now(), mapping?: CsvColumnMapping): Omit<CsvImportPreview, "digest"> {
    this.assertWritable();
    const batch = parsePmsExport(csv, observedAt, "src-csv", mapping);
    const resolved = resolveExportRows(this.store.data.properties, batch.rows);
    const addressById = new Map(this.store.data.properties.map((property) => [property.id, property.address]));
    return {
      expectedRevision: this.revision,
      observedAt: batch.observedAt,
      totalRows: batch.rows.length,
      matched: resolved.matched.map((row) => ({
        propertyId: row.propertyId,
        address: addressById.get(row.propertyId) ?? row.propertyId,
      })),
      unmatched: resolved.unmatched.map((row) => ({ ...row.identity })),
      ambiguous: resolved.ambiguous.map((hit) => ({
        ...hit.row.identity,
        matchCount: hit.ids.length,
      })),
      headers: batch.headers,
      detected: batch.detected,
      rejected: batch.rejected,
    };
  }

  importCsv(csv: string, observedAt = this.now(), mapping?: CsvColumnMapping): DeskSnapshot {
    this.assertWritable();
    const batch = parsePmsExport(csv, observedAt, "src-csv", mapping);
    if (!isFresh(batch.observedAt, CSV_FRESH_MS, this.now())) {
      this.stampSource("src-csv", "csv", "PMS CSV export");
      this.holdBook("CSV batch is stale");
      return this.snapshot();
    }
    // Ambiguous and unmatched rows become held work items on Desk; only a
    // broken schema (thrown in parsePmsExport) rejects the whole batch.
    const resolved = resolveExportRows(this.store.data.properties, batch.rows);
    const previous = this.store.data.ledger.map((row) => ({ ...row }));
    try {
      for (const row of resolved.matched) {
        const idx = this.store.data.ledger.findIndex((item) => item.propertyId === row.propertyId);
        if (idx >= 0) this.store.data.ledger[idx] = row;
        else this.store.data.ledger.push(row);
      }
      for (const row of resolved.unmatched) {
        this.holdWork(unmatchedException(row.identity.value, batch.observedAt, batch.sourceId));
      }
      for (const hit of resolved.ambiguous) {
        this.holdWork(ambiguousMatchException(hit.row.identity.value, hit.ids, batch.observedAt, batch.sourceId));
      }
    } catch (err) {
      this.store.data.ledger = previous;
      throw err;
    }
    const held = resolved.unmatched.length + resolved.ambiguous.length;
    if (!resolved.matched.length) {
      // Nothing usable in the batch: holds are recorded on Desk, but the
      // book keeps its current hands. Fixture facts never pose as live.
      this.store.persist();
      this.emit();
      return this.snapshot();
    }
    this.store.data.mode = "live";
    this.observe("src-csv", "csv", "PMS CSV export", resolved.matched);
    return this.evaluateBook(
      "csv",
      `CSV import accepted ${resolved.matched.length} row${resolved.matched.length === 1 ? "" : "s"}` +
        (held ? `; ${held} held for mapping on Desk.` : "."),
    );
  }

  /** Bud/intake: stage add-property proposals from structured items or raw
   * pasted text. Nothing touches the book until the PM allows each card. */
  proposeBook(input: { text?: string; items?: IntakeItem[] }, origin: "ask" | "manual" = "ask"): { created: number; skipped: number; unparsed: string[] } {
    this.assertWritable();
    let items = input.items;
    let unparsed: string[] = [];
    if (!items && input.text !== undefined) {
      const parsed = parseIntakeText(input.text);
      items = parsed.items;
      unparsed = parsed.unparsed;
    }
    if ((items?.length ?? 0) > MAX_BOOK_PROPERTIES) {
      throw Object.assign(new Error(`Stage at most ${MAX_BOOK_PROPERTIES} properties at a time.`), { status: 400 });
    }
    const now = this.now();
    let created = 0;
    let skipped = 0;
    const proposalKeys = new Set(
      this.store.v3.bookProposals.map((proposal) => `${proposal.fields.address.toLowerCase()}|${proposal.fields.tenantName.toLowerCase()}`),
    );
    const propertyAddresses = new Set(this.store.data.properties.map((property) => property.address.toLowerCase()));
    for (const item of items ?? []) {
      const address = String(item.address ?? "").trim();
      const tenantName = String(item.tenantName ?? "").trim();
      const tenantPhone = String(item.tenantPhone ?? "").trim();
      const weeklyRentCents = Math.round(Number(item.weeklyRentCents));
      if (!address || !tenantName || !tenantPhone || !Number.isInteger(weeklyRentCents) || weeklyRentCents <= 0) {
        skipped++;
        continue;
      }
      const key = `${address.toLowerCase()}|${tenantName.toLowerCase()}`;
      const exists = proposalKeys.has(key) || propertyAddresses.has(address.toLowerCase());
      if (exists) {
        skipped++;
        continue;
      }
      this.store.v3.bookProposals.push({
        id: `book-${randomUUID().slice(0, 8)}`,
        kind: "add-property",
        status: "open",
        origin,
        fields: { address, tenantName, tenantPhone, weeklyRentCents },
        createdAt: now,
      });
      proposalKeys.add(key);
      created++;
    }
    if (created || skipped) {
      this.store.persistWithoutBump();
      this.emit();
    }
    return { created, skipped, unparsed };
  }

  allowBookProposal(id: string): DeskSnapshot {
    this.assertWritable();
    const idx = this.store.v3.bookProposals.findIndex((p) => p.id === id && p.status === "open");
    if (idx < 0) throw Object.assign(new Error("no such book proposal"), { status: 404 });
    const proposal = this.store.v3.bookProposals[idx]!;
    const added = this.addProperty({
      address: proposal.fields.address,
      tenantName: proposal.fields.tenantName,
      tenantPhone: proposal.fields.tenantPhone,
      weeklyRentCents: proposal.fields.weeklyRentCents,
    });
    const property = added.properties.find((p) => p.address === proposal.fields.address);
    if (property) {
      appendAllowedLine(property.id, `added from ${proposal.origin === "ask" ? "Bud intake" : "intake"} — ${proposal.fields.address}, ${proposal.fields.tenantName}`, this.vaultRoot, proposal.fields.address);
    }
    this.store.v3.bookProposals.splice(idx, 1);
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  denyBookProposal(id: string): DeskSnapshot {
    this.assertWritable();
    const idx = this.store.v3.bookProposals.findIndex((p) => p.id === id);
    if (idx < 0) throw Object.assign(new Error("no such book proposal"), { status: 404 });
    this.store.v3.bookProposals.splice(idx, 1);
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  /** Recovery escrow: the book key as hex (You-page reveal/copy). */
  recoveryKeyHex(): string {
    return this.store.keyHex;
  }

  get keyFilePath(): string {
    return this.store.keyFile;
  }

  /** Unlock a quarantined book with the escrowed key: try every quarantined
   * snapshot, and on the first that decrypts, restore the key + book files and
   * reopen in memory so Ask does not need a manual restart click. */
  unlockWithKey(keyHex: string): { ok: true; restoredFrom: string; needsRestart: false } {
    const clean = String(keyHex ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(clean)) {
      throw Object.assign(new Error("the recovery key is 64 hex characters"), { status: 400 });
    }
    const key = Buffer.from(clean, "hex");
    const dir = dirname(this.keyFilePath);
    const candidates = this.store.recovery.quarantined.length
      ? [...this.store.recovery.quarantined]
      : readdirSync(dir).filter((f) => f.startsWith("desk.json.quarantine-")).map((f) => join(dir, f));
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        const envelope = JSON.parse(readFileSync(candidate, "utf8"));
        decryptJson(key, envelope);
      } catch {
        continue;
      }
      writeFileSync(this.keyFilePath, key, { mode: 0o600 });
      const deskFile = this.keyFilePath.replace(/desk\.key$/, "desk.json");
      if (existsSync(deskFile) && deskFile !== candidate) {
        renameSync(deskFile, `${deskFile}.replaced-${Date.now()}`);
      }
      renameSync(candidate, deskFile);
      this.store.reopen({ properties: [], ledger: [] }, key);
      this.emit();
      return { ok: true, restoredFrom: candidate, needsRestart: false };
    }
    throw Object.assign(new Error("that key does not open the quarantined book"), { status: 403 });
  }

  /** When recovery is active, try the session key and any leftover desk.key file. */
  tryAutoUnlock(): { ok: true; restoredFrom: string } | { ok: false; detail: string } {
    if (!this.store.recovery.active) return { ok: false, detail: "Desk is not in recovery." };
    const tried = new Set<string>();
    const attempts: string[] = [this.recoveryKeyHex()];
    try {
      if (existsSync(this.keyFilePath)) {
        const raw = readFileSync(this.keyFilePath);
        if (raw.length === 32) attempts.push(raw.toString("hex"));
        else {
          const text = raw.toString("utf8").trim().toLowerCase();
          if (/^[0-9a-f]{64}$/.test(text)) attempts.push(text);
        }
      }
    } catch {
      /* best-effort file probe */
    }
    let lastDetail = "that key does not open the quarantined book";
    for (const hex of attempts) {
      if (tried.has(hex)) continue;
      tried.add(hex);
      try {
        const result = this.unlockWithKey(hex);
        return { ok: true, restoredFrom: result.restoredFrom };
      } catch (cause) {
        lastDetail = cause instanceof Error ? cause.message : String(cause);
      }
    }
    return { ok: false, detail: lastDetail };
  }

  startAgain(confirmation: string): { ok: true; needsRestart: true; preserved: string[] } {
    if (!this.store.recovery.active) {
      throw Object.assign(new Error("Desk is not in recovery"), { status: 409 });
    }
    if (confirmation !== "START AGAIN") {
      throw Object.assign(new Error("type START AGAIN to confirm"), { status: 400 });
    }
    const stamp = this.now();
    const preserved = this.store.recovery.quarantined.filter((path) => existsSync(path)).map((path) => basename(path));
    const currentBook = this.keyFilePath.replace(/desk\.key$/, "desk.json");
    for (const [source, label] of [[this.keyFilePath, "desk.key"], [currentBook, "desk.json"]] as const) {
      if (!existsSync(source)) continue;
      const destination = join(dirname(source), `${label}.abandoned-${stamp}`);
      renameSync(source, destination);
      preserved.push(basename(destination));
    }
    return { ok: true, needsRestart: true, preserved };
  }

  resetFixtures(): DeskSnapshot {
    this.assertWritable();
    this.store.replaySample(fixtureBook(), this.now(), () => {
      this.evaluateBook("demo", "Sample morning replayed.", undefined, { emit: false });
    });
    this.emit();
    return this.snapshot();
  }

  patchProperty(id: string, patch: Partial<PropertyOptions>): Property {
    this.assertWritable();
    const property = this.store.data.properties.find((p) => p.id === id);
    if (!property) throw Object.assign(new Error("no such property"), { status: 404 });
    const options = { ...property.options };
    applyOptions(options, patch);
    property.options = options;
    this.invalidateCapabilities({ propertyId: id });
    // A rule moved, so cards computed under the old rule are stale. Recompute
    // from the facts already on the book. An unchecked book has nothing to
    // recompute — evaluating there would invent cards from fixture facts.
    if (this.store.data.lastRunAt != null) {
      this.reevaluateOrKeepMiss({ stampRun: false });
    } else {
      this.store.persist();
      this.emit();
    }
    return property;
  }

  addProperty(input: NewPropertyInput): DeskSnapshot {
    this.assertWritable();
    if (this.store.data.properties.length >= MAX_BOOK_PROPERTIES) {
      throw Object.assign(new Error(`the book is full (${MAX_BOOK_PROPERTIES} properties)`), { status: 400 });
    }
    const prepared = this.prepareProperty(input);
    this.insertProperty(prepared);
    writePropertyNote(prepared.property.id, "", { address: prepared.property.address }, this.vaultRoot);
    // Book membership changed — recompute cards from facts already on the book.
    // Do not stamp lastRunAt: adding a row is not a Recheck. Unchecked books
    // stay empty of cards until a real check (same honesty as patchProperty).
    if (this.store.data.lastRunAt != null) {
      return this.reevaluateOrKeepMiss({ stampRun: false });
    }
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  private prepareProperty(
    input: NewPropertyInput,
    addresses = new Set(this.store.data.properties.map((property) => property.address.toLowerCase())),
    codes = new Set(
      this.store.data.properties.map((property) => property.propertyCode?.toLowerCase()).filter((code): code is string => Boolean(code)),
    ),
    ids = new Set(this.store.data.properties.map((property) => property.id)),
  ): PreparedProperty {
    const address = String(input.address ?? "").trim();
    const tenantName = String(input.tenantName ?? "").trim();
    const tenantPhone = String(input.tenantPhone ?? "").trim();
    const propertyCode = String(input.propertyCode ?? "").trim();
    const rent = Number(input.weeklyRentCents);
    if (!address) throw Object.assign(new Error("address required"), { status: 400 });
    if (address.length > 160) throw Object.assign(new Error("address is too long"), { status: 400 });
    if (propertyCode.length > 80) throw Object.assign(new Error("property code is too long"), { status: 400 });
    if (!tenantName) throw Object.assign(new Error("tenant name required"), { status: 400 });
    if (!Number.isInteger(rent) || rent <= 0) throw Object.assign(new Error("weekly rent required"), { status: 400 });
    if (addresses.has(address.toLowerCase())) {
      throw Object.assign(new Error("that address is already on the book"), { status: 409 });
    }
    if (propertyCode && codes.has(propertyCode.toLowerCase())) {
      throw Object.assign(new Error("that property code is already on the book"), { status: 409 });
    }

    const options = shopDefaults();
    if (input.options) applyOptions(options, input.options);
    let id = `prop-${randomUUID().slice(0, 8)}`;
    while (ids.has(id)) id = `prop-${randomUUID().slice(0, 8)}`;
    addresses.add(address.toLowerCase());
    if (propertyCode) codes.add(propertyCode.toLowerCase());
    ids.add(id);
    return {
      property: { id, address, tenantName, tenantPhone, weeklyRentCents: rent, options, ...(propertyCode ? { propertyCode } : {}) },
      facts: {
        propertyId: id,
        daysSinceDue: 0,
        rentLanded: false,
        levyPaid: false,
        daysSinceCourtesy: null,
      },
    };
  }

  private insertProperty(prepared: PreparedProperty): void {
    this.store.data.properties.push(prepared.property);
    this.store.data.ledger.push(prepared.facts);
  }

  removeProperty(id: string): DeskSnapshot {
    this.assertWritable();
    if (!this.store.data.properties.some((p) => p.id === id)) {
      throw Object.assign(new Error("no such property"), { status: 404 });
    }
    this.store.data.properties = this.store.data.properties.filter((p) => p.id !== id);
    this.store.data.ledger = this.store.data.ledger.filter((r) => r.propertyId !== id);
    this.store.data.drafts = this.store.data.drafts.filter((d) => d.propertyId !== id);
    this.store.data.escalations = this.store.data.escalations.filter((e) => e.propertyId !== id);
    this.store.data.results = this.store.data.results.filter((r) => r.propertyId !== id);
    this.store.data.workItems = this.store.data.workItems.filter((w) => w.propertyId !== id);
    this.invalidateCapabilities({ propertyId: id });
    archivePropertyNote(id, this.vaultRoot);
    if (this.store.data.lastRunAt != null) {
      return this.reevaluateOrKeepMiss({ stampRun: false });
    }
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  writeNotes(id: string, body: string): { id: string; body: string } {
    this.assertWritable();
    const property = this.store.data.properties.find((p) => p.id === id);
    if (!property) throw Object.assign(new Error("no such property"), { status: 404 });
    const next = writePropertyNote(id, body, { address: property.address }, this.vaultRoot);
    this.emit();
    return { id, body: next };
  }

  notesFor(id: string): { id: string; body: string } {
    const property = this.store.data.properties.find((p) => p.id === id);
    if (!property) throw Object.assign(new Error("no such property"), { status: 404 });
    return { id, body: readPropertyNote(id, this.vaultRoot) };
  }

  /** Ask/Bud path: same pending Desk card morning check would create. */
  proposeFromAsk(input: { propertyId: string; kind?: DraftKind; body?: string; expectedRevision?: number }): DeskSnapshot {
    this.assertWritable();
    if (input.expectedRevision != null && input.expectedRevision !== this.store.data.revision) {
      throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    }
    const property = this.store.data.properties.find((p) => p.id === input.propertyId);
    if (!property) throw Object.assign(new Error("no such property"), { status: 404 });
    const kind: DraftKind = input.kind === "levy-from-rent" ? "levy-from-rent" : "courtesy-rent";
    if (kind === "levy-from-rent" && !property.options.levyFromRent) {
      throw Object.assign(new Error("no levy-from-rent on this property"), { status: 400 });
    }
    const pending = this.store.data.drafts.find((d) => d.propertyId === property.id && d.kind === kind && d.status === "pending");
    if (pending) return this.snapshot();
    const now = this.now();
    const facts = this.facts(property.id);
    const draft = composeDraft(property, facts, now, kind);
    if (input.body?.trim()) {
      draft.body = kind === "courtesy-rent" ? withCourtesyDisclaimer(input.body) : input.body.trim();
    }
    const work = this.newWork(property, draft, now, "proposed", ["src-ask"]);
    draft.workItemId = work.id;
    this.store.data.drafts.push(draft);
    this.store.data.workItems.push(work);
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  /** Friday owner letter v0: one factual catch-up per property per week,
   * drafted from Desk facts + Notes. Copy-only — the clock and Run now both
   * land here; nothing leaves without the PM. */
  draftOwnerLetters(): DeskSnapshot {
    this.assertWritable();
    const now = this.now();
    const weekStart = ownerLetterWeekStart(now);
    for (const property of this.store.data.properties) {
      const exists = this.store.data.drafts.some(
        (d) => d.propertyId === property.id && d.kind === "owner-letter" && d.periodDueAt === weekStart,
      );
      if (exists) continue;
      const facts = this.facts(property.id);
      const note = readPropertyNote(property.id, this.vaultRoot);
      const draft = composeOwnerLetter(property, facts, note, now);
      const work = this.newWork(property, draft, now, "proposed", ["src-desk"]);
      draft.workItemId = work.id;
      this.store.data.drafts.push(draft);
      this.store.data.workItems.push(work);
    }
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  allowDraft(id: string, expectedRevision?: number, via?: string): Draft {
    return this.command({ type: "allow", draftId: id, expectedRevision: expectedRevision ?? this.store.data.revision, via }).drafts.find((d) => d.id === id)!;
  }

  denyDraft(id: string, expectedRevision?: number, via?: string, reason?: string): Draft {
    const note = normalizeDenyReason(reason);
    const draft = this.command({
      type: "deny",
      draftId: id,
      expectedRevision: expectedRevision ?? this.store.data.revision,
      via,
    }).drafts.find((d) => d.id === id)!;
    if (note) this.appendDenyReason(draft.propertyId, note);
    return draft;
  }

  editDraft(id: string, body: string, expectedRevision?: number): Draft {
    return this.command({ type: "edit", draftId: id, expectedRevision: expectedRevision ?? this.store.data.revision, body }).drafts.find((d) => d.id === id)!;
  }

  command(cmd: DeskCommand): DeskSnapshot {
    this.assertWritable();
    if ("expectedRevision" in cmd && cmd.expectedRevision != null && cmd.expectedRevision !== this.store.data.revision) {
      throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    }
    switch (cmd.type) {
      case "check-demo":
        return this.runMorningCheck();
      case "import-csv":
        return this.importCsv(cmd.csv, cmd.observedAt, cmd.mapping);
      case "propose":
        return this.proposeFromAsk(cmd);
      case "allow":
        this.decide(cmd.draftId, "approved", cmd.approver ?? "pm", cmd.via);
        break;
      case "deny":
        this.decide(cmd.draftId, "denied", "pm", cmd.via);
        break;
      case "edit":
        this.edit(cmd.draftId, cmd.body);
        break;
      case "prepare-portal":
        this.preparePortal(cmd.draftId);
        break;
      case "handoff-ready":
        this.setWork(cmd.workItemId, "handoff-ready");
        break;
      case "confirm":
        this.setWork(cmd.workItemId, "confirmed");
        break;
      case "effect-unknown":
        this.setWork(cmd.workItemId, "effect-unknown");
        break;
    }
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  capabilityFor(draftId: string) {
    const draft = this.store.data.drafts.find((d) => d.id === draftId);
    if (!draft?.workItemId) return null;
    return this.store.data.capabilities.find((c) => c.workItemId === draft.workItemId && !c.usedAt && !c.invalidatedAt) ?? null;
  }

  private isDemoWorkerMiss(detail = this.store.data.handsDetail): boolean {
    if (this.store.data.hands !== "demo" || !detail) return false;
    return !/^Demo book/.test(detail);
  }

  private reevaluateOrKeepMiss(opts?: { stampRun?: boolean }): DeskSnapshot {
    if (this.isDemoWorkerMiss()) {
      this.store.persist();
      this.emit();
      return this.snapshot();
    }
    return this.evaluateBook(this.store.data.hands, this.store.data.handsDetail, undefined, opts);
  }

  /** Live Recheck missed on the Demo book. Do not draft fixture cards. */
  private recordDemoMiss(detail: string): DeskSnapshot {
    const now = this.now();
    this.stampSource("src-hermes", "hermes", "Worker ledger");
    this.store.data.lastRunAt = now;
    this.store.data.hands = "demo";
    this.store.data.handsDetail = detail;
    this.store.data.results = [];
    this.store.persist();
    this.emit();
    this.recordHandsLast(false, detail);
    return this.snapshot();
  }

  /** `stampRun: false` recomputes cards from facts already on the book without
   * claiming a fresh check — a rule changed, nothing was re-read. */
  private evaluateBook(
    hands: HandsSource,
    handsDetail: string | null,
    skipIds?: ReadonlySet<string>,
    opts?: { stampRun?: boolean; emit?: boolean },
  ): DeskSnapshot {
    const now = this.now();
    const results = [];
    for (const property of this.store.data.properties) {
      if (skipIds?.has(property.id)) {
        results.push({ propertyId: property.id, outcome: "hold" as const, reason: "uncovered-by-worker" as const, daysLate: this.facts(property.id).daysSinceDue });
        continue;
      }
      const facts = this.facts(property.id);
      const classified = classifyMoneyRow(property, facts, now, hands === "csv" ? "src-csv" : hands === "hermes" ? "src-hermes" : "src-demo");
      results.push({ propertyId: classified.propertyId, outcome: classified.outcome, reason: classified.reason, daysLate: classified.daysLate });
      const periodDueAt = dueDate(now, facts.daysSinceDue);
      if (classified.outcome === "hold") {
        this.holdWork(classified);
      } else if (classified.outcome === "draft") {
        const kind: DraftKind = classified.reason === "rent-landed-levy-unpaid" ? "levy-from-rent" : "courtesy-rent";
        const key = occurrenceKey(property.id, kind, periodDueAt);
        const exists = this.store.data.drafts.some((d) => d.propertyId === property.id && d.kind === kind);
        const workExists = this.store.data.workItems.some((w) => w.occurrenceKey === key && w.state !== "superseded" && w.state !== "cancelled");
        if (!exists && !workExists) {
          const draft = composeDraft(property, facts, now, kind);
          const work = this.newWork(property, draft, now, "proposed", [classified.sourceId]);
          draft.workItemId = work.id;
          this.store.data.drafts.push(draft);
          this.store.data.workItems.push(work);
        }
      } else if (classified.outcome === "escalate") {
        const exists = this.store.data.escalations.some((e) => e.propertyId === property.id && e.reason === classified.reason);
        if (!exists) {
          this.store.data.escalations.push({
            id: `esc-${randomUUID()}`,
            propertyId: property.id,
            reason: "statutory-clock",
            periodDueAt,
            createdAt: now,
            detail:
              `${property.address} is ${classified.daysLate} days late on this sample book (courtesy window ends day ${property.options.courtesyUntilDay}). ` +
              `That is a shop reminder rule, not a legal clock. A licensed person decides whether any state notice is due — in the PMS. RealBud will not draft or send one.`,
          });
        }
      }
    }
    this.store.data.results = results;
    if (opts?.stampRun !== false) this.store.data.lastRunAt = now;
    this.store.data.hands = hands;
    this.store.data.handsDetail = handsDetail;
    this.store.persist();
    if (opts?.emit !== false) this.emit();
    return this.snapshot();
  }

  private holdBook(detail: string): void {
    const now = this.now();
    this.store.data.hands = "held";
    this.store.data.handsDetail = detail;
    this.store.data.lastRunAt = now;
    for (const property of this.store.data.properties) {
      this.holdWork({
        propertyId: property.id,
        reason: "unknown-facts",
        daysLate: this.facts(property.id).daysSinceDue,
        observedAt: now,
        sourceId: "src-held",
      });
    }
    this.store.persist();
    this.emit();
  }

  private holdWork(exception: { propertyId: string; reason: string; daysLate: number; observedAt: number; sourceId: string; detail?: string }): void {
    const key = occurrenceKey(exception.propertyId, `hold:${exception.reason}`, 0);
    if (this.store.data.workItems.some((w) => w.occurrenceKey === key && w.state === "held")) return;
    const property = this.store.data.properties.find((p) => p.id === exception.propertyId);
    this.store.data.workItems.push({
      id: `work-${randomUUID()}`,
      kind: "money-arrears",
      state: "held",
      propertyId: exception.propertyId,
      occurrenceKey: key,
      periodDueAt: 0,
      recipient: {
        name: property?.tenantName ?? "",
        phone: property?.tenantPhone ?? "",
      },
      sourceIds: [exception.sourceId],
      observedAt: exception.observedAt,
      proposalHash: `hold-${exception.reason}`,
      createdAt: this.now(),
      updatedAt: this.now(),
      holdReason: exception.detail ? `${exception.reason}: ${exception.detail}` : exception.reason,
      origin: this.pendingOrigin,
    });
  }

  private newWork(property: Property, draft: Draft, now: number, state: WorkState, sourceIds: string[]): WorkItem {
    return {
      id: `work-${randomUUID()}`,
      kind: draft.kind === "owner-letter" ? "owner-letter" : "money-arrears",
      state,
      propertyId: property.id,
      occurrenceKey: occurrenceKey(property.id, draft.kind, draft.periodDueAt),
      periodDueAt: draft.periodDueAt,
      draftId: draft.id,
      recipient: { name: property.tenantName, phone: property.tenantPhone },
      sourceIds,
      observedAt: now,
      proposalHash: proposalHash({
        propertyId: property.id,
        kind: draft.kind,
        periodDueAt: draft.periodDueAt,
        body: draft.body,
        to: draft.to,
        channel: draft.channel,
      }),
      createdAt: now,
      updatedAt: now,
      origin: this.pendingOrigin,
    };
  }

  private appendDenyReason(propertyId: string, reason: string): void {
    try {
      const current = this.notesFor(propertyId);
      const next = current.body.trim() ? `${current.body.trim()}\n${reason}` : reason;
      this.writeNotes(propertyId, next);
    } catch {
      /* notes are best-effort on a deny — same as a phone deny */
    }
  }

  private decide(id: string, state: "approved" | "denied", approver = "pm", via?: string): void {
    const draft = this.requirePending(id);
    const work = this.workForDraft(draft);
    assertTransition(work.state, state);
    draft.status = state === "approved" ? "allowed" : "denied";
    draft.decidedAt = this.now();
    if (via) draft.via = via;
    work.state = state;
    work.updatedAt = this.now();
    if (state === "approved" && draft.channel === "portal") {
      this.mintCapability(work, draft, approver);
    }
    const property = this.store.data.properties.find((p) => p.id === draft.propertyId);
    const verb = state === "approved" ? "approved" : "denied";
    const kind =
      draft.kind === "levy-from-rent" ? "levy flag" : draft.kind === "owner-letter" ? "owner letter" : "courtesy SMS";
    appendAllowedLine(
      draft.propertyId,
      `${new Date(this.now()).toISOString().slice(0, 10)} — ${verb} ${kind} for ${property?.address ?? draft.propertyId} (not sent by RealBud).`,
      this.vaultRoot,
      property?.address,
    );
  }

  private edit(id: string, body: string): void {
    const draft = this.requirePending(id);
    const next = String(body ?? "").trim();
    if (!next) throw Object.assign(new Error("draft body required"), { status: 400 });
    if (next.length > 4_000) throw Object.assign(new Error("draft is too long"), { status: 400 });
    draft.body = draft.kind === "courtesy-rent" ? withCourtesyDisclaimer(next) : next;
    const work = this.workForDraft(draft);
    work.proposalHash = proposalHash({
      propertyId: draft.propertyId,
      kind: draft.kind,
      periodDueAt: draft.periodDueAt,
      body: draft.body,
      to: draft.to,
      channel: draft.channel,
    });
    work.updatedAt = this.now();
    this.invalidateCapabilities({ workItemId: work.id });
  }

  private preparePortal(draftId: string): void {
    assertRoutineCannotMint("pm");
    const draft = this.store.data.drafts.find((d) => d.id === draftId);
    if (!draft) throw Object.assign(new Error("no such draft"), { status: 404 });
    const work = this.workForDraft(draft);
    if (work.state !== "approved") throw Object.assign(new Error("approve the wording before portal prepare"), { status: 409 });
    const cap = this.store.data.capabilities.find((c) => c.workItemId === work.id && !c.usedAt && !c.invalidatedAt);
    if (!cap) throw Object.assign(new Error("portal capability missing or invalidated"), { status: 409 });
    if (cap.expiresAt <= this.now()) throw Object.assign(new Error("portal capability expired"), { status: 409 });
    if (cap.revision !== this.store.data.revision) throw Object.assign(new Error("portal capability is stale"), { status: 409 });
    const recipe = this.store.data.recipes.find((r) => r.id === cap.recipeId && r.version === cap.recipeVersion);
    if (!recipe?.published) throw Object.assign(new Error("portal recipe is not published"), { status: 409 });
    assertTransition(work.state, "preparing");
    work.state = "preparing";
    cap.usedAt = this.now();
    const meta = persistArtifact({
      workItemId: work.id,
      step: "prefill",
      body: Buffer.from(JSON.stringify({ draftId, proposalHash: work.proposalHash }), "utf8"),
      now: this.now(),
      dir: join(this.store.file, ".."),
    });
    work.artifactIds = [...(work.artifactIds ?? []), meta.id];
    assertTransition(work.state, "handoff-ready");
    work.state = "handoff-ready";
    work.updatedAt = this.now();
  }

  async preparePortalAsync(draftId: string): Promise<DeskSnapshot> {
    assertRoutineCannotMint("pm");
    this.assertWritable();
    const draft = this.store.data.drafts.find((d) => d.id === draftId);
    if (!draft) throw Object.assign(new Error("no such draft"), { status: 404 });
    const work = this.workForDraft(draft);
    if (work.state !== "approved") throw Object.assign(new Error("approve the wording before portal prepare"), { status: 409 });
    const cap = this.store.data.capabilities.find((c) => c.workItemId === work.id && !c.usedAt && !c.invalidatedAt);
    if (!cap) throw Object.assign(new Error("portal capability missing or invalidated"), { status: 409 });
    if (cap.expiresAt <= this.now()) throw Object.assign(new Error("portal capability expired"), { status: 409 });
    if (cap.revision !== this.store.data.revision) throw Object.assign(new Error("portal capability is stale"), { status: 409 });
    const recipe = this.store.data.recipes.find((r) => r.id === cap.recipeId && r.version === cap.recipeVersion);
    if (!recipe?.published) throw Object.assign(new Error("portal recipe is not published"), { status: 409 });
    if (!this.portalUrl) throw Object.assign(new Error("no portal URL configured"), { status: 409 });
    assertTransition(work.state, "preparing");
    work.state = "preparing";
    const result = await runBoundedPrefill({
      baseUrl: this.portalUrl,
      body: draft.body,
      capability: cap,
      recipe,
      now: this.now(),
    });
    cap.usedAt = this.now();
    const meta = persistArtifact({
      workItemId: work.id,
      step: "prefill",
      body: Buffer.from(JSON.stringify({ draftId, proposalHash: work.proposalHash, portal: result }), "utf8"),
      now: this.now(),
      dir: join(this.store.file, ".."),
    });
    work.artifactIds = [...(work.artifactIds ?? []), meta.id];
    if (!result.ok) {
      assertTransition(work.state, "failed");
      work.state = "failed";
      work.updatedAt = this.now();
      this.store.persist();
      this.emit();
      throw Object.assign(new Error(result.error), { status: 502 });
    }
    assertTransition(work.state, "handoff-ready");
    work.state = "handoff-ready";
    work.updatedAt = this.now();
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  private setWork(id: string, state: WorkState): void {
    const work = this.store.data.workItems.find((w) => w.id === id);
    if (!work) throw Object.assign(new Error("no such work item"), { status: 404 });
    assertTransition(work.state, state);
    work.state = state;
    work.updatedAt = this.now();
  }

  private mintCapability(work: WorkItem, draft: Draft, approver: string): void {
    const binding = this.store.data.portalBindings.find((b) => b.propertyId === draft.propertyId);
    const recipe = this.store.data.recipes.find((r) => r.id === (binding?.recipeId ?? FAKE_PORTAL_RECIPE.id) && r.published);
    if (!binding || !recipe) return;
    this.store.data.capabilities.push({
      id: `cap-${randomUUID()}`,
      workItemId: work.id,
      revision: this.store.data.revision + 1,
      proposalHash: work.proposalHash,
      propertyId: draft.propertyId,
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      operation: "prefill-courtesy",
      approver,
      expiresAt: this.now() + 30 * 60_000,
    });
  }

  private invalidateCapabilities(filter: { propertyId?: string; workItemId?: string }): void {
    const now = this.now();
    for (const cap of this.store.data.capabilities) {
      if (filter.propertyId && cap.propertyId !== filter.propertyId) continue;
      if (filter.workItemId && cap.workItemId !== filter.workItemId) continue;
      if (!cap.usedAt && !cap.invalidatedAt) cap.invalidatedAt = now;
    }
  }

  private stampSource(id: string, kind: "csv" | "hermes" | "demo", label: string): void {
    const existing = this.store.data.sources.find((s) => s.id === id);
    if (existing) {
      existing.lastCheckedAt = this.now();
      existing.label = label;
      return;
    }
    this.store.data.sources.push({ id, kind, label, stableKey: `${kind}:${id}`, lastCheckedAt: this.now() });
  }

  private recordHandsLast(ok: boolean, detail: string): void {
    try {
      writeHandsLast(dirname(this.store.file), { at: this.now(), ok, detail, kind: "recheck" });
    } catch {
      /* a last-test write must never fail Recheck */
    }
  }

  private observe(id: string, kind: "csv" | "hermes" | "demo", label: string, rows: LedgerFacts[]): void {
    this.stampSource(id, kind, label);
    this.store.data.observations.push({
      id: `obs-${randomUUID()}`,
      sourceId: id,
      observedAt: this.now(),
      staleAfterMs: kind === "csv" ? CSV_FRESH_MS : 30 * 60_000,
      facts: rows[0],
    });
  }

  private requirePending(id: string): Draft {
    const draft = this.store.data.drafts.find((d) => d.id === id);
    if (!draft) throw Object.assign(new Error("no such draft"), { status: 404 });
    if (draft.status !== "pending") throw Object.assign(new Error("draft is already decided"), { status: 409 });
    return draft;
  }

  private workForDraft(draft: Draft): WorkItem {
    const work = this.store.data.workItems.find((w) => w.id === draft.workItemId || w.draftId === draft.id);
    if (!work) throw Object.assign(new Error("no such work item"), { status: 404 });
    return work;
  }

  private facts(propertyId: string): LedgerFacts {
    const facts = this.store.data.ledger.find((row) => row.propertyId === propertyId);
    if (!facts) throw new Error(`missing ledger for ${propertyId}`);
    return facts;
  }

  private assertWritable(): void {
    if (this.store.recovery.active) {
      throw Object.assign(new Error("desk is read-only in recovery mode"), { status: 409 });
    }
  }

  private emit(): void {
    this.onCommit?.(this.snapshot());
  }
}

export type { DeskFileV2 };
