/** Live Recheck on the Demo book missed the worker. Training copy starts with "Demo book". */
export function isDemoWorkerMiss(hands, handsDetail) {
    if (hands !== "demo" || !handsDetail)
        return false;
    return !/^Demo book/.test(handsDetail);
}
const INBOX_LABEL = "Inbox planned";
const INBOX_DETAIL = "This morning review does not include an overnight inbox check. Use Ask with a connected email source for email tasks.";
const LABEL = {
    unchecked: "Not checked",
    quiet: "Checked",
    "needs-you": "Needs you",
    held: "Waiting",
    licensee: "For licensee",
};
const TONE = {
    unchecked: "muted",
    quiet: "muted",
    "needs-you": "agency",
    held: "hold",
    licensee: "danger",
};
function isPendingDraft(draft, propertyId) {
    return draft.propertyId === propertyId && draft.status === "pending";
}
function isMoneyHold(work, propertyId) {
    return work.propertyId === propertyId && work.state === "held" && work.kind === "money-arrears";
}
function attentionFor(propertyId, snap) {
    if (snap.lastRunAt == null)
        return "unchecked";
    if (isDemoWorkerMiss(snap.hands, snap.handsDetail))
        return "unchecked";
    if (snap.escalations.some((row) => row.propertyId === propertyId))
        return "licensee";
    if (snap.drafts.some((row) => isPendingDraft(row, propertyId)))
        return "needs-you";
    const result = snap.results.find((row) => row.propertyId === propertyId);
    if (result?.outcome === "hold")
        return "held";
    if (snap.workItems.some((row) => isMoneyHold(row, propertyId)))
        return "held";
    if (result)
        return "quiet";
    if (snap.hands === "held")
        return "held";
    return "unchecked";
}
function headlineFor(brief, snap) {
    if (brief.lastRunAt != null && isDemoWorkerMiss(snap.hands, snap.handsDetail)) {
        return "Recheck missed. Bud did not return live facts.";
    }
    const n = brief.addresses.length;
    if (brief.lastRunAt == null) {
        if (n === 0)
            return "The book is empty. Add a property or drop an export.";
        if (n === 1)
            return "One address on the book. Recheck has not run.";
        return `${n} addresses on the book. Recheck has not run.`;
    }
    const bits = [];
    if (brief.needsYou)
        bits.push(brief.needsYou === 1 ? "1 needs you" : `${brief.needsYou} need you`);
    if (brief.held)
        bits.push(brief.held === 1 ? "1 held" : `${brief.held} held`);
    if (brief.licensee)
        bits.push(brief.licensee === 1 ? "1 for the licensee" : `${brief.licensee} for the licensee`);
    if (bits.length === 0)
        return `${brief.checkedCount} addresses checked. Nothing waiting.`;
    return `${brief.checkedCount} addresses checked. ${bits.join(", ")}.`;
}
export function morningBrief(snap) {
    const addresses = snap.properties.map((property) => {
        const attention = attentionFor(property.id, snap);
        return {
            propertyId: property.id,
            address: property.address,
            attention,
            label: LABEL[attention],
            tone: TONE[attention],
        };
    });
    const checkedCount = addresses.filter((row) => row.attention !== "unchecked").length;
    const draft = {
        lastRunAt: snap.lastRunAt,
        addresses,
        checkedCount,
        needsYou: addresses.filter((row) => row.attention === "needs-you").length,
        held: addresses.filter((row) => row.attention === "held").length,
        licensee: addresses.filter((row) => row.attention === "licensee").length,
        inboxConnected: false,
        inboxLabel: INBOX_LABEL,
        inboxDetail: INBOX_DETAIL,
    };
    return { ...draft, headline: headlineFor(draft, snap) };
}
export function shortStreet(address) {
    const street = address.split(",")[0]?.trim();
    return street || address;
}
const BRIEF_COLLAPSE_AFTER = 8;
function isExpandedAttention(attention) {
    return attention === "needs-you" || attention === "licensee";
}
function summarizeCollapsed(rows) {
    const n = rows.length;
    const fine = rows.filter((row) => row.attention === "quiet").length;
    const held = rows.filter((row) => row.attention === "held").length;
    const unchecked = rows.filter((row) => row.attention === "unchecked").length;
    if (fine === n)
        return `and ${n} more — checked, nothing waiting`;
    const bits = [];
    if (fine)
        bits.push(`${fine} fine`);
    if (held)
        bits.push(`${held} held`);
    if (unchecked)
        bits.push(`${unchecked} not checked`);
    return `and ${n} more: ${bits.join(" · ")}`;
}
/** Render-only: at 9+ addresses, keep needs-you and licensee rows and fold the rest. */
export function collapseBriefRows(rows) {
    if (rows.length <= BRIEF_COLLAPSE_AFTER) {
        return { expanded: [...rows], collapsedCount: 0, collapsedSummary: null };
    }
    const expanded = rows.filter((row) => isExpandedAttention(row.attention));
    const rest = rows.filter((row) => !isExpandedAttention(row.attention));
    return {
        expanded,
        collapsedCount: rest.length,
        collapsedSummary: rest.length ? summarizeCollapsed(rest) : null,
    };
}
