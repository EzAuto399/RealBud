import { createHash } from "node:crypto";
const MAX_BANK_CREDITS = 5_000;
const MAX_REFERENCE_LENGTH = 240;
const MAX_CREDIT_CENTS = 50_000_000;
export const BANK_CREDIT_RELEVANCE_MS = 16 * 24 * 60 * 60_000;
const WEEKLY_MATCH_WINDOW_MS = 8 * 24 * 60 * 60_000;
const FORTNIGHTLY_MATCH_WINDOW_MS = 15 * 24 * 60 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;
export const BANK_OBSERVATION_FRESH_MS = 30 * 60_000;
function invalid(message) {
    return Object.assign(new Error(message), { status: 400, code: "invalid-bank-observation" });
}
function isDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function bankTransactionDigest(accountFingerprint, credit) {
    return createHash("sha256").update(JSON.stringify({
        accountFingerprint,
        bookedAt: credit.bookedAt,
        amountCents: credit.amountCents,
        reference: credit.reference,
    })).digest("hex");
}
function hasOnlyKeys(value, allowed) {
    const set = new Set(allowed);
    return Object.keys(value).every((key) => set.has(key));
}
function referenceKey(value) {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("en-AU")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}
function referenceContainsCode(reference, propertyCode) {
    const haystack = referenceKey(reference);
    const needle = referenceKey(propertyCode);
    if (needle.length < 4)
        return false;
    return ` ${haystack} `.includes(` ${needle} `);
}
export function validateBankObservationBatch(batch) {
    if (!batch || typeof batch !== "object" || Array.isArray(batch)
        || !hasOnlyKeys(batch, ["kind", "schemaVersion", "accountFingerprint", "observedAt", "credits"])) {
        throw invalid("bank observation fields are invalid");
    }
    if (batch?.kind !== "realbud.bank-credit-observation.v1" || batch.schemaVersion !== 1) {
        throw invalid("bank observation version is invalid");
    }
    if (!isDigest(batch.accountFingerprint))
        throw invalid("bank account fingerprint is invalid");
    if (!Number.isFinite(batch.observedAt) || batch.observedAt < 0)
        throw invalid("bank observation time is invalid");
    if (!Array.isArray(batch.credits) || batch.credits.length > MAX_BANK_CREDITS) {
        throw invalid("bank credit batch exceeds its bound");
    }
    const ids = new Set();
    for (const credit of batch.credits) {
        if (!credit || typeof credit !== "object" || Array.isArray(credit)
            || !hasOnlyKeys(credit, ["transactionDigest", "bookedAt", "amountCents", "reference"])) {
            throw invalid("bank credit fields are invalid");
        }
        if (!isDigest(credit?.transactionDigest) || ids.has(credit.transactionDigest)) {
            throw invalid("bank transaction digests must be unique SHA-256 values");
        }
        ids.add(credit.transactionDigest);
        if (!Number.isFinite(credit.bookedAt)
            || credit.bookedAt > batch.observedAt + CLOCK_SKEW_MS
            || credit.bookedAt < batch.observedAt - BANK_CREDIT_RELEVANCE_MS) {
            throw invalid("bank transaction time is outside the bounded observation window");
        }
        if (!Number.isInteger(credit.amountCents) || credit.amountCents < 1 || credit.amountCents > MAX_CREDIT_CENTS) {
            throw invalid("bank credit amount is invalid");
        }
        if (typeof credit.reference !== "string" || !credit.reference.trim() || credit.reference.length > MAX_REFERENCE_LENGTH) {
            throw invalid("bank credit reference is invalid");
        }
        if (credit.transactionDigest !== bankTransactionDigest(batch.accountFingerprint, credit)) {
            throw invalid("bank transaction digest does not match its bounded fields");
        }
    }
}
/** Exact property-code comparison only. Tenant names, Notes, account numbers
 * and fuzzy model guesses never participate in a money match. */
export function matchBankCredits(properties, batch) {
    validateBankObservationBatch(batch);
    const provisional = [];
    const held = [];
    for (const credit of batch.credits) {
        const candidates = properties.filter((property) => property.propertyCode && referenceContainsCode(credit.reference, property.propertyCode));
        if (candidates.length === 0) {
            held.push({ credit, reason: "unmatched", candidatePropertyIds: [] });
            continue;
        }
        if (candidates.length > 1) {
            held.push({ credit, reason: "ambiguous", candidatePropertyIds: candidates.map((property) => property.id) });
            continue;
        }
        const property = candidates[0];
        const interval = credit.amountCents === property.weeklyRentCents
            ? "weekly"
            : credit.amountCents === property.weeklyRentCents * 2
                ? "fortnightly"
                : null;
        if (!interval) {
            held.push({ credit, reason: "amount-mismatch", candidatePropertyIds: [property.id] });
            continue;
        }
        const age = batch.observedAt - credit.bookedAt;
        const maximumAge = interval === "weekly" ? WEEKLY_MATCH_WINDOW_MS : FORTNIGHTLY_MATCH_WINDOW_MS;
        if (age > maximumAge) {
            held.push({ credit, reason: "outside-payment-window", candidatePropertyIds: [property.id] });
            continue;
        }
        provisional.push({ credit, propertyId: property.id, interval });
    }
    const counts = new Map();
    for (const match of provisional)
        counts.set(match.propertyId, (counts.get(match.propertyId) ?? 0) + 1);
    const matched = [];
    for (const match of provisional) {
        if ((counts.get(match.propertyId) ?? 0) > 1) {
            held.push({ credit: match.credit, reason: "multiple-credits", candidatePropertyIds: [match.propertyId] });
        }
        else {
            matched.push(match);
        }
    }
    return { matched, held };
}
