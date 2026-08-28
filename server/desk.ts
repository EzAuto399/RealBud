// Desk spine: evaluate → proposal → human decision. Encrypted v2 store.
// snapshot() is side-effect free. Approval never means sent.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { decryptJson } from "./desk-crypto.ts";
import { join, dirname } from "node:path";

import type {
  DeskBookView,
  DeskSnapshot,
  Draft,
  DraftKind,
  HandsSource,
  InboundCaseDetail,
  ClosureKind,
  ImportIdentity,
  LedgerFacts,
  Property,
  PropertyOptions,
  WorkItem,
  WorkState,
} from "../shared/contracts.ts";
import { CLOSURE_KINDS } from "../shared/contracts.ts";
import { DATA_DIR } from "./config.ts";
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
import { DeskStore, type DeskFileV2 } from "./desk-store.ts";
import { decodeDeskPlain } from "./desk-v3-decode.ts";
import { failClosedRecovery } from "./desk-v3-recovery.ts";
import { assertTransition, occurrenceKey, proposalHash } from "./desk-work.ts";
import { tryHermesLedger, type HermesLedgerAttempt } from "./hermes-hands.ts";
import { ambiguousMatchException, classifyMoneyRow, unmatchedException } from "./morning-money.ts";
import { composeOwnerLetter, ownerLetterWeekStart } from "./owner-letter.ts";
import { intakeItemError, parseIntakeText, type IntakeItem } from "./intake.ts";
import { assertRoutineCannotMint, freezeAuthorization, withPresentation, type BrowserPresentation } from "./handoff-auth.ts";
import type { RoutineOrigin } from "../shared/contracts.ts";
import { FAKE_PORTAL_RECIPE, fakePortalRecipeAt } from "./portal-recipe.ts";
import { CSV_FRESH_MS, isFresh } from "./source-gate.ts";
import {
  BANK_OBSERVATION_FRESH_MS,
  BANK_CREDIT_RELEVANCE_MS,
  matchBankCredits,
  type BankObservationBatch,
} from "./bank-observation.ts";
import { assertOperationalDraftContent } from "./consequential-content.ts";
import { evaluateFromProjection } from "./case-evaluator.ts";
import type { MoneyPosition } from "../shared/desk-v3.ts";
import { deriveProposalReviewAssist } from "./review-assist.ts";
import {
  classifyInboundBatch,
  demoInboundBatch,
  type ClassifiedInbound,
  type InboundBatchInput,
} from "./inbound-triage.ts";
import {
  appendAllowedLine,
  appendAllowedLines,
  archivePropertyNote,
  readPropertyNote,
  seedVault,
  vaultDirFromDeskFile,
  writePropertyNote,
} from "./vault.ts";

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
  propertyCode?: string;
  tenantName: string;
  tenantPhone: string;
  weeklyRentCents: number;
  options?: Partial<PropertyOptions>;
}

interface PreparedProperty {
  property: Property;
  facts: LedgerFacts;
}

interface IntakeAllowedNote {
  propertyId: string;
  address: string;
  line: string;
}

const INBOUND_FOLLOW_UP_MS = 2 * 24 * 60 * 60 * 1_000;

function strongestInbound(items: ClassifiedInbound[]): ClassifiedInbound {
  const rank: Record<InboundCaseDetail["priority"], number> = {
    "licensed-review": 4,
    "urgent-review": 3,
    priority: 2,
    routine: 1,
  };
  return items.slice().sort((a, b) => rank[b.detail.priority] - rank[a.detail.priority] || b.detail.receivedAt - a.detail.receivedAt)[0]!;
}

export type DeskCommand =
  | { type: "allow"; draftId: string; expectedRevision: number; approver?: string }
  | { type: "deny"; draftId: string; expectedRevision: number }
  | { type: "edit"; draftId: string; expectedRevision: number; body: string }
  | { type: "check-demo"; expectedRevision?: number }
  | { type: "import-csv"; expectedRevision: number; csv: string; observedAt?: number }
  | { type: "propose"; expectedRevision?: number; propertyId: string; kind?: DraftKind; body?: string }
  | { type: "prepare-portal"; expectedRevision: number; draftId: string }
  | { type: "handoff-ready"; expectedRevision: number; workItemId: string }
  | { type: "confirm"; expectedRevision: number; workItemId: string; attestation?: boolean }
  | { type: "effect-unknown"; expectedRevision: number; workItemId: string };

export class Desk {
  private store: DeskStore;
  private now: () => number;
  private hermes: (ids: string[]) => Promise<HermesLedgerAttempt>;
  private onCommit: ((snap: DeskSnapshot) => void) | null;
  private portalUrl: string | null;
  private vaultRoot: string;
  private presentation: BrowserPresentation = "side-by-side";
  private pendingOrigin?: RoutineOrigin;

  constructor(opts?: {
    file?: string;
    now?: () => number;
    key?: Buffer;
    hermes?: (ids: string[]) => Promise<HermesLedgerAttempt>;
    onCommit?: (snap: DeskSnapshot) => void;
    portalUrl?: string;
    vaultDir?: string;
  }) {
    this.now = opts?.now ?? Date.now;
    this.hermes = opts?.hermes ?? ((ids) => tryHermesLedger(ids));
    this.onCommit = opts?.onCommit ?? null;
    this.portalUrl = opts?.portalUrl ?? process.env.FAKE_PORTAL_URL ?? null;
    const file = opts?.file ?? join(DATA_DIR, "desk.json");
    this.vaultRoot = opts?.vaultDir ?? vaultDirFromDeskFile(file);
    seedVault(this.vaultRoot);
    this.store = new DeskStore({
      file,
      book: fixtureBook(),
      key: opts?.key,
      now: this.now,
    });
    if (this.store.data.recipes.length === 0 && !this.store.recovery.active) {
      const fakeRecipe = this.portalUrl ? fakePortalRecipeAt(this.portalUrl) : FAKE_PORTAL_RECIPE;
      this.store.data.recipes.push({ ...fakeRecipe });
      this.store.data.portalBindings.push({
        propertyId: "prop-oak",
        recipeId: fakeRecipe.id,
        recipeVersion: fakeRecipe.version,
        remotePropertyId: "oak-1",
      });
      this.store.persistWithoutBump();
    }
    this.reconcileInterruptedHandoffs();
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
      // Notes are deliberately absent from portfolio snapshots. They are
      // loaded only through propertySnapshot()/notesFor() for one selected
      // property and never enter evaluation or the default queue payload.
      properties: d.properties.map((p) => ({ ...p, notes: undefined })),
      ledger: d.ledger,
      drafts: d.drafts,
      escalations: d.escalations,
      lastRunAt: d.lastRunAt,
      results: d.results,
      hands: d.hands,
      handsDetail: d.handsDetail,
      book: this.bookView(),
      loadOff: this.loadOffView(),
    };
  }

  queueSnapshot(): DeskSnapshot {
    const snap = this.snapshot();
    const activeStates = new Set<WorkState>([
      "proposed",
      "approved",
      "held",
      "preparing",
      "handoff-ready",
      "failed",
      "waiting",
      "effect-unknown",
      "handoff-expired",
    ]);
    const workItems = snap.workItems.filter((work) => activeStates.has(work.state));
    const workIds = new Set(workItems.map((work) => work.id));
    const draftIds = new Set(workItems.map((work) => work.draftId).filter((id): id is string => Boolean(id)));
    const caseIds = new Set(workItems.map((work) => work.id));
    return {
      ...snap,
      workItems,
      drafts: snap.drafts.filter((draft) => draftIds.has(draft.id)),
      book: snap.book
        ? {
            ...snap.book,
            tenancies: [],
            contacts: [],
            importIssues: snap.book.importIssues.filter((issue) => issue.status === "open"),
            cases: snap.book.cases.filter((item) => caseIds.has(item.id)),
            decisions: snap.book.decisions.filter((decision) => workIds.has(decision.caseId)),
            reviewAssist: snap.book.reviewAssist?.filter((item) => draftIds.has(item.proposalId)),
            archivedProperties: snap.book.archivedProperties.slice(-50),
          }
        : undefined,
    };
  }

  caseSnapshot(id: string): DeskSnapshot {
    const snap = this.snapshot();
    const work = snap.workItems.find((item) => item.id === id);
    const caseRow = snap.book?.cases.find((item) => item.id === id);
    if (!work && !caseRow) throw Object.assign(new Error("no such case"), { status: 404 });
    const propertyId = work?.propertyId || caseRow?.propertyId;
    const draftId = work?.draftId;
    return {
      ...snap,
      properties: propertyId ? snap.properties.filter((property) => property.id === propertyId) : [],
      ledger: propertyId ? snap.ledger.filter((row) => row.propertyId === propertyId) : [],
      drafts: draftId ? snap.drafts.filter((draft) => draft.id === draftId) : [],
      escalations: snap.escalations.filter((item) => item.id === id),
      workItems: work ? [work] : [],
      results: propertyId ? snap.results.filter((row) => row.propertyId === propertyId) : [],
      book: snap.book
        ? {
            ...snap.book,
            tenancies: propertyId ? snap.book.tenancies.filter((item) => item.propertyId === propertyId) : [],
            contacts: propertyId ? snap.book.contacts.filter((item) => item.propertyId === propertyId) : [],
            archivedProperties: [],
            importIssues: snap.book.importIssues.filter((issue) => issue.id === id),
            bookProposals: [],
            cases: snap.book.cases.filter((item) => item.id === id),
            decisions: snap.book.decisions.filter((item) => item.caseId === id || item.proposalId === draftId),
            reviewAssist: snap.book.reviewAssist?.filter((item) => item.proposalId === draftId),
          }
        : undefined,
    };
  }

  propertySnapshot(id: string): DeskSnapshot {
    const snap = this.snapshot();
    const property = snap.properties.find((item) => item.id === id);
    if (!property) throw Object.assign(new Error("no such property"), { status: 404 });
    const workItems = snap.workItems.filter((item) => item.propertyId === id);
    const workIds = new Set(workItems.map((item) => item.id));
    const draftIds = new Set(workItems.map((item) => item.draftId).filter((draftId): draftId is string => Boolean(draftId)));
    return {
      ...snap,
      properties: [{ ...property, notes: readPropertyNote(id, this.vaultRoot) }],
      ledger: snap.ledger.filter((row) => row.propertyId === id),
      drafts: snap.drafts.filter((draft) => draftIds.has(draft.id) || draft.propertyId === id),
      escalations: snap.escalations.filter((item) => item.propertyId === id),
      workItems,
      results: snap.results.filter((row) => row.propertyId === id),
      book: snap.book
        ? {
            ...snap.book,
            tenancies: snap.book.tenancies.filter((item) => item.propertyId === id),
            contacts: snap.book.contacts.filter((item) => item.propertyId === id),
            archivedProperties: [],
            importIssues: snap.book.importIssues.filter((issue) => issue.linkedPropertyId === id || issue.candidates.includes(id)),
            bookProposals: [],
            cases: snap.book.cases.filter((item) => item.propertyId === id),
            decisions: snap.book.decisions.filter((item) => workIds.has(item.caseId)),
            reviewAssist: snap.book.reviewAssist?.filter((item) => draftIds.has(item.proposalId)),
          }
        : undefined,
    };
  }

  private loadOffView(): NonNullable<DeskSnapshot["loadOff"]> {
    const work = this.store.data.workItems;
    return {
      recordsChecked: this.store.data.lastRunAt == null ? 0 : this.store.data.results.length,
      draftsPrepared: this.store.data.drafts.filter((draft) => draft.status === "pending").length,
      exceptionsHeld: work.filter((item) => item.state === "held").length,
      waitingOnSomeone: work.filter((item) => item.state === "waiting").length,
      followUpsClosed: work.filter((item) => item.lifecycle?.closedAt !== undefined).length,
      // These two values require runtime instrumentation; null is deliberate
      // and prevents the UI from presenting invented time-saved claims.
      systemsAvoided: null,
      elapsedMs: null,
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

  updateAgencyName(name: unknown, expectedRevision?: number): DeskSnapshot {
    this.assertWritable();
    if (expectedRevision != null && expectedRevision !== this.store.data.revision) {
      throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    }
    if (typeof name !== "string") throw Object.assign(new Error("agency name must be a string"), { status: 400 });
    const nextName = name.trim();
    if (nextName.length > 120) throw Object.assign(new Error("agency name is too long"), { status: 400 });
    if (nextName === this.store.v3.agency.name) return this.snapshot();

    const previousData = structuredClone(this.store.data);
    const previousV3 = structuredClone(this.store.v3);
    this.store.v3 = {
      ...this.store.v3,
      agency: { ...this.store.v3.agency, name: nextName },
    };
    try {
      this.store.persist();
    } catch (error) {
      const diskState = this.agencyDiskState(nextName, previousData.revision + 1);
      if (diskState !== "not-landed") {
        const message = diskState === "landed"
          ? "RealBud saved the agency name, but could not verify that storage safely finished. Restart RealBud before making another change."
          : "RealBud could not verify whether the agency name reached storage. Restart RealBud before making another change.";
        this.store.recovery = failClosedRecovery(message);
        throw Object.assign(new Error(message), { status: 503, code: "commit-outcome-unknown", cause: error });
      }
      this.store.data = previousData;
      this.store.v3 = previousV3;
      throw error;
    }
    this.emit();
    return this.snapshot();
  }

  private agencyDiskState(name: string, revision: number): "landed" | "not-landed" | "unknown" {
    try {
      const envelope = JSON.parse(readFileSync(this.store.file, "utf8"));
      const plain = decryptJson(Buffer.from(this.store.keyHex, "hex"), envelope);
      const decoded = decodeDeskPlain(plain, { properties: [], ledger: [] }, this.store.data.timezone);
      if (decoded.version !== 3 || decoded.data.revision !== revision) return "not-landed";
      return decoded.data.agency.name === name ? "landed" : "not-landed";
    } catch {
      return "unknown";
    }
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
        sourceId: item.sourceId,
        rawIdentity: item.rawIdentity,
        identityKind: item.identityKind,
        candidates: [...item.candidates],
        linkedPropertyId: item.linkedPropertyId,
        resolvedAt: item.resolvedAt,
        resolvedBy: item.resolvedBy,
        resolutionCount: item.resolutions?.length ?? 0,
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
        inbound: item.inbound,
        lifecycle: item.lifecycle,
        sourceIncident: item.sourceIncident,
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
      reviewAssist: deriveProposalReviewAssist(v3, this.now()),
      handoff,
    };
  }

  /** Training / Demo book only. Never counts as a live check. */
  runMorningCheck(): DeskSnapshot {
    this.assertWritable();
    return this.evaluateBook("demo", "Demo book — Recheck asks the worker or a CSV for live facts.");
  }

  /** Scheduled MVP path: re-evaluate the latest structured PMS evidence
   * already admitted to Desk. This is deterministic, model-independent and
   * still fails closed through MoneyPosition freshness/conflict projection.
   * It does not scan for a newer file or pretend to refresh the PMS. */
  runMorningCheckFromCurrentSource(): DeskSnapshot {
    this.assertWritable();
    if (this.store.data.mode === "demo") return this.runMorningCheck();
    if (!this.store.data.sources.some((source) => source.kind === "csv")) {
      this.holdBook("No structured PMS export is attached to this live book. Import a current export on Desk.", {
        sourceId: "src-csv",
        kind: "csv",
        label: "PMS export",
        stableKey: "csv:src-csv",
        code: "missing",
      });
      return this.snapshot();
    }
    const csvSources = this.store.data.sources.filter((source) => source.kind === "csv");
    const latest = this.store.v3.evidence
      .filter((evidence) => csvSources.some((source) => source.id === evidence.sourceId) && evidence.observedAt != null)
      .sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))[0];
    if (!latest || latest.staleAt <= this.now()) {
      const source = csvSources.find((item) => item.id === latest?.sourceId) ?? csvSources[0]!;
      this.holdBook("The latest structured PMS export is stale. Import a current export before Bud prepares wording.", {
        sourceId: source.id,
        kind: "csv",
        label: source.label || "PMS export",
        stableKey: source.stableKey,
        code: "stale",
      });
      return this.snapshot();
    }
    return this.evaluateBook(
      "csv",
      "Re-evaluated the latest structured PMS export already on Desk. Import a newer export when the source is stale.",
    );
  }

  /** Live recheck. A miss never fabricates rows. Demo mode may still evaluate
   * the labelled Demo book, and that is not a successful live check. */
  async runMorningCheckLive(): Promise<DeskSnapshot> {
    this.assertWritable();
    const startedRevision = this.store.data.revision;
    const ids = this.store.data.properties.map((p) => p.id);
    const attempt = await this.hermes(ids);
    if (this.store.data.revision !== startedRevision) {
      throw Object.assign(new Error("Desk changed while Bud was checking. Recheck again from the current book."), {
        status: 409,
        code: "revision-conflict",
      });
    }
    if (attempt.rows) {
      const requested = new Set(ids);
      const rows = attempt.rows.filter((row) => requested.has(row.propertyId));
      this.observePortfolio("src-hermes", "hermes", "Worker ledger", rows, this.now(), ids);
      if (this.store.data.mode === "demo") {
        this.holdBook(`${attempt.detail} Worker-read balances remain unverified until a current PMS export is matched.`, {
          sourceId: "src-hermes",
          kind: "hermes",
          label: "Worker ledger",
          stableKey: "hermes:src-hermes",
          code: "unverified",
        });
        return this.snapshot();
      }
      return this.evaluateBook("hermes", `${attempt.detail} Worker-read balances are unverified; current PMS evidence remains authoritative.`);
    }
    if (this.store.data.mode === "demo") {
      return this.evaluateBook("demo", attempt.detail);
    }
    this.holdBook(attempt.detail, {
      sourceId: "src-hermes",
      kind: "hermes",
      label: "Worker ledger",
      stableKey: "hermes:src-hermes",
      code: "unavailable",
    });
    return this.snapshot();
  }

  importCsv(csv: string, observedAt = this.now(), expectedRevision?: number): DeskSnapshot {
    return this.importStructuredCsv(csv, observedAt, expectedRevision, {
      sourceId: "src-csv",
      sourceLabel: "PMS CSV export",
      sourceStableKey: "csv:src-csv",
    });
  }

  /** Broker-owned structured import. The digest-bound source marker is
   * committed atomically with the parsed evidence, so a crash after Desk
   * commit but before broker reconciliation can be retried without applying
   * the same output twice. */
  importBrokerCsv(input: {
    csv: string;
    observedAt: number;
    expectedRevision: number;
    sourceId: string;
    sourceLabel: string;
    sourceStableKey: string;
  }): DeskSnapshot {
    return this.importStructuredCsv(input.csv, input.observedAt, input.expectedRevision, input);
  }

  hasSourceStableKey(stableKey: string): boolean {
    return this.store.v3.sources.some((source) => source.stableKey === stableKey)
      || this.store.data.sources.some((source) => source.stableKey === stableKey);
  }

  hasBankTransactionDigests(transactionDigests: readonly string[]): boolean {
    const evidenceIds = new Set(this.store.data.observations.map((observation) => observation.id));
    return transactionDigests.every((digest) => evidenceIds.has(`obs-bank-${digest}`));
  }

  private importStructuredCsv(
    csv: string,
    observedAt: number,
    expectedRevision: number | undefined,
    source: { sourceId: string; sourceLabel: string; sourceStableKey: string },
  ): DeskSnapshot {
    this.assertWritable();
    if (expectedRevision != null && expectedRevision !== this.store.data.revision) {
      throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    }
    const batch = parsePmsExport(csv, observedAt, source.sourceId);
    if (!isFresh(batch.observedAt, CSV_FRESH_MS, this.now())) {
      this.holdBook(batch.observedAt > this.now() ? "PMS export timestamp is in the future" : "PMS export is stale", {
        sourceId: source.sourceId,
        kind: "csv",
        label: source.sourceLabel,
        stableKey: source.sourceStableKey,
        code: "stale",
      });
      return this.snapshot();
    }
    // Ambiguous and unmatched rows become held work items on Desk; only a
    // broken schema (thrown in parsePmsExport) rejects the whole batch.
    const savedDecisions = this.store.data.importIssues
      .filter((issue) => issue.sourceId === batch.sourceId && issue.status !== "open")
      .map((issue) => ({
        identity: { kind: issue.identityKind ?? "address", value: issue.rawIdentity } as ImportIdentity,
        action: issue.status === "linked" ? "linked" as const : "rejected" as const,
        propertyId: issue.linkedPropertyId,
      }));
    const resolved = resolveExportRows(this.store.data.properties, batch.rows, savedDecisions);
    const rowsByProperty = new Map<string, LedgerFacts[]>();
    for (const row of resolved.matched) {
      const rows = rowsByProperty.get(row.propertyId) ?? [];
      rows.push(row);
      rowsByProperty.set(row.propertyId, rows);
    }
    const conflictedIds = new Set<string>();
    let matched: LedgerFacts[] = [];
    for (const [propertyId, rows] of rowsByProperty) {
      if (rows.length === 1) matched.push(rows[0]!);
      else conflictedIds.add(propertyId);
    }
    for (const hit of resolved.ambiguous) {
      for (const propertyId of hit.ids) conflictedIds.add(propertyId);
    }
    matched = matched.filter((row) => !conflictedIds.has(row.propertyId));
    const previous = this.store.data.ledger.map((row) => ({ ...row }));
    try {
      for (const row of matched) {
        const idx = this.store.data.ledger.findIndex((item) => item.propertyId === row.propertyId);
        if (idx >= 0) this.store.data.ledger[idx] = row;
        else this.store.data.ledger.push(row);
      }
      for (const row of resolved.unmatched) {
        this.holdWork(unmatchedException(row.identity.value, batch.observedAt, batch.sourceId)).importIdentity = { ...row.identity };
      }
      for (const hit of resolved.ambiguous) {
        this.holdWork(ambiguousMatchException(hit.row.identity.value, hit.ids, batch.observedAt, batch.sourceId)).importIdentity = { ...hit.row.identity };
      }
      for (const propertyId of conflictedIds) {
        if (rowsByProperty.get(propertyId)?.length === 1) continue;
        this.holdWork({
          propertyId,
          reason: "conflicted-source",
          daysLate: this.facts(propertyId).daysSinceDue,
          observedAt: batch.observedAt,
          sourceId: batch.sourceId,
          detail: "the export contains more than one row for this property",
        });
      }
    } catch (err) {
      this.store.data.ledger = previous;
      throw err;
    }
    const held = resolved.unmatched.length + resolved.ambiguous.length + [...conflictedIds].filter((id) => (rowsByProperty.get(id)?.length ?? 0) > 1).length;
    if (!matched.length) {
      // Nothing usable in the batch: holds are recorded on Desk, but the
      // book keeps its current hands. Fixture facts never pose as live.
      this.rememberSource(source.sourceId, "csv", source.sourceLabel, source.sourceStableKey);
      this.store.persist();
      this.emit();
      return this.snapshot();
    }
    this.store.data.mode = "live";
    this.observePortfolio(
      source.sourceId,
      "csv",
      source.sourceLabel,
      matched,
      batch.observedAt,
      this.store.data.properties.map((property) => property.id),
      conflictedIds,
      source.sourceStableKey,
    );
    const missing = this.store.data.properties.length - matched.length - conflictedIds.size;
    return this.evaluateBook(
      "csv",
      `PMS export covered ${matched.length} of ${this.store.data.properties.length} properties` +
        (missing > 0 ? `; ${missing} missing from this snapshot` : "") +
        (held ? `; ${held} row${held === 1 ? "" : "s"} held for review` : "") +
        (resolved.rejected.length ? `; ${resolved.rejected.length} saved row rejection${resolved.rejected.length === 1 ? "" : "s"} applied.` : "."),
    );
  }

  /** Typed read-only bank comparison. It records only digest-addressed
   * credit observations. Raw references, account numbers and credentials do
   * not enter Desk. Exact matches can veto stale/wrong warning wording but
   * can never become PMS authority or perform trust reconciliation. */
  importBankObservations(batch: BankObservationBatch, expectedRevision: number): DeskSnapshot {
    this.assertWritable();
    if (expectedRevision !== this.store.data.revision) {
      throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    }
    if (!isFresh(batch.observedAt, BANK_OBSERVATION_FRESH_MS, this.now())) {
      throw Object.assign(
        new Error(batch.observedAt > this.now() ? "bank observation timestamp is in the future" : "bank observation is stale"),
        { status: 409, code: "stale-bank-observation" },
      );
    }
    const result = matchBankCredits(this.store.data.properties, batch);
    const sourceId = `src-bank-${batch.accountFingerprint.slice(0, 20)}`;
    const sourceStableKey = `bank:${batch.accountFingerprint}`;
    const seen = new Set(this.store.data.observations.map((observation) => observation.id));
    const matches = new Map(result.matched.map((match) => [match.credit.transactionDigest, match]));
    const holds = new Map(result.held.map((hold) => [hold.credit.transactionDigest, hold]));
    let added = 0;

    for (const credit of batch.credits) {
      const observationId = `obs-bank-${credit.transactionDigest}`;
      if (seen.has(observationId)) continue;
      seen.add(observationId);
      const match = matches.get(credit.transactionDigest);
      const hold = holds.get(credit.transactionDigest);
      if (match) {
        const facts = this.facts(match.propertyId);
        this.store.data.observations.push({
          id: observationId,
          sourceId,
          observedAt: batch.observedAt,
          propertyId: match.propertyId,
          staleAfterMs: BANK_CREDIT_RELEVANCE_MS,
          coverage: "observed",
          facts: {
            ...facts,
            rentLanded: true,
            amountPaidCents: credit.amountCents,
          },
        });
      } else {
        // Persist a content-free marker even for a held transaction so retry
        // cannot mint duplicate exception cards. The raw reference is never
        // copied into the book.
        this.store.data.observations.push({
          id: observationId,
          sourceId,
          observedAt: batch.observedAt,
          staleAfterMs: BANK_CREDIT_RELEVANCE_MS,
          coverage: "missing",
        });
        const identity = `Bank credit ${credit.transactionDigest.slice(0, 10)}`;
        if (hold?.reason === "unmatched") {
          this.holdWork(unmatchedException(identity, batch.observedAt, sourceId));
        } else if (hold?.reason === "ambiguous") {
          this.holdWork(ambiguousMatchException(identity, hold.candidatePropertyIds, batch.observedAt, sourceId));
        } else {
          const propertyId = hold?.candidatePropertyIds[0] ?? identity;
          this.holdWork({
            propertyId,
            reason: "conflicted-source",
            daysLate: this.store.data.ledger.find((row) => row.propertyId === propertyId)?.daysSinceDue ?? 0,
            observedAt: batch.observedAt,
            sourceId,
            detail: hold?.reason === "multiple-credits"
              ? "more than one bank credit matched this property in the bounded check"
              : hold?.reason === "outside-payment-window"
                ? "the credit fell outside the bounded weekly or fortnightly payment window"
                : "the bank credit amount did not equal the configured weekly or fortnightly rent",
          });
        }
      }
      added += 1;
    }

    if (added === 0) return this.snapshot();
    this.rememberSource(sourceId, "portal", "Read-only bank activity", sourceStableKey);
    if (this.store.data.mode !== "live") {
      this.store.persist();
      this.emit();
      return this.snapshot();
    }
    const detail = `PMS evidence compared with read-only bank activity: ${result.matched.length} exact code/amount match${result.matched.length === 1 ? "" : "es"}; ${result.held.length} held. Bank activity does not replace the PMS or perform trust reconciliation.`;
    return this.evaluateBook(this.store.data.hands, detail);
  }

  /** Source-safe Wave 1 foundation. It accepts only the bounded in-memory
   * contract and is deliberately restricted to the labelled Demo book until
   * a named-office read-only mailbox adapter is approved. */
  ingestInboundFixture(batch: InboundBatchInput, expectedRevision: number): DeskSnapshot {
    this.assertWritable();
    if (expectedRevision !== this.store.data.revision) {
      throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    }
    if (this.store.data.mode !== "demo") {
      throw Object.assign(new Error("Live inbox triage is pilot-gated until a named read-only mailbox is configured."), {
        status: 409,
        code: "pilot-gated",
      });
    }

    const now = this.now();
    const classified = classifyInboundBatch(batch, this.store.data.properties, this.store.v3.agency.name, now);
    const existingKeys = new Set(this.store.v3.evidence.map((item) => item.sourceRecordKey));
    const fresh = classified.filter((item) => !existingKeys.has(item.detail.messageKey));
    if (fresh.length === 0) return this.snapshot();

    const sourceId = "src-demo-inbox";
    this.store.data.workItems = this.store.data.workItems.filter(
      (work) => work.id !== "case-maint-prop-oak" && work.id !== "case-inbound-prop-oak",
    );
    if (!this.store.data.sources.some((source) => source.id === sourceId)) {
      this.store.data.sources.push({ id: sourceId, kind: "mail", label: "Demo read-only inbox", stableKey: "demo:read-only-inbox" });
    }
    if (!this.store.v3.sources.some((source) => source.id === sourceId)) {
      this.store.v3.sources.push({
        id: sourceId,
        authority: "demo",
        collector: "mail",
        label: "Demo read-only inbox",
        stableKey: "demo:read-only-inbox",
        freshnessMs: 7 * 24 * 60 * 60 * 1_000,
      });
    }

    for (const item of fresh) {
      const evidenceId = `ev-mail-${item.detail.messageKey.slice(0, 32)}`;
      this.store.v3.evidence.push({
        id: evidenceId,
        authority: "demo",
        collector: "mail",
        sourceId,
        sourceRecordKey: item.detail.messageKey,
        observedAt: item.detail.receivedAt,
        ingestedAt: now,
        staleAt: now + 7 * 24 * 60 * 60 * 1_000,
        propertyId: item.propertyId,
        payload: { inbound: item.detail },
      });
    }

    const byThread = new Map<string, ClassifiedInbound[]>();
    for (const item of fresh) {
      const rows = byThread.get(item.detail.threadKey) ?? [];
      rows.push(item);
      byThread.set(item.detail.threadKey, rows);
    }

    for (const [threadKey, rows] of byThread) {
      const strongest = strongestInbound(rows);
      const latest = rows.slice().sort((a, b) => b.detail.receivedAt - a.detail.receivedAt)[0]!;
      const propertyIds = new Set(rows.map((row) => row.propertyId).filter((id): id is string => Boolean(id)));
      const existing = this.store.data.workItems.find((work) => work.inbound?.threadKey === threadKey && work.state !== "cancelled");
      if (existing?.propertyId) propertyIds.add(existing.propertyId);
      const ambiguousThread = propertyIds.size > 1;
      const propertyId = ambiguousThread ? "" : ([...propertyIds][0] ?? strongest.propertyId ?? "");
      const property = this.store.data.properties.find((item) => item.id === propertyId);
      const evidenceIds = [
        ...(existing?.evidenceIds ?? (existing?.evidenceId ? [existing.evidenceId] : [])),
        ...rows.map((row) => `ev-mail-${row.detail.messageKey.slice(0, 32)}`),
      ].filter((id, index, all) => all.indexOf(id) === index);
      const flags = [...new Set([...(existing?.inbound?.flags ?? []), ...rows.flatMap((row) => row.detail.flags), ...(ambiguousThread ? ["thread-property-conflict"] : [])])];
      const detail: InboundCaseDetail = {
        ...strongest.detail,
        senderName: latest.detail.senderName,
        senderAddress: latest.detail.senderAddress,
        subject: latest.detail.subject,
        receivedAt: latest.detail.receivedAt,
        messageKey: latest.detail.messageKey,
        attachmentCount: (existing?.inbound?.attachmentCount ?? 0) + rows.reduce((sum, row) => sum + row.detail.attachmentCount, 0),
        messageCount: (existing?.inbound?.messageCount ?? 0) + rows.length,
        flags,
      };
      const contact = property
        ? this.store.v3.contacts.find((candidate) => candidate.propertyId === property.id && candidate.name.trim().toLowerCase() === detail.senderName.trim().toLowerCase())
        : undefined;
      const blockedByContact = Boolean(contact?.safeguards.doNotContact);
      const holdReason = ambiguousThread
        ? "Held because one message thread refers to more than one property."
        : blockedByContact
          ? "Held because the matched contact has a do-not-contact safeguard."
          : strongest.holdReason;
      const draftBody = holdReason ? undefined : strongest.draftBody;

      if (existing) {
        existing.kind = strongest.workKind;
        existing.propertyId = propertyId;
        existing.occurrenceKey = `inbound:${threadKey}`;
        existing.periodDueAt = detail.receivedAt;
        existing.recipient = { name: detail.senderName, phone: "", doNotContact: blockedByContact };
        existing.sourceIds = [sourceId];
        existing.observedAt = detail.receivedAt;
        existing.evidenceId = evidenceIds.at(-1);
        existing.evidenceIds = evidenceIds;
        existing.inbound = detail;
        existing.updatedAt = now;
        existing.holdReason = holdReason;
        const currentDraft = existing.draftId ? this.store.data.drafts.find((draft) => draft.id === existing.draftId) : undefined;
        if (!draftBody) {
          if (currentDraft?.status === "pending") currentDraft.status = "stale";
          existing.draftId = undefined;
          existing.state = "held";
          existing.proposalHash = `hold-inbound-${detail.messageKey.slice(0, 16)}`;
        } else if (currentDraft?.status === "pending") {
          currentDraft.propertyId = propertyId;
          currentDraft.kind = "inbound-reply";
          currentDraft.channel = "email";
          currentDraft.to = detail.senderAddress;
          currentDraft.body = draftBody;
          currentDraft.periodDueAt = detail.receivedAt;
          existing.state = "proposed";
          existing.proposalHash = proposalHash({ propertyId, kind: currentDraft.kind, periodDueAt: currentDraft.periodDueAt, body: currentDraft.body, to: currentDraft.to, channel: currentDraft.channel });
        } else {
          const draft = this.newInboundDraft(existing.id, propertyId, detail, draftBody, now);
          existing.draftId = draft.id;
          existing.state = "proposed";
          existing.proposalHash = proposalHash({ propertyId, kind: draft.kind, periodDueAt: draft.periodDueAt, body: draft.body, to: draft.to, channel: draft.channel });
          this.store.data.drafts.push(draft);
        }
        continue;
      }

      const workId = `case-inbound-${threadKey.slice(0, 32)}`;
      const draft = draftBody ? this.newInboundDraft(workId, propertyId, detail, draftBody, now) : undefined;
      const work: WorkItem = {
        id: workId,
        kind: strongest.workKind,
        state: draft ? "proposed" : "held",
        propertyId,
        occurrenceKey: `inbound:${threadKey}`,
        periodDueAt: detail.receivedAt,
        draftId: draft?.id,
        recipient: { name: detail.senderName, phone: "", doNotContact: blockedByContact },
        sourceIds: [sourceId],
        observedAt: detail.receivedAt,
        evidenceId: evidenceIds.at(-1),
        evidenceIds,
        proposalHash: draft
          ? proposalHash({ propertyId, kind: draft.kind, periodDueAt: draft.periodDueAt, body: draft.body, to: draft.to, channel: draft.channel })
          : `hold-inbound-${detail.messageKey.slice(0, 16)}`,
        createdAt: now,
        updatedAt: now,
        holdReason,
        inbound: detail,
        origin: this.pendingOrigin,
      };
      this.store.data.workItems.push(work);
      if (draft) this.store.data.drafts.push(draft);
    }

    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  ingestDemoInbox(expectedRevision: number): DeskSnapshot {
    return this.ingestInboundFixture(demoInboundBatch(this.now()), expectedRevision);
  }

  resolveImportIssue(input: {
    issueId: string;
    action: "linked" | "rejected";
    propertyId?: string;
    expectedRevision: number;
    requestId?: string;
  }): DeskSnapshot {
    this.assertWritable();
    const requestId = input.requestId?.trim() || `import-resolution-${randomUUID()}`;
    if (!/^[A-Za-z0-9._:-]{8,120}$/.test(requestId)) {
      throw Object.assign(new Error("requestId is invalid"), { status: 400, field: "requestId" });
    }
    const issue = this.store.data.importIssues.find((item) => item.id === input.issueId);
    if (!issue) throw Object.assign(new Error("no such import issue"), { status: 404 });
    const replay = issue.resolutions?.find((receipt) => receipt.id === requestId);
    if (replay) {
      if (replay.action !== input.action || replay.propertyId !== input.propertyId) {
        throw Object.assign(new Error("requestId was already used for a different import decision"), { status: 409, code: "idempotency-conflict" });
      }
      return this.snapshot();
    }
    if (input.expectedRevision !== this.store.data.revision) {
      throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    }
    if (input.action === "linked") {
      if (!input.propertyId || !this.store.data.properties.some((property) => property.id === input.propertyId)) {
        throw Object.assign(new Error("choose an active property for this import row"), { status: 400, field: "propertyId" });
      }
    } else if (input.propertyId) {
      throw Object.assign(new Error("a rejected row cannot be linked to a property"), { status: 400, field: "propertyId" });
    }

    const now = this.now();
    issue.status = input.action;
    issue.linkedPropertyId = input.action === "linked" ? input.propertyId : undefined;
    issue.resolvedAt = now;
    issue.resolvedBy = "pm";
    issue.resolutions = [
      ...(issue.resolutions ?? []),
      { id: requestId, action: input.action, propertyId: input.propertyId, actorId: "pm", at: now },
    ];
    this.store.data.workItems = this.store.data.workItems.filter((work) => work.id !== issue.id);
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  markInboundWaiting(workItemId: string, expectedRevision: number): DeskSnapshot {
    this.assertWritable();
    if (expectedRevision !== this.store.data.revision) throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    const work = this.requireInboundWork(workItemId);
    const draft = work.draftId ? this.store.data.drafts.find((item) => item.id === work.draftId) : undefined;
    if (!draft || draft.status !== "allowed") throw Object.assign(new Error("Allow the exact reply wording before recording an external send."), { status: 409 });
    assertTransition(work.state, "waiting");
    work.state = "waiting";
    const now = this.now();
    work.updatedAt = now;
    work.lifecycle = {
      waitingParty: "sender",
      dueAt: now + INBOUND_FOLLOW_UP_MS,
      nextCheckAt: now + INBOUND_FOLLOW_UP_MS,
    };
    if (work.inbound) {
      work.inbound.waitingOn = "sender";
      work.inbound.followUpAt = now + INBOUND_FOLLOW_UP_MS;
    }
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  closeInboundCase(workItemId: string, expectedRevision: number, closureKind: ClosureKind = "resolved-externally"): DeskSnapshot {
    this.assertWritable();
    if (expectedRevision !== this.store.data.revision) throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    if (!(CLOSURE_KINDS as readonly string[]).includes(closureKind)) {
      throw Object.assign(new Error("unknown closure reason"), { status: 400, field: "closureKind" });
    }
    const work = this.requireInboundWork(workItemId);
    assertTransition(work.state, "confirmed");
    work.state = "confirmed";
    const now = this.now();
    work.updatedAt = now;
    work.lifecycle = { closedAt: now, closedBy: "pm", closureKind };
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  snoozeCase(workItemId: string, expectedRevision: number, until: number): DeskSnapshot {
    this.assertWritable();
    if (expectedRevision !== this.store.data.revision) throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    const work = this.store.data.workItems.find((item) => item.id === workItemId);
    if (!work) throw Object.assign(new Error("no such case"), { status: 404 });
    const now = this.now();
    if (work.state !== "waiting") throw Object.assign(new Error("only a waiting case can be reminded later"), { status: 409 });
    if (!Number.isInteger(until) || until <= now || until > now + 365 * 24 * 60 * 60 * 1_000) {
      throw Object.assign(new Error("reminder time must be within the next 365 days"), { status: 400, field: "until" });
    }
    work.lifecycle = {
      ...(work.lifecycle ?? {}),
      reminderSuppressedUntil: until,
      nextCheckAt: until,
    };
    if (work.inbound) work.inbound.followUpAt = until;
    work.updatedAt = now;
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  cancelCase(workItemId: string, expectedRevision: number, closureKind: ClosureKind = "cancelled"): DeskSnapshot {
    this.assertWritable();
    if (expectedRevision !== this.store.data.revision) throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    if (!(CLOSURE_KINDS as readonly string[]).includes(closureKind)) {
      throw Object.assign(new Error("unknown closure reason"), { status: 400, field: "closureKind" });
    }
    const work = this.store.data.workItems.find((item) => item.id === workItemId);
    if (!work) throw Object.assign(new Error("no such case"), { status: 404 });
    assertTransition(work.state, "cancelled");
    const now = this.now();
    work.state = "cancelled";
    work.updatedAt = now;
    work.lifecycle = { closedAt: now, closedBy: "pm", closureKind };
    if (work.draftId) {
      const draft = this.store.data.drafts.find((item) => item.id === work.draftId);
      if (draft?.status === "pending") draft.status = "stale";
    }
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  private requireInboundWork(id: string): WorkItem {
    const work = this.store.data.workItems.find((item) => item.id === id);
    if (!work || (work.kind !== "inbound-triage" && work.kind !== "maintenance-intake")) {
      throw Object.assign(new Error("no such inbound case"), { status: 404 });
    }
    return work;
  }

  private newInboundDraft(workItemId: string, propertyId: string, detail: InboundCaseDetail, body: string, now: number): Draft {
    return {
      id: `draft-inbound-${randomUUID()}`,
      propertyId,
      kind: "inbound-reply",
      status: "pending",
      channel: "email",
      to: detail.senderAddress,
      body,
      periodDueAt: detail.receivedAt,
      createdAt: now,
      workItemId,
    };
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
    const now = this.now();
    const proposalKeys = new Set(
      this.store.v3.bookProposals.map(
        (proposal) => `${normalizeAddress(proposal.fields.address)}|${proposal.fields.tenantName.toLowerCase()}`,
      ),
    );
    const propertyAddresses = new Set(this.store.data.properties.map((property) => normalizeAddress(property.address)));
    let created = 0;
    let skipped = 0;
    for (const item of items ?? []) {
      const address = String(item.address ?? "").trim();
      const tenantName = String(item.tenantName ?? "").trim();
      const tenantPhone = String(item.tenantPhone ?? "").trim();
      const weeklyRentCents = Math.round(Number(item.weeklyRentCents));
      const addressKey = normalizeAddress(address);
      if (
        !addressKey ||
        intakeItemError({ address, tenantName, tenantPhone, weeklyRentCents })
      ) {
        skipped++;
        continue;
      }
      const key = `${addressKey}|${tenantName.toLowerCase()}`;
      const exists = proposalKeys.has(key) || propertyAddresses.has(addressKey);
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

  allowBookProposals(ids: string[], expectedRevision?: number): DeskSnapshot {
    this.assertWritable();
    if (expectedRevision != null && expectedRevision !== this.store.data.revision) {
      throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      throw Object.assign(new Error("select at least one book proposal"), { status: 400 });
    }
    const cleanIds = ids.map((id) => String(id ?? "").trim());
    if (cleanIds.some((id) => !id) || new Set(cleanIds).size !== cleanIds.length) {
      throw Object.assign(new Error("book proposal ids must be unique"), { status: 400 });
    }
    if (this.store.data.properties.length + cleanIds.length > 200) {
      throw Object.assign(new Error("the book is full (200 properties)"), { status: 400 });
    }
    const proposalsById = new Map(this.store.v3.bookProposals.map((proposal) => [proposal.id, proposal]));
    const proposals = cleanIds.map((id) => {
      const proposal = proposalsById.get(id);
      if (!proposal) throw Object.assign(new Error("no such book proposal"), { status: 404 });
      return proposal;
    });
    const prepared = this.prepareProperties(proposals.map((proposal) => proposal.fields));
    return this.commitPropertyBatch(
      prepared,
      new Set(cleanIds),
      prepared.map((item, index) => ({
        propertyId: item.property.id,
        address: item.property.address,
        line: `added from ${proposals[index]!.origin === "ask" ? "Bud intake" : "intake"} — ${proposals[index]!.fields.address}, ${proposals[index]!.fields.tenantName}`,
      })),
    );
  }

  allowBookProposal(id: string, expectedRevision?: number): DeskSnapshot {
    return this.allowBookProposals([id], expectedRevision);
  }

  denyBookProposals(ids: string[], expectedRevision?: number): DeskSnapshot {
    this.assertWritable();
    if (expectedRevision != null && expectedRevision !== this.store.data.revision) {
      throw Object.assign(new Error("stale desk revision"), { status: 409, code: "revision-conflict" });
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      throw Object.assign(new Error("select at least one book proposal"), { status: 400 });
    }
    const cleanIds = ids.map((id) => String(id ?? "").trim());
    if (cleanIds.some((id) => !id) || new Set(cleanIds).size !== cleanIds.length) {
      throw Object.assign(new Error("book proposal ids must be unique"), { status: 400 });
    }
    const existingIds = new Set(this.store.v3.bookProposals.map((proposal) => proposal.id));
    if (cleanIds.some((id) => !existingIds.has(id))) {
      throw Object.assign(new Error("no such book proposal"), { status: 404 });
    }
    const denied = new Set(cleanIds);
    this.store.v3 = {
      ...this.store.v3,
      bookProposals: this.store.v3.bookProposals.filter((proposal) => !denied.has(proposal.id)),
    };
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  denyBookProposal(id: string, expectedRevision?: number): DeskSnapshot {
    return this.denyBookProposals([id], expectedRevision);
  }

  /** Recovery escrow: the book key as hex (You-page reveal/copy). */
  recoveryKeyHex(): string {
    return this.store.keyHex;
  }

  get keyFilePath(): string {
    return this.store.keyFile;
  }

  /** Unlock a quarantined book with the escrowed key: try every quarantined
   * snapshot, and on the first that decrypts, restore the key + book files.
   * The app restarts to reopen the restored book. */
  unlockWithKey(keyHex: string): { ok: true; restoredFrom: string; needsRestart: true } {
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
      // key verified against this snapshot: restore both files
      writeFileSync(this.keyFilePath, Buffer.from(clean, "hex"), { mode: 0o600 });
      renameSync(candidate, this.keyFilePath.replace("desk.key", "desk.json"));
      return { ok: true, restoredFrom: candidate, needsRestart: true };
    }
    throw Object.assign(new Error("that key does not open the quarantined book"), { status: 403 });
  }

    resetFixtures(): DeskSnapshot {
    this.assertWritable();
    const book = fixtureBook();
    this.store.data.properties = book.properties;
    this.store.data.ledger = book.ledger;
    this.store.data.drafts = [];
    this.store.data.escalations = [];
    this.store.data.workItems = [];
    this.store.data.results = [];
    this.store.data.lastRunAt = null;
    this.store.data.mode = "demo";
    this.store.data.hands = "demo";
    this.store.data.handsDetail = null;
    this.store.data.capabilities = [];
    this.store.persist();
    return this.evaluateBook("demo", "Demo book reset.");
  }

  patchProperty(id: string, patch: Partial<PropertyOptions>): Property {
    this.assertWritable();
    const property = this.store.data.properties.find((p) => p.id === id);
    if (!property) throw Object.assign(new Error("no such property"), { status: 404 });
    applyOptions(property.options, patch);
    this.invalidateCapabilities({ propertyId: id });
    this.store.persist();
    this.emit();
    return property;
  }

  addProperties(inputs: NewPropertyInput[]): DeskSnapshot {
    this.assertWritable();
    const prepared = this.prepareProperties(inputs);
    return this.commitPropertyBatch(prepared);
  }

  addProperty(input: NewPropertyInput): DeskSnapshot {
    return this.addProperties([input]);
  }

  private prepareProperties(inputs: NewPropertyInput[]): PreparedProperty[] {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw Object.assign(new Error("add at least one property"), { status: 400 });
    }
    if (this.store.data.properties.length + inputs.length > 200) {
      throw Object.assign(new Error("the book is full (200 properties)"), { status: 400 });
    }

    const addresses = new Set<string>();
    const propertyCodes = new Set(
      this.store.data.properties
        .map((property) => property.propertyCode?.trim().toLowerCase())
        .filter((value): value is string => Boolean(value)),
    );
    const ids = new Set([
      ...this.store.data.properties.map((property) => property.id),
      ...this.store.v3.properties.map((property) => property.id),
    ]);
    const prepared: PreparedProperty[] = [];

    for (const input of inputs) {
      const address = String(input.address ?? "").trim();
      const tenantName = String(input.tenantName ?? "").trim();
      const tenantPhone = String(input.tenantPhone ?? "").trim();
      const propertyCode = String(input.propertyCode ?? "").trim();
      const rent = Number(input.weeklyRentCents);
      if (!address || !normalizeAddress(address)) throw Object.assign(new Error("address required"), { status: 400 });
      const issue = intakeItemError({ address, tenantName, tenantPhone, weeklyRentCents: rent });
      if (issue) throw Object.assign(new Error(issue), { status: 400 });
      if (propertyCode && (propertyCode.length > 120 || /[\u0000-\u001f\u007f]/.test(propertyCode))) {
        throw Object.assign(new Error("property code is invalid"), { status: 400, field: "propertyCode" });
      }

      const addressKey = normalizeAddress(address);
      if (addresses.has(addressKey)) {
        throw Object.assign(new Error(`a property already exists at ${address}`), { status: 409, field: "address" });
      }
      addresses.add(addressKey);
      const propertyCodeKey = propertyCode.toLowerCase();
      if (propertyCodeKey && propertyCodes.has(propertyCodeKey)) {
        throw Object.assign(new Error(`property code ${propertyCode} is already in use`), { status: 409, field: "propertyCode" });
      }
      if (propertyCodeKey) propertyCodes.add(propertyCodeKey);

      const options = shopDefaults();
      if (input.options) applyOptions(options, input.options);
      let id: string;
      do {
        id = `prop-${randomUUID().slice(0, 8)}`;
      } while (ids.has(id) || existsSync(join(this.vaultRoot, "properties", `${id}.md`)));
      ids.add(id);
      prepared.push({
        property: { id, address, propertyCode: propertyCode || undefined, tenantName, tenantPhone, weeklyRentCents: rent, options },
        facts: {
          propertyId: id,
          daysSinceDue: 0,
          rentLanded: false,
          levyPaid: false,
          daysSinceCourtesy: null,
        },
      });
    }
    return prepared;
  }

  /** One visible bulk approval becomes one encrypted Desk commit. Inputs and
   * references are fully validated before this method mutates the working
   * book; write failures restore the in-memory book and new Notes files. */
  private commitPropertyBatch(
    prepared: PreparedProperty[],
    proposalIds = new Set<string>(),
    intakeNotes: IntakeAllowedNote[] = [],
  ): DeskSnapshot {
    const previousData = structuredClone(this.store.data);
    const previousV3 = this.store.v3;
    const notePaths = prepared.map((item) => join(this.vaultRoot, "properties", `${item.property.id}.md`));
    const decisionAt = this.now();
    const decisionPath = join(this.vaultRoot, "decisions", `${new Date(decisionAt).toISOString().slice(0, 10)}.md`);
    const decisionExisted = intakeNotes.length > 0 && existsSync(decisionPath);
    const previousDecision = decisionExisted ? readFileSync(decisionPath, "utf8") : null;
    let persistStarted = false;

    try {
      for (const item of prepared) {
        this.store.data.properties.push(item.property);
        this.store.data.ledger.push(item.facts);
      }
      if (intakeNotes.length > 0) {
        appendAllowedLines(
          intakeNotes.map((note) => ({ id: note.propertyId, line: note.line, address: note.address })),
          this.vaultRoot,
          decisionAt,
        );
      } else {
        for (const item of prepared) {
          writePropertyNote(item.property.id, "", { address: item.property.address }, this.vaultRoot);
        }
      }
      if (proposalIds.size > 0) {
        this.store.v3 = {
          ...this.store.v3,
          bookProposals: this.store.v3.bookProposals.filter((proposal) => !proposalIds.has(proposal.id)),
        };
      }
      this.evaluateBookInMemory(this.store.data.hands, this.store.data.handsDetail);
      persistStarted = true;
      this.store.persist();
    } catch (error) {
      const diskState = persistStarted ? this.propertyBatchDiskState(prepared, proposalIds) : "not-landed";
      if (diskState !== "not-landed") {
        const message = diskState === "landed"
          ? "RealBud saved the full batch, but could not verify that storage safely finished. Restart RealBud before making another change."
          : "RealBud could not verify whether the full batch reached storage. Restart RealBud before making another change.";
        this.store.recovery = failClosedRecovery(message);
        throw Object.assign(
          new Error(message),
          { status: 503, code: "commit-outcome-unknown", cause: error },
        );
      }
      this.store.data = previousData;
      this.store.v3 = previousV3;
      for (const path of notePaths) {
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          /* best-effort cross-file rollback; preserve the original failure */
        }
      }
      if (intakeNotes.length > 0) {
        try {
          if (previousDecision !== null) writeFileSync(decisionPath, previousDecision);
          else if (existsSync(decisionPath)) unlinkSync(decisionPath);
        } catch {
          /* best-effort audit-file rollback; preserve the original failure */
        }
      }
      throw error;
    }
    this.emit();
    return this.snapshot();
  }

  private propertyBatchDiskState(
    prepared: PreparedProperty[],
    proposalIds: Set<string>,
  ): "landed" | "not-landed" | "unknown" {
    try {
      const envelope = JSON.parse(readFileSync(this.store.file, "utf8"));
      const plain = decryptJson(Buffer.from(this.store.keyHex, "hex"), envelope);
      const decoded = decodeDeskPlain(plain, { properties: [], ledger: [] }, this.store.data.timezone);
      if (decoded.version !== 3 || decoded.data.revision !== this.store.data.revision) return "not-landed";
      const propertyIds = new Set(decoded.data.properties.map((property) => property.id));
      const openProposalIds = new Set(decoded.data.bookProposals.map((proposal) => proposal.id));
      const landed = prepared.every((item) => propertyIds.has(item.property.id))
        && [...proposalIds].every((id) => !openProposalIds.has(id));
      return landed ? "landed" : "not-landed";
    } catch {
      return "unknown";
    }
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
    return this.evaluateBook(this.store.data.hands, this.store.data.handsDetail);
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
    const now = this.now();
    let facts = this.facts(property.id);
    let factsObservedAt = now;
    let position: MoneyPosition | undefined;
    if (this.store.data.mode === "live") {
      const preview = this.store.previewV3(now);
      const tenancy = preview.tenancies.find((item) => item.propertyId === property.id && item.status === "current");
      position = tenancy ? preview.moneyPositions.find((item) => item.tenancyId === tenancy.id) : undefined;
      const projectedProperty = preview.properties.find((item) => item.id === property.id);
      const result = position && tenancy && projectedProperty
        ? evaluateFromProjection({
            propertyId: property.id,
            address: property.address,
            weeklyRentCents: tenancy.weeklyRentCents,
            options: projectedProperty.options,
            tenancyId: tenancy.id,
            money: position,
          })
        : null;
      const supportedKind = result?.reason === "rent-landed-levy-unpaid" ? "levy-from-rent" : result?.reason === "rent-unpaid-courtesy" ? "courtesy-rent" : null;
      if (position?.status !== "current" || result?.outcome !== "draft" || supportedKind !== kind) {
        throw Object.assign(new Error("Current PMS evidence does not support that wording. Recheck the property first."), {
          status: 409,
          code: "source-not-actionable",
        });
      }
      facts = {
        propertyId: property.id,
        daysSinceDue: position.facts.daysSinceDue ?? 0,
        rentLanded: position.facts.rentLanded ?? false,
        levyPaid: position.facts.levyPaid ?? false,
        daysSinceCourtesy: position.facts.daysSinceCourtesy ?? null,
        amountPaidCents: position.facts.amountPaidCents,
        reversed: position.facts.reversed,
      };
      factsObservedAt = position.observedAt ?? now;
    }
    const periodDueAt = dueDate(factsObservedAt, facts.daysSinceDue);
    const key = occurrenceKey(property.id, kind, periodDueAt);
    if (this.store.data.mode === "live") this.staleOpenMoneyWork(property.id, key, now);
    const pending = this.store.data.drafts.find((draft) => {
      if (draft.propertyId !== property.id || draft.kind !== kind || draft.status !== "pending" || draft.periodDueAt !== periodDueAt) return false;
      return true;
    });
    if (pending) {
      const work = this.workForDraft(pending);
      this.groundWork(work, position, position?.sourceId ?? "src-ask", factsObservedAt);
      this.store.persist();
      this.emit();
      return this.snapshot();
    }
    const draft = composeDraft(property, facts, now, kind, factsObservedAt);
    if (input.body?.trim()) {
      draft.body = kind === "courtesy-rent" ? withCourtesyDisclaimer(input.body) : input.body.trim();
    }
    const work = this.newWork(property, draft, now, "proposed", ["src-ask"], position);
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
    const preview = this.store.data.mode === "live" ? this.store.previewV3(now) : null;
    for (const property of this.store.data.properties) {
      const tenancy = preview?.tenancies.find((item) => item.propertyId === property.id && item.status === "current");
      const position = tenancy ? preview?.moneyPositions.find((item) => item.tenancyId === tenancy.id) : undefined;
      if (preview && position?.status !== "current") {
        const key = occurrenceKey(property.id, "hold:owner-letter-source", weekStart);
        const existing = this.store.data.workItems.find((item) => item.occurrenceKey === key && item.state === "held");
        if (!existing) {
          this.store.data.workItems.push({
            id: `work-${randomUUID()}`,
            kind: "owner-letter",
            state: "held",
            propertyId: property.id,
            occurrenceKey: key,
            periodDueAt: weekStart,
            recipient: { name: "Owner", phone: "" },
            sourceIds: position ? [position.sourceId] : [],
            observedAt: position?.observedAt ?? now,
            evidenceId: position?.evidenceId,
            evidenceStatus: position?.status ?? "requires-recheck",
            evidenceStaleAt: position?.staleAt,
            proposalHash: "hold-owner-letter-source",
            createdAt: now,
            updatedAt: now,
            holdReason: "current PMS evidence required before drafting an owner update",
            origin: this.pendingOrigin,
          });
        }
        continue;
      }
      for (const held of this.store.data.workItems) {
        if (held.kind === "owner-letter" && held.propertyId === property.id && held.state === "held" && held.periodDueAt === weekStart) {
          held.state = "stale";
          held.updatedAt = now;
        }
      }
      const exists = this.store.data.drafts.some(
        (d) => d.propertyId === property.id && d.kind === "owner-letter" && d.periodDueAt === weekStart && d.status !== "stale",
      );
      if (exists) continue;
      const facts = position
        ? {
            propertyId: property.id,
            daysSinceDue: position.facts.daysSinceDue ?? 0,
            rentLanded: position.facts.rentLanded ?? false,
            levyPaid: position.facts.levyPaid ?? false,
            daysSinceCourtesy: position.facts.daysSinceCourtesy ?? null,
            amountPaidCents: position.facts.amountPaidCents,
            reversed: position.facts.reversed,
          }
        : this.facts(property.id);
      const note = readPropertyNote(property.id, this.vaultRoot);
      const draft = composeOwnerLetter(property, facts, note, now);
      const work = this.newWork(property, draft, now, "proposed", ["src-desk"], position);
      draft.workItemId = work.id;
      this.store.data.drafts.push(draft);
      this.store.data.workItems.push(work);
    }
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  allowDraft(id: string, expectedRevision?: number): Draft {
    return this.command({ type: "allow", draftId: id, expectedRevision: expectedRevision ?? this.store.data.revision }).drafts.find((d) => d.id === id)!;
  }

  denyDraft(id: string, expectedRevision?: number): Draft {
    return this.command({ type: "deny", draftId: id, expectedRevision: expectedRevision ?? this.store.data.revision }).drafts.find((d) => d.id === id)!;
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
        return this.importCsv(cmd.csv, cmd.observedAt);
      case "propose":
        return this.proposeFromAsk(cmd);
      case "allow":
        this.decide(cmd.draftId, "approved", cmd.approver ?? "pm");
        break;
      case "deny":
        this.decide(cmd.draftId, "denied");
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

  private evaluateBook(hands: HandsSource, handsDetail: string | null): DeskSnapshot {
    this.evaluateBookInMemory(hands, handsDetail);
    this.store.persist();
    this.emit();
    return this.snapshot();
  }

  private evaluateBookInMemory(hands: HandsSource, handsDetail: string | null): void {
    const now = this.now();
    const liveEvidence = this.store.data.mode === "live" && hands !== "demo";
    const preview = liveEvidence ? this.store.previewV3(now) : null;
    const results: DeskSnapshot["results"] = [];
    for (const property of this.store.data.properties) {
      const facts = this.facts(property.id);
      const tenancy = preview?.tenancies.find((item) => item.propertyId === property.id && item.status === "current");
      const position = tenancy ? preview?.moneyPositions.find((item) => item.tenancyId === tenancy.id) : undefined;
      const projectedProperty = preview?.properties.find((item) => item.id === property.id);
      const projected = position && tenancy && projectedProperty
        ? evaluateFromProjection({
            propertyId: property.id,
            address: property.address,
            weeklyRentCents: tenancy.weeklyRentCents,
            options: projectedProperty.options,
            tenancyId: tenancy.id,
            money: position,
          })
        : null;
      const classified = projected
        ? {
            ...projected,
            observedAt: position?.observedAt ?? now,
            sourceId: position?.sourceId ?? "src-held",
          }
        : liveEvidence
          ? {
              propertyId: property.id,
              outcome: "hold" as const,
              reason: "unknown-facts" as const,
              daysLate: 0,
              observedAt: now,
              sourceId: "src-held",
            }
          : classifyMoneyRow(property, facts, now, hands === "csv" ? "src-csv" : hands === "hermes" ? "src-hermes" : "src-demo");
      if (liveEvidence) this.staleOwnerWorkForEvidence(property.id, position, now);
      results.push({ propertyId: classified.propertyId, outcome: classified.outcome, reason: classified.reason, daysLate: classified.daysLate });
      const positionFacts: LedgerFacts = position
        ? {
            propertyId: property.id,
            daysSinceDue: position.facts.daysSinceDue ?? 0,
            rentLanded: position.facts.rentLanded ?? false,
            levyPaid: position.facts.levyPaid ?? false,
            daysSinceCourtesy: position.facts.daysSinceCourtesy ?? null,
            amountPaidCents: position.facts.amountPaidCents,
            reversed: position.facts.reversed,
          }
        : facts;
      const factsObservedAt = position?.observedAt ?? now;
      const periodDueAt = dueDate(factsObservedAt, positionFacts.daysSinceDue);
      if (classified.outcome === "hold") {
        const holdKey = occurrenceKey(property.id, `hold:${classified.reason}`, 0);
        this.staleOpenMoneyWork(property.id, holdKey, now);
        this.holdWork(classified, position);
      } else if (classified.outcome === "draft") {
        const kind: DraftKind = classified.reason === "rent-landed-levy-unpaid" ? "levy-from-rent" : "courtesy-rent";
        const key = occurrenceKey(property.id, kind, periodDueAt);
        this.staleOpenMoneyWork(property.id, key, now);
        const pending = this.store.data.workItems.find((work) => {
          if (work.kind !== "money-arrears" || work.occurrenceKey !== key || work.state !== "proposed") return false;
          const draft = this.store.data.drafts.find((item) => item.id === work.draftId || item.workItemId === work.id);
          return draft?.status === "pending";
        });
        if (pending) {
          this.groundWork(pending, position, classified.sourceId, classified.observedAt);
          continue;
        }
        const decided = this.store.data.workItems.some(
          (work) => work.kind === "money-arrears" && work.occurrenceKey === key && work.state !== "stale" && work.state !== "superseded" && work.state !== "cancelled",
        );
        const demoDuplicate = !liveEvidence && this.store.data.drafts.some((draft) => draft.propertyId === property.id && draft.kind === kind);
        if (!decided && !demoDuplicate) {
          const draft = composeDraft(property, positionFacts, now, kind, factsObservedAt);
          const work = this.newWork(property, draft, now, "proposed", [classified.sourceId], position);
          draft.workItemId = work.id;
          this.store.data.drafts.push(draft);
          this.store.data.workItems.push(work);
        }
      } else if (classified.outcome === "escalate") {
        this.staleOpenMoneyWork(property.id, undefined, now);
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
      } else {
        this.staleOpenMoneyWork(property.id, undefined, now);
        if (liveEvidence) {
          this.store.data.escalations = this.store.data.escalations.filter((item) => item.propertyId !== property.id);
        }
      }
    }
    this.store.data.results = results;
    this.store.data.lastRunAt = now;
    this.store.data.hands = hands;
    this.store.data.handsDetail = handsDetail;
  }

  private holdBook(
    detail: string,
    incident: {
      sourceId: string;
      kind: "csv" | "hermes" | "portal" | "demo";
      label: string;
      stableKey: string;
      code: "missing" | "stale" | "unavailable" | "unverified" | "revoked";
    },
  ): void {
    const now = this.now();
    this.rememberSource(incident.sourceId, incident.kind, incident.label, incident.stableKey);
    this.store.data.hands = "held";
    this.store.data.handsDetail = detail;
    this.store.data.lastRunAt = now;
    for (const property of this.store.data.properties) {
      this.staleOpenMoneyWork(property.id, occurrenceKey(property.id, "hold:unknown-facts", 0), now);
    }
    for (const legacy of this.store.data.workItems) {
      if (legacy.state === "held" && legacy.holdReason === "unknown-facts") {
        legacy.state = "stale";
        legacy.updatedAt = now;
      }
    }
    const active = this.store.data.workItems.find(
      (work) => work.kind === "source-incident" && work.state === "held" && work.sourceIncident?.sourceId === incident.sourceId,
    );
    if (active) {
      active.holdReason = detail;
      active.updatedAt = now;
      active.sourceIds = [incident.sourceId];
      active.sourceIncident = {
        sourceId: incident.sourceId,
        code: incident.code,
        affectedPropertyCount: this.store.data.properties.length,
        firstSeenAt: active.sourceIncident?.firstSeenAt ?? now,
        lastSeenAt: now,
      };
    } else {
      this.store.data.workItems.push({
        id: `case-source-${randomUUID()}`,
        kind: "source-incident",
        state: "held",
        propertyId: "",
        occurrenceKey: `source-incident:${incident.sourceId}`,
        periodDueAt: 0,
        recipient: { name: "", phone: "" },
        sourceIds: [incident.sourceId],
        observedAt: now,
        proposalHash: `source-incident:${incident.sourceId}:${incident.code}`,
        createdAt: now,
        updatedAt: now,
        holdReason: detail,
        sourceIncident: {
          sourceId: incident.sourceId,
          code: incident.code,
          affectedPropertyCount: this.store.data.properties.length,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        origin: this.pendingOrigin,
      });
    }
    this.store.data.results = this.store.data.properties.map((property) => ({
      propertyId: property.id,
      outcome: "hold",
      reason: incident.code === "stale" ? "stale-source" : "unknown-facts",
      daysLate: this.facts(property.id).daysSinceDue,
    }));
    this.store.persist();
    this.emit();
  }

  private holdWork(
    exception: { propertyId: string; reason: string; daysLate: number; observedAt: number; sourceId: string; detail?: string },
    position?: MoneyPosition,
  ): WorkItem {
    const key = occurrenceKey(exception.propertyId, `hold:${exception.reason}`, 0);
    const existing = this.store.data.workItems.find((work) => work.occurrenceKey === key && work.state === "held");
    if (existing) {
      existing.holdReason = exception.detail ? `${exception.reason}: ${exception.detail}` : exception.reason;
      existing.updatedAt = this.now();
      this.groundWork(existing, position, exception.sourceId, exception.observedAt);
      return existing;
    }
    const property = this.store.data.properties.find((p) => p.id === exception.propertyId);
    const work: WorkItem = {
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
      evidenceId: position?.evidenceId,
      evidenceStatus: position?.status,
      evidenceStaleAt: position?.staleAt,
      proposalHash: `hold-${exception.reason}`,
      createdAt: this.now(),
      updatedAt: this.now(),
      holdReason: exception.detail ? `${exception.reason}: ${exception.detail}` : exception.reason,
      origin: this.pendingOrigin,
    };
    this.store.data.workItems.push(work);
    return work;
  }

  private newWork(
    property: Property,
    draft: Draft,
    now: number,
    state: WorkState,
    sourceIds: string[],
    position?: MoneyPosition,
  ): WorkItem {
    return {
      id: `work-${randomUUID()}`,
      kind: draft.kind === "owner-letter" ? "owner-letter" : "money-arrears",
      state,
      propertyId: property.id,
      occurrenceKey: occurrenceKey(property.id, draft.kind, draft.periodDueAt),
      periodDueAt: draft.periodDueAt,
      draftId: draft.id,
      recipient: { name: property.tenantName, phone: property.tenantPhone },
      sourceIds: position ? [position.sourceId] : sourceIds,
      observedAt: position?.observedAt ?? now,
      evidenceId: position?.evidenceId,
      evidenceStatus: position?.status,
      evidenceStaleAt: position?.staleAt,
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

  private groundWork(work: WorkItem, position: MoneyPosition | undefined, sourceId: string, observedAt: number): void {
    work.sourceIds = [position?.sourceId ?? sourceId];
    work.observedAt = position?.observedAt ?? observedAt;
    work.evidenceId = position?.evidenceId;
    work.evidenceStatus = position?.status;
    work.evidenceStaleAt = position?.staleAt;
    work.updatedAt = this.now();
  }

  private staleOpenMoneyWork(propertyId: string, keepOccurrenceKey: string | undefined, now: number): void {
    for (const work of this.store.data.workItems) {
      if (work.kind !== "money-arrears" || work.propertyId !== propertyId) continue;
      if (work.occurrenceKey === keepOccurrenceKey) continue;
      if (work.state !== "proposed" && work.state !== "held") continue;
      work.state = "stale";
      work.updatedAt = now;
      work.holdReason = work.holdReason ?? "superseded by newer evidence";
      const draft = this.store.data.drafts.find((item) => item.id === work.draftId || item.workItemId === work.id);
      if (draft?.status === "pending") draft.status = "stale";
      this.invalidateCapabilities({ workItemId: work.id });
    }
  }

  private staleOwnerWorkForEvidence(propertyId: string, position: MoneyPosition | undefined, now: number): void {
    for (const work of this.store.data.workItems) {
      if (work.kind !== "owner-letter" || work.propertyId !== propertyId || work.state !== "proposed") continue;
      if (position?.status === "current" && work.evidenceId === position.evidenceId) continue;
      work.state = "stale";
      work.updatedAt = now;
      work.holdReason = "superseded by newer money evidence";
      const draft = this.store.data.drafts.find((item) => item.id === work.draftId || item.workItemId === work.id);
      if (draft?.status === "pending") draft.status = "stale";
      this.invalidateCapabilities({ workItemId: work.id });
    }
  }

  private decide(id: string, state: "approved" | "denied", approver = "pm"): void {
    const draft = this.requirePending(id);
    const work = this.workForDraft(draft);
    if (state === "approved") {
      assertOperationalDraftContent(draft.body, draft.kind);
      this.assertDraftStillSupported(draft, work);
    }
    assertTransition(work.state, state);
    draft.status = state === "approved" ? "allowed" : "denied";
    draft.decidedAt = this.now();
    work.state = state;
    work.updatedAt = this.now();
    if (state === "approved" && draft.channel === "portal") {
      this.mintCapability(work, draft, approver);
    }
    const property = this.store.data.properties.find((p) => p.id === draft.propertyId);
    const verb = state === "approved" ? "approved" : "denied";
    const kind =
      draft.kind === "levy-from-rent"
        ? "levy flag"
        : draft.kind === "owner-letter"
          ? "owner letter"
          : draft.kind === "inbound-reply"
            ? "inbound reply"
            : "courtesy SMS";
    if (property) {
      appendAllowedLine(
        draft.propertyId,
        `${new Date(this.now()).toISOString().slice(0, 10)} — ${verb} ${kind} for ${property.address} (not sent by RealBud).`,
        this.vaultRoot,
        property.address,
      );
    }
  }

  private assertDraftStillSupported(draft: Draft, work: WorkItem): void {
    if (draft.kind === "inbound-reply") {
      const inbound = work.inbound;
      const evidenceIds = new Set(work.evidenceIds ?? (work.evidenceId ? [work.evidenceId] : []));
      const hasMessageEvidence = this.store.v3.evidence.some(
        (item) => evidenceIds.has(item.id) && item.collector === "mail" && item.sourceRecordKey === inbound?.messageKey,
      );
      const expectedHash = proposalHash({
        propertyId: draft.propertyId,
        kind: draft.kind,
        periodDueAt: draft.periodDueAt,
        body: draft.body,
        to: draft.to,
        channel: draft.channel,
      });
      const blocked =
        !inbound ||
        inbound.category === "licensed-matter" ||
        inbound.flags.includes("untrusted-instruction") ||
        inbound.flags.includes("property-ambiguous") ||
        inbound.flags.includes("thread-property-conflict") ||
        work.recipient.doNotContact;
      if (blocked || !hasMessageEvidence || draft.to !== inbound.senderAddress || work.proposalHash !== expectedHash) {
        throw Object.assign(new Error("This reply is no longer supported by the admitted inbound evidence. Review the held case before allowing it."), {
          status: 409,
          code: "stale-proposal",
        });
      }
      return;
    }
    if (this.store.data.mode !== "live") return;
    const now = this.now();
    const preview = this.store.previewV3(now);
    const property = preview.properties.find((item) => item.id === draft.propertyId && item.status === "active");
    const tenancy = preview.tenancies.find((item) => item.propertyId === draft.propertyId && item.status === "current");
    const position = tenancy ? preview.moneyPositions.find((item) => item.tenancyId === tenancy.id) : undefined;
    const currentProperty = this.store.data.properties.find((item) => item.id === draft.propertyId);
    if (draft.kind === "owner-letter") {
      if (
        position?.status !== "current" ||
        position.staleAt <= now ||
        !work.evidenceId ||
        work.evidenceId !== position.evidenceId
      ) {
        throw Object.assign(new Error("This owner update is no longer supported by current PMS evidence. Run the owner-letter routine again."), {
          status: 409,
          code: "stale-proposal",
        });
      }
      return;
    }
    const expectedKind = draft.kind === "levy-from-rent" ? "levy-from-rent" : "courtesy-rent";
    const result = property && tenancy && position
      ? evaluateFromProjection({
          propertyId: property.id,
          address: property.address,
          weeklyRentCents: tenancy.weeklyRentCents,
          options: property.options,
          tenancyId: tenancy.id,
          money: position,
        })
      : null;
    const currentKind = result?.reason === "rent-landed-levy-unpaid" ? "levy-from-rent" : result?.reason === "rent-unpaid-courtesy" ? "courtesy-rent" : null;
    const periodDueAt = position?.observedAt == null
      ? null
      : dueDate(position.observedAt, position.facts.daysSinceDue ?? 0);
    const supported =
      position?.status === "current" &&
      position.staleAt > now &&
      Boolean(work.evidenceId) &&
      work.evidenceId === position.evidenceId &&
      result?.outcome === "draft" &&
      currentKind === expectedKind &&
      periodDueAt === draft.periodDueAt &&
      currentProperty?.tenantName === work.recipient.name &&
      currentProperty?.tenantPhone === work.recipient.phone;
    if (!supported) {
      throw Object.assign(new Error("This wording is no longer supported by the current PMS evidence. Recheck before allowing it."), {
        status: 409,
        code: "stale-proposal",
      });
    }
  }

  private edit(id: string, body: string): void {
    const draft = this.requirePending(id);
    const next = String(body ?? "").trim();
    if (!next) throw Object.assign(new Error("draft body required"), { status: 400 });
    if (next.length > 4_000) throw Object.assign(new Error("draft is too long"), { status: 400 });
    const guarded = draft.kind === "courtesy-rent" ? withCourtesyDisclaimer(next) : next;
    assertOperationalDraftContent(guarded, draft.kind);
    draft.body = guarded;
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
    assertOperationalDraftContent(draft.body, draft.kind);
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
    assertOperationalDraftContent(draft.body, draft.kind);
    const work = this.workForDraft(draft);
    if (work.state !== "approved") throw Object.assign(new Error("approve the wording before portal prepare"), { status: 409 });
    const cap = this.store.data.capabilities.find((c) => c.workItemId === work.id && !c.usedAt && !c.invalidatedAt);
    if (!cap) throw Object.assign(new Error("portal capability missing or invalidated"), { status: 409 });
    if (cap.expiresAt <= this.now()) throw Object.assign(new Error("portal capability expired"), { status: 409 });
    if (cap.revision !== this.store.data.revision) throw Object.assign(new Error("portal capability is stale"), { status: 409 });
    const recipe = this.store.data.recipes.find((r) => r.id === cap.recipeId && r.version === cap.recipeVersion);
    if (!recipe?.published) throw Object.assign(new Error("portal recipe is not published"), { status: 409 });
    if (!this.portalUrl) throw Object.assign(new Error("no portal URL configured"), { status: 409 });
    // Claim the one-use authorization durably before touching the external
    // portal. If the process stops after this commit, startup converts the
    // in-flight state to effect-unknown and will not replay the prefill.
    const executionCapability = structuredClone(cap);
    const startedAt = this.now();
    assertTransition(work.state, "preparing");
    work.state = "preparing";
    work.updatedAt = startedAt;
    cap.usedAt = startedAt;
    this.store.persist();
    this.emit();

    let result: Awaited<ReturnType<typeof runBoundedPrefill>>;
    try {
      result = await runBoundedPrefill({
        baseUrl: this.portalUrl,
        body: draft.body,
        capability: executionCapability,
        recipe,
        now: startedAt,
      });
    } catch {
      result = { ok: false, error: "portal preparation failed", effect: "none" };
    }
    const currentWork = this.store.data.workItems.find((item) => item.id === work.id);
    if (!currentWork || currentWork.state !== "preparing") {
      throw Object.assign(new Error("portal preparation lost its in-flight Desk state"), { status: 409, code: "handoff-state-conflict" });
    }
    let meta: ReturnType<typeof persistArtifact>;
    try {
      meta = persistArtifact({
        workItemId: currentWork.id,
        step: "prefill",
        body: Buffer.from(JSON.stringify({ draftId, proposalHash: currentWork.proposalHash, portal: result }), "utf8"),
        now: this.now(),
        dir: join(this.store.file, ".."),
      });
    } catch {
      assertTransition(currentWork.state, "effect-unknown");
      currentWork.state = "effect-unknown";
      currentWork.updatedAt = this.now();
      this.persistExternalHandoffOutcome(currentWork.id);
      throw Object.assign(new Error("portal preparation finished without a durable audit receipt"), { status: 503, code: "handoff-effect-unknown" });
    }
    currentWork.artifactIds = [...(currentWork.artifactIds ?? []), meta.id];
    if (!result.ok) {
      const nextState = result.effect === "unknown" ? "effect-unknown" : "failed";
      assertTransition(currentWork.state, nextState);
      currentWork.state = nextState;
      currentWork.updatedAt = this.now();
      this.persistExternalHandoffOutcome(currentWork.id);
      throw Object.assign(new Error(result.error), { status: 502 });
    }
    assertTransition(currentWork.state, "handoff-ready");
    currentWork.state = "handoff-ready";
    currentWork.updatedAt = this.now();
    this.persistExternalHandoffOutcome(currentWork.id);
    return this.snapshot();
  }

  private persistExternalHandoffOutcome(workItemId: string): void {
    try {
      this.store.persist();
      this.emit();
    } catch (cause) {
      // A generic pre-replace failure is normally safe to retry, but not once
      // an external adapter has run. Convert the restored in-flight record to
      // effect-unknown when storage permits; otherwise startup will do so.
      if (!this.store.recovery.active) {
        const restored = this.store.data.workItems.find((item) => item.id === workItemId);
        if (restored?.state === "preparing") {
          assertTransition(restored.state, "effect-unknown");
          restored.state = "effect-unknown";
          restored.updatedAt = this.now();
          try {
            this.store.persist();
          } catch {
            // The already-durable preparing state is still non-retryable and
            // will reconcile to effect-unknown on the next process start.
          }
        }
      }
      this.emit();
      throw Object.assign(
        new Error("RealBud could not durably confirm the portal outcome. Treat it as effect unknown and do not retry; restart RealBud and review Desk."),
        { status: 503, code: "handoff-effect-unknown", cause },
      );
    }
  }

  private reconcileInterruptedHandoffs(): void {
    if (this.store.recovery.active) return;
    const interrupted = this.store.data.workItems.filter((work) => work.state === "preparing");
    if (!interrupted.length) return;
    const recoveredAt = this.now();
    for (const work of interrupted) {
      assertTransition(work.state, "effect-unknown");
      work.state = "effect-unknown";
      work.updatedAt = recoveredAt;
      const capability = this.store.data.capabilities.find((item) => item.workItemId === work.id && !item.invalidatedAt);
      if (capability && !capability.usedAt) capability.usedAt = recoveredAt;
    }
    this.store.persist();
    this.emit();
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

  private observePortfolio(
    id: string,
    kind: "csv" | "hermes" | "demo",
    label: string,
    rows: LedgerFacts[],
    observedAt: number,
    allPropertyIds: string[],
    conflictedIds = new Set<string>(),
    stableKey = `${kind}:${id}`,
  ): void {
    this.rememberSource(id, kind, label, stableKey);
    for (const incident of this.store.data.workItems) {
      if (incident.kind === "source-incident" && incident.state === "held" && incident.sourceIncident?.sourceId === id) {
        incident.state = "stale";
        incident.updatedAt = observedAt;
      }
    }
    const byProperty = new Map(rows.map((row) => [row.propertyId, row]));
    for (const propertyId of allPropertyIds) {
      const facts = byProperty.get(propertyId);
      const coverage = conflictedIds.has(propertyId) ? "conflicted" : facts ? "observed" : "missing";
      this.store.data.observations.push({
        id: `obs-${randomUUID()}`,
        sourceId: id,
        observedAt,
        propertyId,
        staleAfterMs: kind === "csv" ? CSV_FRESH_MS : 30 * 60_000,
        coverage,
        facts: coverage === "observed" ? facts : undefined,
      });
    }
  }

  private rememberSource(
    id: string,
    kind: "csv" | "hermes" | "portal" | "demo",
    label: string,
    stableKey: string,
  ): void {
    const byId = this.store.data.sources.find((source) => source.id === id);
    if (byId && byId.stableKey !== stableKey) {
      throw Object.assign(new Error("source id is already bound to different evidence"), {
        status: 409,
        code: "source-identity-conflict",
      });
    }
    const byStableKey = this.store.data.sources.find((source) => source.stableKey === stableKey);
    if (byStableKey && byStableKey.id !== id) {
      throw Object.assign(new Error("source evidence marker is already bound"), {
        status: 409,
        code: "source-identity-conflict",
      });
    }
    if (!byId) this.store.data.sources.push({ id, kind, label, stableKey });
  }

  private requirePending(id: string): Draft {
    const draft = this.store.data.drafts.find((d) => d.id === id);
    if (!draft) throw Object.assign(new Error("no such draft"), { status: 404 });
    if (draft.status === "stale") {
      throw Object.assign(new Error("this proposal was superseded by newer evidence"), { status: 409, code: "stale-proposal" });
    }
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
