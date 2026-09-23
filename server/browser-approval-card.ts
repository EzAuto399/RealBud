// The approval card for a consequential browser step, built from what the
// broker persisted (server/browser-broker.ts passes the record's id, kind,
// facts and expiry in the permission params), and the card side of Stop.
// The broker decides and re-checks the step; this only shows its decision.
import { redactSecretsInText } from "./redact.ts";
import {
  BROWSER_APPROVAL_CARD_PURPOSE,
  BROWSER_APPROVAL_CARD_VERSION,
  BROWSER_APPROVAL_HASH_FACTS,
  parseBrowserApprovalCard,
  type BrowserApprovalCard,
  type BrowserApprovalFactName,
} from "../shared/browser-approval-card.ts";

/** Recorded on the card when Stop ended the task before the person decided. */
export const BROWSER_APPROVAL_STOPPED = "stopped";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
/** A shown value must be exactly the page's value: a redacted, trimmed or
 * cleaned preview is shown but can never count as confirmed. */
function shown(value: unknown): { value: string | null; exact: boolean } {
  if (typeof value !== "string") return { value: null, exact: false };
  const clean = redactSecretsInText(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
  return clean.trim() ? { value: clean, exact: clean === value } : { value: null, exact: false };
}

/** The card for a broker permission that carries an approval record.
 * Undefined when the step is not a consequential approval; throws when it is
 * one but its facts cannot be shown, so the caller never shows it. */
export function browserApprovalCardFrom(params: unknown): BrowserApprovalCard | undefined {
  if (!record(params) || params.approval === undefined) return undefined;
  const approval = params.approval;
  if (!record(approval) || !Array.isArray(approval.facts) || typeof params.url !== "string" || typeof params.label !== "string") {
    throw new Error("This approval's details are unavailable.");
  }
  const control = shown(params.label.match(/"([^"]{1,120})"/)?.[1] ?? params.label.slice(0, 120));
  return parseBrowserApprovalCard({
    version: BROWSER_APPROVAL_CARD_VERSION,
    purpose: BROWSER_APPROVAL_CARD_PURPOSE,
    id: approval.id,
    kind: approval.kind,
    site: new URL(params.url).hostname,
    control: control.value?.slice(0, 120),
    facts: approval.facts.map(item => {
      const fact = record(item) ? item : {};
      const name = fact.name as BrowserApprovalFactName;
      // A hash binds the approval to the page text; it is not something to read.
      if (BROWSER_APPROVAL_HASH_FACTS.includes(name)) return { name, value: null, confirmed: fact.confirmed === true };
      const value = shown(fact.value);
      return { name, value: value.value, confirmed: fact.confirmed === true && value.exact };
    }),
    expiresAt: approval.expiresAt,
  });
}

/** Persisted cards are re-redacted; a damaged one becomes null, which the app
 * shows as held and never as approvable. */
export function sanitizeBrowserApprovalCard(value: unknown): BrowserApprovalCard | null {
  try {
    const card = parseBrowserApprovalCard(value);
    return parseBrowserApprovalCard({ ...card, control: redactSecretsInText(card.control), facts: card.facts.map(fact => {
      const value = fact.value === null ? null : redactSecretsInText(fact.value);
      return { ...fact, value, confirmed: fact.confirmed && value === fact.value };
    }) });
  } catch { return null; }
}

interface CardMessage { id: string; card?: { browserApproval?: unknown; answered?: string; dismissed?: boolean } }
interface CardStore<M extends CardMessage> {
  messagesFor(threadId: string): M[];
  patchMessage(threadId: string, messageId: string, patch: Partial<M>): M | null;
}
export interface StoppedBrowserApproval<M> { key: string; threadId: string; requestId: string; message: M }

/** Stop records every open browser approval on the thread (or on all threads)
 * as stopped before the turn is cancelled. The caller forgets the returned
 * request keys, so a late click can never approve them. */
export function stopBrowserApprovalCards<M extends CardMessage>(
  store: CardStore<M>,
  open: Iterable<[key: string, messageId: string]>,
  threadId?: string,
): StoppedBrowserApproval<M>[] {
  const stopped: StoppedBrowserApproval<M>[] = [];
  for (const [key, messageId] of [...open]) {
    const split = key.indexOf(":");
    const thread = key.slice(0, split), requestId = key.slice(split + 1);
    if (split < 1 || (threadId !== undefined && thread !== threadId)) continue;
    const message = store.messagesFor(thread).find(row => row.id === messageId);
    if (!message?.card || message.card.browserApproval === undefined || message.card.answered || message.card.dismissed) continue;
    const patched = store.patchMessage(thread, messageId, { card: { ...message.card, answered: BROWSER_APPROVAL_STOPPED, dismissed: false } } as Partial<M>);
    if (patched) stopped.push({ key, threadId: thread, requestId, message: patched });
  }
  return stopped;
}
