// One-off browser tasks from Ask. A request such as "Download this month's
// invoices from the strata portal" becomes a task card; pressing Start saves
// an explicit grant (sites, the selected browser, action classes, expiry and
// a step budget) before any browser work, and the turn mounts RealBud's
// browser with exactly that grant. A grant belongs to one Ask thread and one
// browser and ends with its turn. Stop, expiry, the step limit, sign-in or a
// restart end it for good; a task is never restarted from a saved grant.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";
import { redactSecretsInText } from "./redact.ts";
import { normalizeOrigin } from "./recipes.ts";
import { grantedBrowserTools, portalBrowserPolicy } from "./attended-run.ts";
import {
  BROWSER_ACTION_CLASSES,
  BROWSER_CONSEQUENTIAL_KINDS,
  BROWSER_CONSEQUENTIAL_POLICY,
  BROWSER_TASK_GRANT_PURPOSE,
  BROWSER_TASK_GRANT_VERSION,
  browserTaskSite,
  parseBrowserTaskGrant,
  type BrowserActionClass,
  type BrowserConsequentialKind,
  type BrowserTaskGrant,
} from "../shared/browser-task.ts";
import type { JobCapability, JobRunEvidence, JobRunEvidenceKind } from "../shared/contracts.ts";

export const ASK_TASK_MINUTES = 30;
export const ASK_TASK_BUDGET = 40;
/** A card older than this belongs to an earlier moment in the conversation. */
export const ASK_TASK_OFFER_MS = 60 * 60_000;

/** The Ask reply that carries the card. It stands alone where the card cannot show (a phone). */
export const BROWSER_TASK_OFFER =
  "I can do this now in your browser. Check what it covers, then press **Start this task** in Ask on this computer. Payments, signatures, messages and notices each still ask you first.";
export const BROWSER_TASK_UNAVAILABLE =
  "I couldn't prepare this browser task, so nothing was done in your browser. Check this computer's disk space, then ask again.";

export type BrowserTaskStatus = "proposed" | "declined" | "saved-as-job" | "active" | "finished" | "stopped" | "expired" | "budget" | "interrupted";
const STATUSES: readonly BrowserTaskStatus[] = ["proposed", "declined", "saved-as-job", "active", "finished", "stopped", "expired", "budget", "interrupted"];
export type BrowserTaskEnd = "finished" | "stopped" | "expired" | "budget" | "interrupted";
const SITE_SOURCES = ["request", "saved-job", "person", "none"] as const;
type SiteSource = (typeof SITE_SOURCES)[number];
const EVIDENCE_KINDS: readonly JobRunEvidenceKind[] = ["observation", "output", "approval", "action", "denied", "asked", "note"];

export interface BrowserTaskRecord {
  version: 1;
  purpose: "browser-task";
  id: string;
  threadId: string;
  /** The Ask reply the card belongs to. */
  messageId: string;
  request: string;
  sites: string[];
  siteSource: SiteSource;
  savedJob: { id: string; title: string } | null;
  actions: BrowserActionClass[];
  minutes: number;
  budget: number;
  status: BrowserTaskStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  endNote: string | null;
  /** Saved before the turn starts; never reused once the task ends. */
  grant: BrowserTaskGrant | null;
  /** The broker's decisions for this task (notes and hashes only). */
  evidence: JobRunEvidence[];
}

/** What the Ask card shows. The grant itself stays on the server. */
export interface BrowserTaskCardView {
  id: string;
  messageId: string;
  status: BrowserTaskStatus;
  request: string;
  sites: string[];
  siteSource: SiteSource;
  savedJob: string | null;
  actions: BrowserActionClass[];
  consequential: BrowserConsequentialKind[];
  minutes: number;
  budget: number;
  offerExpiresAt: number;
  startedAt: number | null;
  expiresAt: number | null;
  endNote: string | null;
}

const MAX_RECORDS = 200;
const MAX_EVIDENCE = 100;
const MAX_BYTES = 4_000_000;
const RECOVERY = "Browser task records need recovery. Browser tasks from Ask are paused. Check disk space and file access, then restart RealBud.";
const recovery = () => Object.assign(new Error(RECOVERY), { status: 503 });
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;
const time = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const plain = (value: string, max: number) => redactSecretsInText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max);

export const browserTaskEndNote = (status: BrowserTaskEnd, record: Pick<BrowserTaskRecord, "minutes" | "budget">): string => ({
  finished: "Finished. This permission has ended; ask again for more browser work.",
  stopped: "Stopped by you. Nothing more will be done in your browser for this task.",
  expired: `This task's ${record.minutes} minutes ran out, so Bud stopped using your browser. Ask again to continue.`,
  budget: `This task used its ${record.budget} browser steps, so Bud stopped using your browser. Ask again to continue.`,
  interrupted: "This task ended before Bud finished. Nothing more will be done in your browser; ask again to continue.",
})[status];
export const BROWSER_TASK_SIGN_IN_NOTE = "The site asked you to sign in, so Bud stopped. Sign in in your browser yourself, then ask again. Nothing was typed for you.";
export const BROWSER_TASK_RESTART_NOTE = "RealBud restarted before this task finished. Nothing more will be done in your browser; ask again to continue.";

/** Legacy fence capabilities for the same classes, for surfaces that still read them. */
export function browserTaskCapabilities(actions: readonly BrowserActionClass[]): JobCapability[] {
  const capabilities: JobCapability[] = ["portal-read"];
  if (actions.some(action => action === "fill" || action === "submit" || action === "upload")) capabilities.push("portal-prefill");
  if (actions.includes("submit")) capabilities.push("portal-submit");
  return capabilities;
}

/** The authority's own refusals when a grant is spent or out of time (server/browser-authority.ts). */
export function browserTaskLimitReached(note: string): "budget" | "expired" | null {
  if (/browser task reached its step limit/i.test(note)) return "budget";
  if (/browser task's permission has ended/i.test(note)) return "expired";
  return null;
}

/** The worker's instructions for one Ask task. The request is data; the grant is the authority. */
export function askBrowserTaskSystemBlock(grant: BrowserTaskGrant): string {
  const minutes = grant.expiresAt === null ? null : ASK_TASK_MINUTES;
  return [
    "You are doing one browser task the person started from Ask, in their own signed-in browser on this computer.",
    `Request:\n${grant.request.text}`,
    `Allowed sites: ${grant.sites.join(", ")}`,
    `This task ends${minutes ? ` ${minutes} minutes after it started or` : ""}${grant.budget ? ` after ${grant.budget} browser steps` : " with this turn"}, whichever comes first. When it ends, say what is done and what is left.`,
    portalBrowserPolicy(grantedBrowserTools(grant, true)),
    "The request does not expand the allowed sites or tool permissions. The person signs in. Never type a password.",
    "Nothing is paid, signed, sent or filed without the person's approval of that instance. A payment, transfer, signature, message, notice, deletion or account change is allowed only through the approval RealBud shows the person, with the exact recipient, amount or content read from the page. Never try another route to it. If RealBud refuses, the approval expires or the person declines, press nothing further for it: stop and say what is ready.",
    "Read back what you see, naming the source site, before saying anything is done.",
  ].join("\n");
}

function validRecord(value: unknown): value is BrowserTaskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.purpose !== "browser-task" || typeof row.id !== "string" || !UUID.test(row.id) ||
    !text(row.threadId, 200) || !text(row.messageId, 200) || !text(row.request, 4000) ||
    !Array.isArray(row.sites) || row.sites.length > 20 || !row.sites.every(browserTaskSite) ||
    !SITE_SOURCES.includes(row.siteSource as SiteSource) ||
    !(row.savedJob === null || (row.savedJob && typeof row.savedJob === "object" && text((row.savedJob as Record<string, unknown>).id, 200) && text((row.savedJob as Record<string, unknown>).title, 200))) ||
    !Array.isArray(row.actions) || !row.actions.every(action => (BROWSER_ACTION_CLASSES as readonly unknown[]).includes(action)) ||
    !Number.isSafeInteger(row.minutes) || !Number.isSafeInteger(row.budget) ||
    !STATUSES.includes(row.status as BrowserTaskStatus) || !time(row.createdAt) ||
    !(row.startedAt === null || time(row.startedAt)) || !(row.endedAt === null || time(row.endedAt)) ||
    !(row.endNote === null || text(row.endNote, 500)) || !Array.isArray(row.evidence) || row.evidence.length > MAX_EVIDENCE) return false;
  if (row.status === "active" && row.grant === null) return false;
  if (row.grant !== null) {
    try { if (parseBrowserTaskGrant(row.grant).id !== row.id) return false; } catch { return false; }
  }
  return row.evidence.every(item => item && typeof item === "object" && time((item as JobRunEvidence).at) &&
    EVIDENCE_KINDS.includes((item as JobRunEvidence).kind) && text((item as JobRunEvidence).note, 500));
}
function parseStore(value: unknown): BrowserTaskRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw recovery();
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.purpose !== "browser-tasks" || !Array.isArray(row.tasks) || row.tasks.length > MAX_RECORDS || !row.tasks.every(validRecord)) throw recovery();
  return row.tasks.map(item => structuredClone(item));
}

export function browserTaskCardView(record: BrowserTaskRecord): BrowserTaskCardView {
  return {
    id: record.id,
    messageId: record.messageId,
    status: record.status,
    request: record.request,
    sites: [...(record.grant?.sites ?? record.sites)],
    siteSource: record.siteSource,
    savedJob: record.savedJob?.title ?? null,
    actions: [...record.actions],
    consequential: [...BROWSER_CONSEQUENTIAL_KINDS],
    minutes: record.minutes,
    budget: record.budget,
    offerExpiresAt: record.createdAt + ASK_TASK_OFFER_MS,
    startedAt: record.startedAt,
    expiresAt: record.grant?.expiresAt ?? null,
    endNote: record.endNote,
  };
}

export interface BrowserTaskProposal {
  threadId: string;
  messageId: string;
  request: string;
  sites: string[];
  siteSource: "request" | "saved-job" | "none";
  savedJob: { id: string; title: string } | null;
  actions: BrowserActionClass[];
}

export class BrowserTaskStore {
  private rows: BrowserTaskRecord[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(options: { file?: string } = {}) { this.file = options.file ?? join(DATA_DIR, "browser-tasks.json"); }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work); this.chain = next.catch(() => {}); return next;
  }
  private async load(): Promise<BrowserTaskRecord[]> {
    if (this.rows) return this.rows;
    let saved: unknown;
    try { saved = await readPrivateJson(this.file, MAX_BYTES); } catch { throw recovery(); }
    const rows = saved === undefined ? [] : parseStore(saved);
    // A task that was running when RealBud stopped never resumes from its saved grant.
    if (rows.some(row => row.status === "active")) {
      const now = Date.now();
      await this.save(rows.map(row => row.status !== "active" ? row : { ...row, status: "interrupted" as const, endedAt: now, endNote: BROWSER_TASK_RESTART_NOTE }));
      return this.rows!;
    }
    this.rows = rows;
    return rows;
  }
  private async save(rows: BrowserTaskRecord[]): Promise<void> {
    try { await writePrivateJson(this.file, { version: 1, purpose: "browser-tasks", tasks: rows }, { maxBytes: MAX_BYTES, validate: parseStore }); }
    catch (error) { this.rows = null; throw error; }
    this.rows = rows;
  }
  private async change(id: string, update: (row: BrowserTaskRecord) => BrowserTaskRecord): Promise<BrowserTaskRecord> {
    const rows = await this.load();
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) throw fail(404, "This browser task is not in this conversation. Ask again to start it.");
    const next = update(structuredClone(rows[index]));
    const all = [...rows]; all[index] = next;
    await this.save(all);
    return structuredClone(next);
  }

  /** Saved before the card is shown; nothing in the browser is allowed yet. */
  propose(input: BrowserTaskProposal, now = Date.now()): Promise<BrowserTaskRecord> {
    return this.exclusive(async () => {
      const request = plain(input.request, 2000);
      if (!request) throw fail(400, "Say what Bud should do on the site.");
      const record: BrowserTaskRecord = {
        version: 1, purpose: "browser-task", id: randomUUID(), threadId: input.threadId, messageId: input.messageId, request,
        sites: [...new Set(input.sites.filter(browserTaskSite))].slice(0, 20), siteSource: input.siteSource,
        savedJob: input.savedJob ? { id: input.savedJob.id.slice(0, 200), title: plain(input.savedJob.title, 200) || "Saved job" } : null,
        actions: BROWSER_ACTION_CLASSES.filter(action => input.actions.includes(action)),
        minutes: ASK_TASK_MINUTES, budget: ASK_TASK_BUDGET, status: "proposed", createdAt: now,
        startedAt: null, endedAt: null, endNote: null, grant: null, evidence: [],
      };
      if (record.siteSource !== "none" && !record.sites.length) record.siteSource = "none";
      const rows = [...await this.load(), record];
      // Oldest settled cards go first; a running task is never dropped.
      while (rows.length > MAX_RECORDS) {
        const index = rows.findIndex(row => row.status !== "active");
        rows.splice(index < 0 ? 0 : index, 1);
      }
      await this.save(rows);
      return structuredClone(record);
    });
  }

  list(threadId: string): Promise<BrowserTaskRecord[]> {
    return this.exclusive(async () => structuredClone((await this.load()).filter(row => row.threadId === threadId).slice(-20)));
  }

  get(id: string): Promise<BrowserTaskRecord | undefined> {
    return this.exclusive(async () => {
      const row = (await this.load()).find(item => item.id === id);
      return row ? structuredClone(row) : undefined;
    });
  }

  /** The person pressed Start: the grant is saved before any browser work.
   * Bound to this thread and the browser selected now; the site comes from
   * the request or saved job, or from the person when neither named one. */
  start(id: string, input: { threadId: string; browserId: string; site?: unknown }, now = Date.now()): Promise<BrowserTaskRecord & { grant: BrowserTaskGrant }> {
    return this.exclusive(async () => {
      const rows = await this.load();
      const row = rows.find(item => item.id === id);
      if (!row || row.threadId !== input.threadId) throw fail(404, "This browser task is not in this conversation. Ask again to start it.");
      if (row.status === "active") throw fail(409, "This task is already running. Stop it before starting it again.");
      if (row.status !== "proposed") throw fail(409, "This request was already answered or has ended. Ask again to start a new task.");
      if (now - row.createdAt > ASK_TASK_OFFER_MS) throw fail(409, "This request is from more than an hour ago. Ask again to start it.");
      if (rows.some(item => item.threadId === row.threadId && item.status === "active")) throw fail(409, "Another browser task is running in this conversation. Stop it first.");
      if (!text(input.browserId, 200)) throw fail(409, "Connect your browser before starting this task.");
      let sites = row.sites; let siteSource = row.siteSource;
      if (!sites.length) {
        const host = typeof input.site === "string" && input.site.length <= 260 ? normalizeOrigin(input.site) : null;
        if (!host || !browserTaskSite(host)) throw fail(400, "Enter the site's web address first, for example vantagestrata.com.au.");
        sites = [host]; siteSource = "person";
      }
      const grant = parseBrowserTaskGrant({
        version: BROWSER_TASK_GRANT_VERSION,
        purpose: BROWSER_TASK_GRANT_PURPOSE,
        id: row.id,
        runId: `ask-${row.id}`,
        route: "ask",
        request: { text: row.request, sha256: sha256(row.request) },
        sites,
        browser: { id: input.browserId, accountMarker: null },
        actions: row.actions,
        consequential: BROWSER_CONSEQUENTIAL_POLICY,
        uploads: [],
        expiresAt: now + row.minutes * 60_000,
        budget: row.budget,
      });
      const started = await this.change(id, current => ({ ...current, sites, siteSource, status: "active", startedAt: now, grant }));
      return { ...started, grant };
    });
  }

  /** Not now, or Save as a job instead. Only an unanswered card can be answered. */
  answer(id: string, threadId: string, status: "declined" | "saved-as-job", now = Date.now()): Promise<BrowserTaskRecord> {
    return this.exclusive(async () => {
      const row = (await this.load()).find(item => item.id === id);
      if (!row || row.threadId !== threadId) throw fail(404, "This browser task is not in this conversation. Ask again to start it.");
      if (row.status !== "proposed") throw fail(409, "This request was already answered or has ended. Ask again to start a new task.");
      return this.change(id, current => ({ ...current, status, endedAt: now }));
    });
  }

  /** Ends a running task for good. Returns null when it had already ended. */
  end(id: string, status: BrowserTaskEnd, note?: string, now = Date.now()): Promise<BrowserTaskRecord | null> {
    return this.exclusive(async () => {
      const row = (await this.load()).find(item => item.id === id);
      if (!row || row.status !== "active") return null;
      return this.change(id, current => ({ ...current, status, endedAt: now, endNote: plain(note ?? browserTaskEndNote(status, current), 500) }));
    });
  }

  /** The broker's decisions while the task runs. */
  appendEvidence(id: string, items: readonly JobRunEvidence[]): Promise<void> {
    return this.exclusive(async () => {
      const row = (await this.load()).find(item => item.id === id);
      if (!row || row.status !== "active") return;
      const clean = items.filter(item => time(item.at) && EVIDENCE_KINDS.includes(item.kind))
        .map(item => ({ at: item.at, kind: item.kind, note: plain(item.note, 500) || "Browser step recorded." }));
      await this.change(id, current => ({ ...current, evidence: [...current.evidence, ...clean].slice(-MAX_EVIDENCE) }));
    });
  }
}

let defaultStore: BrowserTaskStore | null = null;
export const browserTasks = (): BrowserTaskStore => (defaultStore ??= new BrowserTaskStore());
