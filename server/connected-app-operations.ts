// RealBud's dispatch receipts contain identifiers, fixed status text and, for a
// card answered from a paired phone, who answered it and where. Tool arguments,
// provider results, account details and credentials stay out.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { assertOwnPrivate, mkdirPrivateSync, openPrivateFileSync, restrictNewSync, writeFileAtomic } from "./atomic.ts";
import { windowsFilePrivacySync } from "./windows-file-privacy.ts";
import { DATA_DIR } from "./config.ts";
import { opaqueDigest } from "../shared/connected-app-binding.ts";
import { MAIL_SENDS } from "../shared/app-tool-policy.ts";

export type ConnectedAppOperationStatus = "started" | "succeeded" | "failed" | "unknown" | "denied";
export interface ConnectedAppOperation {
  id: string;
  threadId: string;
  toolName: string;
  toolSlugs: string[];
  status: ConnectedAppOperationStatus;
  startedAt: number;
  finishedAt?: number;
  detail: string;
  /** Who answered the card when it was not this computer, e.g. "Allowed once by Sam via Telegram · 2:16 pm". */
  approval?: string;
  /** Opaque reviewed identities only. No account labels or mail content. */
  accountDigest?: string;
  realmDigest?: string;
  bindingDigest?: string;
  effectDigest?: string;
  reviewDigest?: string;
  workspaceDigest?: string;
  repeatOf?: string;
  revision?: number;
  reconciliation?: { outcome: "sent" | "not-sent"; at: number; source: "manual-app-inspection"; recoveryBindingDigest: string };
  /** Owner checked an unconfirmed outcome that has no saved account identity
   * (older history or an older gateway). Releases the hold; proves nothing. */
  acknowledgement?: { at: number; source: "owner-checked-app" };
}
type OperationInput = Pick<ConnectedAppOperation, "threadId" | "toolName" | "toolSlugs" | "approval" | "accountDigest" | "realmDigest" | "bindingDigest" | "effectDigest" | "reviewDigest" | "workspaceDigest" | "repeatOf">;
const MAX_OPERATIONS = 1_000;
const MAX_BYTES = 2 * 1024 * 1024;
const DETAILS = {
  started: "The app operation was recorded before dispatch. Its outcome is not yet confirmed.",
  succeeded: "The app service returned a successful operation result.",
  failed: "The app service reported an operation failure. Review its result before retrying.",
  unknown: "The app outcome is unknown. Check the app before trying this action again; RealBud has not replayed it.",
  denied: "The app operation was not approved or was stopped before dispatch.",
  partial: "Some app operations failed; others may have succeeded. Check the app before retrying.",
} as const;
const RECOVERY = "Connected-app history needs recovery. App actions are paused. Check disk space and file access, then restore the saved history if needed and restart RealBud.";
const LOCK_BUSY = "Connected-app history is being updated by another RealBud process. Nothing new was sent. Try again in a moment.";
/** An unreadable lock this old cannot belong to a live writer, which records its
 * owner immediately after creating the file, before any other step. */
const LOCK_GRACE_MS = 5_000;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const sendsMail = (row: Pick<ConnectedAppOperation, "toolName" | "toolSlugs">) => MAIL_SENDS.has(row.toolName) || row.toolSlugs.some(slug => MAIL_SENDS.has(slug));
/** A mail send with no saved account identity whose outcome nobody has checked.
 * A provider-reported failure is terminal and an in-flight start settles itself;
 * restart turns an interrupted start into unknown. */
export const heldWithoutIdentity = (row: ConnectedAppOperation): boolean => !row.effectDigest && row.status === "unknown" && !row.acknowledgement;
const legacyHeld = (id: string) => `An earlier mail action has an unconfirmed outcome and no saved account details (operation ${id}). Check that mailbox's sent mail, then the office owner marks it checked in Connected apps. Nothing new was sent.`;
export const validAppToolName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,149}$/.test(value);
export const validAppToolSlug = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,149}$/.test(value);
const validThread = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const validApproval = (value: unknown): boolean => value === undefined || (typeof value === "string" && /^[^\r\n]{1,300}$/.test(value));
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const clone = (row: ConnectedAppOperation): ConnectedAppOperation => ({ ...row, toolSlugs: [...row.toolSlugs], ...(row.reconciliation ? { reconciliation: { ...row.reconciliation } } : {}),
  ...(row.acknowledgement ? { acknowledgement: { ...row.acknowledgement } } : {}) });
const failure = () => Object.assign(new Error(RECOVERY), { status: 503 });
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const identities = (row: { realmDigest?: unknown; accountDigest?: unknown; bindingDigest?: unknown; effectDigest?: unknown; reviewDigest?: unknown; workspaceDigest?: unknown }) => {
  const fields = [row.accountDigest, row.bindingDigest, row.effectDigest, row.reviewDigest, row.workspaceDigest];
  return (fields.every(value => value === undefined) && row.realmDigest === undefined) || (fields.every(opaqueDigest) && (row.realmDigest === undefined || opaqueDigest(row.realmDigest)));
};
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
function privateDirectory(path: string): void {
  mkdirPrivateSync(path, 0o700);
  const stat = lstatSync(path); assertOwnPrivate(stat, "directory");
  if (process.platform !== "win32" && (stat.mode & 0o077)) throw failure();
  windowsFilePrivacySync(path, "directory");
}
function privateSnapshot(path: string, limit: number): unknown | undefined {
  let descriptor: number;
  try { descriptor = openPrivateFileSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined; throw error; }
  try {
    const stat = fstatSync(descriptor);
    if (stat.size > limit || (process.platform !== "win32" && (stat.mode & 0o077))) throw failure();
    windowsFilePrivacySync(path, "file");
    const chunks: Buffer[] = []; let bytes = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64_000, limit + 1 - bytes));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (!count) break; bytes += count;
      if (bytes > limit) throw failure(); chunks.push(chunk.subarray(0, count));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { closeSync(descriptor); }
}

function validateOperationSnapshot(rows: unknown[]): ConnectedAppOperation[] {
  const ids = new Set<string>();
  return rows.map((row: unknown) => {
        if (!record(row) || !uuid(row.id) || ids.has(row.id) ||
          !validThread(row.threadId) || !validAppToolName(row.toolName) || !Array.isArray(row.toolSlugs) ||
          row.toolSlugs.length > 50 || !row.toolSlugs.every(validAppToolSlug) || !timestamp(row.startedAt) ||
          typeof row.status !== "string" || !["started", "succeeded", "failed", "unknown", "denied"].includes(row.status) ||
          (row.status === "started" ? row.finishedAt !== undefined : !timestamp(row.finishedAt)) ||
          (row.finishedAt !== undefined && Number(row.finishedAt) < row.startedAt) ||
          (row.detail !== DETAILS[row.status as ConnectedAppOperationStatus] && !(row.status === "failed" && row.detail === DETAILS.partial)) || !validApproval(row.approval) ||
          !identities(row) || (row.repeatOf !== undefined && (!uuid(row.repeatOf) || !row.effectDigest)) ||
          (row.revision !== undefined && (!Number.isSafeInteger(row.revision) || Number(row.revision) < 0)) ||
          (row.reconciliation !== undefined && (!record(row.reconciliation) || !["sent", "not-sent"].includes(String(row.reconciliation.outcome)) ||
            !timestamp(row.reconciliation.at) || row.reconciliation.at < row.startedAt || row.reconciliation.source !== "manual-app-inspection" ||
            !opaqueDigest(row.reconciliation.recoveryBindingDigest) || Object.keys(row.reconciliation).some(key => !["outcome", "at", "source", "recoveryBindingDigest"].includes(key)) || !row.effectDigest || !["unknown", "failed"].includes(row.status))) ||
          (row.acknowledgement !== undefined && (!record(row.acknowledgement) || Object.keys(row.acknowledgement).sort().join(",") !== "at,source" || row.acknowledgement.source !== "owner-checked-app" ||
            !timestamp(row.acknowledgement.at) || row.acknowledgement.at < row.startedAt ||
            (row.effectDigest === undefined ? row.status !== "unknown" : !row.realmDigest || !["unknown", "failed"].includes(row.status)))) ||
          Object.keys(row).some(key => !["id", "threadId", "toolName", "toolSlugs", "status", "startedAt", "finishedAt", "detail", "approval", "accountDigest", "realmDigest", "bindingDigest", "effectDigest", "reviewDigest", "workspaceDigest", "repeatOf", "revision", "reconciliation", "acknowledgement"].includes(key))) throw failure();
        ids.add(row.id);
        return clone(row as unknown as ConnectedAppOperation);
  });
}

/** Pure admission shared by live history and portable backup; no store/key opens. */
export const CONNECTED_MAIL_OPERATIONS_FILE = 'connected-app-operations.json';
export function validateConnectedAppOperationsSnapshot(value: unknown): { version: 1; operations: ConnectedAppOperation[] } {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'operations,version' || value.version !== 1 || !Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw failure();
  return { version: 1, operations: validateOperationSnapshot(value.operations) };
}
/** Restore cannot infer provider failure from an interrupted dispatch. */
export function interruptConnectedAppOperationsForRestore(value: unknown, at: number) {
  if (!timestamp(at)) throw failure();
  const saved = validateConnectedAppOperationsSnapshot(value);
  return { version: 1, operations: saved.operations.map(row => row.status === 'started' ? { ...row, status: 'unknown' as const, revision: (row.revision ?? 0) + 1,
    finishedAt: Math.max(row.startedAt, at), detail: DETAILS.unknown } : row) };
}

/** A process that exists but is not ours (EPERM) cannot own a lock inside this
 * account's private folder, so its pid was reused. */
function processGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { const code = (error as NodeJS.ErrnoException)?.code; return code === "ESRCH" || code === "EPERM"; }
}
function staleOwner(text: string, stat: Stats): boolean {
  let owner: unknown;
  try { owner = JSON.parse(text); } catch { owner = undefined; }
  if (!record(owner) || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || typeof owner.bootUptime !== "number" || !Number.isFinite(owner.bootUptime) || owner.bootUptime < 0)
    return Date.now() - stat.mtimeMs > LOCK_GRACE_MS;
  // Every section is synchronous and never nested, so a lock naming this
  // process is left over; uptime smaller than at creation means a reboot since.
  return owner.pid === process.pid || owner.bootUptime > uptime() + 1 || processGone(Number(owner.pid));
}
function acquireLock(lock: string): number {
  for (let attempt = 0; ; attempt++) {
    try { return openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw failure();
      const verdict = attempt === 0 ? reclaimStaleLock(lock) : "busy";
      if (verdict === "unsafe") throw failure();
      if (verdict === "busy") throw conflict(LOCK_BUSY);
    }
  }
}
/** Moves aside exactly the stale lock it inspected; a lock created in between
 * is put back and treated as busy. */
function reclaimStaleLock(lock: string): "reclaimed" | "busy" | "unsafe" {
  let seen: Stats, text = "";
  try {
    const descriptor = openPrivateFileSync(lock);
    try {
      seen = fstatSync(descriptor); // openPrivateFileSync admitted one plain file owned by this account
      if (seen.size <= 4_096) { const bytes = Buffer.alloc(seen.size); text = bytes.subarray(0, readSync(descriptor, bytes, 0, bytes.length, 0)).toString("utf8"); }
    } finally { closeSync(descriptor); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" ? "reclaimed" : code === "EUNSAFE" || code === "ELOOP" ? "unsafe" : "busy";
  }
  if (!staleOwner(text, seen)) return "busy";
  const aside = `${lock}.stale-${randomUUID()}`;
  try { renameSync(lock, aside); } catch (error) { return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "reclaimed" : "busy"; }
  let moved: Stats | undefined;
  try { moved = lstatSync(aside); } catch { /* removed by its owner */ }
  if (moved && (moved.ino !== seen.ino || moved.dev !== seen.dev)) {
    try { linkSync(aside, lock); } catch { /* a newer owner already holds the name */ }
    try { unlinkSync(aside); } catch { /* best effort */ }
    return "busy";
  }
  try { unlinkSync(aside); } catch { /* best effort */ }
  return "reclaimed";
}
/** Removes the lock only while the name is still this descriptor's file. */
function releaseLock(lock: string, descriptor: number): void {
  let ours = false;
  try { const mine = fstatSync(descriptor), named = lstatSync(lock); ours = mine.ino === named.ino && mine.dev === named.dev; } catch { /* already gone */ }
  closeSync(descriptor);
  if (ours) try { unlinkSync(lock); } catch { /* a left-over lock naming this process is reclaimed next time */ }
}

// Only the module's default singleton delays IO until startup migration and
// restore have completed. Ordinary explicit stores remain eager.
const DEFER_DEFAULT_SINGLETON = Symbol('connected-app-startup');

export class ConnectedAppOperationStore {
  private rows: ConnectedAppOperation[] = [];
  private held = false;
  private initialized = false;
  private readonly file: string;
  private readonly now: () => number;
  private readonly workspaceIdOverride?: string;
  private readonly workspaceFile: string;
  /** Host-only injection for isolated tests; production reads persisted
   * workspace identity, which stays stable when its backup moves paths. */
  constructor(options: { file?: string; now?: () => number; workspaceId?: string } = {}, startup?: typeof DEFER_DEFAULT_SINGLETON) {
    this.file = options.file ?? join(DATA_DIR, "connected-app-operations.json");
    if (options.workspaceId !== undefined && !uuid(options.workspaceId)) throw failure();
    this.workspaceIdOverride = options.workspaceId;
    this.workspaceFile = join(dirname(this.file), 'company-installation', 'workspace.json');
    this.now = options.now ?? Date.now;
    if (startup !== DEFER_DEFAULT_SINGLETON) this.initialize();
  }
  private initialize(): void {
    if (this.initialized) return;
    // Recovery calls locked(), which re-enters assertAvailable(). Admit once
    // before that recursion; a failure stays held for this store's lifetime.
    this.initialized = true;
    try {
      privateDirectory(dirname(this.file));
      const saved = privateSnapshot(this.file, MAX_BYTES);
      if (saved === undefined) return;
      if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.operations) || saved.operations.length > MAX_OPERATIONS) throw failure();
      this.rows = validateOperationSnapshot(saved.operations);
      if (this.rows.some(row => row.status === "started")) {
        this.locked(() => this.commit(this.rows.map(row => row.status === "started"
          ? { ...row, status: "unknown", revision: (row.revision ?? 0) + 1, finishedAt: Math.max(row.startedAt, this.now()), detail: DETAILS.unknown } : row)));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") this.held = true;
    }
  }
  get workspaceDigest(): string {
    this.assertAvailable();
    let workspaceId = this.workspaceIdOverride;
    if (!workspaceId) {
      privateDirectory(dirname(this.workspaceFile));
      const saved = privateSnapshot(this.workspaceFile, 64_000);
      if (!record(saved) || saved.version !== 1 || !uuid(saved.id) || Object.keys(saved).sort().join(",") !== "id,version,workerMemberKey" ||
        !(saved.workerMemberKey === null || (typeof saved.workerMemberKey === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(saved.workerMemberKey)))) throw failure();
      workspaceId = saved.id;
    }
    return createHash("sha256").update(workspaceId).digest("hex");
  }

  list(threadId?: string): ConnectedAppOperation[] {
    this.assertAvailable(); this.reload();
    return this.rows.filter(row => threadId === undefined || row.threadId === threadId)
      .sort((a, b) => b.startedAt - a.startedAt).map(clone);
  }

  start(input: OperationInput): ConnectedAppOperation { return this.add(input, "started"); }
  deny(input: OperationInput): ConnectedAppOperation { return this.add(input, "denied"); }

  finish(id: string, status: Exclude<ConnectedAppOperationStatus, "started" | "denied">, partial = false): ConnectedAppOperation {
    return this.locked(() => this.finishLocked(id, status, partial));
  }
  /** Only for a locally cancelled request or the gateway's documented
   * pre-adapter session refusal, never a timeout or arbitrary HTTP error. */
  cancelBeforeDispatch(id: string): ConnectedAppOperation {
    return this.locked(() => {
      const row = this.rows.find(item => item.id === id);
      if (!row) throw Object.assign(new Error("No such app operation."), { status: 404 });
      if (row.status !== "started") return clone(row);
      const next: ConnectedAppOperation = { ...row, status: "denied", revision: (row.revision ?? 0) + 1, finishedAt: Math.max(row.startedAt, this.now()), detail: DETAILS.denied };
      this.commit(this.rows.map(item => item.id === id ? next : item)); return clone(next);
    });
  }
  private finishLocked(id: string, status: Exclude<ConnectedAppOperationStatus, "started" | "denied">, partial: boolean): ConnectedAppOperation {
    this.assertAvailable();
    const existing = this.rows.find(row => row.id === id);
    if (!existing) throw Object.assign(new Error("No such app operation."), { status: 404 });
    if (existing.status !== "started") return clone(existing);
    const next = { ...existing, status, revision: (existing.revision ?? 0) + 1, finishedAt: Math.max(existing.startedAt, this.now()), detail: partial && status === "failed" ? DETAILS.partial : DETAILS[status] };
    this.commit(this.rows.map(row => row.id === id ? next : row));
    return clone(next);
  }

  /** A fresh person/card may approve an intentional repeat of known success;
   * it cannot make an uncertain operation safe to replay. */
  priorMailEffect(effectDigest: string, realmDigest?: string): ConnectedAppOperation | undefined {
    this.assertAvailable(); this.reload();
    if (this.rows.some(row => row.effectDigest && row.status !== "denied" && row.workspaceDigest !== this.workspaceDigest))
      throw conflict("Connected-app receipts belong to another private workspace. Restore the matching workspace identity and history before sending mail. Nothing new was sent.");
    this.holdLegacyMail();
    const rows = this.rows.filter(row => row.effectDigest === effectDigest && row.status !== "denied");
    // The effect digest already binds account, company and gateway origin, so a
    // receipt from another realm can never match it. Only this exact message's
    // own receipts must carry the same realm evidence; a gateway or company move
    // leaves older receipts in history without holding unrelated new mail.
    if (rows.some(row => !row.realmDigest || (realmDigest !== undefined && row.realmDigest !== realmDigest)))
      throw conflict('This exact message has a receipt without matching company and connection details. Check it in the mail app and restore the original history before sending it again. Nothing new was sent.');
    const unresolved = rows.find(row => row.status === "started" || ((row.status === "unknown" || row.status === "failed") && !row.reconciliation));
    if (unresolved) throw conflict(`This exact reviewed message already has an unresolved outcome (operation ${unresolved.id}). Inspect that account in the mail app and record its outcome in Connected apps before trying again. Nothing new was sent.`);
    return rows.reverse().find(row => row.status === "succeeded" || row.reconciliation?.outcome === "sent");
  }
  /** An unresolved receipt for this exact message saved under an earlier
   * company or managed gateway. The effect digest binds the realm, so the
   * caller recomputes this message's effect under each such receipt's own saved
   * account identity (`effectFor`); a match is the same recipients, subject,
   * body and attachments. It does not hold: the send card warns. */
  earlierRealmMailEffect(realmDigest: string, effectFor: (accountDigest: string) => string): ConnectedAppOperation | undefined {
    this.assertAvailable(); this.reload();
    const workspaceDigest = this.workspaceDigest;
    const row = this.rows.find(item => item.effectDigest && item.accountDigest && item.realmDigest && item.realmDigest !== realmDigest && item.workspaceDigest === workspaceDigest &&
      (item.status === "started" || ((item.status === "unknown" || item.status === "failed") && !item.reconciliation && !item.acknowledgement)) &&
      effectFor(item.accountDigest) === item.effectDigest);
    return row && clone(row);
  }
  /** Older history and older gateways leave mail receipts without an account
   * identity; any such unconfirmed send holds new mail until the owner checks it. */
  assertNoHeldLegacyMail(): void { this.assertAvailable(); this.reload(); this.holdLegacyMail(); }
  private holdLegacyMail(): void {
    const held = this.rows.find(row => heldWithoutIdentity(row) && sendsMail(row));
    if (held) throw conflict(legacyHeld(held.id));
  }

  /** Owner-only GUI step: the owner checked the app. It never changes the
   * recorded provider outcome. For a receipt with no account identity it is the
   * only release. An identified receipt qualifies only while its company and
   * managed gateway (realm) are none of `currentRealms`, the realms the caller
   * just read from the current connection: such a receipt can no longer be
   * checked against its original connection. In its own realm, Inspect and
   * record mail outcome is the only path. */
  acknowledge(id: string, expectedRevision: number, currentRealms?: readonly string[]): ConnectedAppOperation {
    return this.locked(() => {
      const row = this.rows.find(item => item.id === id);
      if (!row) throw Object.assign(new Error("No such app operation."), { status: 404 });
      if (row.effectDigest) {
        if (!row.realmDigest || !Array.isArray(currentRealms) || !currentRealms.length || !currentRealms.every(opaqueDigest) || currentRealms.includes(row.realmDigest) || row.workspaceDigest !== this.workspaceDigest)
          throw conflict("This receipt has saved account details. Use Inspect and record mail outcome instead.");
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw conflict("Invalid recovery decision.");
      if (row.acknowledgement && (row.revision ?? 0) === expectedRevision + 1) return clone(row);
      if (!(row.status === "unknown" || (row.effectDigest && row.status === "failed")) || row.reconciliation || row.acknowledgement || (row.revision ?? 0) !== expectedRevision)
        throw conflict("This app operation changed. Refresh recent activity before marking it checked.");
      const next: ConnectedAppOperation = { ...row, revision: expectedRevision + 1, acknowledgement: { at: Math.max(row.startedAt, this.now()), source: "owner-checked-app" } };
      this.commit(this.rows.map(item => item.id === id ? next : item)); return clone(next);
    });
  }

  reconcile(id: string, expectedRevision: number, outcome: "sent" | "not-sent", binding: { accountDigest: string; realmDigest: string; originalBindingDigest: string; recoveryBindingDigest: string; workspaceDigest: string }): ConnectedAppOperation {
    return this.locked(() => {
      const row = this.rows.find(item => item.id === id);
      if (!row) throw Object.assign(new Error("No such app operation."), { status: 404 });
      if (!opaqueDigest(binding.accountDigest) || !opaqueDigest(binding.realmDigest) || row.realmDigest !== binding.realmDigest || !opaqueDigest(binding.originalBindingDigest) || !opaqueDigest(binding.recoveryBindingDigest) || row.accountDigest !== binding.accountDigest || row.bindingDigest !== binding.originalBindingDigest || !row.effectDigest ||
        row.workspaceDigest !== this.workspaceDigest || binding.workspaceDigest !== this.workspaceDigest)
        throw conflict("The original verified mail account or connection changed. This outcome remains held; recover that exact connection before recording its outcome.");
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !["sent", "not-sent"].includes(outcome)) throw conflict("Invalid recovery decision.");
      if (row.reconciliation && row.reconciliation.outcome === outcome && row.reconciliation.recoveryBindingDigest === binding.recoveryBindingDigest && (row.revision ?? 0) === expectedRevision + 1) return clone(row);
      if ((row.revision ?? 0) !== expectedRevision || row.reconciliation || !["unknown", "failed"].includes(row.status)) throw conflict("This app operation changed. Refresh its receipt before recording an outcome.");
      const next: ConnectedAppOperation = { ...row, revision: expectedRevision + 1, reconciliation: { outcome, at: Math.max(row.startedAt, this.now()), source: "manual-app-inspection", recoveryBindingDigest: binding.recoveryBindingDigest } };
      this.commit(this.rows.map(item => item.id === id ? next : item)); return clone(next);
    });
  }

  private add(input: OperationInput, status: "started" | "denied"): ConnectedAppOperation {
    return this.locked(() => this.addLocked(input, status));
  }
  private addLocked(input: OperationInput, status: "started" | "denied"): ConnectedAppOperation {
    this.assertAvailable();
    if (!validThread(input.threadId) || !validAppToolName(input.toolName) || !Array.isArray(input.toolSlugs) ||
      input.toolSlugs.length > 50 || !input.toolSlugs.every(validAppToolSlug) || !validApproval(input.approval) || !identities(input) ||
      (input.repeatOf !== undefined && (!uuid(input.repeatOf) || !input.effectDigest)) || (input.effectDigest && (!opaqueDigest(input.realmDigest) || input.workspaceDigest !== this.workspaceDigest))) throw Object.assign(new Error("Invalid app operation identifiers."), { status: 400 });
    if (status === "started" && input.effectDigest) {
      const prior = this.priorMailEffect(input.effectDigest, input.realmDigest);
      if (prior ? input.repeatOf !== prior.id : input.repeatOf !== undefined) throw conflict("Sending this exact message again requires a separate intentional-repeat approval for its current receipt.");
    } else if (status === "started" && sendsMail(input)) this.holdLegacyMail();
    const now = this.now();
    const row: ConnectedAppOperation = { id: randomUUID(), threadId: input.threadId, toolName: input.toolName,
      toolSlugs: [...new Set(input.toolSlugs)], status, startedAt: now,
      ...(status === "denied" ? { finishedAt: now } : {}), detail: DETAILS[status], ...(input.approval ? { approval: input.approval } : {}),
      ...(input.effectDigest ? { accountDigest: input.accountDigest, realmDigest: input.realmDigest, bindingDigest: input.bindingDigest, effectDigest: input.effectDigest, reviewDigest: input.reviewDigest, workspaceDigest: input.workspaceDigest, revision: 0 } : {}),
      ...(input.repeatOf ? { repeatOf: input.repeatOf } : {}) };
    // Unresolved outcomes cannot disappear when routine successful reads churn.
    const next = [...this.rows];
    if (next.length >= MAX_OPERATIONS) {
      const evict = next.findIndex(item => item.status !== "started" && (item.status !== "unknown" || item.acknowledgement) && !item.effectDigest);
      if (evict < 0) throw Object.assign(new Error("Retained mail history reached its safety limit. Export/recover the retained history with service support before further app actions; no identified or uncertain outcomes were discarded."), { status: 503 });
      next.splice(evict, 1);
    }
    this.commit([...next, row]);
    return clone(row);
  }

  private assertAvailable(): void { this.initialize(); if (this.held) throw failure(); }
  private reload(): void {
    // Atomic rename gives readers one complete generation. Reopening an
    // already-running store does not turn another instance's live start into a
    // replayable failure; every mutation reads the current disk generation.
    try {
      const saved = privateSnapshot(this.file, MAX_BYTES);
      if (saved === undefined) { if (this.rows.length) throw failure(); return; }
      if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.operations) || saved.operations.length > MAX_OPERATIONS) throw failure();
      this.rows = validateOperationSnapshot(saved.operations);
    } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || this.rows.length) { this.held = true; throw failure(); } }
  }
  /** Cross-process exclusion only: every section below is synchronous, so two
   * stores in one process never interleave. The lock names its owner (pid and
   * OS uptime at creation); a crash leaves a lock whose process is gone or
   * belongs to an earlier boot, and the next writer reclaims it. Reclaiming
   * never settles an outcome: an interrupted start still becomes unknown. */
  private locked<T>(action: () => T): T {
    this.assertAvailable();
    privateDirectory(dirname(this.file));
    const lock = `${this.file}.lock`, descriptor = acquireLock(lock);
    try {
      // Name the owner before anything slow: an empty lock older than
      // LOCK_GRACE_MS is reclaimable, and the Windows ACL step can take seconds.
      writeSync(descriptor, JSON.stringify({ version: 1, pid: process.pid, bootUptime: uptime() })); fsyncSync(descriptor);
      restrictNewSync([{ path: lock, kind: "file" }]);
      this.reload(); return action();
    } finally { releaseLock(lock, descriptor); }
  }
  private commit(next: ConnectedAppOperation[]): void {
    const body = JSON.stringify({ version: 1, operations: next });
    try {
      if (Buffer.byteLength(body) > MAX_BYTES) throw failure();
      privateDirectory(dirname(this.file));
      writeFileAtomic(this.file, body, 0o600);
      this.rows = next;
    } catch {
      // A rename may have succeeded before fsync failed. Either way no new
      // dispatch is authorized; disk is authoritative again only on restart.
      this.held = true;
      throw failure();
    }
  }
}

export const connectedAppOperations = new ConnectedAppOperationStore({}, DEFER_DEFAULT_SINGLETON);
export const listConnectedAppOperations = (threadId?: string): ConnectedAppOperation[] => connectedAppOperations.list(threadId);
