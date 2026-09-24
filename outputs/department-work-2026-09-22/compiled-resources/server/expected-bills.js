// Expected-bill register for Austin Phase 1. Desk surfaces these rows;
// workflow packs prepare updates. REI remains the financial record.
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
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
];
function billsPath(dataDir = DATA_DIR) {
    return join(dataDir, "expected-bills.json");
}
function isStatus(value) {
    return typeof value === "string" && BILL_STATUSES.includes(value);
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function nullableNumber(value) {
    return value === null || finiteNumber(value);
}
function isBill(value) {
    return record(value) &&
        [value.id, value.propertyId, value.kind].every(field => typeof field === "string" && field.trim().length > 0) &&
        isStatus(value.status) && typeof value.note === "string" &&
        (value.sourceRef === null || typeof value.sourceRef === "string") &&
        nullableNumber(value.windowStartAt) && nullableNumber(value.windowEndAt) && nullableNumber(value.amountCents) &&
        finiteNumber(value.createdAt) && finiteNumber(value.updatedAt);
}
function recoveryRequired() {
    // The API may display this message. Never include file contents, paths or raw IO errors.
    return Object.assign(new Error("Saved bill records could not be read safely. Bill changes are paused and existing data has been preserved. Contact support to check file access or restore a known-good backup, then retry."), { status: 503, code: "expected_bills_recovery_required" });
}
function loadFile(dataDir = DATA_DIR) {
    const path = billsPath(dataDir);
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            // A dangling link is a persisted entry needing repair, not a fresh register.
            try {
                lstatSync(path);
            }
            catch (statError) {
                if (statError.code === "ENOENT")
                    return { version: 1, bills: [] };
            }
        }
        throw recoveryRequired();
    }
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        throw recoveryRequired();
    }
    if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.bills) || !raw.bills.every(isBill) ||
        new Set(raw.bills.map(bill => bill.id)).size !== raw.bills.length)
        throw recoveryRequired();
    // Retain the existing v1 representation and extra metadata; never filter damaged rows away.
    return raw;
}
function saveFile(file, dataDir = DATA_DIR) {
    mkdirSync(dataDir, { recursive: true });
    writeFileAtomic(billsPath(dataDir), JSON.stringify(file, null, 2), 0o600);
}
export function listExpectedBills(dataDir = DATA_DIR) {
    return loadFile(dataDir).bills
        .slice()
        .sort((a, b) => (a.windowEndAt ?? a.updatedAt) - (b.windowEndAt ?? b.updatedAt));
}
export function upsertExpectedBill(input, dataDir = DATA_DIR) {
    const propertyId = String(input.propertyId ?? "").trim();
    const kind = String(input.kind ?? "").trim().slice(0, 80);
    if (!propertyId)
        throw Object.assign(new Error("Name the property."), { status: 400 });
    if (!kind)
        throw Object.assign(new Error("Name the bill kind."), { status: 400 });
    if (!isStatus(input.status))
        throw Object.assign(new Error("That bill status is not supported."), { status: 400 });
    const file = loadFile(dataDir);
    const now = Date.now();
    const id = input.id?.trim() || randomUUID();
    if (id.startsWith("source-bill:") || id.startsWith("bill-prediction:"))
        throw Object.assign(new Error("Source-linked bills require their reviewed source and current revision. Open the source bill review."), { status: 409 });
    const existing = file.bills.find((bill) => bill.id === id);
    const bill = {
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
    if (!isBill(bill))
        throw Object.assign(new Error("Check the bill dates, amount and source reference before saving."), { status: 400 });
    file.bills = [...file.bills.filter((row) => row.id !== id), bill];
    saveFile(file, dataDir);
    return bill;
}
export function groupExpectedBills(bills) {
    const groups = {
        "needs-you": [],
        "due-soon": [],
        "in-process": [],
        settled: [],
    };
    for (const bill of bills) {
        if (bill.status === "missing" || bill.status === "insufficient-funds" || bill.status === "company-advance" || bill.status === "owner-to-pay" || bill.status === "hold") {
            groups["needs-you"].push(bill);
        }
        else if (bill.status === "expected" || bill.status === "received") {
            groups["due-soon"].push(bill);
        }
        else if (bill.status === "in-process") {
            groups["in-process"].push(bill);
        }
        else {
            groups.settled.push(bill);
        }
    }
    return groups;
}
