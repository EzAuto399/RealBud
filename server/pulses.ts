// After a named loop settles, one digest per paired channel — the brief
// line, never a drip per card. Quiet hours and send ride remote-decisions.
import type { DeskSnapshot } from "../shared/contracts.ts";

import { morningBrief } from "../src/lib/morning-brief.ts";
import { sendPairedDigest } from "./remote-decisions.ts";

const REVIEW = "Review on Desk, or decide here as cards arrive.";

export function pulseDigestText(loopId: string, snapshot: DeskSnapshot): string | null {
  const brief = morningBrief(snapshot);
  if (brief.needsYou <= 0 && brief.licensee <= 0) return null;
  const bits = [`${brief.checkedCount} checked`];
  if (brief.needsYou) bits.push(brief.needsYou === 1 ? "1 needs you" : `${brief.needsYou} need you`);
  if (brief.licensee) bits.push(brief.licensee === 1 ? "1 for the licensee" : `${brief.licensee} for the licensee`);
  return `${pulseTitle(loopId)}: ${bits.join(" · ")}. ${REVIEW}`;
}

export async function pulseLoopSettled(loopId: string, snapshot: DeskSnapshot): Promise<void> {
  const text = pulseDigestText(loopId, snapshot);
  if (!text) return;
  try {
    await sendPairedDigest(text, snapshot.timezone || "Australia/Sydney");
  } catch {
    /* a channel miss must never fail the clock */
  }
}

function pulseTitle(loopId: string): string {
  if (loopId === "owner-letter") return "Friday owner letter";
  return "Morning money";
}
