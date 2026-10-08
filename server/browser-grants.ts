// One-off browser tasks from Ask. A request such as "Download this month's
// invoices from the strata portal" becomes a task card; pressing Start saves
// an explicit grant (sites, the selected browser, action classes, expiry and
// a step budget) before any browser work, and the turn mounts RealBud's
// browser with exactly that grant. A grant belongs to one Ask thread and one
// browser and ends with its turn. Stop, expiry, the step limit or a restart
// end it for good; a task is never restarted from a saved grant. A sign-in
// request pauses it instead: the same grant, with its remaining time and
// steps, continues once the person has signed in, and never after it expired.
// A desktop task is the same card given one open app window instead of a site
// (`grant.desktop`, server/desktop-fence.ts): its grant has no sites, it never
// pauses for sign-in, and Start re-reads the window before saving the grant.
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { readPrivateJson, trimOldestToBytes, writePrivateJson } from "./private-json.ts";
import { redactSecretsInText } from "./redact.ts";
import { normalizeOrigin } from "./recipes.ts";
import { grantedBrowserTools, portalBrowserPolicy } from "./attended-run.ts";
import { addBrowserTaskUpload, browserTaskWorkroom, MAX_BROWSER_FILE_BYTES } from "./browser-runtime.ts";
import { startCuaClient, type CuaClient } from "./cua-client.ts";
import { desktopSnapshot } from "./desktop-fence.ts";
import { readCuaConnection } from "./local-computer.ts";
import { DESKTOP_WINDOWS_MAX, parseDesktopTarget, type DesktopTarget } from "../shared/desktop-task.ts";
import {
  BROWSER_ACTION_CLASSES,
  BROWSER_CONSEQUENTIAL_KINDS,
  BROWSER_CONSEQUENTIAL_POLICY,
  BROWSER_TASK_GRANT_PURPOSE,
  BROWSER_TASK_GRANT_VERSION,
  browserTaskSite,
  browserTaskUploadName,
  parseBrowserTaskGrant,
  type BrowserActionClass,
  type BrowserConsequentialKind,
  type BrowserTaskGrant,
  type BrowserTaskUpload,
} from "../shared/browser-task.ts";
import type { JobCapability, JobRunEvidence, JobRunEvidenceKind } from "../shared/contracts.ts";

export const ASK_TASK_MINUTES = 30;
export const ASK_TASK_BUDGET = 40;
/** A card older than this belongs to an earlier moment in the conversation. */
export const ASK_TASK_OFFER_MS = 60 * 60_000;

/** The Ask reply that carries the card. It stands alone where the card cannot show (a phone). */
export const BROWSER_TASK_OFFER =
  "I can do this now in your browser. Check what it covers, then press **Start this task** in Work on this computer. Payments, signatures, messages and notices each still ask you first.";
/** The Ask reply that carries a desktop task's card (an app window instead of a site). */
export const DESKTOP_TASK_OFFER =
  "I can do this now in an app on this computer. Check the window and what it covers, then press **Start this task** in Work on this computer. Payments, signatures, messages and deletions each still ask you first.";
export const BROWSER_TASK_UNAVAILABLE =
  "I couldn't prepare this browser task, so nothing was done in your browser. Check this computer's disk space, then ask again.";

export type BrowserTaskStatus = "proposed" | "declined" | "saved-as-job" | "active" | "paused" | "finished" | "stopped" | "expired" | "budget" | "interrupted";
const STATUSES: readonly BrowserTaskStatus[] = ["proposed", "declined", "saved-as-job", "active", "paused", "finished", "stopped", "expired", "budget", "interrupted"];
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
  /** A person-started portal recipe task (server/portal-recipe-task.ts): RealBud's
   * runner does the steps instead of a model turn. Absent on other tasks. */
  recipe?: BrowserTaskRecipe;
  /** A desktop task's app window, preselected from the request (an open window of the app it named).
   * Data only: Start checks the window again; the grant's `desktop` is the authority. */
  desktop?: DesktopTarget;
  /** Proposed from a request for an app on this computer ("… in the Notepad app"), so the card asks for a window,
   * not a site. Wording only; absent on older records and website tasks. */
  appTask?: true;
}

/** The pack recipes a task runs and the account the person selected. Data only: the grant is the authority. */
export interface BrowserTaskRecipe {
  portal: string;
  runs: Array<{ recipe: string; inputs: Record<string, string> }>;
  /** `marker` (the portal header's account name) is always required; `urlValue` only when the office saved one. */
  account: { urlValue?: string; marker: string };
}
const RECIPE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const shortText = (value: unknown, max: number) => text(value, max) && !/[\u0000-\u001f\u007f]/.test(value as string);
export function validBrowserTaskRecipe(value: unknown): value is BrowserTaskRecipe {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const account = row.account as Record<string, unknown> | null;
  if (Object.keys(row).some(key => !["portal", "runs", "account"].includes(key)) || typeof row.portal !== "string" || !RECIPE_NAME.test(row.portal) ||
    !account || typeof account !== "object" || Object.keys(account).some(key => key !== "urlValue" && key !== "marker") ||
    (account.urlValue !== undefined && !shortText(account.urlValue, 200)) || !shortText(account.marker, 200) || !Array.isArray(row.runs) || row.runs.length < 1 || row.runs.length > 12) return false;
  return row.runs.every(run => {
    if (!run || typeof run !== "object" || Array.isArray(run)) return false;
    const { recipe, inputs, ...rest } = run as Record<string, unknown>;
    if (Object.keys(rest).length || typeof recipe !== "string" || !RECIPE_NAME.test(recipe) || !inputs || typeof inputs !== "object" || Array.isArray(inputs)) return false;
    const entries = Object.entries(inputs as Record<string, unknown>);
    return entries.length <= 12 && entries.every(([key, item]) => /^[a-z][a-z0-9_]{0,39}$/.test(key) && typeof item === "string" && item.length <= 200 && !/[\u0000-\u001f\u007f]/.test(item));
  });
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
  /** What the task has done so far, in short words from its own record, oldest first. */
  progress: string[];
  /** A desktop task's app window: its grant's, or the one preselected before Start. */
  desktop?: DesktopTarget;
  /** Asked for an app on this computer: the card asks for a window, not a site. */
  appTask?: true;
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

export const browserTaskEndNote = (status: BrowserTaskEnd, record: Pick<BrowserTaskRecord, "minutes" | "budget"> & { grant?: BrowserTaskGrant | null }): string => {
  const app = record.grant?.desktop?.appName;
  const place = app ?? "your browser";
  return ({
    finished: `Finished. This permission has ended; ask again for more ${app ? "work in the app" : "browser work"}.`,
    stopped: `Stopped by you. Nothing more will be done in ${place} for this task.`,
    expired: `This task's ${record.minutes} minutes ran out, so Bud stopped using ${place}. Ask again to continue.`,
    budget: `This task used its ${record.budget} ${app ? "" : "browser "}steps, so Bud stopped using ${place}. Ask again to continue.`,
    interrupted: `This task ended before Bud finished. Nothing more will be done in ${place}; ask again to continue.`,
  })[status];
};
export const BROWSER_TASK_SIGN_IN_NOTE = "The site asked you to sign in, so Bud stopped. Sign in in your browser yourself, then ask again. Nothing was typed for you.";
/** A sign-in pause: the task keeps its grant, time and steps until the person continues or stops it. */
export const BROWSER_TASK_PAUSED_NOTE = "The site asked you to sign in, so Bud paused this task. Sign in in your browser yourself, then press Continue on the sign-in request: Bud carries on with the same task. Nothing was typed for you.";
/** A sign-in the person finishes on the page itself, while Bud waits in the same step. */
export const BROWSER_TASK_PAGE_SIGN_IN_NOTE = "The site asked you to sign in. Finish signing in on the page in your browser and press Done there: Bud carries on with the same task. Nothing was typed for you.";
/** A task that was still waiting for sign-in when its time ran out. */
const PAUSED_EXPIRED_NOTE = "This task's time ran out while it waited for you to sign in. Nothing more will be done in your browser; start the task again from your request.";
/** A task that holds its grant: running, or paused for sign-in. */
const holding = (row: Pick<BrowserTaskRecord, "status">) => row.status === "active" || row.status === "paused";
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
  const ends = `This task ends${minutes ? ` ${minutes} minutes after it started or` : ""}${grant.budget ? ` after ${grant.budget} steps` : " with this turn"}, whichever comes first. When it ends, say what is done and what is left.`;
  // The window's title is the app's own text (a mail subject, a file name): it stays out of these instructions.
  if (grant.desktop) return [
    "You are doing one task the person started from Ask, in one app window on this computer.",
    `Request:\n${grant.request.text}`,
    `App: ${grant.desktop.appName}`,
    ends,
    "Use only the workdesktop tools: read the window with get_window_state, then press, type, scroll or press keys by the element_token it returns, and read the window again after each step to confirm what changed. Use release when you are done.",
    "The request does not expand what you may do or which window you may use. Never work in another app or window. The person signs in. Never type a password, code or bank or card details.",
    "Nothing is paid, signed, sent or deleted without the person's approval of that instance. Each of those is allowed only through the approval RealBud shows the person, with the app's own words for the button. If RealBud refuses, the approval expires or the person declines, press nothing further for it: stop and say what is ready.",
    "Read back what you see in the window before saying anything is done.",
  ].join("\n");
  return [
    "You are doing one browser task the person started from Ask, in their own signed-in browser on this computer.",
    `Request:\n${grant.request.text}`,
    `Allowed sites: ${grant.sites.join(", ")}`,
    `This task ends${minutes ? ` ${minutes} minutes after it started or` : ""}${grant.budget ? ` after ${grant.budget} browser steps` : " with this turn"}, whichever comes first. When it ends, say what is done and what is left.`,
    portalBrowserPolicy(grantedBrowserTools(grant, true)),
    ...(grant.uploads.length && grant.actions.includes("upload") ? [`Files the person attached in this conversation, which browser_upload may send after their approval: ${grant.uploads.map(file => file.name).join(", ")}. No other file can be uploaded.`] : []),
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
  if ((row.status === "active" || row.status === "paused") && row.grant === null) return false;
  // Records saved before recipe tasks existed have no `recipe`.
  if (row.recipe !== undefined && !validBrowserTaskRecipe(row.recipe)) return false;
  if (row.grant !== null) {
    try { if (parseBrowserTaskGrant(row.grant).id !== row.id) return false; } catch { return false; }
  }
  if (row.desktop !== undefined) { try { parseDesktopTarget(row.desktop); } catch { return false; } }
  if (row.appTask !== undefined && row.appTask !== true) return false;
  return row.evidence.every(item => item && typeof item === "object" && time((item as JobRunEvidence).at) &&
    EVIDENCE_KINDS.includes((item as JobRunEvidence).kind) && text((item as JobRunEvidence).note, 500));
}
function parseStore(value: unknown): BrowserTaskRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw recovery();
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.purpose !== "browser-tasks" || !Array.isArray(row.tasks) || row.tasks.length > MAX_RECORDS || !row.tasks.every(validRecord)) throw recovery();
  return row.tasks.map(item => structuredClone(item));
}

/** The card's progress lines from the task's recorded actions ("Signed in to REI Cloud", "Opened Reports",
 * "Downloaded tenants.csv"): the plain sentence only, never the action record's hashes or a field value. */
export function browserTaskProgress(evidence: readonly JobRunEvidence[]): string[] {
  const lines: string[] = [];
  for (const item of evidence) {
    if (item.kind !== "action") continue;
    const sentence = item.note.split(" Action record:")[0]!.replace(/\s+value="(?:[^"\\]|\\.)*"?/g, "").trim();
    const download = sentence.match(/^Downloaded '([^']{1,120})'/);
    let line = download ? `Downloaded ${download[1]}` : (sentence.split(/\.(?:\s|$)/)[0] ?? "")
      .replace(/ (?:on|from) [a-z0-9-]+(?:\.[a-z0-9-]+)+\b.*$/i, "")
      .replace(/\b(?:link|button|combobox|textbox|searchbox|menuitem|tab|checkbox|radio|option) "((?:[^"\\]|\\.){1,120})"/g, "$1");
    if (/^You finished the (?:sign-in page|verification step)\b/.test(line)) line = "Signed in";
    if (!line || /^allowed (?:for this browser task|by rule|once by you)/i.test(line) || lines.at(-1) === line) continue;
    lines.push(line.slice(0, 80));
  }
  return lines.slice(-8);
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
    progress: browserTaskProgress(record.evidence),
    ...(record.grant?.desktop ?? record.desktop ? { desktop: structuredClone(record.grant?.desktop ?? record.desktop!) } : {}),
    ...(record.appTask ? { appTask: true as const } : {}),
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
  recipe?: BrowserTaskRecipe;
  /** A desktop task's preselected app window (no sites). */
  desktop?: DesktopTarget;
  /** Proposed from a request for an app on this computer (no sites). */
  appTask?: true;
}

/** A thread's saved messages. Only the person's own messages are read for attachments. */
export type BrowserTaskThreadMessages = (threadId: string) => Promise<ReadonlyArray<unknown>>;
/** Every saved thread, so a copy referenced from another thread is never this thread's. */
function savedThreadIds(dataDir: string): () => Promise<string[]> {
  return async () => {
    try { return (await readdir(dataDir)).flatMap(name => /^messages-(.+)\.json$/.exec(name)?.[1] ?? []); } catch { return []; }
  };
}
/** The Store's saved thread file (server/store.ts `messagesFile`), read only. Written atomically before any reply. */
function savedThreadMessages(dataDir: string): BrowserTaskThreadMessages {
  return async threadId => {
    if (!threadId || /[\\/\0]/.test(threadId) || threadId === "." || threadId === "..") return [];
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(dataDir, `messages-${threadId}.json`), "utf8")); } catch { return []; }
    if (Array.isArray(raw)) return raw;
    return raw && typeof raw === "object" && Array.isArray((raw as { messages?: unknown }).messages) ? (raw as { messages: unknown[] }).messages : [];
  };
}
/** The composer's file reference (src/lib/composer-attachments.ts `composeMessage`). */
const ATTACHED_FILE = /<attached-file path="([^"]{1,4096})" \/>/g;
const unescapeAttribute = (value: string) => value.replace(/&#9;/g, "\t").replace(/&#13;/g, "\r").replace(/&#10;/g, "\n")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/** `saveAskAttachment` names each private copy `<uuid>-<name>`. */
const ASK_COPY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/;
/** File references in the person's own messages (never a model's text). */
function personReferences(messages: ReadonlyArray<unknown>): string[] {
  return messages.flatMap(message => {
    if (!message || typeof message !== "object") return [];
    const { role, text: body } = message as { role?: unknown; text?: unknown };
    return role === "user" && typeof body === "string" ? [...body.matchAll(ATTACHED_FILE)].map(match => unescapeAttribute(match[1])) : [];
  });
}
/** The files the person attached in this thread: references in their own
 * messages that resolve to RealBud's private ask-uploads copies. Each attach
 * makes a fresh copy, so a copy also referenced from another thread is
 * ambiguous and left out. Never an original disk path, another workroom file,
 * a model's text or another thread's file. */
export async function threadAttachedFiles(dataDir: string, messages: ReadonlyArray<unknown>, otherThreads: ReadonlyArray<ReadonlyArray<unknown>> = []): Promise<Array<{ name: string; path: string }>> {
  let folder: string;
  // The same (non-native) realpathSync saveAskAttachment uses for the copy's
  // path. The native realpath expands Windows 8.3 names (RUNNER~1), so the
  // person's own reference would never match its folder.
  try { folder = realpathSync(join(dataDir, "vault", "ask-uploads")); } catch { return []; }
  const elsewhere = new Set(otherThreads.flatMap(personReferences));
  const found: Array<{ name: string; path: string }> = []; const names = new Set<string>();
  for (const path of personReferences(messages)) {
    const name = ASK_COPY.exec(basename(path))?.[1];
    if (elsewhere.has(path) || !isAbsolute(path) || dirname(path) !== folder || !name || name.endsWith(".inspection.json") || !browserTaskUploadName(name) || names.has(name.toLowerCase())) continue;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BROWSER_FILE_BYTES || realpathSync(path) !== path) continue;
      if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) continue;
    } catch { continue; }
    names.add(name.toLowerCase()); found.push({ name, path });
    if (found.length >= 20) return found;
  }
  return found;
}

export class BrowserTaskStore {
  private rows: BrowserTaskRecord[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly dataDir: string;
  private readonly browserRoot: string;
  private readonly threadMessages: BrowserTaskThreadMessages;
  private readonly threadIds: () => Promise<string[]>;
  constructor(options: { file?: string; dataDir?: string; browserRoot?: string; threadMessages?: BrowserTaskThreadMessages; threadIds?: () => Promise<string[]> } = {}) {
    this.dataDir = options.dataDir ?? DATA_DIR;
    this.file = options.file ?? join(this.dataDir, "browser-tasks.json");
    // The same folder as the work browser runtime's (server/browser-runtime.ts `browserRuntime.root`), so the broker finds the copies.
    this.browserRoot = options.browserRoot ?? join(this.dataDir, "browser");
    this.threadMessages = options.threadMessages ?? savedThreadMessages(this.dataDir);
    this.threadIds = options.threadIds ?? savedThreadIds(this.dataDir);
  }
  /** Copies this thread's attachments into the task's private uploads; the grant lists each by name and hash. */
  private async taskUploads(threadId: string, grantId: string): Promise<BrowserTaskUpload[]> {
    const others = await Promise.all((await this.threadIds()).filter(id => id !== threadId).map(id => this.threadMessages(id)));
    const files = await threadAttachedFiles(this.dataDir, await this.threadMessages(threadId), others);
    const workroom = browserTaskWorkroom(this.browserRoot, grantId);
    const uploads: BrowserTaskUpload[] = [];
    // A file that cannot be copied is left out; it is never replaced by another path.
    for (const file of files) { try { uploads.push(await addBrowserTaskUpload(workroom, file.name, await readFile(file.path))); } catch { /* left out */ } }
    return uploads;
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work); this.chain = next.catch(() => {}); return next;
  }
  private async load(): Promise<BrowserTaskRecord[]> {
    if (this.rows) return this.rows;
    let saved: unknown;
    try { saved = await readPrivateJson(this.file, MAX_BYTES); } catch { throw recovery(); }
    const rows = saved === undefined ? [] : parseStore(saved);
    // A task that was running when RealBud stopped never resumes from its saved grant.
    // One paused for sign-in stays paused, and resumable only while its grant holds.
    const now = Date.now();
    const lapsed = (row: BrowserTaskRecord) => row.status === "paused" && typeof row.grant?.expiresAt === "number" && row.grant.expiresAt <= now;
    if (rows.some(row => row.status === "active" || lapsed(row))) {
      await this.save(rows.map(row => row.status === "active" ? { ...row, status: "interrupted" as const, endedAt: now,
        endNote: row.grant?.desktop ? BROWSER_TASK_RESTART_NOTE.replace("your browser", row.grant.desktop.appName) : BROWSER_TASK_RESTART_NOTE }
        : lapsed(row) ? { ...row, status: "expired" as const, endedAt: now, endNote: PAUSED_EXPIRED_NOTE } : row));
      return this.rows!;
    }
    this.rows = rows;
    return rows;
  }
  private async save(rows: BrowserTaskRecord[]): Promise<void> {
    // Evidence makes tasks large: near the file cap the oldest settled tasks go
    // first; a proposed, running or paused task is never dropped.
    rows = trimOldestToBytes(rows, MAX_BYTES * 0.8, row => !holding(row) && row.status !== "proposed");
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
      if (input.recipe !== undefined && !validBrowserTaskRecipe(input.recipe)) throw fail(400, "This portal task's recipes or account are not valid. Choose them again.");
      const desktop = input.desktop === undefined ? undefined : parseDesktopTarget(structuredClone(input.desktop));
      if ((desktop || input.appTask) && (input.sites.length || input.recipe)) throw fail(400, "A task works in a website or an app window, not both.");
      const record: BrowserTaskRecord = {
        version: 1, purpose: "browser-task", id: randomUUID(), threadId: input.threadId, messageId: input.messageId, request,
        sites: [...new Set(input.sites.filter(browserTaskSite))].slice(0, 20), siteSource: input.siteSource,
        savedJob: input.savedJob ? { id: input.savedJob.id.slice(0, 200), title: plain(input.savedJob.title, 200) || "Saved job" } : null,
        actions: BROWSER_ACTION_CLASSES.filter(action => input.actions.includes(action)),
        minutes: ASK_TASK_MINUTES, budget: ASK_TASK_BUDGET, status: "proposed", createdAt: now,
        startedAt: null, endedAt: null, endNote: null, grant: null, evidence: [],
        ...(input.recipe ? { recipe: structuredClone(input.recipe) } : {}),
        ...(desktop ? { desktop } : {}),
        ...(input.appTask === true ? { appTask: true as const } : {}),
      };
      if (record.siteSource !== "none" && !record.sites.length) record.siteSource = "none";
      const rows = [...await this.load(), record];
      // Oldest settled cards go first; a running or paused task is never dropped.
      while (rows.length > MAX_RECORDS) {
        const index = rows.findIndex(row => !holding(row));
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
  start(id: string, input: { threadId: string; browserId?: string; site?: unknown; desktop?: DesktopTarget }, now = Date.now()): Promise<BrowserTaskRecord & { grant: BrowserTaskGrant }> {
    return this.exclusive(async () => {
      const rows = await this.load();
      const row = rows.find(item => item.id === id);
      if (!row || row.threadId !== input.threadId) throw fail(404, "This browser task is not in this conversation. Ask again to start it.");
      if (holding(row)) throw fail(409, "This task is already running. Stop it before starting it again.");
      if (row.status !== "proposed") throw fail(409, "This request was already answered or has ended. Ask again to start a new task.");
      if (now - row.createdAt > ASK_TASK_OFFER_MS) throw fail(409, "This request is from more than an hour ago. Ask again to start it.");
      if (rows.some(item => item.threadId === row.threadId && holding(item))) throw fail(409, "Another browser task is running in this conversation. Stop it first.");
      // A desktop task: the one app window the host checked just now, no sites, no browser and no uploads.
      const desktop = input.desktop === undefined ? undefined : parseDesktopTarget(structuredClone(input.desktop));
      if (desktop && (row.sites.length || row.recipe)) throw fail(409, "This task is for a website. Start it without choosing an app window.");
      if (!desktop && !text(input.browserId, 200)) throw fail(409, "Connect your browser before starting this task.");
      let sites = row.sites; let siteSource = row.siteSource;
      if (!sites.length && !desktop) {
        const host = typeof input.site === "string" && input.site.length <= 260 ? normalizeOrigin(input.site) : null;
        if (!host || !browserTaskSite(host)) throw fail(400, "Enter the site's web address first, for example vantagestrata.com.au.");
        sites = [host]; siteSource = "person";
      }
      // Only a task that may upload gets copies, and only of files the person attached in this thread.
      const uploads = !desktop && row.actions.includes("upload") ? await this.taskUploads(row.threadId, row.id) : [];
      const grant = parseBrowserTaskGrant({
        version: BROWSER_TASK_GRANT_VERSION,
        purpose: BROWSER_TASK_GRANT_PURPOSE,
        id: row.id,
        runId: `ask-${row.id}`,
        route: "ask",
        request: { text: row.request, sha256: sha256(row.request) },
        sites,
        // A recipe task is bound to the account the person selected: the broker refuses any control once its marker is gone.
        browser: { id: desktop ? null : input.browserId!, accountMarker: row.recipe?.account.marker ?? null },
        actions: row.actions,
        consequential: BROWSER_CONSEQUENTIAL_POLICY,
        uploads,
        expiresAt: now + row.minutes * 60_000,
        budget: row.budget,
        ...(desktop ? { desktop } : {}),
      });
      const started = await this.change(id, current => ({ ...current, sites, siteSource, status: "active", startedAt: now, grant, ...(desktop ? { desktop } : {}) }));
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

  /** The site asked the person to sign in: the task keeps its saved grant
   * (time and steps included) and waits. A paused task only takes the new
   * note (the page wait handed over to the sign-in request). Returns null
   * when the task has ended. */
  pause(id: string, note = BROWSER_TASK_PAUSED_NOTE): Promise<BrowserTaskRecord | null> {
    return this.exclusive(async () => {
      const row = (await this.load()).find(item => item.id === id);
      if (!row || !holding(row)) return null;
      return this.change(id, current => ({ ...current, status: "paused", endNote: plain(note, 500) }));
    });
  }

  /** The person signed in: the same grant carries on, only in its own
   * conversation, only while it has time left, and only in the browser it
   * was started with (when the caller names the browser selected now). */
  resume(id: string, input: { threadId: string; browserId?: string | null }, now = Date.now()): Promise<BrowserTaskRecord & { grant: BrowserTaskGrant }> {
    return this.exclusive(async () => {
      const row = (await this.load()).find(item => item.id === id);
      if (!row || row.threadId !== input.threadId) throw fail(404, "This browser task is not in this conversation. Ask again to start it.");
      if (row.status !== "paused" || !row.grant) throw fail(409, "This task is no longer waiting for sign-in. Start the task again from your request.");
      if (row.grant.expiresAt !== null && row.grant.expiresAt <= now) throw fail(409, "This task's permission has ended. Start the task again from your request.");
      if (input.browserId !== undefined && row.grant.browser.id && input.browserId !== row.grant.browser.id) {
        throw fail(409, "The selected browser changed while this task was paused. Start the task again from your request.");
      }
      const resumed = await this.change(id, current => ({ ...current, status: "active", endNote: null }));
      return { ...resumed, grant: resumed.grant! };
    });
  }

  /** Ends a running or paused task for good. Returns null when it had already ended. */
  end(id: string, status: BrowserTaskEnd, note?: string, now = Date.now()): Promise<BrowserTaskRecord | null> {
    return this.exclusive(async () => {
      const row = (await this.load()).find(item => item.id === id);
      if (!row || !holding(row)) return null;
      return this.change(id, current => ({ ...current, status, endedAt: now, endNote: plain(note ?? browserTaskEndNote(status, current), 500) }));
    });
  }

  /** The broker's decisions while the task runs (including a wait on the sign-in page). */
  appendEvidence(id: string, items: readonly JobRunEvidence[]): Promise<void> {
    return this.exclusive(async () => {
      const row = (await this.load()).find(item => item.id === id);
      if (!row || !holding(row)) return;
      const clean = items.filter(item => time(item.at) && EVIDENCE_KINDS.includes(item.kind))
        .map(item => ({ at: item.at, kind: item.kind, note: plain(item.note, 500) || "Browser step recorded." }));
      await this.change(id, current => ({ ...current, evidence: [...current.evidence, ...clean].slice(-MAX_EVIDENCE) }));
    });
  }
}

let defaultStore: BrowserTaskStore | null = null;
export const browserTasks = (): BrowserTaskStore => (defaultStore ??= new BrowserTaskStore());

// ── Desktop tasks: the open app windows a person may give a task ─────────
/** Apps a desktop task never works in: RealBud itself and its desktop helper (the cua-driver cursor overlay),
 * system shells (Dock, taskbar, input and search hosts), browsers (those use browser tasks), terminals and
 * code editors, system settings, and password stores. Matched on the app's name (".exe" dropped) and, when
 * the helper gives one, its bundle id. */
const NOT_A_TASK_APP = new RegExp(`^(?:${[
  "realbud.*", "electron", "cua-driver", "cua.*driver",
  "dock", "window ?server", "windowmanager", "systemuiserver", "control cent(?:er|re)", "notification cent(?:er|re)",
  "textinputhost", "shellexperiencehost", "startmenuexperiencehost", "searchhost", "searchapp", "lockapp", "shellhost",
  "google chrome.*", "chrome", "chromium", "microsoft edge.*", "msedge", "safari.*", "firefox.*", "arc", "brave.*", "opera.*", "vivaldi", "orion", "tor browser",
  "terminal", "iterm2?", "warp", "alacritty", "kitty", "wezterm.*", "ghostty", "hyper", "tabby", "windows terminal", "windowsterminal", "command prompt", "cmd",
  "conhost", "(?:windows )?powershell.*", "pwsh", "git bash", "mintty",
  "code", "code - insiders", "visual studio.*", "devenv", "cursor", "windsurf", "zed", "xcode", "android studio", "sublime text", "nova", "fleet",
  "jetbrains.*", "intellij idea.*", "idea64", "pycharm.*", "webstorm.*", "goland.*", "clion.*", "rider.*", "phpstorm.*", "rubymine.*", "datagrip.*", "rustrover.*",
  "system settings", "system preferences", "settings", "control panel", "keychain access", "passwords", "credential manager",
  "1password.*", "bitwarden", "dashlane", "lastpass", "keepassxc", "keepass", "enpass", "nordpass", "proton pass", "keeper.*", "roboform",
].join("|")})$`, "i");
const NOT_A_TASK_BUNDLE = /^(?:com\.realbud\.|com\.github\.electron|com\.google\.chrome|org\.chromium\.|com\.microsoft\.edge|com\.apple\.safari|org\.mozilla\.|company\.thebrowser\.|com\.brave\.|com\.apple\.terminal|com\.googlecode\.iterm2|dev\.warp\.|com\.microsoft\.vscode|com\.todesktop\.|com\.jetbrains\.|com\.apple\.dt\.xcode|com\.apple\.systempreferences|com\.apple\.keychainaccess|com\.apple\.passwords|com\.1password\.|com\.agilebits\.|com\.bitwarden\.)/i;
/** cua-driver 0.22 list_windows sends no bundle id. The app's own name stands in (shown on cards as is); the
 * fence identifies the window by pid and window id, and the broker accepts the stand-in only for the same pid,
 * window and app name. ponytail: use the driver's bundle_id once the pinned release sends it. */
const bundleStandIn = (appName: string) => appName.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 200) || "app";

/** Shell windows that are not app windows: the desktop itself and the helper's cursor overlay, whatever app name they carry. */
const NOT_A_TASK_WINDOW = /^(?:Program Manager|Cua\.AgentCursorOverlay\b.*)$/i;
/** A row whose bounds say it has no area (hidden, minimised to nothing or a shell stub). Rows without bounds pass. */
const emptyBounds = (bounds: unknown) => {
  if (!bounds || typeof bounds !== "object") return false;
  const { width, height } = bounds as Record<string, unknown>;
  return !(typeof width === "number" && width > 0 && typeof height === "number" && height > 0);
};

/** The windows a person may give a task, from a list_windows answer: titled, non-empty windows of other apps, at
 * most 200. The picker, the named-app preselect and Start's check all read through here. */
export function desktopWindowChoices(rows: unknown, ownPids: readonly number[] = [process.pid, process.ppid]): DesktopTarget[] {
  const out: DesktopTarget[] = [];
  const seen = new Set<number>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const { app_name, bundle_id, pid, window_id, title, bounds } = row as Record<string, unknown>;
    const appName = typeof app_name === "string" ? app_name.trim() : "";
    const bundle = typeof bundle_id === "string" ? bundle_id : "";
    if (!appName || typeof title !== "string" || !title.trim() || ownPids.includes(pid as number) || seen.has(window_id as number) ||
      emptyBounds(bounds) || NOT_A_TASK_WINDOW.test(title.trim()) ||
      NOT_A_TASK_APP.test(appName.replace(/\.exe$/i, "")) || NOT_A_TASK_BUNDLE.test(bundle)) continue;
    try { out.push(parseDesktopTarget({ appName, bundleId: bundle || bundleStandIn(appName), pid, windowId: window_id, title })); } catch { continue; }
    seen.add(window_id as number);
    if (out.length >= DESKTOP_WINDOWS_MAX) break;
  }
  return out;
}

const DESKTOP_UNAVAILABLE = "Apps on this computer aren't available here.";
/** One short desktop-helper session: list or read, then close. Null when the helper is not set up (macOS and Windows only). */
async function withDesktopHelper<T>(work: (client: CuaClient) => Promise<T>, timeoutMs?: number): Promise<T | null> {
  if (!["darwin", "win32"].includes(process.platform) && process.env.REALBUD_CUA_TEST_READY !== "1") return null;
  const connection = readCuaConnection();
  if (!connection) return null;
  const client = await startCuaClient(connection, timeoutMs ? { timeoutMs } : {});
  try { return await work(client); } finally { client.close(); }
}
const listWith = async (client: CuaClient) => {
  const listed = await client.call("list_windows", {});
  if (listed.isError) throw fail(503, DESKTOP_UNAVAILABLE);
  return desktopWindowChoices(listed.structuredContent?.windows);
};

/** `GET /api/desktop/windows`: the open windows a task may use, or null when this computer cannot list them. */
export async function listDesktopWindows(options: { timeoutMs?: number } = {}): Promise<DesktopTarget[] | null> {
  return withDesktopHelper(listWith, options.timeoutMs);
}

/** Start's check: the chosen window is still open and offered, and its controls read (not degraded, not empty).
 * Returns the window as listed now; anything else is a plain refusal and nothing starts. */
export async function checkDesktopWindow(choice: { pid: number; windowId: number }): Promise<DesktopTarget> {
  const target = await withDesktopHelper(async client => {
    const window = (await listWith(client)).find(row => row.pid === choice.pid && row.windowId === choice.windowId);
    if (!window) throw fail(409, "That window is no longer open, or Bud does not work in that app. Choose the window again.");
    const read = await client.call("get_window_state", { pid: window.pid, window_id: window.windowId, include_screenshot: false });
    const raw = read.structuredContent ?? read;
    const degraded = Boolean(raw && typeof raw === "object" && (raw as Record<string, unknown>).degraded_reason != null);
    if (read.isError || degraded || !desktopSnapshot(raw).elements.some(element => !element.menuBar && element.token)) {
      throw fail(409, "RealBud could not read the controls in that window, so the task did not start. Bring the window to the front and press Start again.");
    }
    return window;
  }).catch((error: unknown) => { throw typeof (error as { status?: unknown })?.status === "number" ? error : fail(503, DESKTOP_UNAVAILABLE); });
  if (!target) throw fail(503, DESKTOP_UNAVAILABLE);
  return target;
}

/** Start's `window` field: exactly `{pid, windowId}`, or a plain refusal. */
export function desktopWindowChoice(value: unknown): { pid: number; windowId: number } {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const id = (item: unknown) => typeof item === "number" && Number.isSafeInteger(item) && item > 0;
  if (!row || Object.keys(row).length !== 2 || !id(row.pid) || !id(row.windowId)) throw fail(400, "Choose the app window again.");
  return { pid: row.pid as number, windowId: row.windowId as number };
}
