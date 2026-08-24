// Desk spine: evaluate → proposal → human decision. Encrypted v2 store.
// snapshot() is side-effect free. Approval never means sent.
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  DeskBookView,
  DeskSnapshot,
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
import { tryHermesLedger, type HermesLedgerAttempt } from "./hermes-hands.ts";
import { ambiguousMatchException, classifyMoneyRow, unmatchedException } from "./morning-money.ts";
import { composeOwnerLetter, ownerLetterWeekStart } from "./owner-letter.ts";
import { assertRoutineCannotMint, freezeAuthorization, withPresentation, type BrowserPresentation } from "./handoff-auth.ts";
import type { RoutineOrigin } from "../shared/contracts.ts";
import { FAKE_PORTAL_RECIPE } from "./portal-recipe.ts";
import { CSV_FRESH_MS, isFresh } from "./source-gate.ts";
import {
  appendAllowedLine,
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
  tenantName: string;
  tenantPhone: string;
  weeklyRentCents: number;
  options?: Partial<PropertyOptions>;
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
    return this.evaluateBook("demo", "Demo book — Recheck asks Hermes or a CSV for live facts.");
  }

  /** Live recheck. A miss never fabricates rows. Demo mode may still evaluate
   * the labelled Demo book, and that is not a successful live check. */
  async runMorningCheckLive(): Promise<DeskSnapshot> {
    this.assertWritable();
    const ids = this.store.data.properties.map((p) => p.id);
    const attempt = await this.hermes(ids);
    if (attempt.rows) {
      for (const row of attempt.rows) {
        const idx = this.store.data.ledger.findIndex((item) => item.propertyId === row.propertyId);
        if (idx >= 0) this.store.data.ledger[idx] = row;
        else this.store.data.ledger.push(row);
      }
      this.observe("src-hermes", "hermes", "Hermes ledger", attempt.rows);
      return this.evaluateBook("hermes", attempt.detail);
    }
    if (this.store.data.mode === "demo") {
      return this.evaluateBook("demo", attempt.detail);
    }
    this.holdBook(attempt.detail);
    return this.snapshot();
  }

  importCsv(csv: string, observedAt = this.now()): DeskSnapshot {
    this.assertWritable();
    const batch = parsePmsExport(csv, observedAt, "src-csv");
    if (!isFresh(batch.observedAt, CSV_FRESH_MS, this.now())) {
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

  addProperty(input: NewPropertyInput): DeskSnapshot {
    this.assertWritable();
    const address = String(input.address ?? "").trim();
    const tenantName = String(input.tenantName ?? "").trim();
    const tenantPhone = String(input.tenantPhone ?? "").trim();
    const rent = Number(input.weeklyRentCents);
    if (!address) throw Object.assign(new Error("address required"), { status: 400 });
    if (address.length > 160) throw Object.assign(new Error("address is too long"), { status: 400 });
    if (!tenantName) throw Object.assign(new Error("tenant name required"), { status: 400 });
    if (!Number.isInteger(rent) || rent <= 0) throw Object.assign(new Error("weekly rent required"), { status: 400 });
    if (this.store.data.properties.length >= 200) throw Object.assign(new Error("the book is full (200 properties)"), { status: 400 });

    const options = shopDefaults();
    if (input.options) applyOptions(options, input.options);
    const id = `prop-${randomUUID().slice(0, 8)}`;
    this.store.data.properties.push({ id, address, tenantName, tenantPhone, weeklyRentCents: rent, options });
    writePropertyNote(id, "", { address }, this.vaultRoot);
    this.store.data.ledger.push({
      propertyId: id,
      daysSinceDue: 0,
      rentLanded: false,
      levyPaid: false,
      daysSinceCourtesy: null,
    });
    return this.evaluateBook(this.store.data.hands, this.store.data.handsDetail);
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
    const now = this.now();
    const results = [];
    for (const property of this.store.data.properties) {
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
    this.store.data.lastRunAt = now;
    this.store.data.hands = hands;
    this.store.data.handsDetail = handsDetail;
    this.store.persist();
    this.emit();
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

  private decide(id: string, state: "approved" | "denied", approver = "pm"): void {
    const draft = this.requirePending(id);
    const work = this.workForDraft(draft);
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

  private observe(id: string, kind: "csv" | "hermes" | "demo", label: string, rows: LedgerFacts[]): void {
    if (!this.store.data.sources.some((s) => s.id === id)) {
      this.store.data.sources.push({ id, kind, label, stableKey: `${kind}:${id}` });
    }
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
