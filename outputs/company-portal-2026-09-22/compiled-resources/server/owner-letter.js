// Friday owner letter v0 — one factual catch-up per property, drafted from
// the Desk book (ledger facts) plus the PM's Notes on the card. Copy-only:
// the PM approves wording and sends it themselves. RealBud never emails.
import { randomUUID } from "node:crypto";
function ausDate(ms) {
    return new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}
function aud(cents) {
    return `$${(cents / 100).toFixed(2)}`;
}
/** Monday 00:00 local of the week containing `now` — one letter per property per week. */
export function ownerLetterWeekStart(now) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    return day.getTime() - ((day.getDay() + 6) % 7) * 86_400_000;
}
export function composeOwnerLetter(property, facts, note, now) {
    const periodDueAt = ownerLetterWeekStart(now);
    const due = now - facts.daysSinceDue * 86_400_000;
    const lines = [`Weekly update for ${property.address}.`];
    if (facts.reversed) {
        lines.push(`A rent payment this week was reversed on the ledger — the office will follow up.`);
    }
    else {
        lines.push(facts.rentLanded
            ? `Rent is on the ledger for the week due ${ausDate(due)}.`
            : `Rent for the week due ${ausDate(due)} (${facts.daysSinceDue} days ago) is not on the ledger yet.`);
    }
    if (property.options.levyFromRent) {
        lines.push(facts.levyPaid
            ? `The ${aud(property.options.levyFromRent.amountCents)} levy taken from rent shows as paid for this period.`
            : `The ${aud(property.options.levyFromRent.amountCents)} levy taken from rent does not show as paid for this period yet — the office is checking the bill.`);
    }
    // Notes colour the draft; they are preferences, not shop rules, and the
    // wording stays editable before anything is copied out.
    const trimmed = note.trim();
    if (trimmed)
        lines.push(`Also worth knowing:\n${trimmed}`);
    lines.push(`Prepared from the RealBud Desk book. Your PM reviews and edits this before it goes anywhere.`);
    return {
        id: `draft-${randomUUID()}`,
        propertyId: property.id,
        kind: "owner-letter",
        status: "pending",
        channel: "desk",
        to: "Owner · via you",
        periodDueAt,
        createdAt: now,
        body: lines.join("\n\n"),
    };
}
