// Deterministic, source-safe inbound triage. This module never connects to a
// mailbox, follows message instructions, opens attachments, or performs an
// external action. A named read-only adapter may supply this contract later.
import { createHash } from "node:crypto";
import { normalizeAddress } from "./csv-ledger.js";
const MAX_MESSAGES = 100;
const MAX_BODY_CHARS = 20_000;
const MAX_ATTACHMENTS = 12;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_MS = 5 * 60 * 1_000;
const LICENSED_LANGUAGE = /\b(?:breach notice|notice to leave|notice to vacate|termination notice|evict(?:ion)?|tribunal|qcat|ncat|vcat|rent increase|bond claim|statutory notice)\b/i;
const UNTRUSTED_INSTRUCTION = /\b(?:password|passcode|one[- ]time code|verification code|run (?:this )?command|open terminal|disable security|send money|bank account login)\b/i;
const URGENT_MAINTENANCE = /\b(?:burst pipe|flood(?:ing|ed)?|active leak|gas leak|fire|sparking|exposed wire|electrical hazard|ceiling collapse|no power|locked out|sewage)\b/i;
const ROUTINE_MAINTENANCE = /\b(?:maintenance|repair|broken|leak|tap|toilet|hot water|air con|air-conditioning|appliance|mould|pest|damage)\b/i;
const TRADIE_UPDATE = /\b(?:plumber|electrician|contractor|technician|tradie|quote|invoice|attended|job complete|work completed)\b/i;
const BDM_LEAD = /\b(?:manage my property|property management|rental appraisal|management fee|switch(?:ing)? agent|new landlord|leasing my property)\b/i;
const PAYMENT_EVIDENCE = /\b(?:paid (?:the )?rent|rent payment|payment receipt|bank transfer|payment made|remittance|proof of payment)\b/i;
const OWNER_INSTRUCTION = /\b(?:owner instruction|as the owner|landlord instruction|please approve|i approve the quote|my investment property)\b/i;
function invalid(message) {
    throw Object.assign(new Error(message), { status: 400, code: "invalid-inbound-batch" });
}
function boundedString(value, label, max, allowEmpty = false) {
    if (typeof value !== "string")
        invalid(`${label} must be a string`);
    const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!allowEmpty && !cleaned)
        invalid(`${label} is required`);
    if (cleaned.length > max)
        invalid(`${label} is too long`);
    return cleaned;
}
function digest(kind, accountKey, value) {
    return createHash("sha256").update(`realbud-inbound-${kind}-v1\0${accountKey}\0${value}`).digest("hex");
}
function classifyCategory(text) {
    if (LICENSED_LANGUAGE.test(text))
        return "licensed-matter";
    if (URGENT_MAINTENANCE.test(text))
        return "urgent-maintenance-review";
    if (BDM_LEAD.test(text))
        return "bdm-lead";
    if (PAYMENT_EVIDENCE.test(text))
        return "payment-evidence";
    if (OWNER_INSTRUCTION.test(text))
        return "owner-instruction";
    if (TRADIE_UPDATE.test(text))
        return "tradie-update";
    if (ROUTINE_MAINTENANCE.test(text))
        return "routine-maintenance";
    return "unmatched";
}
function priorityFor(category) {
    if (category === "licensed-matter")
        return "licensed-review";
    if (category === "urgent-maintenance-review")
        return "urgent-review";
    if (category === "payment-evidence" || category === "owner-instruction" || category === "tradie-update")
        return "priority";
    return "routine";
}
function matchProperty(properties, text) {
    const normalized = ` ${normalizeAddress(text)} `;
    const hits = properties.filter((property) => {
        const address = normalizeAddress(property.address);
        const code = property.propertyCode?.trim().toLowerCase();
        return (address.length >= 8 && normalized.includes(` ${address} `)) || Boolean(code && code.length >= 4 && new RegExp(`(?:^|[^a-z0-9])${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "i").test(text));
    });
    if (hits.length === 1)
        return { propertyId: hits[0].id, ambiguous: false };
    return { ambiguous: hits.length > 1 };
}
function summaryFor(category, senderName, address) {
    const who = senderName || "The sender";
    const where = address ? ` for ${address}` : "";
    switch (category) {
        case "urgent-maintenance-review": return `${who} reported a potentially urgent maintenance issue${where}.`;
        case "routine-maintenance": return `${who} reported a maintenance issue${where}.`;
        case "tradie-update": return `${who} supplied a contractor or quote update${where}.`;
        case "owner-instruction": return `${who} supplied an owner instruction${where}.`;
        case "payment-evidence": return `${who} supplied payment information${where}; allocation is not confirmed.`;
        case "bdm-lead": return `${who} asked about property-management services.`;
        case "licensed-matter": return `${who} raised wording that requires licensed human review.`;
        default: return `${who} sent a message that could not be matched safely.`;
    }
}
function firstName(name) {
    return name.split(/\s+/)[0] || "there";
}
function replyFor(detail, agencyName, propertyAddress) {
    const greeting = `Hi ${firstName(detail.senderName)},`;
    const signoff = `Regards,\n${agencyName || "Property management team"}`;
    const where = propertyAddress ? ` for ${propertyAddress}` : "";
    switch (detail.category) {
        case "urgent-maintenance-review":
            return `${greeting}\n\nThanks for letting us know. We have recorded the reported maintenance issue${where} for urgent property-manager review. No contractor has been engaged by this acknowledgement. If there is immediate danger to people or property, contact the relevant emergency service directly.\n\n${signoff}`;
        case "routine-maintenance":
            return `${greeting}\n\nThanks for letting us know. We have recorded the maintenance issue${where} for property-manager review. Please reply with any useful photos and preferred access times if you have not already provided them. No contractor has been engaged by this acknowledgement.\n\n${signoff}`;
        case "tradie-update":
            return `${greeting}\n\nThanks for the update. We have recorded the contractor or quote information${where} for property-manager review. This acknowledgement does not accept a quote or authorise work.\n\n${signoff}`;
        case "owner-instruction":
            return `${greeting}\n\nThanks for the instruction. We have recorded it${where} for property-manager review. No external action has been taken by this acknowledgement.\n\n${signoff}`;
        case "payment-evidence":
            return `${greeting}\n\nThanks for sending the payment information${where}. We have recorded it for property-manager review, but the payment has not yet been matched or allocated in the PMS.\n\n${signoff}`;
        case "bdm-lead":
            return `${greeting}\n\nThanks for contacting us about property management. A team member can review what you need and arrange a conversation. This acknowledgement does not quote fees, provide an appraisal, or create an agreement.\n\n${signoff}`;
        default:
            return undefined;
    }
}
export function classifyInboundBatch(input, properties, agencyName, now = Date.now()) {
    const accountKey = boundedString(input?.accountKey, "accountKey", 120);
    if (!Array.isArray(input?.messages))
        invalid("messages must be an array");
    if (input.messages.length > MAX_MESSAGES)
        invalid(`messages must contain at most ${MAX_MESSAGES} items`);
    const seen = new Set();
    return input.messages.map((message, index) => {
        if (!message || typeof message !== "object" || Array.isArray(message))
            invalid(`messages[${index}] must be an object`);
        const providerMessageId = boundedString(message.providerMessageId, `messages[${index}].providerMessageId`, 240);
        const providerThreadId = boundedString(message.providerThreadId ?? providerMessageId, `messages[${index}].providerThreadId`, 240);
        const senderName = boundedString(message.from?.name ?? "", `messages[${index}].from.name`, 120, true);
        const senderAddress = boundedString(message.from?.address, `messages[${index}].from.address`, 254).toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(senderAddress))
            invalid(`messages[${index}].from.address is invalid`);
        const subject = boundedString(message.subject, `messages[${index}].subject`, 300, true);
        const body = boundedString(message.body, `messages[${index}].body`, MAX_BODY_CHARS, true);
        if (!Number.isInteger(message.receivedAt) || message.receivedAt < now - MAX_AGE_MS || message.receivedAt > now + MAX_FUTURE_MS) {
            invalid(`messages[${index}].receivedAt is outside the admitted window`);
        }
        const attachments = message.attachmentNames ?? [];
        if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS)
            invalid(`messages[${index}].attachmentNames is invalid`);
        attachments.forEach((name, attachmentIndex) => boundedString(name, `messages[${index}].attachmentNames[${attachmentIndex}]`, 160));
        const messageKey = digest("message", accountKey, providerMessageId);
        if (seen.has(messageKey))
            invalid(`messages[${index}] duplicates another message in this batch`);
        seen.add(messageKey);
        const threadKey = digest("thread", accountKey, providerThreadId);
        const text = `${subject}\n${body}`;
        const category = classifyCategory(text);
        const propertyMatch = matchProperty(properties, text);
        const property = propertyMatch.propertyId ? properties.find((item) => item.id === propertyMatch.propertyId) : undefined;
        const flags = [];
        if (category === "urgent-maintenance-review")
            flags.push("urgent-review");
        if (category === "licensed-matter")
            flags.push("licensed-review");
        if (UNTRUSTED_INSTRUCTION.test(text))
            flags.push("untrusted-instruction");
        if (attachments.length)
            flags.push("attachments-unopened");
        if (/\b(?:access|key|available|appointment)\b/i.test(text))
            flags.push("access-mentioned");
        if (/\bquote\b/i.test(text))
            flags.push("quote-mentioned");
        if (propertyMatch.ambiguous)
            flags.push("property-ambiguous");
        else if (!property)
            flags.push("property-unmatched");
        const detail = {
            category,
            priority: priorityFor(category),
            senderName,
            senderAddress,
            subject,
            summary: summaryFor(category, senderName, property?.address),
            receivedAt: message.receivedAt,
            messageKey,
            threadKey,
            attachmentCount: attachments.length,
            messageCount: 1,
            flags,
            waitingOn: category === "licensed-matter" ? "licensed-review" : "pm-send",
        };
        const blocked = category === "licensed-matter" || flags.includes("untrusted-instruction") || propertyMatch.ambiguous;
        const holdReason = category === "licensed-matter"
            ? "Licensed review required. Bud did not draft statutory wording."
            : flags.includes("untrusted-instruction")
                ? "Held because the untrusted message contains instructions or secret-like content Bud must not act on."
                : propertyMatch.ambiguous
                    ? "Held because the message matches more than one property."
                    : category === "unmatched"
                        ? "Held because Bud could not classify the message safely."
                        : undefined;
        return {
            detail,
            propertyId: property?.id,
            workKind: category === "urgent-maintenance-review" || category === "routine-maintenance" || category === "tradie-update"
                ? "maintenance-intake"
                : "inbound-triage",
            draftBody: blocked ? undefined : replyFor(detail, agencyName, property?.address),
            holdReason,
        };
    });
}
/** Fixed, labelled sample data for product QA. This is not a mailbox adapter. */
export function demoInboundBatch(now = Date.now()) {
    return {
        accountKey: "realbud-demo-inbox",
        messages: [
            {
                providerMessageId: "demo-maintenance-001",
                providerThreadId: "demo-maintenance-thread",
                receivedAt: now - 8 * 60 * 1_000,
                from: { name: "Sam Nguyen", address: "sam.nguyen@example.test" },
                subject: "Burst pipe — 12 Oak St, Dickson ACT",
                body: "There is an active leak under the kitchen sink. I can provide access this afternoon and attached a photo.",
                attachmentNames: ["kitchen-leak.jpg"],
            },
            {
                providerMessageId: "demo-bdm-001",
                providerThreadId: "demo-bdm-thread",
                receivedAt: now - 21 * 60 * 1_000,
                from: { name: "Morgan Lee", address: "morgan.lee@example.test" },
                subject: "Property management enquiry",
                body: "I am a new landlord and would like to discuss property management for my investment property.",
            },
        ],
    };
}
