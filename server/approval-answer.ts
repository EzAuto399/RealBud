// How RealBud's one-time card ended, so a broker never tells Bud "not approved"
// when nobody answered, or the request stopped, before the person chose.

/** "user": the person answered; "timeout": nobody answered in the card's window; "stopped": the request ended first. */
export type ApprovalResolution = "user" | "timeout" | "stopped";
/** A card's result. A bare boolean is the person's own answer. */
export type ApprovalAnswer = boolean | { allowed: boolean; resolution: ApprovalResolution };

export const APPROVAL_TIMED_OUT = "The card was shown but nobody answered within 4 minutes, so nothing changed. Ask again when you're at RealBud.";
export const APPROVAL_DENIED = "The person chose Don't allow. Nothing changed.";
/** Receipt line for a card nobody answered. */
export const APPROVAL_TIMED_OUT_RECEIPT = "Nobody answered within 4 minutes";

export const approvalAnswer = (answer: ApprovalAnswer): { allowed: boolean; resolution: ApprovalResolution } =>
  typeof answer === "boolean" ? { allowed: answer, resolution: "user" } : answer;
