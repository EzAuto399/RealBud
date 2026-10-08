import { propertyPortalView } from "./property-portals.ts";
// Desk spine: evaluate → proposal → human decision. Encrypted v2 store.
// snapshot() is side-effect free. Approval never means sent.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { decryptJson } from "./desk-crypto.ts";
import { basename, dirname, join } from "node:path";

import type {
  DeskBookView,
  DeskSnapshot,
  CsvColumnMapping,
  CsvImportPreview,
  Draft,
  DraftKind,
  FactSource,
  HandsSource,
  LedgerFacts,
  Property,
  PropertyOptions,
  PropertyOwner,
  ReiField,
  ReiFieldValue,
  ReiRefs,
  WorkItem,
  WorkState,
} from "../shared/contracts.ts";
import { REI_FIELDS } from "../shared/contracts.ts";
import type { BookProposal } from "../shared/desk-v3.ts";
import { DATA_DIR } from "./config.ts";
import { writeFilePrivateSync } from "./atomic.ts";
import { persistArtifact } from "./audit-artifacts.ts";
import { normalizeAddress, parsePmsExport, resolveExportRows } from "./csv-ledger.ts";
import { runBoundedPrefill } from "./portal-handoff.ts";
import {
  applyOptions,
  composeDraft,
  dueDate,
  fixtureBook,
  shopDefaults,
  withCourtesyDisclaimer,
} from "./desk-evaluate.ts";
import { DeskStore, emptyV2, type DeskFileV2 } from "./desk-store.ts";
import { projectWorkingV2 } from "./desk-v3-project.ts";
import { ensureDemoBreadth } from "./desk-v3-demo-breadth.ts";
import { migrateV2ToV3 } from "./desk-v3-migrate.ts";
import { assertTransition, occurrenceKey, proposalHash } from "./desk-work.ts";
import { tryHermesLedger, uncoveredPropertyIds, type HermesLedgerAttempt } from "./hermes-hands.ts";
import { writeHandsLast } from "./hands-last.ts";
import { EMPTY_BOOK_DETAIL } from "./routines.ts";
import { ambiguousMatchException, classifyMoneyRow, unmatchedException } from "./morning-money.ts";
import { composeOwnerLetter, ownerLetterWeekStart } from "./owner-letter.ts";
import { parseIntakeText, type IntakeItem } from "./intake.ts";
import { assertRoutineCannotMint, freezeAuthorization, withPresentation, type BrowserPresentation } from "./handoff-auth.ts";
import type { RoutineOrigin, RunUsage } from "../shared/contracts.ts";
import { addRunUsage } from "./run-cost.ts";
import { emptyOffice, parseJurisdictions, parseOfficePatch } from "../shared/office.ts";
import { FAKE_PORTAL_RECIPE } from "./portal-recipe.ts";
import { CSV_FRESH_MS, isFresh, reiMoneyStaleReason, reiOwnerLetterStaleReason } from "./source-gate.ts";
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
  owner?: PropertyOwner;
}

/** One REI read, mapped onto Desk by server/rei-desk-sync.ts. Desk applies it with the precedence rule. */
export interface ReiDeskRead {
  observedAt: number;
  /** REI values for one matched Desk property. */
  updates: Array<{ propertyId: string; values: Partial<Record<ReiField, ReiFieldValue>>; refs?: ReiRefs }>;
  /** Properties REI has and Desk does not: proposed as cards, never added. */
  proposals: Array<{ address: string; tenantName: string; weeklyRentCents: number; ownerName?: string; rei?: ReiRefs }>;
  /** Unmatched or ambiguous rows, held for a person. `identity` is what REI showed. */
  holds: Array<{ identity: string; kind: "unmatched" | "ambiguous"; detail: string }>;
  /** Parts read completely (every page). Only these are stamped fresh. */
  fresh: string[];
}
export interface ReiDeskApplied { updated: number; differs: number; proposed: number; held: number; fresh: string[] }

/** The source a REI read stamps for one part, e.g. src-rei-tenants. */
export const reiSourceId = (part: string) => `src-rei-${part}`;
/** One Needs-you item per REI part whose page no longer matches the shipped recipe (src/lib/desk-queue.ts). */
export const REI_PAGE_CHANGED_KEY = "rei-page-changed:";
export const reiPageChangedNote = (part: string) =>
  `REI's page changed, so Bud couldn't read ${part}. Desk stays marked not fresh. RealBud needs a recipe update; nothing in REI was changed.`;
/** Fields a money proposal reads that REI may own. */
const REI_MONEY_FIELDS: readonly ReiField[] = ["tenantName", "weeklyRentCents", "amountOwingCents", "paidTo"];
/** Owner and arrears fields an owner letter speaks to that REI may own. */
const REI_OWNER_LETTER_FIELDS: readonly ReiField[] = ["ownerName", "ownerContact", "amountOwingCents", "paidTo"];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const tidy = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
function readField(property: Property, field: ReiField): ReiFieldValue | undefined {
  if (field === "ownerName") return property.owner?.name || undefined;
  if (field === "ownerContact") return property.owner?.contact || undefined;
  const value = property[field];
  return value === "" ? undefined : value;
}
function writeField(property: Property, field: ReiField, value: ReiFieldValue): void {
  if (field === "ownerName" || field === "ownerContact") {
    const owner = property.owner ?? { name: "", contact: "" };
    property.owner = { ...owner, [field === "ownerName" ? "name" : "contact"]: String(value) };
  } else if (field === "weeklyRentCents" || field === "amountOwingCents") property[field] = Number(value);
  else property[field] = String(value);
}
function sameValue(field: ReiField, a: ReiFieldValue, b: ReiFieldValue): boolean {
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return field === "address" ? normalizeAddress(a) === normalizeAddress(b) : tidy(a) === tidy(b);
}
/** A value Desk can hold for this field, or a plain sentence saying why not. */
function checkField(field: ReiField, value: unknown): ReiFieldValue {
  const bad = (why: string) => Object.assign(new Error(why), { status: 400 });
  if (field === "weeklyRentCents") {
    if (!Number.isInteger(value) || (value as number) <= 0) throw bad("weekly rent must be a whole number of cents above zero");
    return value as number;
  }
  if (field === "amountOwingCents") {
    if (!Number.isSafeInteger(value)) throw bad("amount owing must be a whole number of cents");
    return value as number;
  }
  if (typeof value !== "string") throw bad(`${field} must be text`);
  const text = value.trim();
  if (field === "paidTo") {
    if (!YMD.test(text)) throw bad("paid-to date must be YYYY-MM-DD");
    return text;
  }
  if (text.length > 160) throw bad(`${field} is too long`);
  if (!text && field !== "ownerContact") throw bad(`${field} required`);
  return text;
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
    // The fictional portal recipe belongs to the sample book only.
    if (this.store.data.recipes.length === 0 && !this.store.recovery.active && this.store.data.mode === "demo") {
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
        ...(item.fields.ownerName ? { ownerName: item.fields.ownerName } : {}),
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

  /** Live recheck. A miss never fabricates rows or a finished morning.
   * `usage` collects the worker's Modelvia requests, even when the result is refused below. */
  async runMorningCheckLive(usage?: RunUsage): Promise<DeskSnapshot> {
    this.assertWritable();
    const startedAtRevision = this.store.data.revision;
    const ids = this.store.data.properties.map((p) => p.id);
    // An empty book has nothing for Bud to read: no model turn, no hold.
    if (ids.length === 0) return this.recordEmptyBook();
    const attempt = await this.hermes(ids);
    if (usage) addRunUsage(usage, attempt.usage);
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
    const prepared = proposals.map((proposal) => {
      const row = this.prepareProperty(proposalInput(proposal), addresses, codes, ids);
      this.stampNewProperty(row.property, proposal.origin === "rei" ? "rei" : "import", proposal.fields.rei);
      return row;
    });
    const proposalIds = new Set(proposals.map((proposal) => proposal.id));
    this.store.runBatch(() => {
      for (const row of prepared) this.insertProperty(row);
      this.leaveSampleIfOnlyRealProperties();
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
  proposeBook(
    input: { text?: string; items?: Array<IntakeItem & { ownerName?: string; rei?: ReiRefs }> },
    origin: "ask" | "manual" | "rei" = "ask",
  ): { created: number; skipped: number; unparsed: string[] } {
    this.assertWritable();
    let items = input.items;
    let unparsed: string[] = [];
    if (!items && input.text !== undefined) {
      const parsed = parseIntakeText(input.text);
      items = parsed.items;
      unparsed = parsed.unparsed;
    }
    const { created, skipped } = this.stageBookProposals(items ?? [], origin);
    if (created || skipped) {
      this.store.persistWithoutBump();
      this.emit();
    }
    return { created, skipped, unparsed };
  }

  /** Adds book cards in memory only; the caller persists. Throws before any change when there are too many. */
  private stageBookProposals(items: Array<IntakeItem & { ownerName?: string; rei?: ReiRefs }>, origin: "ask" | "manual" | "rei"): { created: number; skipped: number } {
    if (items.length > MAX_BOOK_PROPERTIES) {
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
      // REI's tenant list shows no phone, so a REI card may come without one.
      if (!address || !tenantName || (!tenantPhone && origin !== "rei") || !Number.isInteger(weeklyRentCents) || weeklyRentCents <= 0) {
        skipped++;
        continue;
      }
      const key = `${address.toLowerCase()}|${tenantName.toLowerCase()}`;
      // One REI card per address: a later read adds nothing until it is allowed or discarded.
      const exists = proposalKeys.has(key) || propertyAddresses.has(address.toLowerCase()) ||
        (origin === "rei" && this.store.v3.bookProposals.some((proposal) => proposal.fields.address.toLowerCase() === address.toLowerCase()));
      // Owner and REI references come only from a REI read, never from a request body.
      const ownerName = origin === "rei" ? String(item.ownerName ?? "").trim().slice(0, 160) : "";
      const rei = origin === "rei" && item.rei && Object.keys(item.rei).length ? { ...item.rei } : undefined;
      if (exists) {
        skipped++;
        continue;
      }
      this.store.v3.bookProposals.push({
        id: `book-${randomUUID().slice(0, 8)}`,
        kind: "add-property",
        status: "open",
        origin,
        fields: { address, tenantName, tenantPhone, weeklyRentCents, ...(ownerName ? { ownerName } : {}), ...(rei ? { rei } : {}) },
        createdAt: now,
      });
      proposalKeys.add(key);
      created++;
    }
    return { created, skipped };
  }

  allowBookProposal(id: string): DeskSnapshot {
    this.assertWritable();
    const idx = this.store.v3.bookProposals.findIndex((p) => p.id === id && p.status === "open");
    if (idx < 0) throw Object.assign(new Error("no such book proposal"), { status: 404 });
    const proposal = this.store.v3.bookProposals[idx]!;
    const added = this.addProperty(proposalInput(proposal), proposal.origin === "rei" ? "rei" : "import", proposal.fields.rei);
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
      writeFilePrivateSync(this.keyFilePath, key, 0o600);
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

  /** The sample exactly as RealBud made it: demo mode, the fixture
   * properties unedited, none added or removed, no accepted proposals. */
  isUntouchedSample(): boolean {
    const data = this.store.data;
    if (this.store.recovery.active || data.mode !== "demo") return false;
    // Used: a sample morning ran, a card was decided, or work was held.
    if (data.lastRunAt != null || data.drafts.length || data.escalations.length || data.results.length) return false;
    if (this.store.v3.decisions.length) return false;
    const seed = fixtureBook();
    // The sample's own training work items, in their seeded state, and nothing else.
    const at = this.now();
    const seededWork = projectWorkingV2(ensureDemoBreadth(migrateV2ToV3(emptyV2(fixtureBook()), at), at)).workItems;
    const workKey = (items: typeof data.workItems) => items.map((item) => `${item.id}|${item.state}`).sort().join(",");
    if (workKey(data.workItems) !== workKey(seededWork)) return false;
    const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected);
    const matches = <T extends object>(rows: T[], expected: T[], key: (row: T) => string) =>
      rows.length === expected.length && expected.every((want) => {
        const have = rows.find((row) => key(row) === key(want)) as Record<string, unknown> | undefined;
        return Boolean(have) && Object.entries(want).every(([field, value]) => same(have![field], value));
      });
    if (!matches(data.properties, seed.properties, (row) => row.id)) return false;
    if (!matches(data.ledger, seed.ledger, (row) => row.propertyId)) return false;
    if (!same(data.sources, emptyV2(seed).sources)) return false;
    const binding = { propertyId: "prop-oak", recipeId: FAKE_PORTAL_RECIPE.id, recipeVersion: FAKE_PORTAL_RECIPE.version, remotePropertyId: "oak-1" };
    return data.portalBindings.length === 0 || (data.portalBindings.length === 1 && same(data.portalBindings[0], binding));
  }

  /**
   * Replace the sample with an empty office book. Idempotent: a book that is
   * already live is returned as it is and never wiped. `expectedRevision`
   * guards the person's explicit choice against a book that changed.
   */
  startLiveBook(input: { expectedRevision?: unknown } = {}): DeskSnapshot {
    this.assertWritable();
    if (input.expectedRevision !== undefined && input.expectedRevision !== this.revision) {
      throw Object.assign(new Error("The book changed while you were deciding. Nothing was replaced. Review the book and try again."), { status: 409, code: "revision-conflict" });
    }
    if (this.store.data.mode !== "demo") return this.snapshot();
    this.store.startLiveBook(this.now(), (id) => id !== FAKE_PORTAL_RECIPE.id);
    this.emit();
    return this.snapshot();
  }

  /** Linked office: start clean, but only over the untouched sample. An
   * edited sample is kept and the person chooses (`startLiveBook`). */
  startLiveBookIfUntouched(): boolean {
    if (!this.isUntouchedSample()) return false;
    this.startLiveBook();
    return true;
  }

  /** A sample whose fixture rows are all gone holds only the person's own
   * properties: the first one added or accepted makes it the office book.
   * While any fixture row remains it stays the sample, so fixture facts never
   * pose as live; a linked computer offers "Start your office book" instead. */
  private leaveSampleIfOnlyRealProperties(): void {
    if (this.store.data.mode !== "demo" || !this.store.data.properties.length) return;
    const fixtureIds = new Set(fixtureBook().properties.map((property) => property.id));
    if (this.store.data.properties.some((property) => fixtureIds.has(property.id))) return;
    const ids = new Set(this.store.data.properties.map((property) => property.id));
    this.store.replaceWithLiveBook(this.now(), (id) => id !== FAKE_PORTAL_RECIPE.id, {
      properties: this.store.data.properties,
      ledger: this.store.data.ledger.filter((row) => ids.has(row.propertyId)),
    });
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

  /** `source`: a person in Desk, unless a REI card or an intake card was allowed. */
  addProperty(input: NewPropertyInput, source: FactSource = "desk", rei?: ReiRefs): DeskSnapshot {
    this.assertWritable();
    if (this.store.data.properties.length >= MAX_BOOK_PROPERTIES) {
      throw Object.assign(new Error(`the book is full (${MAX_BOOK_PROPERTIES} properties)`), { status: 400 });
    }
    const prepared = this.prepareProperty(input);
    this.stampNewProperty(prepared.property, source, rei);
    this.insertProperty(prepared);
    this.leaveSampleIfOnlyRealProperties();
    // Book membership changed — recompute cards from facts already on the book.
    // Do not stamp lastRunAt: adding a row is not a Recheck. Unchecked books
    // stay empty of cards until a real check (same honesty as patchProperty).
    // A failed save (disk full) puts the book back as desk.json holds it, so the
    // row is not "already on the book" in memory and gone after a restart.
    let snapshot: DeskSnapshot;
    if (this.store.data.lastRunAt != null) {
      snapshot = this.reevaluateOrKeepMiss({ stampRun: false });
    } else {
      this.store.persist();
      this.emit();
      snapshot = this.snapshot();
    }
    // The empty note is a convenience (a missing note reads as empty), so it is
    // written only once the row is saved and cannot undo that save.
    try {
      writePropertyNote(prepared.property.id, "", { address: prepared.property.address }, this.vaultRoot);
    } catch (cause) {
      console.warn("RealBud saved the property but could not start its private note", {
        error: cause instanceof Error ? cause.name : "UnknownError",
      });
    }
    return snapshot;
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

    const owner = input.owner
      ? { name: String(checkField("ownerName", input.owner.name)), contact: String(checkField("ownerContact", input.owner.contact ?? "")) }
      : undefined;
    const options = shopDefaults();
    if (input.options) applyOptions(options, input.options);
    let id = `prop-${randomUUID().slice(0, 8)}`;
    while (ids.has(id)) id = `prop-${randomUUID().slice(0, 8)}`;
    addresses.add(address.toLowerCase());
    if (propertyCode) codes.add(propertyCode.toLowerCase());
    ids.add(id);
    return {
      property: { id, address, tenantName, tenantPhone, weeklyRentCents: rent, options, ...(propertyCode ? { propertyCode } : {}), ...(owner ? { owner } : {}) },
      facts: {
        propertyId: id,
        daysSinceDue: 0,
        rentLanded: false,
        levyPaid: false,
        daysSinceCourtesy: null,
      },
    };
  }

  /** Every value a new property starts with records who supplied it. */
  private stampNewProperty(property: Property, source: FactSource, rei?: ReiRefs): void {
    const observedAt = this.now();
    property.origins = Object.fromEntries(
      REI_FIELDS.filter((field) => readField(property, field) !== undefined).map((field) => [field, { source, observedAt }]),
    );
    if (rei && Object.keys(rei).length) property.rei = { ...rei };
  }

  /** A person changes REI-sourced facts in Desk. Each becomes a Desk value a REI read never silently overwrites. */
  editPropertyFacts(id: string, patch: Record<string, unknown>): DeskSnapshot {
    this.assertWritable();
    const property = this.store.data.properties.find((p) => p.id === id);
    if (!property) throw Object.assign(new Error("no such property"), { status: 404 });
    const entries = Object.entries(patch ?? {}).filter(([key]) => key !== "expectedRevision");
    if (!entries.length || entries.some(([key]) => !(REI_FIELDS as readonly string[]).includes(key))) {
      throw Object.assign(new Error(`Change only ${REI_FIELDS.join(", ")}.`), { status: 400 });
    }
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== this.revision) {
      throw Object.assign(new Error("The book changed while you were editing. Reload it and try again."), { status: 409, code: "revision-conflict" });
    }
    const values = entries.map(([key, value]) => [key as ReiField, checkField(key as ReiField, value)] as const);
    const address = values.find(([field]) => field === "address")?.[1];
    if (address !== undefined && this.store.data.properties.some((p) => p.id !== id && normalizeAddress(p.address) === normalizeAddress(String(address)))) {
      throw Object.assign(new Error("that address is already on the book"), { status: 409 });
    }
    const observedAt = this.now();
    for (const [field, value] of values) {
      writeField(property, field, value);
      property.origins = { ...property.origins, [field]: { source: "desk", observedAt } };
      // The person wrote the field themselves; the next REI read compares again.
      this.dropDiffer(property, field);
    }
    return this.saveFactsChange(property.id);
  }

  /** A person picks one side of "Differs from REI". */
  resolveReiDiffer(id: string, field: string, pick: string): DeskSnapshot {
    this.assertWritable();
    if (pick !== "rei" && pick !== "desk") throw Object.assign(new Error("Pick REI or Desk."), { status: 400 });
    const property = this.store.data.properties.find((p) => p.id === id);
    const differ = property?.differs?.find((item) => item.field === field);
    if (!property || !differ) throw Object.assign(new Error("This difference was already settled. Reload the book."), { status: 404 });
    if (pick === "rei") {
      writeField(property, differ.field, differ.rei);
      property.origins = { ...property.origins, [differ.field]: { source: "rei", observedAt: differ.observedAt } };
    } else {
      property.origins = { ...property.origins, [differ.field]: { source: "desk", observedAt: this.now(), declinedRei: differ.rei } };
    }
    this.dropDiffer(property, differ.field);
    return this.saveFactsChange(property.id);
  }

  /**
   * Apply one REI read. REI wins for every field it provides, except a field a
   * person changed in Desk (or one older than sources): that is held as
   * "Differs from REI" until a person picks. New properties become cards;
   * unmatched or ambiguous rows become held work. Only parts read completely
   * are stamped fresh, and the book's check state (lastRunAt, hands) is untouched.
   */
  applyReiRead(read: ReiDeskRead): ReiDeskApplied {
    this.assertWritable();
    // Checked before anything changes, so a refused read leaves Desk exactly as it was.
    if (read.proposals.length > MAX_BOOK_PROPERTIES) {
      throw Object.assign(new Error(`REI shows more than ${MAX_BOOK_PROPERTIES} properties Desk doesn't have; stage at most ${MAX_BOOK_PROPERTIES} at a time. Nothing from this read was applied.`), { status: 400 });
    }
    const applied: ReiDeskApplied = { updated: 0, differs: 0, proposed: 0, held: 0, fresh: [] };
    const changed = new Set<string>();
    for (const update of read.updates) {
      const property = this.store.data.properties.find((p) => p.id === update.propertyId);
      if (!property) continue;
      const refs = { ...property.rei, ...update.refs };
      if (Object.keys(refs).length && JSON.stringify(refs) !== JSON.stringify(property.rei ?? {})) {
        property.rei = refs;
        changed.add(property.id);
      }
      for (const [key, raw] of Object.entries(update.values)) {
        const field = key as ReiField;
        let value: ReiFieldValue;
        try {
          value = checkField(field, raw);
        } catch {
          continue;
        }
        const outcome = this.applyReiValue(property, field, value, read.observedAt);
        if (outcome !== "same") changed.add(property.id);
        if (outcome === "held") applied.differs += 1;
      }
    }
    applied.updated = changed.size;
    for (const hold of read.holds) {
      this.holdWork({
        propertyId: hold.identity,
        reason: hold.kind === "unmatched" ? "unmatched" : "ambiguous-match",
        daysLate: 0,
        observedAt: read.observedAt,
        sourceId: "src-rei",
        ...(hold.kind === "ambiguous" ? { detail: hold.detail } : {}),
      });
      applied.held += 1;
    }
    for (const part of read.fresh) {
      this.stampSource(reiSourceId(part), "portal", `REI Cloud ${part}`, read.observedAt);
      applied.fresh.push(part);
      // A part read whole again clears its "REI's page changed" item.
      for (const work of this.store.data.workItems) {
        if (work.occurrenceKey === `${REI_PAGE_CHANGED_KEY}${part}` && work.state === "held") {
          work.state = "superseded";
          work.updatedAt = this.now();
        }
      }
    }
    for (const id of changed) this.invalidateCapabilities({ propertyId: id });
    if (read.proposals.length) {
      applied.proposed = this.stageBookProposals(read.proposals.map((item) => ({ ...item, tenantPhone: "" })), "rei").created;
    }
    // One write for the whole read: stamps, updates, holds and cards land together or not at all.
    // An unchanged value still records when REI last showed it.
    if (read.updates.length || applied.held || applied.fresh.length || read.proposals.length) {
      this.store.persist();
      this.emit();
    }
    return applied;
  }

  /** REI's page for one part no longer matches the recipe: one Needs-you item for that part, updated in place
   * on later mornings and cleared when the part next reads whole (applyReiRead). Freshness stamps are untouched. */
  noteReiPageChanged(part: string): void {
    this.assertWritable();
    const key = `${REI_PAGE_CHANGED_KEY}${part}`;
    const now = this.now();
    const open = this.store.data.workItems.find((w) => w.occurrenceKey === key && w.state === "held");
    if (open) {
      open.observedAt = now;
      open.updatedAt = now;
    } else {
      this.store.data.workItems.push({
        id: `work-${randomUUID()}`,
        kind: "money-arrears",
        state: "held",
        propertyId: "",
        occurrenceKey: key,
        periodDueAt: 0,
        recipient: { name: "", phone: "" },
        sourceIds: [reiSourceId(part)],
        observedAt: now,
        proposalHash: key,
        createdAt: now,
        updatedAt: now,
        holdReason: reiPageChangedNote(part),
      });
    }
    this.store.persist();
    this.emit();
  }

  /** "set": REI's value stands. "held": a Desk value differs and waits for a person. "same": nothing changed. */
  private applyReiValue(property: Property, field: ReiField, value: ReiFieldValue, observedAt: number): "set" | "held" | "same" {
    const current = readField(property, field);
    const origin = property.origins?.[field];
    const fromRei = (): "set" => {
      writeField(property, field, value);
      property.origins = { ...property.origins, [field]: { source: "rei", observedAt } };
      this.dropDiffer(property, field);
      return "set";
    };
    if (current === undefined) return fromRei();
    if (sameValue(field, current, value)) {
      const unchanged = origin?.source === "rei" && current === value && !property.differs?.some((item) => item.field === field);
      fromRei();
      return unchanged ? "same" : "set";
    }
    if (origin && origin.source !== "desk") return fromRei();
    // A Desk value, or one older than sources: never overwritten. Raise or refresh the hold,
    // unless the person already kept their value over this same REI value.
    if (origin?.declinedRei !== undefined && sameValue(field, origin.declinedRei, value)) return "same";
    const held = property.differs?.find((item) => item.field === field);
    if (held && sameValue(field, held.rei, value)) return "same";
    property.differs = [...(property.differs ?? []).filter((item) => item.field !== field), { field, rei: value, observedAt }];
    return "held";
  }

  private dropDiffer(property: Property, field: ReiField): void {
    if (!property.differs?.some((item) => item.field === field)) return;
    property.differs = property.differs.filter((item) => item.field !== field);
    if (!property.differs.length) delete property.differs;
  }

  /** Same honesty as patchProperty: recompute cards only on a checked book, never claim a fresh check. */
  private saveFactsChange(propertyId: string): DeskSnapshot {
    this.invalidateCapabilities({ propertyId });
    if (this.store.data.lastRunAt != null) return this.reevaluateOrKeepMiss({ stampRun: false });
    this.store.persist();
    this.emit();
    return this.snapshot();
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
    let snapshot: DeskSnapshot;
    if (this.store.data.lastRunAt != null) {
      snapshot = this.reevaluateOrKeepMiss({ stampRun: false });
    } else {
      this.store.persist();
      this.emit();
      snapshot = this.snapshot();
    }
    // Archive the note only after the removal is saved: a failed save keeps the
    // property, and its note must stay live with it.
    try {
      archivePropertyNote(id, this.vaultRoot);
    } catch (cause) {
      console.warn("RealBud removed the property but could not mark its private note archived", {
        error: cause instanceof Error ? cause.name : "UnknownError",
      });
    }
    return snapshot;
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
    // Same gate as the morning money check: REI's owner and arrears facts back a letter only while REI is fresh.
    const reiStale = reiOwnerLetterStaleReason(this.store.data.sources, now);
    for (const property of this.store.data.properties) {
      const exists = this.store.data.drafts.some(
        (d) => d.propertyId === property.id && d.kind === "owner-letter" && d.periodDueAt === weekStart,
      );
      if (exists) continue;
      const facts = this.facts(property.id);
      if (reiStale && REI_OWNER_LETTER_FIELDS.some((field) => property.origins?.[field]?.source === "rei")) {
        this.holdWork({ propertyId: property.id, reason: "stale-source", daysLate: facts.daysSinceDue, observedAt: now, sourceId: "src-rei", detail: reiStale }, "owner-letter");
        continue;
      }
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
    let afterSave: (() => void) | undefined;
    switch (cmd.type) {
      case "check-demo":
        return this.runMorningCheck();
      case "import-csv":
        return this.importCsv(cmd.csv, cmd.observedAt, cmd.mapping);
      case "propose":
        return this.proposeFromAsk(cmd);
      case "allow":
        afterSave = this.decide(cmd.draftId, "approved", cmd.approver ?? "pm", cmd.via);
        break;
      case "deny":
        afterSave = this.decide(cmd.draftId, "denied", "pm", cmd.via);
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
    afterSave?.();
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

  /** Nothing to check. Not a check (no lastRunAt) and not a hold. A sample
   * book's detail is left alone: there any non-"Demo book" detail reads as a miss. */
  private recordEmptyBook(): DeskSnapshot {
    if (this.store.data.mode === "live" && this.store.data.handsDetail !== EMPTY_BOOK_DETAIL) {
      this.store.data.handsDetail = EMPTY_BOOK_DETAIL;
      this.store.data.results = [];
      this.store.persist();
      this.emit();
    }
    return this.snapshot();
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
    // REI's tenant, rent and arrears facts back a proposal only while REI's tenants and arrears are fresh.
    const reiStale = reiMoneyStaleReason(this.store.data.sources, now);
    for (const property of this.store.data.properties) {
      if (skipIds?.has(property.id)) {
        results.push({ propertyId: property.id, outcome: "hold" as const, reason: "uncovered-by-worker" as const, daysLate: this.facts(property.id).daysSinceDue });
        continue;
      }
      const facts = this.facts(property.id);
      const classified = classifyMoneyRow(property, facts, now, hands === "csv" ? "src-csv" : hands === "hermes" ? "src-hermes" : "src-demo");
      if (classified.outcome === "draft" && reiStale && REI_MONEY_FIELDS.some((field) => property.origins?.[field]?.source === "rei")) {
        this.holdWork({ ...classified, reason: "stale-source", sourceId: "src-rei", detail: reiStale });
        results.push({ propertyId: property.id, outcome: "hold" as const, reason: "stale-source" as const, daysLate: classified.daysLate });
        continue;
      }
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

  private holdWork(exception: { propertyId: string; reason: string; daysLate: number; observedAt: number; sourceId: string; detail?: string }, kind: "money-arrears" | "owner-letter" = "money-arrears"): void {
    const key = occurrenceKey(exception.propertyId, kind === "owner-letter" ? `hold:owner-letter:${exception.reason}` : `hold:${exception.reason}`, 0);
    if (this.store.data.workItems.some((w) => w.occurrenceKey === key && w.state === "held")) return;
    const property = this.store.data.properties.find((p) => p.id === exception.propertyId);
    this.store.data.workItems.push({
      id: `work-${randomUUID()}`,
      kind,
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

  /** Returns the note line to write once the decision is saved: a decision that
   * fails to save (disk full) must not leave "approved" in the property note. */
  private decide(id: string, state: "approved" | "denied", approver = "pm", via?: string): () => void {
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
    const line = `${new Date(this.now()).toISOString().slice(0, 10)} — ${verb} ${kind} for ${property?.address ?? draft.propertyId} (not sent by RealBud).`;
    return () => {
      try {
        appendAllowedLine(draft.propertyId, line, this.vaultRoot, property?.address);
      } catch (cause) {
        console.warn("RealBud saved the decision but could not add it to the private property note", {
          error: cause instanceof Error ? cause.name : "UnknownError",
        });
      }
    };
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

  private stampSource(id: string, kind: "csv" | "hermes" | "demo" | "portal", label: string, at = this.now()): void {
    const existing = this.store.data.sources.find((s) => s.id === id);
    if (existing) {
      existing.lastCheckedAt = at;
      existing.label = label;
      return;
    }
    this.store.data.sources.push({ id, kind, label, stableKey: `${kind}:${id}`, lastCheckedAt: at });
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

function proposalInput(proposal: BookProposal): NewPropertyInput {
  const { address, tenantName, tenantPhone, weeklyRentCents, ownerName } = proposal.fields;
  return { address, tenantName, tenantPhone, weeklyRentCents, ...(ownerName ? { owner: { name: ownerName, contact: "" } } : {}) };
}

export type { DeskFileV2 };
