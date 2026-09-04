// Remote Desk decisions over a paired channel. One pending card per
// channel; the in-memory push map is empty on boot and rebuilds from the
// next commitDesk snapshot. Licensee / escalation rows never travel as
// buttons. Quiet hours follow the book's timezone, not the machine's.
// Digest queue + receipts survive restart when bind.storeDir is set.
import { createHash } from "node:crypto";
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
const BOOK_MOVED = "the book moved — open Desk to review";
const LICENSEE_REFUSAL = "that card needs the licensee — open Desk when you're at a screen";
const ELSEWHERE = "This Bud is paired elsewhere.";
const FLUSH_MS = 60_000;
const PUSH_MAX = 500;

type ChannelPending = { draftId: string; deferred: boolean };

let bound: RemoteDecisionsBind | null = null;
// Pushed-but-undecided draft ids. Lost on process start — the next
// notifyDeskSnapshot rebuilds from the live snapshot.
const pendingByChannel = new Map<RemoteChannelId, ChannelPending>();
const deferredDigests: Array<{ text: string; timeZone: string }> = [];
type DigestReceipt = { channel: RemoteChannelId; hash: string; at: number };
const digestReceipts: DigestReceipt[] = [];
const RECEIPT_MAX = 200;
let flushTimer: ReturnType<typeof setInterval> | null = null;

export function bindRemoteDecisions(opts: RemoteDecisionsBind): void {
  bound = opts;
  loadDigestStore();
}

export function resetRemoteDecisions(): void {
  stopRemoteDecisionFlush();
  pendingByChannel.clear();
  deferredDigests.length = 0;
  digestReceipts.length = 0;
  bound = null;
}

export function pendingDraftId(channel: RemoteChannelId): string | null {
  const row = pendingByChannel.get(channel);
  return row && !row.deferred ? row.draftId : null;
}

export function isDecidableDraft(draft: Draft): boolean {
  return draft.status === "pending" && DECIDABLE.has(draft.kind);
}

export function isQuietHours(now: number, timeZone: string): boolean {
  const minutes = localMinutes(now, timeZone);
  return minutes < 7 * 60 + 1 || minutes >= 18 * 60;
}

export function parseRemoteDecisionText(text: string): { decision: "allow" | "deny"; reason?: string } | null {
  const trimmed = text.trim();
  if (/^(yes|y|allow)$/i.test(trimmed)) return { decision: "allow" };
  const deny = trimmed.match(/^(no|n|deny)(?:\s*[-–—:]\s*(.+))?$/i);
  if (!deny) return null;
  const reason = deny[2]?.trim();
  return reason ? { decision: "deny", reason } : { decision: "deny" };
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

export function notifyDeskSnapshot(snapshot: DeskSnapshot): Promise<void> {
  if (!bound) return Promise.resolve();
  return pushFromSnapshot(snapshot).catch(() => {
    /* a channel miss must never fail a Desk write */
  });
}

export async function decideRemotely(
  channel: RemoteChannelId,
  chatKey: string,
  draftId: string,
  decision: "allow" | "deny",
  reason: string | undefined,
  byName: string,
): Promise<RemoteDecideResult> {
  if (!bound) return { ok: false, message: BOOK_MOVED };
  const adapter = bound.channels.find((item) => item.id === channel);
  if (!adapter || adapter.pairedKey() !== chatKey) return { ok: false, message: ELSEWHERE };

  const snapshot = bound.desk.snapshot();
  if (snapshot.escalations.some((item) => item.id === draftId)) {
    return { ok: false, message: LICENSEE_REFUSAL };
  }
  const draft = snapshot.drafts.find((item) => item.id === draftId);
  if (!draft || draft.status !== "pending") return { ok: false, message: BOOK_MOVED };
  if (!DECIDABLE.has(draft.kind)) return { ok: false, message: LICENSEE_REFUSAL };

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
  const nextSnap = bound.desk.snapshot();
  await Promise.resolve(bound.commit(nextSnap));
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

async function pushFromSnapshot(snapshot: DeskSnapshot): Promise<void> {
  if (!bound) return;
  const quiet = isQuietHours(nowMs(), snapshot.timezone || "Australia/Sydney");
  for (const channel of bound.channels) {
    if (!channel.pairedKey()) continue;
    const tracked = pendingByChannel.get(channel.id);
    if (tracked) {
      const live = snapshot.drafts.find((item) => item.id === tracked.draftId);
      if (!live || !isDecidableDraft(live)) {
        pendingByChannel.delete(channel.id);
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
    if (quiet) {
      pendingByChannel.set(channel.id, { draftId: next.id, deferred: true });
      continue;
    }
    await sendPush(channel, next, snapshot);
  }
}

async function sendPush(channel: RemoteChannelAdapter, draft: Draft, snapshot: DeskSnapshot): Promise<void> {
  try {
    await channel.sendDecision(decisionPushText(addressFor(snapshot, draft.propertyId), draft.kind), draft.id);
    pendingByChannel.set(channel.id, { draftId: draft.id, deferred: false });
  } catch {
    pendingByChannel.set(channel.id, { draftId: draft.id, deferred: true });
  }
}
