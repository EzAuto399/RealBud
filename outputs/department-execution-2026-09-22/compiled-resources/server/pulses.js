import { morningBrief } from "../src/lib/morning-brief.js";
import { sendPairedDigest } from "./remote-decisions.js";
const REVIEW = "Review on Desk, or decide here as cards arrive.";
export function pulseDigestText(loopId, snapshot) {
    const brief = morningBrief(snapshot);
    if (brief.headline.startsWith("Recheck missed")) {
        return `${pulseTitle(loopId)}: Recheck missed — facts held. Open Desk.`;
    }
    if (brief.needsYou <= 0 && brief.licensee <= 0)
        return null;
    const bits = [`${brief.checkedCount} checked`];
    if (brief.needsYou)
        bits.push(brief.needsYou === 1 ? "1 needs you" : `${brief.needsYou} need you`);
    if (brief.licensee)
        bits.push(brief.licensee === 1 ? "1 for the licensee" : `${brief.licensee} for the licensee`);
    return `${pulseTitle(loopId)}: ${bits.join(" · ")}. ${REVIEW}`;
}
export async function pulseLoopSettled(loopId, snapshot) {
    const text = pulseDigestText(loopId, snapshot);
    if (!text)
        return;
    try {
        await sendPairedDigest(text, snapshot.timezone || "Australia/Sydney");
    }
    catch {
        /* a channel miss must never fail the clock */
    }
}
function pulseTitle(loopId) {
    if (loopId === "owner-letter")
        return "Friday owner letter";
    return "Morning Recheck";
}
