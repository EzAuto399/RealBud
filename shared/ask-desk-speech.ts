/** Desk questions are code-owned. Do not send them to a model that cannot see the queue. */

const DESK_QUESTION =
  /\b(?:what needs me|what still needs (?:me|allow)|what(?:'s|s| is) waiting(?: on desk)?|what(?:'s|s| is) on(?: the)? desk|explain (?:the )?(?:\d+ )?(?:licensee )?holds?|licensee holds?(?: on desk)?|review (?:this )?morning(?:'s)? exceptions)\b/i;

export function matchAskDeskSpeech(text: string): boolean {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 240) return false;
  return DESK_QUESTION.test(clean);
}
