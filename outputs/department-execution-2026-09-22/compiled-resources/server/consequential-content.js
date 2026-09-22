// Code-owned outbound wording guard. This is deliberately narrower than a
// legal classifier: it catches the statutory/enforcement language RealBud is
// structurally forbidden to prepare, and sends the wording back to a licensed
// human. It never supplies a deadline, legal interpretation or replacement
// wording.
import { COURTESY_DISCLAIMER } from "../shared/contracts.js";
const FORMAL_PROCESS = /\b(?:formal notice|breach notice|notice to (?:leave|vacate|remedy(?: breach)?)|notice of (?:termination|intention to leave|rent increase)|termination notice|statutory notice|remedy breach notice|show cause notice|evict(?:ion|ed)?|tribunal|qcat|ncat|vcat|sacat|bond claim|possession order|warrant of possession|rent increase notice|form\s*(?:11|12|13|16|17))\b/i;
const THREATENED_PROCESS = /\b(?:issue|serve|send|file|apply for|commence|start|take)\s+(?:you\s+)?(?:a\s+|an\s+|the\s+)?(?:breach|termination|eviction|statutory|legal|tribunal|court|possession)\b/i;
const TERMINATION_DIRECTION = /\b(?:terminate|end)\s+(?:your\s+|the\s+)?(?:tenancy|lease)|\b(?:your\s+|the\s+)?(?:tenancy|lease)\s+(?:(?:will|may|can)\s+be|is\s+(?:going\s+to\s+be\s+)?|was\s+)\s*(?:terminated|ended)\b|\b(?:leave|vacate)\s+(?:the\s+)?(?:property|premises)\s+by\b/i;
const DEADLINE_NUMBER = "(?:\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|twenty[- ]?one|twenty[- ]?eight|thirty)";
const LEGAL_DEADLINE = new RegExp(`\\b(?:you have|you must(?: (?:pay|remedy|leave|vacate))?|must be (?:paid|remedied)|required to (?:pay|remedy|leave|vacate)|(?:pay|remedy|leave|vacate)\\s+within)\\s+(?:within\\s+)?${DEADLINE_NUMBER}\\s+(?:calendar\\s+|business\\s+)?days?\\b`, "i");
const LEGAL_AUTHORITY = /\b(?:(?:under|pursuant to|required by)\s+(?:the\s+)?(?:residential tenanc(?:y|ies)|property|real estate|state|territory)\s+(?:act|law|legislation|regulation)s?|(?:section|s\.)\s*\d+[a-z]?(?:\(\d+\))?)\b/i;
function withoutFixedDisclaimer(body) {
    return String(body ?? "").replace(COURTESY_DISCLAIMER, " ");
}
export function checkConsequentialContent(body) {
    const text = withoutFixedDisclaimer(body);
    if (FORMAL_PROCESS.test(text))
        return { ok: false, reason: "formal-process" };
    if (THREATENED_PROCESS.test(text))
        return { ok: false, reason: "threatened-process" };
    if (TERMINATION_DIRECTION.test(text))
        return { ok: false, reason: "termination-direction" };
    if (LEGAL_DEADLINE.test(text))
        return { ok: false, reason: "legal-deadline" };
    if (LEGAL_AUTHORITY.test(text))
        return { ok: false, reason: "legal-authority" };
    return { ok: true };
}
export function assertOperationalDraftContent(body, kind) {
    const checked = checkConsequentialContent(body);
    if (checked.ok)
        return;
    throw Object.assign(new Error(`This ${kind === "courtesy-rent" ? "courtesy wording" : "draft"} contains notice, enforcement or legal-clock language. RealBud cannot prepare or approve it; a licensed human must handle it outside RealBud.`), { status: 409, code: "licensed-content-required" });
}
