// Pure shop-rule evaluators and deterministic courtesy copy.
import { randomUUID } from "node:crypto";
import { COURTESY_DISCLAIMER, NEVER_ACTIONS, aud } from "../shared/contracts.js";
export { COURTESY_DISCLAIMER, NEVER_ACTIONS, aud };
const DAY = 86_400_000;
const NEVER = [...NEVER_ACTIONS];
const RENT_SOURCES = ["mepay", "bank", "pms-export", "fixture", "csv"];
const NOTIFY_CHANNELS = ["sms", "email", "portal", "desk"];
export function shopDefaults() {
    return {
        rentSource: "fixture",
        graceDays: 3,
        courtesyUntilDay: 7,
        levyFromRent: null,
        notifyChannel: "sms",
        never: [...NEVER],
    };
}
export function applyOptions(options, patch) {
    if (patch.graceDays != null) {
        const n = Number(patch.graceDays);
        if (!Number.isInteger(n) || n < 0 || n > 28)
            throw Object.assign(new Error("grace days must be 0–28"), { status: 400 });
        options.graceDays = n;
    }
    if (patch.courtesyUntilDay != null) {
        const n = Number(patch.courtesyUntilDay);
        if (!Number.isInteger(n) || n < 1 || n > 60)
            throw Object.assign(new Error("courtesy window must be 1–60 days"), { status: 400 });
        options.courtesyUntilDay = n;
    }
    if (options.courtesyUntilDay <= options.graceDays) {
        throw Object.assign(new Error("courtesy window must be after grace days"), { status: 400 });
    }
    if (patch.levyFromRent !== undefined) {
        if (patch.levyFromRent === null)
            options.levyFromRent = null;
        else {
            const amount = Number(patch.levyFromRent.amountCents);
            if (!Number.isInteger(amount) || amount <= 0)
                throw Object.assign(new Error("levy amount required"), { status: 400 });
            options.levyFromRent = {
                amountCents: amount,
                cadence: patch.levyFromRent.cadence === "monthly" ? "monthly" : "quarterly",
            };
        }
    }
    if (patch.rentSource !== undefined) {
        if (!RENT_SOURCES.includes(patch.rentSource))
            throw Object.assign(new Error("unknown rent source"), { status: 400 });
        options.rentSource = patch.rentSource;
    }
    if (patch.notifyChannel !== undefined) {
        if (!NOTIFY_CHANNELS.includes(patch.notifyChannel))
            throw Object.assign(new Error("unknown notify channel"), { status: 400 });
        options.notifyChannel = patch.notifyChannel;
    }
    options.never = [...NEVER];
}
export function fixtureBook() {
    const properties = [
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
    const ledger = [
        { propertyId: "prop-oak", daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
        { propertyId: "prop-harbour", daysSinceDue: 2, rentLanded: true, levyPaid: false, daysSinceCourtesy: null },
        { propertyId: "prop-pine", daysSinceDue: 5, rentLanded: false, levyPaid: false, daysSinceCourtesy: 4 },
        { propertyId: "prop-king", daysSinceDue: 10, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
        { propertyId: "prop-birch", daysSinceDue: 3, rentLanded: true, levyPaid: true, daysSinceCourtesy: null },
        { propertyId: "prop-flora", daysSinceDue: 1, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
    ];
    return { properties, ledger };
}
export function evaluateProperty(property, facts) {
    const daysLate = facts.daysSinceDue;
    if (facts.reversed) {
        return { propertyId: property.id, outcome: "hold", reason: "reversed", daysLate };
    }
    if (facts.amountPaidCents != null &&
        property.weeklyRentCents > 0 &&
        facts.rentLanded &&
        facts.amountPaidCents < property.weeklyRentCents &&
        !property.options.levyFromRent) {
        return { propertyId: property.id, outcome: "hold", reason: "partial", daysLate };
    }
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
function firstName(name) {
    return name.trim().split(/\s+/)[0] ?? name;
}
export function withCourtesyDisclaimer(body) {
    const trimmed = String(body ?? "").trim();
    if (/not a formal notice/i.test(trimmed) && /does not start/i.test(trimmed))
        return trimmed;
    const withoutLoose = trimmed.replace(/\n*This is not a formal notice\.?\s*$/i, "").trim();
    return `${withoutLoose}\n\n${COURTESY_DISCLAIMER}`;
}
function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
export function dueDate(now, daysSinceDue) {
    return startOfDay(now) - daysSinceDue * DAY;
}
function ausDate(ms) {
    return new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}
export function composeDraft(property, facts, now, kind) {
    const periodDueAt = dueDate(now, facts.daysSinceDue);
    if (kind === "levy-from-rent") {
        const levy = property.options.levyFromRent;
        return {
            id: `draft-${randomUUID()}`,
            propertyId: property.id,
            kind,
            status: "pending",
            channel: "desk",
            to: "PM desk",
            periodDueAt,
            createdAt: now,
            body: `Rent landed for ${property.address}. The ${aud(levy.amountCents)} ${levy.cadence} levy taken from rent is not marked paid on the owner ledger.\n` +
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
        body: withCourtesyDisclaimer(`Hi ${firstName(property.tenantName)}, just a courtesy from the office — we haven't seen this week's rent for ${property.address} yet (due ${ausDate(periodDueAt)}, ${aud(property.weeklyRentCents)}/wk). ` +
            `If you've already paid, ignore this. If something's up, reply and we'll sort it.`),
    };
}
