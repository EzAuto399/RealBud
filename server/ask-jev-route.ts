/**
 * Jev pre-route for Ask. When no product-control regex matches a message the
 * person typed, ONE Jev choice may map it to a read-only control: the caller
 * then gives exactly the reply the regex gives for that control today. Every
 * other outcome (low confidence, a slow or failed call, anything not clearly
 * read-only) goes to Bud as before. Jev output is data, never authority: no
 * route here changes a setting, starts work, approves, sends or connects.
 *
 * Routable controls are read-only and parameterless: schedule-status (lists
 * jobs), connected-status (lists connections), connections / setup / bank-feed
 * (point to the person's own Add, Set up Bud and Connect bank feed controls).
 * schedule-edit is never routed: changing a schedule goes to Bud's approval card.
 */
import type { JevQuestion, JevRequest, JevResult } from "./jev-client.ts";
import { isAskProductControl } from "../shared/ask-controls.ts";
import { scheduleIntentReply } from "./schedule-intent.ts";
import { redactSecretsInText } from "./redact.ts";

export type AskJevRoute = "schedule-status" | "connected-status" | "connections" | "setup" | "bank-feed";
export type AskJevDecide = (request: JevRequest, options?: { timeoutMs?: number }) => Promise<JevResult>;

// To be tuned against labelled cases by scripts/eval-jev*. Missing confidence
// or probabilities count as below threshold.
export const ASK_JEV_MIN_CONFIDENCE = 0.95;
export const ASK_JEV_MIN_MARGIN = 0.3;
/** Small so a slow Jev never noticeably delays Bud. */
export const ASK_JEV_TIMEOUT_MS = 2_500;
export const ASK_JEV_MAX_TEXT = 2_000;

const QUESTION: JevQuestion = {
  type: "choice",
  instructions: "The state is one message a person typed to Bud, an office assistant. Pick the option that describes the WHOLE message. Choose bud unless one other option clearly fits all of it.",
  criteria: {
    "schedule-status": "Only asks to see which recurring jobs, routines or scheduled work exist. Not a request to add, change, move, pause or run one.",
    "connected-status": "Only asks which apps, accounts or sources Bud is connected to or can use. Not a request to connect, disconnect or use one.",
    connections: "Only asks how or where to connect an office app in general. Not about a property, lease, tenant or owner.",
    setup: "Only asks how to set up, fix or finish connecting Bud itself, or why Bud is not ready or working.",
    "bank-feed": "Only asks about connecting or setting up the office bank feed (Redbark). Not about a payment, transaction, tenant or property.",
    bud: "Anything else: work on properties, tenants, owners, money or mail; any request to change, add, pause, run, send, pay or approve; more than one request; or not sure.",
  },
};
const ROUTES = new Set<string>(["schedule-status", "connected-status", "connections", "setup", "bank-feed"]);

/** The pure decision: one Jev choice over the message text alone, accepted only
 * above both thresholds. Long, multi-line or attachment-bearing text never calls Jev. */
export async function chooseAskRoute(text: string, decide: AskJevDecide): Promise<AskJevRoute | null> {
  const value = text.trim();
  if (!value || value.length > ASK_JEV_MAX_TEXT || /[\r\n]|<(?:pasted-text|attached-file)\b/.test(value)) return null;
  let result: JevResult;
  try { result = await decide({ state: redactSecretsInText(value), questions: { route: QUESTION } }, { timeoutMs: ASK_JEV_TIMEOUT_MS }); }
  catch { return null; }
  const answer = result.ok ? result.answers.route : undefined;
  if (answer?.type !== "choice" || !ROUTES.has(answer.choice) || !answer.probabilities) return null;
  const top = answer.probabilities[answer.choice] ?? 0;
  const runnerUp = Math.max(0, ...Object.entries(answer.probabilities).filter(([key]) => key !== answer.choice).map(([, p]) => p));
  return (answer.confidence ?? 0) >= ASK_JEV_MIN_CONFIDENCE && top - runnerUp >= ASK_JEV_MIN_MARGIN ? answer.choice as AskJevRoute : null;
}

/** The Ask seam: only a person's own message, only when every regex control
 * missed and Jev is ready. */
export async function askJevRoute(text: string, options: { person: boolean; ready: () => boolean; decide: AskJevDecide }): Promise<AskJevRoute | null> {
  if (!options.person || isAskProductControl(text) || scheduleIntentReply(text) || /^\s*check\s+.+?\s+connection[.!]?\s*$/i.test(text) || !options.ready()) return null;
  return chooseAskRoute(text, options.decide);
}

/** The only turns that reach Jev (the Ask pre-route and Bud's `decide` tool):
 * a message the person typed in Ask. Never a phone channel relay, a queued
 * follow-up drained later, or an attended job's `systemExtra` turn. */
export function personAskTurn(opts?: { personAsk?: boolean; channelRelay?: boolean; systemExtra?: string }): boolean {
  return opts?.personAsk === true && !opts.channelRelay && !opts.systemExtra;
}

/** A desktop task's pick_control: the person's own Ask, or the Start they pressed on their own task card in this app
 * (`startedByPerson`, set only by the session-authenticated Start route). Never a relay, a queued drain, a loop,
 * a recovery or a sign-in continuation. `decide` and the Ask pre-route keep `personAskTurn`. */
export function personDesktopTurn(opts?: { personAsk?: boolean; channelRelay?: boolean; systemExtra?: string; startedByPerson?: boolean }): boolean {
  return personAskTurn(opts) || (opts?.startedByPerson === true && !opts.channelRelay);
}
