// Remote Desk decisions over a paired channel. One pending card per
// channel. Push receipts survive restart in bind.storeDir so Telegram is
// not re-flooded with the same Allow/Deny card after every boot.
// Licensee / escalation rows never travel as buttons. Quiet hours follow
// the book's timezone, not the machine's. Digest queue + receipts also
// survive restart when bind.storeDir is set.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { DeskSnapshot, Draft, DraftKind } from "../shared/contracts.ts";

export type RemoteChannelId = "telegram" | "discord" | "slack";

export type RemoteDecideResult =
  | { ok: true; stamp: string; draft: Draft }
  | { ok: false; message: string };

export type RemoteChannelAdapter = {
  id: RemoteChannelId;
  label: string;
  pairedKey(): string | null;
  sendDecision(text: string, draftId: string): Promise<void>;
  sendDigest?(text: string): Promise<void>;
};

export type RemoteDesk = {
  snapshot(): DeskSnapshot;
  allowDraft(id: string, expectedRevision?: number, via?: string): Draft;
  denyDraft(id: string, expectedRevision?: number, via?: string, reason?: string): Draft;
  notesFor?(id: string): { id: string; body: string };
  writeNotes?(id: string, body: string): { id: string; body: string };
};

export type RemoteDecisionsBind = {
  desk: RemoteDesk;
  channels: RemoteChannelAdapter[];
  commit: (snapshot: DeskSnapshot) => void | Promise<void>;
  now?: () => number;
  /** When set, quiet-hour digest queue and delivery receipts survive restart. */
  storeDir?: string;
};

const DECIDABLE: ReadonlySet<DraftKind> = new Set(["courtesy-rent", "levy-from-rent", "owner-letter"]);
const BOOK_MOVED = "This work changed. Review the current wording on Desk before deciding.";
const LICENSEE_REFUSAL = "that card needs the licensee — open Desk when you're at a screen";
const ELSEWHERE = "This Bud is paired elsewhere.";
const FLUSH_MS = 60_000;
const PUSH_MAX = 500;
const REVIEW_MAX = 1800;
const STALE_CARD = "This review card is no longer current. Use the latest card, or review the wording on Desk. Nothing was changed by this reply.";

type ChannelPending = { draftId: string; decisionId: string; fingerprint: string; pairedKey: string; deferred: boolean; previewOnly: boolean };
type DecisionPushReceipt = { channel: RemoteChannelId; draftId: string; fingerprint: string; decisionId: string; pairedKey: string; at: number };

let bound: RemoteDecisionsBind | null = null;
// Pushed-but-undecided draft ids. Restored from storeDir on bind so a restart
// does not re-flood Telegram/Discord with the same Allow/Deny card.
const pendingByChannel = new Map<RemoteChannelId, ChannelPending>();
const decisionPushReceipts: DecisionPushReceipt[] = [];
const deferredDigests: Array<{ text: string; timeZone: string }> = [];
type DigestReceipt = { channel: RemoteChannelId; hash: string; at: number };
const digestReceipts: DigestReceipt[] = [];
const RECEIPT_MAX = 200;
const DECISION_PUSH_MAX = 200;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let pushFlight: Promise<void> | null = null;
let pushRequested = false;

export function bindRemoteDecisions(opts: RemoteDecisionsBind): void {
  resetRemoteDecisions();
  bound = opts;
  loadDigestStore();
  loadDecisionPushStore();
}

export function resetRemoteDecisions(): void {
  stopRemoteDecisionFlush();
  pendingByChannel.clear();
  decisionPushReceipts.length = 0;
  deferredDigests.length = 0;
  digestReceipts.length = 0;
  bound = null;
  pushFlight = null;
  pushRequested = false;
}

export function pendingDraftId(channel: RemoteChannelId): string | null {
  const row = pendingByChannel.get(channel);
  return row && !row.deferred ? row.draftId : null;
}

export function pendingDecisionId(channel: RemoteChannelId): string | null {
  const row = pendingByChannel.get(channel);
  return row && !row.deferred && !row.previewOnly ? row.decisionId : null;
}

export function isDecidableDraft(draft: Draft): boolean {
  return draft.status === "pending" && DECIDABLE.has(draft.kind);
}

export function isQuietHours(now: number, timeZone: string): boolean {
  const minutes = localMinutes(now, timeZone);
  return minutes < 7 * 60 + 1 || minutes >= 18 * 60;
}

export function parseRemoteDecisionText(text: string): { decision: "allow" | "deny"; decisionId?: string; reason?: string } | null {
  const trimmed = text.trim();
  const scoped = /^(allow|deny)\s+([a-f0-9]{12})(?:\s*[-–—:]\s*(.{1,1000}))?$/i.exec(trimmed);
  if (scoped) return { decision: scoped[1]!.toLowerCase() as "allow" | "deny", decisionId: scoped[2]!.toLowerCase(), ...(scoped[3] && scoped[1]!.toLowerCase() === "deny" ? { reason: scoped[3].trim() } : {}) };
  if (/^(yes|y|allow)$/i.test(trimmed)) return { decision: "allow" };
  const deny = trimmed.match(/^(no|n|deny)(?:\s*[-–—:]\s*(.+))?$/i);
  if (!deny) return null;
  const reason = deny[2]?.trim();
  return reason ? { decision: "deny", reason } : { decision: "deny" };
}

/** Bare yes/no can refer to a conversation or an older card. Never guess. */
export async function decideRemoteText(channel: RemoteChannelId, chatKey: string, text: string, byName: string): Promise<RemoteDecideResult | null> {
  const parsed = parseRemoteDecisionText(text);
  if (!parsed) return null;
  if (bound?.channels.find(item => item.id === channel)?.pairedKey() !== chatKey) return { ok: false, message: ELSEWHERE };
  if (parsed.decisionId) return decideRemotely(channel, chatKey, parsed.decisionId, parsed.decision, parsed.reason, byName);
  const current = pendingDecisionId(channel);
  if (!current) return null;
  return { ok: false, message: `Review the card, then use its buttons or reply “allow ${current}” or “deny ${current}”. Nothing has changed.` };
}

export function parseDecisionCallback(data: string): { draftId: string; decision: "allow" | "deny" } | null {
  const match = /^d:([\w-]+):(allow|deny)$/.exec(data.trim());
  if (!match) return null;
  return { draftId: match[1]!, decision: match[2] as "allow" | "deny" };
}

export function decisionPushText(address: string, kind: DraftKind): string {
  const ready =
    kind === "levy-from-rent"
      ? "Levy-from-rent wording is ready."
      : kind === "owner-letter"
        ? "Owner update wording is ready."
        : "Courtesy SMS wording is ready.";
  const allowMeans =
    kind === "levy-from-rent"
      ? "Allow sends nothing; it approves the levy flag wording for you to copy."
      : kind === "owner-letter"
        ? "Allow sends nothing; it approves the owner update for you to copy."
        : "Allow sends nothing; it approves the wording for you to copy.";
  const text = `${address} — ${ready} ${allowMeans}`;
  return text.length <= PUSH_MAX ? text : `${text.slice(0, PUSH_MAX - 1)}…`;
}

export function notifyDeskSnapshot(_snapshot: DeskSnapshot): Promise<void> {
  if (!bound) return Promise.resolve();
  pushRequested = true;
  if (pushFlight) return pushFlight;
  const owner = bound;
  const flight = Promise.resolve().then(async () => {
    while (bound === owner && pushRequested) {
      pushRequested = false;
      await pushFromSnapshot(owner.desk.snapshot());
    }
  }).catch(() => {
    console.warn("[remote-decisions] Review notifications could not be refreshed; Desk work is kept.");
  }).finally(() => {
    if (pushFlight === flight) pushFlight = null;
  });
  pushFlight = flight;
  return flight;
}

export async function decideRemotely(
  channel: RemoteChannelId,
  chatKey: string,
  decisionId: string,
  decision: "allow" | "deny",
  reason: string | undefined,
  byName: string,
): Promise<RemoteDecideResult> {
  if (!bound) return { ok: false, message: BOOK_MOVED };
  const adapter = bound.channels.find((item) => item.id === channel);
  if (!adapter || adapter.pairedKey() !== chatKey) return { ok: false, message: ELSEWHERE };

  const snapshot = bound.desk.snapshot();
  if (snapshot.escalations.some((item) => item.id === decisionId)) {
    return { ok: false, message: LICENSEE_REFUSAL };
  }
  const shown = pendingByChannel.get(channel);
  if (!shown || shown.deferred || shown.previewOnly || shown.decisionId !== decisionId || shown.pairedKey !== chatKey) {
    void notifyDeskSnapshot(snapshot);
    return { ok: false, message: STALE_CARD };
  }
  const draftId = shown.draftId;
  const draft = snapshot.drafts.find((item) => item.id === draftId);
  if (!draft || draft.status !== "pending") return { ok: false, message: BOOK_MOVED };
  if (!DECIDABLE.has(draft.kind)) return { ok: false, message: LICENSEE_REFUSAL };
  if (snapshot.recovery.active || reviewFingerprint(snapshot, draft) !== shown.fingerprint) {
    void notifyDeskSnapshot(snapshot);
    return { ok: false, message: STALE_CARD };
  }

  const via = `via ${adapter.label} · ${byName}`;
  let decided: Draft;
  try {
    decided =
      decision === "allow"
        ? bound.desk.allowDraft(draftId, snapshot.revision, via)
        : bound.desk.denyDraft(draftId, snapshot.revision, via, reason);
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    if (status === 409 || status === 404) return { ok: false, message: BOOK_MOVED };
    throw error;
  }

  pendingByChannel.delete(channel);
  clearDecisionPushReceipt(channel, draftId);
  const nextSnap = bound.desk.snapshot();
  // The Desk command has already persisted the decision. A notification miss
  // cannot turn that success into an invitation to repeat the decision.
  try { await Promise.resolve(bound.commit(nextSnap)); }
  catch { console.warn("[remote-decisions] Decision saved; its notification update failed."); }
  const at = decided.decidedAt ?? nowMs();
  return {
    ok: true,
    stamp: `${decision === "allow" ? "Allowed" : "Denied"} via ${adapter.label} · ${byName} · ${formatAuTime(at, nextSnap.timezone)}`,
    draft: decided,
  };
}

export function startRemoteDecisionFlush(): void {
  stopRemoteDecisionFlush();
  if (process.env.VITEST) return;
  // Push any pending Desk review card immediately — do not wait a full quiet tick after boot.
  try {
    void flushDeferredDecisions();
  } catch {
    /* never take down the server */
  }
  flushTimer = setInterval(() => {
    try {
      flushDeferredDecisions();
    } catch {
      /* never take down the server */
    }
  }, FLUSH_MS);
  flushTimer.unref?.();
}

export function stopRemoteDecisionFlush(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
}

export function flushDeferredDecisions(): Promise<void> {
  return (async () => {
    await flushDeferredDigests();
    if (bound) await notifyDeskSnapshot(bound.desk.snapshot());
  })();
}

/** Plain text to every paired channel. Quiet hours queue until the 7:01 flush. */
export async function sendPairedDigest(text: string, timeZone: string): Promise<void> {
  if (!bound) return;
  const zone = timeZone || "Australia/Sydney";
  if (isQuietHours(nowMs(), zone)) {
    queueDigest(text, zone);
    return;
  }
  const delivered = await deliverPairedDigest(text);
  if (!delivered) queueDigest(text, zone);
}

async function flushDeferredDigests(): Promise<void> {
  if (deferredDigests.length === 0) return;
  const still: Array<{ text: string; timeZone: string }> = [];
  const ready: Array<{ text: string; timeZone: string }> = [];
  for (const row of deferredDigests) {
    if (isQuietHours(nowMs(), row.timeZone)) still.push(row);
    else ready.push(row);
  }
  deferredDigests.length = 0;
  deferredDigests.push(...still);
  persistDigestStore();
  for (const row of ready) {
    const delivered = await deliverPairedDigest(row.text);
    if (!delivered) queueDigest(row.text, row.timeZone);
  }
}

async function deliverPairedDigest(text: string): Promise<boolean> {
  if (!bound) return true;
  const hash = digestHash(text);
  let pending = false;
  for (const channel of bound.channels) {
    if (!channel.pairedKey() || !channel.sendDigest) continue;
    if (hasDigestReceipt(channel.id, hash)) continue;
    try {
      await channel.sendDigest(text);
      recordDigestReceipt(channel.id, hash);
    } catch {
      pending = true;
    }
  }
  persistDigestStore();
  return !pending;
}

function digestHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function hasDigestReceipt(channel: RemoteChannelId, hash: string): boolean {
  return digestReceipts.some((row) => row.channel === channel && row.hash === hash);
}

function recordDigestReceipt(channel: RemoteChannelId, hash: string): void {
  if (hasDigestReceipt(channel, hash)) return;
  digestReceipts.push({ channel, hash, at: nowMs() });
  if (digestReceipts.length > RECEIPT_MAX) digestReceipts.splice(0, digestReceipts.length - RECEIPT_MAX);
}

function queueDigest(text: string, timeZone: string): void {
  if (!deferredDigests.some((row) => row.text === text && row.timeZone === timeZone)) {
    deferredDigests.push({ text, timeZone });
  }
  persistDigestStore();
}

function digestStoreDir(): string | null {
  const dir = bound?.storeDir?.trim();
  return dir ? dir : null;
}

function persistDigestStore(): void {
  const dir = digestStoreDir();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, "digest-queue.json"), JSON.stringify(deferredDigests));
  writeFileAtomic(join(dir, "digest-receipts.json"), JSON.stringify(digestReceipts));
}

function loadDigestStore(): void {
  deferredDigests.length = 0;
  digestReceipts.length = 0;
  const dir = digestStoreDir();
  if (!dir) return;
  const queuePath = join(dir, "digest-queue.json");
  const receiptsPath = join(dir, "digest-receipts.json");
  if (existsSync(queuePath)) {
    try {
      const raw = JSON.parse(readFileSync(queuePath, "utf8")) as unknown;
      if (Array.isArray(raw)) {
        for (const row of raw) {
          if (!row || typeof row !== "object") continue;
          const text = (row as { text?: unknown }).text;
          const timeZone = (row as { timeZone?: unknown }).timeZone;
          if (typeof text === "string" && text && typeof timeZone === "string" && timeZone) {
            deferredDigests.push({ text, timeZone });
          }
        }
      }
    } catch {
      /* a corrupt queue must not block Desk */
    }
  }
  if (existsSync(receiptsPath)) {
    try {
      const raw = JSON.parse(readFileSync(receiptsPath, "utf8")) as unknown;
      if (Array.isArray(raw)) {
        for (const row of raw) {
          if (!row || typeof row !== "object") continue;
          const channel = (row as { channel?: unknown }).channel;
          const hash = (row as { hash?: unknown }).hash;
          const at = (row as { at?: unknown }).at;
          if (
            (channel === "telegram" || channel === "discord" || channel === "slack") &&
            typeof hash === "string" &&
            hash &&
            typeof at === "number"
          ) {
            digestReceipts.push({ channel, hash, at });
          }
        }
      }
    } catch {
      /* a corrupt receipt log must not block Desk */
    }
  }
}

function nowMs(): number {
  return bound?.now?.() ?? Date.now();
}

function localMinutes(now: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(now));
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    return hour * 60 + minute;
  } catch {
    const date = new Date(now);
    return date.getHours() * 60 + date.getMinutes();
  }
}

function formatAuTime(at: number, timeZone?: string): string {
  try {
    return new Date(at).toLocaleTimeString("en-AU", {
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return new Date(at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  }
}

function oldestDecidable(snapshot: DeskSnapshot): Draft | undefined {
  return snapshot.drafts
    .filter(isDecidableDraft)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
}

function addressFor(snapshot: DeskSnapshot, propertyId: string): string {
  return snapshot.properties.find((property) => property.id === propertyId)?.address ?? propertyId;
}

function reviewFingerprint(snapshot: DeskSnapshot, draft: Draft): string {
  return createHash("sha256").update(JSON.stringify([snapshot.mode, addressFor(snapshot, draft.propertyId), draft])).digest("hex");
}

function reviewText(snapshot: DeskSnapshot, draft: Draft, decisionId: string): string | null {
  const text = `${decisionPushText(addressFor(snapshot, draft.propertyId), draft.kind)}\n\nTo: ${draft.to} (${draft.channel})\n\n${draft.body}\n\nReply allow ${decisionId} or deny ${decisionId}.`;
  // Never attach approval controls to truncated wording.
  return text.length <= REVIEW_MAX ? text : null;
}

async function pushFromSnapshot(snapshot: DeskSnapshot): Promise<void> {
  if (!bound) return;
  const owner = bound;
  if (snapshot.recovery.active) { pendingByChannel.clear(); persistDecisionPushStore(); return; }
  pruneDecisionPushReceipts(snapshot);
  const quiet = isQuietHours(nowMs(), snapshot.timezone || "Australia/Sydney");
  for (const channel of bound.channels) {
    if (bound !== owner) return;
    if (!channel.pairedKey()) { pendingByChannel.delete(channel.id); persistDecisionPushStore(); continue; }
    const tracked = pendingByChannel.get(channel.id);
    if (tracked) {
      const live = snapshot.drafts.find((item) => item.id === tracked.draftId);
      if (!live || !isDecidableDraft(live) || tracked.pairedKey !== channel.pairedKey() || tracked.fingerprint !== reviewFingerprint(snapshot, live)) {
        pendingByChannel.delete(channel.id);
        persistDecisionPushStore();
      } else if (!tracked.deferred) {
        continue;
      } else if (quiet) {
        continue;
      } else {
        await sendPush(channel, live, snapshot);
        continue;
      }
    }
    const next = oldestDecidable(snapshot);
    if (!next) continue;
    const fingerprint = reviewFingerprint(snapshot, next);
    const delivered = decisionPushReceipts.find(
      (row) =>
        row.channel === channel.id
        && row.draftId === next.id
        && row.fingerprint === fingerprint
        && row.pairedKey === channel.pairedKey(),
    );
    if (delivered) {
      // Already shown on this channel for this wording — restore memory, do not re-send.
      pendingByChannel.set(channel.id, {
        draftId: delivered.draftId,
        decisionId: delivered.decisionId,
        fingerprint: delivered.fingerprint,
        pairedKey: delivered.pairedKey,
        deferred: false,
        previewOnly: false,
      });
      persistDecisionPushStore();
      continue;
    }
    if (quiet) {
      pendingByChannel.set(channel.id, { draftId: next.id, decisionId: randomBytes(6).toString("hex"), fingerprint, pairedKey: channel.pairedKey()!, deferred: true, previewOnly: false });
      persistDecisionPushStore();
      continue;
    }
    await sendPush(channel, next, snapshot);
  }
}

async function sendPush(channel: RemoteChannelAdapter, draft: Draft, snapshot: DeskSnapshot): Promise<void> {
  const owner = bound;
  const pairedKey = channel.pairedKey();
  if (!owner || !pairedKey) return;
  const fingerprint = reviewFingerprint(snapshot, draft);
  const prior = pendingByChannel.get(channel.id);
  const decisionId = prior?.fingerprint === fingerprint && prior.pairedKey === pairedKey ? prior.decisionId : randomBytes(6).toString("hex");
  const text = reviewText(snapshot, draft, decisionId);
  const pending: ChannelPending = { draftId: draft.id, decisionId, fingerprint, pairedKey, deferred: true, previewOnly: text === null };
  pendingByChannel.set(channel.id, pending);
  persistDecisionPushStore();
  try {
    if (text !== null) await channel.sendDecision(text, decisionId);
    else if (channel.sendDigest) await channel.sendDigest(`${decisionPushText(addressFor(snapshot, draft.propertyId), draft.kind)}\n\nThe full wording is too long for this review card. Open its draft on Desk to review before deciding.`);
    else return;
    if (bound !== owner || channel.pairedKey() !== pairedKey || pendingByChannel.get(channel.id) !== pending) return;
    const latest = owner.desk.snapshot();
    const live = latest.drafts.find(item => item.id === draft.id);
    if (latest.recovery.active || !live || !isDecidableDraft(live) || reviewFingerprint(latest, live) !== fingerprint) {
      pendingByChannel.delete(channel.id); persistDecisionPushStore(); pushRequested = true; return;
    }
    pending.deferred = false;
    recordDecisionPushReceipt({ channel: channel.id, draftId: draft.id, fingerprint, decisionId, pairedKey, at: nowMs() });
    persistDecisionPushStore();
  } catch {
    // Retain the same card identity for a later delivery attempt. It is not
    // actionable until delivery is confirmed, and cannot approve another card.
    console.warn(`[remote-decisions] ${channel.id} review card delivery was not confirmed.`);
  }
}

function recordDecisionPushReceipt(row: DecisionPushReceipt): void {
  const idx = decisionPushReceipts.findIndex(
    (item) => item.channel === row.channel && item.draftId === row.draftId && item.pairedKey === row.pairedKey,
  );
  if (idx >= 0) decisionPushReceipts.splice(idx, 1);
  decisionPushReceipts.push(row);
  if (decisionPushReceipts.length > DECISION_PUSH_MAX) {
    decisionPushReceipts.splice(0, decisionPushReceipts.length - DECISION_PUSH_MAX);
  }
}

function clearDecisionPushReceipt(channel: RemoteChannelId, draftId: string): void {
  for (let i = decisionPushReceipts.length - 1; i >= 0; i--) {
    if (decisionPushReceipts[i]!.channel === channel && decisionPushReceipts[i]!.draftId === draftId) {
      decisionPushReceipts.splice(i, 1);
    }
  }
  persistDecisionPushStore();
}

function pruneDecisionPushReceipts(snapshot: DeskSnapshot): void {
  let changed = false;
  for (let i = decisionPushReceipts.length - 1; i >= 0; i--) {
    const row = decisionPushReceipts[i]!;
    const live = snapshot.drafts.find((item) => item.id === row.draftId);
    if (!live || !isDecidableDraft(live)) {
      decisionPushReceipts.splice(i, 1);
      changed = true;
    }
  }
  if (changed) persistDecisionPushStore();
}

function persistDecisionPushStore(): void {
  const dir = digestStoreDir();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const pending = [...pendingByChannel.entries()].map(([channel, row]) => ({ channel, ...row }));
  writeFileAtomic(join(dir, "decision-push-pending.json"), JSON.stringify(pending));
  writeFileAtomic(join(dir, "decision-push-receipts.json"), JSON.stringify(decisionPushReceipts));
}

function loadDecisionPushStore(): void {
  decisionPushReceipts.length = 0;
  pendingByChannel.clear();
  const dir = digestStoreDir();
  if (!dir) return;
  const receiptsPath = join(dir, "decision-push-receipts.json");
  const pendingPath = join(dir, "decision-push-pending.json");
  if (existsSync(receiptsPath)) {
    try {
      const raw = JSON.parse(readFileSync(receiptsPath, "utf8")) as unknown;
      if (Array.isArray(raw)) {
        for (const row of raw) {
          if (!row || typeof row !== "object") continue;
          const channel = (row as { channel?: unknown }).channel;
          const draftId = (row as { draftId?: unknown }).draftId;
          const fingerprint = (row as { fingerprint?: unknown }).fingerprint;
          const decisionId = (row as { decisionId?: unknown }).decisionId;
          const pairedKey = (row as { pairedKey?: unknown }).pairedKey;
          const at = (row as { at?: unknown }).at;
          if (
            (channel === "telegram" || channel === "discord" || channel === "slack")
            && typeof draftId === "string" && draftId
            && typeof fingerprint === "string" && fingerprint
            && typeof decisionId === "string" && decisionId
            && typeof pairedKey === "string" && pairedKey
            && typeof at === "number"
          ) {
            decisionPushReceipts.push({ channel, draftId, fingerprint, decisionId, pairedKey, at });
          }
        }
      }
    } catch {
      /* corrupt receipts must not block Desk */
    }
  }
  if (existsSync(pendingPath)) {
    try {
      const raw = JSON.parse(readFileSync(pendingPath, "utf8")) as unknown;
      if (Array.isArray(raw)) {
        for (const row of raw) {
          if (!row || typeof row !== "object") continue;
          const channel = (row as { channel?: unknown }).channel;
          const draftId = (row as { draftId?: unknown }).draftId;
          const fingerprint = (row as { fingerprint?: unknown }).fingerprint;
          const decisionId = (row as { decisionId?: unknown }).decisionId;
          const pairedKey = (row as { pairedKey?: unknown }).pairedKey;
          const deferred = Boolean((row as { deferred?: unknown }).deferred);
          const previewOnly = Boolean((row as { previewOnly?: unknown }).previewOnly);
          if (
            (channel === "telegram" || channel === "discord" || channel === "slack")
            && typeof draftId === "string" && draftId
            && typeof fingerprint === "string" && fingerprint
            && typeof decisionId === "string" && decisionId
            && typeof pairedKey === "string" && pairedKey
          ) {
            pendingByChannel.set(channel, { draftId, decisionId, fingerprint, pairedKey, deferred, previewOnly });
          }
        }
      }
    } catch {
      /* corrupt pending must not block Desk */
    }
  }
}
