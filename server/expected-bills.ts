// Expected-bill register for Austin Phase 1. Desk surfaces these rows;
// workflow packs prepare updates. REI remains the financial record.
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export const BILL_STATUSES = [
  "expected",
  "missing",
  "received",
  "in-process",
  "paid",
  "insufficient-funds",
  "company-advance",
  "owner-to-pay",
  "hold",
  "cancelled",
] as const;

export type BillStatus = (typeof BILL_STATUSES)[number];

export type ExpectedBill = {
  id: string;
  propertyId: string;
  /** Short office label, e.g. council / water / levy. */
  kind: string;
  status: BillStatus;
  /** Inclusive start of expected arrival window (ms). */
  windowStartAt: number | null;
  /** Inclusive end of expected arrival window (ms). */
  windowEndAt: number | null;
  amountCents: number | null;
  note: string;
  sourceRef: string | null;
  updatedAt: number;
  createdAt: number;
  /** Source-reviewed occurrence fields; arrival predictions are separate. */
  sourceKind?: "mail-reviewed";
  dueDate?: string | null;
  vendor?: string;
  revision?: number;
};

type BillsFile = { version: 1; bills: ExpectedBill[] };

function billsPath(dataDir = DATA_DIR): string {
  return join(dataDir, "expected-bills.json");
}

function isStatus(value: unknown): value is BillStatus {
  return typeof value === "string" && (BILL_STATUSES as readonly string[]).includes(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || finiteNumber(value);
}

function isBill(value: unknown): value is ExpectedBill {
  return record(value) &&
    [value.id, value.propertyId, value.kind].every(field => typeof field === "string" && field.trim().length > 0) &&
    isStatus(value.status) && typeof value.note === "string" &&
    (value.sourceRef === null || typeof value.sourceRef === "string") &&
    nullableNumber(value.windowStartAt) && nullableNumber(value.windowEndAt) && nullableNumber(value.amountCents) &&
    finiteNumber(value.createdAt) && finiteNumber(value.updatedAt);
}

function recoveryRequired(): Error & { status: number; code: string } {
  // The API may display this message. Never include file contents, paths or raw IO errors.
  return Object.assign(new Error(
    "Saved bill records could not be read safely. Bill changes are paused and existing data has been preserved. Contact support to check file access or restore a known-good backup, then retry.",
  ), { status: 503, code: "expected_bills_recovery_required" });
}

function loadFile(dataDir = DATA_DIR): BillsFile {
  const path = billsPath(dataDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A dangling link is a persisted entry needing repair, not a fresh register.
      try { lstatSync(path); } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, bills: [] };
      }
    }
    throw recoveryRequired();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw recoveryRequired();
  }
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.bills) || !raw.bills.every(isBill) ||
      new Set(raw.bills.map(bill => bill.id)).size !== raw.bills.length) throw recoveryRequired();
  // Retain the existing v1 representation and extra metadata; never filter damaged rows away.
  return raw as BillsFile;
}

function saveFile(file: BillsFile, dataDir = DATA_DIR): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(billsPath(dataDir), JSON.stringify(file, null, 2), 0o600);
}

export function listExpectedBills(dataDir = DATA_DIR): ExpectedBill[] {
  return loadFile(dataDir).bills
    .slice()
    .sort((a, b) => (a.windowEndAt ?? a.updatedAt) - (b.windowEndAt ?? b.updatedAt));
}

export function upsertExpectedBill(
  input: {
    id?: string;
    propertyId: string;
    kind: string;
    status: BillStatus;
    windowStartAt?: number | null;
    windowEndAt?: number | null;
    amountCents?: number | null;
    note?: string;
    sourceRef?: string | null;
  },
  dataDir = DATA_DIR,
): ExpectedBill {
  const propertyId = String(input.propertyId ?? "").trim();
  const kind = String(input.kind ?? "").trim().slice(0, 80);
  if (!propertyId) throw Object.assign(new Error("Name the property."), { status: 400 });
  if (!kind) throw Object.assign(new Error("Name the bill kind."), { status: 400 });
  if (!isStatus(input.status)) throw Object.assign(new Error("That bill status is not supported."), { status: 400 });

  const file = loadFile(dataDir);
  const now = Date.now();
  const id = input.id?.trim() || randomUUID();
  if (id.startsWith("source-bill:") || id.startsWith("bill-prediction:")) throw Object.assign(new Error("Source-linked bills require their reviewed source and current revision. Open the source bill review."), { status: 409 });
  const existing = file.bills.find((bill) => bill.id === id);
  const bill: ExpectedBill = {
    id,
    propertyId,
    kind,
    status: input.status,
    windowStartAt: input.windowStartAt === undefined ? (existing?.windowStartAt ?? null) : input.windowStartAt,
    windowEndAt: input.windowEndAt === undefined ? (existing?.windowEndAt ?? null) : input.windowEndAt,
    amountCents: input.amountCents === undefined ? (existing?.amountCents ?? null) : input.amountCents,
    note: (input.note ?? existing?.note ?? "").trim().slice(0, 500),
    sourceRef: input.sourceRef === undefined ? (existing?.sourceRef ?? null) : input.sourceRef,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  // Reject inputs that would create a file the strict reader cannot reopen.
  if (!isBill(bill)) throw Object.assign(new Error("Check the bill dates, amount and source reference before saving."), { status: 400 });
  file.bills = [...file.bills.filter((row) => row.id !== id), bill];
  saveFile(file, dataDir);
  return bill;
}

export function groupExpectedBills(
  bills: readonly ExpectedBill[],
): Record<"needs-you" | "due-soon" | "in-process" | "settled", ExpectedBill[]> {
  const groups: Record<"needs-you" | "due-soon" | "in-process" | "settled", ExpectedBill[]> = {
    "needs-you": [],
    "due-soon": [],
    "in-process": [],
    settled: [],
  };
  for (const bill of bills) {
    if (bill.status === "missing" || bill.status === "insufficient-funds" || bill.status === "company-advance" || bill.status === "owner-to-pay" || bill.status === "hold") {
      groups["needs-you"].push(bill);
    } else if (bill.status === "expected" || bill.status === "received") {
      groups["due-soon"].push(bill);
    } else if (bill.status === "in-process") {
      groups["in-process"].push(bill);
    } else {
      groups.settled.push(bill);
    }
  }
  return groups;
}
