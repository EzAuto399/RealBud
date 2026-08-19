// Fixture PM desk: per-property options + morning arrears check + draft cards.
// v0 sits on fake ledger facts. It never sends, never pays trust, never
// drafts a statutory notice. Allow means "the PM approved this wording."
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { tryHermesLedger, type HandsSource } from "./hermes-hands.ts";

export const NEVER_ACTIONS = ["statutory-send", "trust-pay"] as const;
export const COURTESY_DISCLAIMER =
  "This is not a formal notice and does not start any notice period.";

export type RentSource = "mepay" | "bank" | "pms-export" | "fixture";
export type NotifyChannel = "sms" | "email" | "portal" | "desk";
export type DraftKind = "courtesy-rent" | "levy-from-rent";
export type DraftStatus = "pending" | "allowed" | "denied";
export type CheckOutcome = "draft" | "escalate" | "clear" | "skip";
export type CheckReason =
  | "rent-unpaid-courtesy"
  | "rent-landed-levy-unpaid"
  | "rent-landed"
  | "inside-grace"
  | "already-reminded"
  | "statutory-clock";

export interface LevyFromRent {
  amountCents: number;
  cadence: "quarterly" | "monthly";
}

export interface PropertyOptions {
  rentSource: RentSource;
  graceDays: number;
  /** Days late at which we stop drafting courtesy and escalate. */
  courtesyUntilDay: number;
  levyFromRent: LevyFromRent | null;
  notifyChannel: NotifyChannel;
  never: string[];
}

export interface Property {
  id: string;
  address: string;
  tenantName: string;
  tenantPhone: string;
  weeklyRentCents: number;
  options: PropertyOptions;
}

/** Ledger as relative facts so the demo stays true on any calendar day. */
export interface LedgerFacts {
  propertyId: string;
  daysSinceDue: number;
  rentLanded: boolean;
  levyPaid: boolean;
  /** null = no courtesy this period */
  daysSinceCourtesy: number | null;
}

export interface Draft {
  id: string;
  propertyId: string;
  kind: DraftKind;
  status: DraftStatus;
  channel: NotifyChannel;
  to: string;
  body: string;
  periodDueAt: number;
  createdAt: number;
  decidedAt?: number;
}

export interface Escalation {
  id: string;
  propertyId: string;
  reason: "statutory-clock";
  detail: string;
  periodDueAt: number;
  createdAt: number;
}

export interface CheckResult {
  propertyId: string;
  outcome: CheckOutcome;
  reason: CheckReason;
  daysLate: number;
}

export interface DeskSnapshot {
  properties: Property[];
  /** What the hands (Hermes or the fixture book) reported per property. */
  ledger: LedgerFacts[];
  drafts: Draft[];
  escalations: Escalation[];
  lastRunAt: number | null;
  results: CheckResult[];
  hands: HandsSource;
  /** Why hands are Hermes — or why the last check fell back to fixtures. */
  handsDetail: string | null;
}

interface DeskFile {
  version: 1;
  properties: Property[];
  ledger: LedgerFacts[];
  drafts: Draft[];
  escalations: Escalation[];
  lastRunAt: number | null;
  results: CheckResult[];
  hands: HandsSource;
  handsDetail: string | null;
}

const DAY = 86_400_000;
const NEVER = [...NEVER_ACTIONS];

function shopDefaults(): PropertyOptions {
  return {
    rentSource: "fixture",
    graceDays: 3,
    courtesyUntilDay: 7,
    levyFromRent: null,
    notifyChannel: "sms",
    never: [...NEVER],
  };
}

export interface NewPropertyInput {
  address: string;
  tenantName: string;
  tenantPhone: string;
  weeklyRentCents: number;
  options?: Partial<PropertyOptions>;
}

const RENT_SOURCES: RentSource[] = ["mepay", "bank", "pms-export", "fixture"];
const NOTIFY_CHANNELS: NotifyChannel[] = ["sms", "email", "portal", "desk"];

/** Validate and apply an options patch. `never` is never editable — the
 * hard gates (statutory send, trust pay) cannot be removed from a property. */
function applyOptions(options: PropertyOptions, patch: Partial<PropertyOptions>) {
  if (patch.graceDays != null) {
    const n = Number(patch.graceDays);
    if (!Number.isInteger(n) || n < 0 || n > 28) throw Object.assign(new Error("grace days must be 0–28"), { status: 400 });
    options.graceDays = n;
  }
  if (patch.courtesyUntilDay != null) {
    const n = Number(patch.courtesyUntilDay);
    if (!Number.isInteger(n) || n < 1 || n > 60) throw Object.assign(new Error("courtesy window must be 1–60 days"), { status: 400 });
    options.courtesyUntilDay = n;
  }
  if (options.courtesyUntilDay <= options.graceDays) {
    throw Object.assign(new Error("courtesy window must be after grace days"), { status: 400 });
  }
  if (patch.levyFromRent !== undefined) {
    if (patch.levyFromRent === null) options.levyFromRent = null;
    else {
      const amount = Number(patch.levyFromRent.amountCents);
      if (!Number.isInteger(amount) || amount <= 0) throw Object.assign(new Error("levy amount required"), { status: 400 });
      options.levyFromRent = {
        amountCents: amount,
        cadence: patch.levyFromRent.cadence === "monthly" ? "monthly" : "quarterly",
      };
    }
  }
  if (patch.rentSource !== undefined) {
    if (!RENT_SOURCES.includes(patch.rentSource)) throw Object.assign(new Error("unknown rent source"), { status: 400 });
    options.rentSource = patch.rentSource;
  }
  if (patch.notifyChannel !== undefined) {
    if (!NOTIFY_CHANNELS.includes(patch.notifyChannel)) throw Object.assign(new Error("unknown notify channel"), { status: 400 });
    options.notifyChannel = patch.notifyChannel;
  }
  options.never = [...NEVER];
}

export function fixtureBook(): { properties: Property[]; ledger: LedgerFacts[] } {
  const properties: Property[] = [
    {
      id: "prop-oak",
      address: "12 Oak St, Dickson ACT",
      tenantName: "Sam Nguyen",
      tenantPhone: "0400 111 222",
      weeklyRentCents: 62_000,
      options: shopDefaults(),
    },
    {
      id: "prop-harbour",
      address: "4/22 Harbour Rd, Kingston ACT",
      tenantName: "Priya Shah",
      tenantPhone: "0400 333 444",
      weeklyRentCents: 75_000,
      options: {
        ...shopDefaults(),
        levyFromRent: { amountCents: 42_000, cadence: "quarterly" },
        notifyChannel: "desk",
      },
    },
    {
      id: "prop-pine",
      address: "8 Pine Ave, Braddon ACT",
      tenantName: "Jordan Blake",
      tenantPhone: "0400 555 666",
      weeklyRentCents: 58_000,
      options: shopDefaults(),
    },
    {
      id: "prop-king",
      address: "91 King St, Narrabundah ACT",
      tenantName: "Alex Romero",
      tenantPhone: "0400 777 888",
      weeklyRentCents: 54_000,
      options: shopDefaults(),
    },
    {
      id: "prop-birch",
      address: "3 Birch Cl, Watson ACT",
      tenantName: "Casey Holt",
      tenantPhone: "0400 999 000",
      weeklyRentCents: 50_000,
      options: shopDefaults(),
    },
    {
      id: "prop-flora",
      address: "2/5 Flora St, Ainslie ACT",
      tenantName: "Riley Chen",
      tenantPhone: "0412 000 111",
      weeklyRentCents: 56_000,
      options: shopDefaults(),
    },
  ];
  const ledger: LedgerFacts[] = [
    { propertyId: "prop-oak", daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
    { propertyId: "prop-harbour", daysSinceDue: 2, rentLanded: true, levyPaid: false, daysSinceCourtesy: null },
    { propertyId: "prop-pine", daysSinceDue: 5, rentLanded: false, levyPaid: false, daysSinceCourtesy: 4 },
    { propertyId: "prop-king", daysSinceDue: 10, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
    { propertyId: "prop-birch", daysSinceDue: 3, rentLanded: true, levyPaid: true, daysSinceCourtesy: null },
    { propertyId: "prop-flora", daysSinceDue: 1, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
  ];
  return { properties, ledger };
}

export function aud(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}

export function evaluateProperty(property: Property, facts: LedgerFacts): CheckResult {
  const daysLate = facts.daysSinceDue;
  if (facts.rentLanded) {
    if (property.options.levyFromRent && !facts.levyPaid) {
      return { propertyId: property.id, outcome: "draft", reason: "rent-landed-levy-unpaid", daysLate };
    }
    return { propertyId: property.id, outcome: "clear", reason: "rent-landed", daysLate };
  }
  if (daysLate < property.options.graceDays) {
    return { propertyId: property.id, outcome: "skip", reason: "inside-grace", daysLate };
  }
  if (daysLate >= property.options.courtesyUntilDay) {
    return { propertyId: property.id, outcome: "escalate", reason: "statutory-clock", daysLate };
  }
  if (facts.daysSinceCourtesy != null) {
    return { propertyId: property.id, outcome: "skip", reason: "already-reminded", daysLate };
  }
  return { propertyId: property.id, outcome: "draft", reason: "rent-unpaid-courtesy", daysLate };
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function withCourtesyDisclaimer(body: string): string {
  const trimmed = String(body ?? "").trim();
  if (/not a formal notice/i.test(trimmed) && /does not start/i.test(trimmed)) return trimmed;
  const withoutLoose = trimmed.replace(/\n*This is not a formal notice\.?\s*$/i, "").trim();
  return `${withoutLoose}\n\n${COURTESY_DISCLAIMER}`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dueDate(now: number, daysSinceDue: number): number {
  return startOfDay(now) - daysSinceDue * DAY;
}

function ausDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

export function composeDraft(property: Property, facts: LedgerFacts, now: number, kind: DraftKind): Draft {
  const periodDueAt = dueDate(now, facts.daysSinceDue);
  if (kind === "levy-from-rent") {
    const levy = property.options.levyFromRent!;
    return {
      id: `draft-${randomUUID()}`,
      propertyId: property.id,
      kind,
      status: "pending",
      channel: "desk",
      to: "PM desk",
      periodDueAt,
      createdAt: now,
      body:
        `Rent landed for ${property.address}. The ${aud(levy.amountCents)} ${levy.cadence} levy taken from rent is not marked paid on the owner ledger.\n` +
        `Desk flag only. Check the bill and trust authority in the PMS. RealBud will not move trust money.`,
    };
  }
  return {
    id: `draft-${randomUUID()}`,
    propertyId: property.id,
    kind,
    status: "pending",
    channel: property.options.notifyChannel === "desk" ? "sms" : property.options.notifyChannel,
    to: `${property.tenantName} · ${property.tenantPhone}`,
    periodDueAt,
    createdAt: now,
    body: withCourtesyDisclaimer(
      `Hi ${firstName(property.tenantName)}, just a courtesy from the office — we haven't seen this week's rent for ${property.address} yet (due ${ausDate(periodDueAt)}, ${aud(property.weeklyRentCents)}/wk). ` +
        `If you've already paid, ignore this. If something's up, reply and we'll sort it.`,
    ),
  };
}

function emptyFile(): DeskFile {
  const book = fixtureBook();
  return {
    version: 1,
    properties: book.properties,
    ledger: book.ledger,
    drafts: [],
    escalations: [],
    lastRunAt: null,
    results: [],
    hands: "fixture",
    handsDetail: null,
  };
}

function isProperty(value: unknown): value is Property {
  if (!value || typeof value !== "object") return false;
  const p = value as Property;
  return typeof p.id === "string" && typeof p.address === "string" && p.options != null;
}

export class Desk {
  private file: string;
  private now: () => number;
  private data: DeskFile;

  constructor(opts?: { file?: string; now?: () => number }) {
    this.file = opts?.file ?? join(DATA_DIR, "desk.json");
    this.now = opts?.now ?? Date.now;
    this.data = this.load();
  }

  snapshot(): DeskSnapshot {
    if (this.data.lastRunAt == null) return this.runMorningCheck();
    const { properties, ledger, drafts, escalations, lastRunAt, results, hands, handsDetail } = this.data;
    return {
      properties,
      ledger,
      drafts,
      escalations,
      lastRunAt,
      results,
      hands: hands ?? "fixture",
      handsDetail: handsDetail ?? null,
    };
  }

  /** Training book only — used by tests and first paint. */
  runMorningCheck(): DeskSnapshot {
    return this.evaluateBook("fixture", "Training book — Recheck asks Hermes for the morning ledger.");
  }

  /** Recheck: try pinned Hermes, fall back to the training book. */
  async runMorningCheckLive(): Promise<DeskSnapshot> {
    const attempt = await tryHermesLedger(this.data.ledger);
    if (attempt.rows) {
      for (const row of attempt.rows) {
        const idx = this.data.ledger.findIndex((item) => item.propertyId === row.propertyId);
        if (idx >= 0) this.data.ledger[idx] = row;
      }
    }
    return this.evaluateBook(attempt.rows ? "hermes" : "fixture", attempt.detail);
  }

  private evaluateBook(hands: HandsSource, handsDetail: string | null): DeskSnapshot {
    const now = this.now();
    const results: CheckResult[] = [];
    for (const property of this.data.properties) {
      const facts = this.facts(property.id);
      const result = evaluateProperty(property, facts);
      results.push(result);
      const periodDueAt = dueDate(now, facts.daysSinceDue);
      if (result.outcome === "draft") {
        const kind: DraftKind = result.reason === "rent-landed-levy-unpaid" ? "levy-from-rent" : "courtesy-rent";
        const exists = this.data.drafts.some((d) => d.propertyId === property.id && d.kind === kind);
        if (!exists) this.data.drafts.push(composeDraft(property, facts, now, kind));
      } else if (result.outcome === "escalate") {
        const exists = this.data.escalations.some(
          (e) => e.propertyId === property.id && e.reason === result.reason,
        );
        if (!exists) {
          this.data.escalations.push({
            id: `esc-${randomUUID()}`,
            propertyId: property.id,
            reason: "statutory-clock",
            periodDueAt,
            createdAt: now,
            detail:
              `${property.address} is ${result.daysLate} days late on this sample book (courtesy window ends day ${property.options.courtesyUntilDay}). ` +
              `That is a shop reminder rule, not a legal clock. A licensed person decides whether any state notice is due — in the PMS. RealBud will not draft or send one.`,
          });
        }
      }
    }
    this.data.results = results;
    this.data.lastRunAt = now;
    this.data.hands = hands;
    this.data.handsDetail = handsDetail;
    this.save();
    return this.snapshot();
  }

  resetFixtures(): DeskSnapshot {
    this.data = emptyFile();
    this.save();
    return this.snapshot();
  }

  patchProperty(id: string, patch: Partial<PropertyOptions>): Property {
    const property = this.data.properties.find((p) => p.id === id);
    if (!property) {
      const err = Object.assign(new Error("no such property"), { status: 404 });
      throw err;
    }
    applyOptions(property.options, patch);
    this.save();
    return property;
  }

  /** Add a property to the book. Quiet ledger facts by default: day 0, no
   * rent seen yet — inside grace, so the next check stays silent until
   * Hermes (or a bank export) reports real numbers. */
  addProperty(input: NewPropertyInput): DeskSnapshot {
    const address = String(input.address ?? "").trim();
    const tenantName = String(input.tenantName ?? "").trim();
    const tenantPhone = String(input.tenantPhone ?? "").trim();
    const rent = Number(input.weeklyRentCents);
    if (!address) throw Object.assign(new Error("address required"), { status: 400 });
    if (address.length > 160) throw Object.assign(new Error("address is too long"), { status: 400 });
    if (!tenantName) throw Object.assign(new Error("tenant name required"), { status: 400 });
    if (!Number.isInteger(rent) || rent <= 0) throw Object.assign(new Error("weekly rent required"), { status: 400 });
    if (this.data.properties.length >= 200) throw Object.assign(new Error("the book is full (200 properties)"), { status: 400 });

    const options = shopDefaults();
    if (input.options) applyOptions(options, input.options);
    const id = `prop-${randomUUID().slice(0, 8)}`;
    this.data.properties.push({
      id,
      address,
      tenantName,
      tenantPhone,
      weeklyRentCents: rent,
      options,
    });
    this.data.ledger.push({
      propertyId: id,
      daysSinceDue: 0,
      rentLanded: false,
      levyPaid: false,
      daysSinceCourtesy: null,
    });
    return this.evaluateBook(this.data.hands ?? "fixture", this.data.handsDetail ?? null);
  }

  /** Remove a property and everything that belongs to it (facts, drafts,
   * escalations, results). Pending drafts go with it — nothing was sent. */
  removeProperty(id: string): DeskSnapshot {
    if (!this.data.properties.some((p) => p.id === id)) {
      throw Object.assign(new Error("no such property"), { status: 404 });
    }
    this.data.properties = this.data.properties.filter((p) => p.id !== id);
    this.data.ledger = this.data.ledger.filter((r) => r.propertyId !== id);
    this.data.drafts = this.data.drafts.filter((d) => d.propertyId !== id);
    this.data.escalations = this.data.escalations.filter((e) => e.propertyId !== id);
    this.data.results = this.data.results.filter((r) => r.propertyId !== id);
    return this.evaluateBook(this.data.hands ?? "fixture", this.data.handsDetail ?? null);
  }

  allowDraft(id: string): Draft {
    const draft = this.requirePending(id);
    draft.status = "allowed";
    draft.decidedAt = this.now();
    if (draft.kind === "courtesy-rent") {
      const facts = this.facts(draft.propertyId);
      facts.daysSinceCourtesy = 0;
    }
    this.save();
    return draft;
  }

  denyDraft(id: string): Draft {
    const draft = this.requirePending(id);
    draft.status = "denied";
    draft.decidedAt = this.now();
    this.save();
    return draft;
  }

  editDraft(id: string, body: string): Draft {
    const draft = this.requirePending(id);
    const next = String(body ?? "").trim();
    if (!next) throw Object.assign(new Error("draft body required"), { status: 400 });
    if (next.length > 4_000) throw Object.assign(new Error("draft is too long"), { status: 400 });
    draft.body = draft.kind === "courtesy-rent" ? withCourtesyDisclaimer(next) : next;
    this.save();
    return draft;
  }

  private requirePending(id: string): Draft {
    const draft = this.data.drafts.find((d) => d.id === id);
    if (!draft) throw Object.assign(new Error("no such draft"), { status: 404 });
    if (draft.status !== "pending") throw Object.assign(new Error("draft is already decided"), { status: 409 });
    return draft;
  }

  private facts(propertyId: string): LedgerFacts {
    const facts = this.data.ledger.find((row) => row.propertyId === propertyId);
    if (!facts) throw new Error(`missing ledger for ${propertyId}`);
    return facts;
  }

  private load(): DeskFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as DeskFile;
      if (parsed?.version === 1 && Array.isArray(parsed.properties) && parsed.properties.every(isProperty)) {
        return {
          version: 1,
          properties: parsed.properties,
          ledger: Array.isArray(parsed.ledger) ? parsed.ledger : emptyFile().ledger,
          drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
          escalations: Array.isArray(parsed.escalations) ? parsed.escalations : [],
          lastRunAt: typeof parsed.lastRunAt === "number" ? parsed.lastRunAt : null,
          results: Array.isArray(parsed.results) ? parsed.results : [],
          hands: parsed.hands === "hermes" ? "hermes" : "fixture",
          handsDetail: typeof parsed.handsDetail === "string" ? parsed.handsDetail : null,
        };
      }
    } catch {
      /* first run or junk */
    }
    const fresh = emptyFile();
    this.write(fresh);
    return fresh;
  }

  private save(): void {
    this.write(this.data);
  }

  private write(data: DeskFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(data, null, 2));
  }
}
