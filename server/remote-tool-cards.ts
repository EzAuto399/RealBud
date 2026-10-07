// Bud's live action cards on a paired phone. When a card opens on the desktop
// it is offered to each paired private chat; a tap answers it through the same
// answerLiveRequest the desktop uses, never a side door. Only a read, an in-app
// change or a send whose card holds the whole message gets buttons; anything
// else is a "waiting in RealBud" notice with no amounts or recipients.
// Push and decision receipts survive a restart in remote-tool-decisions.json.
import { createHash, randomBytes } from "node:crypto";

import { officeAppLabel } from "../shared/office-sources.ts";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";
import { redactSecretsInText } from "./redact.ts";
import type { RemoteChannelAdapter, RemoteChannelId, RemoteDecideResult } from "./remote-decisions.ts";
import type { OptionCardData } from "./store.ts";

export type ToolCardChoice = "once" | "task" | "deny";
export type ToolCardAnswerer = { name: string; via: RemoteChannelId };
type PhoneClass = "read" | "write" | "send" | "desktop-only";

export type RemoteToolCardsBind = {
  channels: RemoteChannelAdapter[];
  /** remote-tool-decisions.json */
  file: string;
  /** The office's quiet hours: nothing is pushed. */
  quiet(): boolean;
  timeZone?(): string;
  now?(): number;
  /** The stored card while its request is still waiting in this process, else null. */
  liveCard(threadId: string, requestId: string): OptionCardData | null;
  /** Sets the waiting desktop card's quiet phone line ("Also on Telegram"); never its `held` text. */
  noteCard(threadId: string, requestId: string, note: string): void;
  /** The desktop's own answer path (answerLiveRequest). */
  answer(threadId: string, requestId: string, choice: ToolCardChoice, by: ToolCardAnswerer, line: string): Promise<{ status: number }>;
};

type Outcome = { kind: "phone" | "desktop" | "timeout" | "stopped" | "restart"; at: number; behavior?: "allow" | "deny"; line?: string };
type Push = {
  id: string; channel: RemoteChannelId; pairedKey: string; threadId: string; requestId: string;
  fingerprint: string; cls: PhoneClass; decidable: boolean; at: number; deadline?: string; outcome?: Outcome;
};

const STALE = "This card is no longer current. Nothing was changed.";
const RESTARTED = "RealBud restarted, so this request ended. Nothing was changed.";
const READS_ONLY = "Allow for this task is only for reads. Nothing was changed.";
const QUIET = "Not sent to your phone: quiet hours";
const MAX_TEXT = 1800;
const MAX_ROWS = 200;
const MAX_BYTES = 256_000;
const CHANNELS: readonly string[] = ["telegram", "discord", "slack"];
const KINDS: readonly string[] = ["phone", "desktop", "timeout", "stopped", "restart"];
const CLASSES: readonly string[] = ["read", "write", "send", "desktop-only"];
const BROWSER_KIND: Record<string, string> = { pay: "a payment", sign: "a signature", notice: "a notice", send: "a message", delete: "a deletion", "account-change": "an account change" };

let bound: RemoteToolCardsBind | null = null;
let ready: Promise<void> = Promise.resolve();
/** A damaged receipts file holds phone cards; the desktop is unaffected. */
let held = false;
let saving: Promise<void> = Promise.resolve();
const pushes: Push[] = [];
/** Waiting cards this module noted, and where each is out. */
const live = new Map<string, { on: string[] }>();

export function bindRemoteToolCards(opts: RemoteToolCardsBind): Promise<void> {
  resetRemoteToolCards();
  bound = opts;
  ready = load(opts);
  return ready;
}

export function resetRemoteToolCards(): void {
  bound = null; held = false; pushes.length = 0; live.clear();
  ready = Promise.resolve(); saving = Promise.resolve();
}

const nowMs = () => bound?.now?.() ?? Date.now();
const keyOf = (threadId: string, requestId: string) => `${threadId}:${requestId}`;
/** The chat plus the person who paired, as remote-decisions keys a pairing. */
function pushKey(channel: RemoteChannelAdapter): string | null {
  const chat = channel.pairedKey(), sender = channel.pairedSender?.();
  return chat && sender ? `${chat}#${sender}` : null;
}

function clock(at: number): string {
  const zone = bound?.timeZone?.();
  try { return new Date(at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", ...(zone ? { timeZone: zone } : {}) }); }
  catch { return new Date(at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }); }
}

/** What the person was shown: the stored (already redacted) card, minus the parts that change while it waits. */
export function toolCardFingerprint(card: OptionCardData): string {
  return createHash("sha256").update(JSON.stringify([card.requestId, card.tool ?? null, card.title, card.subtitle, card.detail ?? null,
    card.remote ?? null, card.deadline ?? null, card.readOffer ?? null, card.fence ?? null, card.browserApproval ?? null])).digest("hex");
}

const words = (slugTail: string) => { const text = slugTail.toLowerCase().replace(/_/g, " "); return text.charAt(0).toUpperCase() + text.slice(1); };

/** "Bud is waiting in RealBud: Gmail · Send email." Built from tool names and the site only, never a card's values. */
export function waitingNotice(card: OptionCardData): string {
  const slug = /^(?:Action: |\d+\. ).*\(([A-Z][A-Z0-9]*)_([A-Z0-9_]+)\)$/m.exec(card.subtitle ?? "");
  const site = card.fence?.origin ?? card.browserApproval?.site;
  const app = slug ? officeAppLabel(slug[1]!.toLowerCase()) : site;
  const action = card.browserApproval ? BROWSER_KIND[card.browserApproval.kind] : slug ? words(slug[2]!) : undefined;
  const what = [app, action].filter(Boolean).join(" · ") || card.title;
  return `Bud is waiting in RealBud: ${what}. Open RealBud to decide.`;
}

/** The phone message for one push, with buttons only when the person can decide from it. */
export function toolCardMessage(card: OptionCardData, id: string, waitingUntil: string | null): { cls: PhoneClass; text: string; buttons?: { allow: string; deny: string; task?: string } } {
  const cls: PhoneClass = card.remote && CLASSES.includes(card.remote) ? card.remote : "desktop-only";
  const summary = redactSecretsInText(card.subtitle ?? "");
  const lines = summary.split("\n");
  const first = /^Bud wants to use (?:the )?(.+?)\.$/.exec(lines[0] ?? "");
  const app = card.readOffer?.appLabel ?? first?.[1] ?? card.fence?.origin ?? "a connected app";
  const body = (first ? lines.slice(1) : lines).filter(line => !line.startsWith("This approval applies once")).join("\n").trim();
  const until = waitingUntil ? `\nWaiting until ${waitingUntil}.` : "";
  let text: string | null = null, buttons: { allow: string; deny: string; task?: string } | undefined;
  if (cls === "read") {
    const task = Boolean(card.readOffer);
    text = `Bud wants to read — ${app}.\n${body}${until}\n\nReply allow ${id}${task ? `, task ${id}` : ""} or deny ${id}.`;
    buttons = { allow: "Allow once", ...(task ? { task: "Allow for this task" } : {}), deny: "Deny" };
  } else if (cls === "write") {
    text = `Bud wants to change something — ${app}.\n${body}${until}\n\nReply allow ${id} or deny ${id}.`;
    buttons = { allow: "Allow once", deny: "Deny" };
  } else if (cls === "send") {
    // A managed mail send's card is the whole message: every recipient, the subject, the body and the attachments.
    text = `${summary}${until}\n\nReply allow ${id} to send it, or deny ${id}.`;
    buttons = { allow: "Send it", deny: "Don't send" };
  }
  // Never put buttons under a shortened card.
  return text !== null && text.length <= MAX_TEXT ? { cls, text, buttons } : { cls, text: waitingNotice(card) };
}

/** A card opened on the desktop: push it to every paired private chat. */
export async function remoteToolCardOpened(threadId: string, requestId: string): Promise<void> {
  const owner = bound;
  if (!owner) return;
  await ready;
  if (bound !== owner || held) return;
  const card = owner.liveCard(threadId, requestId);
  const targets = owner.channels.filter(channel => pushKey(channel));
  if (!card || !targets.length) return;
  const key = keyOf(threadId, requestId);
  const entry: { on: string[] } = { on: [] };
  live.set(key, entry);
  if (owner.quiet()) { owner.noteCard(threadId, requestId, QUIET); return; }
  const fingerprint = toolCardFingerprint(card);
  const deadline = card.deadline && Number.isFinite(Date.parse(card.deadline)) ? card.deadline : undefined;
  await Promise.all(targets.map(async channel => {
    const id = randomBytes(6).toString("hex");
    const message = toolCardMessage(card, id, deadline ? clock(Date.parse(deadline)) : null);
    const push: Push = { id, channel: channel.id, pairedKey: pushKey(channel)!, threadId, requestId, fingerprint, cls: message.cls,
      decidable: Boolean(message.buttons), at: nowMs(), ...(deadline ? { deadline } : {}) };
    pushes.push(push);
    void save();
    try {
      if (message.buttons) await channel.sendDecision(message.text, id, message.buttons);
      else if (channel.sendDigest) await channel.sendDigest(message.text);
    } catch {
      // Never delivered: its id can answer nothing.
      pushes.splice(pushes.indexOf(push), 1); void save();
      console.warn(`[remote-tool-cards] ${channel.id} card delivery was not confirmed.`);
      return;
    }
    if (!message.buttons || bound !== owner || live.get(key) !== entry || push.outcome) return;
    entry.on.push(channel.label);
    owner.noteCard(threadId, requestId, `Also on ${entry.on.join(" and ")}`);
  }));
}

/** The card closed on the desktop (any answer, a timeout or a stop). */
export function remoteToolCardResolved(threadId: string, requestId: string, resolved: { behavior: string; resolution?: string }): void {
  live.delete(keyOf(threadId, requestId));
  const kind: Outcome["kind"] = resolved.resolution === "timeout" ? "timeout" : resolved.resolution === "stopped" ? "stopped" : "desktop";
  let changed = false;
  for (const push of pushes) {
    if (push.threadId !== threadId || push.requestId !== requestId || push.outcome) continue;
    push.outcome = { kind, at: nowMs(), ...(kind === "desktop" ? { behavior: resolved.behavior === "allow" ? "allow" as const : "deny" as const } : {}) };
    changed = true;
  }
  if (changed) void save();
}

export function knowsToolCardPush(id: string): boolean {
  return pushes.some(push => push.id === id);
}

/** A tap or reply from a paired chat. The caller has already checked the paired
 * chat and sender (remoteSenderMayDecide); this checks the push was sent to that
 * same person, the card is still live and unchanged, and the id is unused. */
export async function answerToolCardTap(channel: RemoteChannelId, chatKey: string, senderKey: string, byName: string, id: string, decision: "allow" | "deny" | "task"): Promise<RemoteDecideResult> {
  const owner = bound;
  await ready;
  const stale = { ok: false as const, message: STALE };
  const push = pushes.find(row => row.id === id);
  const adapter = owner?.channels.find(item => item.id === channel);
  if (!owner || bound !== owner || held || !push || !adapter || !push.decidable || push.channel !== channel ||
    push.pairedKey !== `${chatKey}#${senderKey}` || pushKey(adapter) !== push.pairedKey) return stale;
  if (push.outcome) return { ok: false, message: outcomeReply(push) };
  const deadline = push.deadline ? Date.parse(push.deadline) : NaN;
  if (Number.isFinite(deadline) && nowMs() >= deadline) return { ok: false, message: `Timed out at ${clock(deadline)}. Bud did not do it.` };
  const card = owner.liveCard(push.threadId, push.requestId);
  if (!card || toolCardFingerprint(card) !== push.fingerprint) return stale;
  if (decision === "task" && !(push.cls === "read" && card.readOffer)) return { ok: false, message: READS_ONLY };
  const choice: ToolCardChoice = decision === "deny" ? "deny" : decision === "task" ? "task" : "once";
  const at = nowMs();
  const name = redactSecretsInText(byName).replace(/[\r\n]+/g, " ").slice(0, 80);
  const line = `${choice === "deny" ? "Denied" : choice === "task" ? "Allowed for this task" : "Allowed once"} by ${name} via ${adapter.label} · ${clock(at)}`;
  // The first answer wins: every push of this card is spent before anything awaits.
  for (const row of pushes) {
    if (row.threadId === push.threadId && row.requestId === push.requestId && !row.outcome) row.outcome = { kind: "phone", at, behavior: choice === "deny" ? "deny" : "allow", line };
  }
  void save();
  let reply: { status: number };
  try { reply = await owner.answer(push.threadId, push.requestId, choice, { name, via: channel }, line); }
  catch { reply = { status: 500 }; }
  return reply.status === 200 ? { ok: true, stamp: line } : stale;
}

function outcomeReply(push: Push): string {
  const outcome = push.outcome!;
  if (outcome.kind === "restart") return RESTARTED;
  if (outcome.kind === "timeout") return `Timed out at ${clock(push.deadline ? Date.parse(push.deadline) : outcome.at)}. Bud did not do it.`;
  if (outcome.kind === "desktop") return `Already decided on the computer (${outcome.behavior === "allow" ? "Allowed" : "Denied"}).`;
  return STALE;
}

async function load(opts: RemoteToolCardsBind): Promise<void> {
  let raw: unknown;
  try { raw = await readPrivateJson(opts.file, MAX_BYTES); }
  catch { if (bound === opts) { held = true; console.warn("[remote-tool-cards] Phone card receipts need recovery; phone cards are paused."); } return; }
  if (bound !== opts || raw === undefined) return;
  const file = raw as { version?: unknown; pushes?: unknown } | null;
  const rows = file?.pushes;
  if (file?.version !== 1 || !Array.isArray(rows) || !rows.every(validPush)) {
    // Kept as it is on disk: a damaged file holds phone cards and is never cleared.
    held = true; console.warn("[remote-tool-cards] Phone card receipts need recovery; phone cards are paused.");
    return;
  }
  // Every request from an earlier run ended with that run.
  const now = nowMs();
  pushes.push(...rows.map(row => row.outcome ? row : { ...row, outcome: { kind: "restart" as const, at: now } }));
  if (rows.some(row => !row.outcome)) await save();
}

function validPush(value: unknown): value is Push {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const text = (item: unknown, max: number) => typeof item === "string" && item.length > 0 && item.length <= max;
  const outcome = row.outcome as Record<string, unknown> | undefined;
  return /^[a-f0-9]{12}$/.test(String(row.id)) && CHANNELS.includes(String(row.channel)) && text(row.pairedKey, 300) && text(row.threadId, 200) &&
    text(row.requestId, 200) && /^[a-f0-9]{64}$/.test(String(row.fingerprint)) && CLASSES.includes(String(row.cls)) && typeof row.decidable === "boolean" &&
    typeof row.at === "number" && (row.deadline === undefined || text(row.deadline, 40)) &&
    (outcome === undefined || (Boolean(outcome) && typeof outcome === "object" && KINDS.includes(String(outcome.kind)) && typeof outcome.at === "number" &&
      (outcome.behavior === undefined || outcome.behavior === "allow" || outcome.behavior === "deny") && (outcome.line === undefined || text(outcome.line, 300))));
}

function save(): Promise<void> {
  const owner = bound;
  if (!owner || held) return saving;
  // Spent rows go first when the log is full.
  while (pushes.length > MAX_ROWS) {
    const spent = pushes.findIndex(row => row.outcome);
    pushes.splice(spent >= 0 ? spent : 0, 1);
  }
  saving = saving.then(async () => {
    if (bound !== owner || held) return;
    try { await writePrivateJson(owner.file, { version: 1, pushes }, { maxBytes: MAX_BYTES, validate: () => {} }); }
    catch { console.warn("[remote-tool-cards] Phone card receipts could not be saved."); }
  });
  return saving;
}
