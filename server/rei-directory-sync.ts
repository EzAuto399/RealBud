// Refresh from REI: Bud reads the office's REI Cloud Tenants or Suppliers list
// itself, through RealBud's work browser, and the person saves the result.
//   tenants   → the W1 tenant directory (server/tenant-directory.ts): each
//               tenant's REI Reference goes in the bank file's last column;
//   suppliers → the W4 supplier directory (server/supplier-directory.ts).
// Modelled on the W1 host's REI stages (server/w1-host.ts): the host issues a
// grant itself for each attempt (the REI site and sign-in host from the pack,
// the selected browser and the saved REI business code, 30 minutes, no
// uploads, consequential steps asked each time) and the pack's recipe runs
// through the browser broker. The grant carries exactly what the recipe needs
// and is refused if that is anything beyond read, navigate and click. The
// recipe reads the list's own grid (scrolled until every row has loaded); there
// is no export or download. Any ask the broker raises is answered only through
// this module's answer route. Signed out → the existing sign-in handover ("Sign
// in to REI Cloud"), then the same read runs again. The rows read become a CSV
// in the grid's column order, read with the CSV parsers the manual imports use,
// and their count is compared with the list's "N records" footer. Nothing is
// saved until the person presses Save on the preview, with the directory
// revision they saw; a read shorter than REI's footer, or one whose footer
// could not be read, cannot be saved. Stop ends the run at any step and saves nothing. Cookies and
// passwords stay in the work browser; Bud never sees them. The scheduled check
// (a loop run) waits on REI's sign-in page until the end of the office day
// and survives a restart (owner decision, 6 Oct 2026; server/w1-sign-in-wait.ts).
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR } from "./config.ts";
import type { BrowserSessionRuntime } from "./browser-session.ts";
import { parseCsvTable } from "./csv-ledger.ts";
import { HumanHandoffs } from "./human-handoffs.ts";
import { answerPortalRecipeAsk, loadShippedPortalRecipePack, portalRecipeApprovalChannel, type PackLoader } from "./portal-recipe-task.ts";
import { portalRecipeGrantNeeds, runPortalRecipes, type PortalRecipeResult, type PortalRunResult } from "./portal-recipe-runner.ts";
import { redactSecretsInText } from "./redact.ts";
import type { createSupplierDirectory } from "./supplier-directory.ts";
import { parseTenantList, type TenantDirectoryStore, type TenantEntry, type TenantRejection } from "./tenant-directory.ts";
import type { W1HostDeps } from "./w1-host.ts";
import { reiSignInWaits, withReiSignInWait, type ReiWaitCopy } from "./w1-sign-in-wait.ts";
import { workflowDatabase } from "./workflow-services.ts";
import { normalizeSupplierRows, type Supplier } from "../shared/supplier-directory.ts";
import { parseBrowserTaskGrant, type BrowserActionClass } from "../shared/browser-task.ts";

export type ReiDirectoryKind = "tenants" | "suppliers";
const PORTAL = "rei-cloud";
const RECIPE: Record<ReiDirectoryKind, string> = { tenants: "tenant-list", suppliers: "supplier-list" };
const LIST: Record<ReiDirectoryKind, string> = { tenants: "tenant list", suppliers: "supplier list" };
const SOURCE: Record<ReiDirectoryKind, string> = { tenants: "REI Tenants list (read from the page)", suppliers: "REI Suppliers list (read from the page)" };
/** What a directory refresh may ever be granted: reading the list's own page. */
const ALLOWED: readonly BrowserActionClass[] = ["read", "navigate", "click"];
const STOPPED = "Stopped. Nothing was saved.";
const SIGN_IN_HOLD = "Finish the saved sign-in handover before starting more browser work.";
const NO_BROWSER = "The work browser could not be opened. Check that Chrome or Edge is installed, then try again.";
const WAIT_COPY = (until: string): ReiWaitCopy => ({
  first: `Sign in to REI Cloud so Bud can check the supplier list. REI's sign-in page is open in the work browser; Bud carries on by itself once you're signed in (waiting until ${until}).`,
  reminder: `Reminder: sign in to REI Cloud so Bud can check the supplier list. Bud waits until ${until}, then the next scheduled check tries again.` });
export const SUPPLIER_MISSED = "Missed: REI Cloud wasn't signed in today, so the supplier list wasn't checked. The next scheduled check tries again.";
const readOnly = async (): Promise<never> => { throw new Error("Read-only sign-in hold check."); };

type SignIn = NonNullable<W1HostDeps["openForSignIn"]>;
type SupplierStore = ReturnType<typeof createSupplierDirectory>;
export interface ReiDirectorySyncDeps {
  /** Where the scheduled check saves its sign-in wait (server/w1-sign-in-wait.ts; default: the office data folder). */
  dataDir?: string;
  runtime: BrowserSessionRuntime & { connect?: () => Promise<unknown> };
  /** The selected browser when it is ready, else null. */
  browserId: () => Promise<string | null>;
  /** The office's REI account: the top-bar business code, and a reicid only when one was saved (W1 settings). */
  account: () => Promise<{ marker: string; urlValue?: string } | null>;
  tenants: TenantDirectoryStore;
  suppliers: SupplierStore;
  /** The pack's recipes (default: the repo pack, never with learned paths). */
  load?: PackLoader;
  /** The sign-in handover (server/browser-sign-in.ts), read at each use (the test lab turns its own on later). */
  signIn?: () => SignIn | undefined;
  signInHolding?: () => boolean;
  pollMs?: number;
  /** The office timezone for the scheduled check's sign-in deadline (undefined: this computer's). */
  timeZone?: () => Promise<string | undefined>;
  /** The clock for the scheduled check's sign-in wait (the lab moves it). */
  now?: () => number;
  /** How often the scheduled check's sign-in wait checks for its midday reminder. */
  waitPollMs?: number;
}

export interface ReiDirectoryPreview {
  file: { name: string; size: number; sha256: string };
  /** `file`: the list as read from REI's page, as CSV (no file is downloaded). Rows read, and the list's own "N records" footer when it was readable. */
  rows: number; footer: number | null; countMatches: boolean | null;
  accepted: number; rejected: TenantRejection[];
  withoutEmail?: number;
  /** Against the saved directory at `baseRevision`. */
  added: number; removed: number; changed: number; unchanged: boolean; baseRevision: number;
  /** Suppliers only: who was added or removed and whose emails changed, for the person to approve. */
  changes?: SupplierChanges;
}
/** At most this many suppliers are listed per kind of change; the counts above stay exact. */
const MAX_LISTED = 50;
export interface SupplierChanges {
  added: Supplier[]; removed: Supplier[];
  emails: Array<{ reference: string; description: string; before: string[]; after: string[] }>;
  /** REI returned far fewer suppliers than before: held with a warning, saved only when the person confirms. */
  bigDrop: boolean;
}
/** Who was added, removed or had their emails changed, by REI Reference. More than 30% of saved suppliers removed is a big drop. */
export function supplierChanges(saved: readonly Supplier[], next: readonly Supplier[]): SupplierChanges {
  const before = new Map(saved.map(s => [s.reference, s])), after = new Set(next.map(s => s.reference));
  const key = (emails: readonly string[]) => [...emails].sort().join(",");
  const removed = saved.filter(s => !after.has(s.reference));
  return {
    added: next.filter(s => !before.has(s.reference)).slice(0, MAX_LISTED),
    removed: removed.slice(0, MAX_LISTED),
    emails: next.flatMap(s => { const old = before.get(s.reference); return old && key(old.emails) !== key(s.emails) ? [{ reference: s.reference, description: s.description, before: old.emails, after: s.emails }] : []; }).slice(0, MAX_LISTED),
    bigDrop: saved.length > 0 && removed.length / saved.length > 0.3,
  };
}
export const SUPPLIER_BIG_DROP = "REI returned far fewer suppliers than before — check REI's Suppliers list before approving.";
/** What the Schedule run says while the supplier check waits or after it ends. */
export interface SupplierCheckResult { ok: boolean; status: "completed" | "awaiting-approval" | "failed" | "missed"; detail: string; quiet?: boolean }
const WHERE = "Bills and calendar → Maintenance checks";
type Phase = "working" | "preview" | "saved" | "stopped" | "failed";
interface Run {
  id: string; kind: ReiDirectoryKind; phase: Phase; startedAt: string; message: string | null;
  /** Started by the person (Refresh from REI) or by the scheduled Supplier list check. */
  origin: "person" | "schedule";
  ask: { requestId: string; tool: string; summary: string } | null;
  /** The sign-in handover's thread while Bud waits for the person (GET /api/browser/sign-in?threadId=…). */
  signIn: string | null;
  preview: ReiDirectoryPreview | null;
  saved: { revision: number; changed: boolean } | null;
}
type Parsed = { kind: "tenants"; tenants: TenantEntry[] } | { kind: "suppliers"; csv: string };

const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong.";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const csvCell = (text: string) => /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
/** The rows read from REI's grid as a CSV, header first in the grid's column order, for the imports' own parsers. */
function gridCsv(rows: PortalRecipeResult["rows"]): string {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return [columns, ...rows.map(row => columns.map(column => row[column] ?? ""))].map(cells => cells.map(csvCell).join(",")).join("\n") + "\n";
}
/** Added, removed and changed entries by reference. */
function diff<T extends { reference: string }>(saved: readonly T[], next: readonly T[]) {
  const before = new Map(saved.map(item => [item.reference, JSON.stringify(item)])), after = new Set(next.map(item => item.reference));
  const added = next.filter(item => !before.has(item.reference)).length, removed = saved.filter(item => !after.has(item.reference)).length;
  const changed = next.filter(item => before.has(item.reference) && before.get(item.reference) !== JSON.stringify(item)).length;
  return { added, removed, changed, unchanged: JSON.stringify(saved) === JSON.stringify(next) };
}
/** Exactly what the supplier import would save (server/supplier-directory.ts redacts descriptions). */
const importedSuppliers = (suppliers: Supplier[]) => suppliers.map(s => ({ ...s, description: redactSecretsInText(s.description) }));

/** Why a read ended, in words the office can act on. */
function endedBecause(kind: ReiDirectoryKind, run: PortalRunResult, marker: string): string {
  const detail = run.detail ? ` ${run.detail}` : "";
  if (run.reason?.startsWith("account-")) return `REI is open in a different business than ${marker}. Switch business in REI, then refresh again. Nothing was saved.`;
  if (run.reason === "not-approved") return `You didn't allow that step in REI, so the ${LIST[kind]} was not read. Nothing was saved.`;
  if (run.reason === "control-missing" || run.reason === "menu-label-missing") return `RealBud could not find REI's ${LIST[kind]}.${detail} Nothing was saved.`;
  if (run.reason === "sign-in" || run.reason === "choose-tab") return `Sign in to REI Cloud in the work browser, then refresh again. Nothing was saved.`;
  return `REI's ${LIST[kind]} could not be read (${run.reason ?? run.outcome}).${detail} Nothing was saved.`;
}

export function createReiDirectorySync(deps: ReiDirectorySyncDeps) {
  // The repo pack only: the recipe reads the list's own grid, so a learned export path (Ask) would only add a report and a download
  // it does not need, and a watch-and-learn recipe never joins an unattended read.
  const load: PackLoader = deps.load ?? loadShippedPortalRecipePack;
  const signInHolding = deps.signInHolding ?? (() => new HumanHandoffs(workflowDatabase(), { release: readOnly, verify: readOnly }).isHolding());
  const waits = reiSignInWaits(deps.dataDir ?? DATA_DIR), now = deps.now ?? Date.now;
  let current: Run | null = null;
  let parsed: Parsed | null = null;
  let stop: AbortController | null = null;
  let working: Promise<void> | null = null;

  async function directories() {
    const tenants = deps.tenants.read(), suppliers = await deps.suppliers.read();
    return {
      tenants: { revision: tenants.revision, count: tenants.directory?.tenants.length ?? 0, savedAt: tenants.directory?.savedAt ?? null },
      suppliers: { revision: suppliers.revision, count: suppliers.suppliers.length, savedAt: suppliers.importedAt },
    };
  }
  async function status() {
    const account = await deps.account().catch(() => null);
    return { account: account?.marker ?? null, ...(await directories()), run: current && { ...structuredClone(current), working: working !== null } };
  }

  /** One attempt under a fresh host-issued grant. */
  async function attempt(run: Run, signal: AbortSignal, account: { marker: string; urlValue?: string }) {
    if (signal.aborted) fail(409, STOPPED);
    if (signInHolding()) fail(409, SIGN_IN_HOLD);
    const browserId = await deps.browserId();
    if (!browserId) return null;
    const pack = await load(PORTAL), runs = [{ recipe: "open-session" }, { recipe: RECIPE[run.kind] }];
    if (!pack.recipes[RECIPE[run.kind]]) fail(409, `RealBud has no REI recipe for the ${LIST[run.kind]} yet.`);
    const needs = portalRecipeGrantNeeds(pack, runs);
    const beyond = needs.actions.filter(action => !ALLOWED.includes(action));
    if (beyond.length) fail(409, `The ${LIST[run.kind]} recipe asks for more than reading (${beyond.join(", ")}). Nothing was started.`);
    const id = randomUUID();
    const text = `Refresh the ${LIST[run.kind]} from REI for ${account.marker}: read every row of the list on its page. Read only; nothing in REI changes.`;
    const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id, runId: `rei-dir-${run.id}`, route: "schedule",
      request: { text, sha256: sha256(text) }, sites: needs.sites, browser: { id: browserId, accountMarker: account.marker },
      actions: needs.actions, consequential: "ask-each", uploads: [], expiresAt: Date.now() + 30 * 60_000, budget: null });
    const approve = portalRecipeApprovalChannel(`rei-dir:${run.id}`, ask => { run.ask = { requestId: ask.requestId, tool: ask.tool, summary: redactSecretsInText(ask.summary).slice(0, 600) }; },
      requestId => { if (run.ask?.requestId === requestId) run.ask = null; });
    return runPortalRecipes({ pack, runs, account, grant, threadId: `rei-dir-${run.id}-${id}`, runtime: deps.runtime, approve, signal,
      ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}) });
  }

  /** `note`: the scheduled check's Schedule row, whose run waits on REI's sign-in page until the office day ends. */
  async function execute(run: Run, signal: AbortSignal, note?: (detail: string) => void) {
    const account = await deps.account();
    if (!account) return fail(409, "Save the REI business code (Schedule → Bank reference review → Set up bank imports) before refreshing from REI.");
    // Cold start: open the work browser first; a browser that is still not ready goes to the sign-in handover.
    if (!(await deps.browserId())) {
      try { await deps.runtime.connect?.(); } catch { return fail(409, NO_BROWSER); }
    }
    let done = await attempt(run, signal, account);
    const signIn = deps.signIn?.();
    if ((!done || done.outcome === "handover" && ["sign-in", "choose-tab"].includes(done.reason ?? "")) && signIn) {
      // The person signs in on REI's own page in the work browser; Bud never sees credentials or codes.
      const threadId = `rei-dir-${run.id}`;
      /** One handover, then the same read (signed in is not proof of the account). */
      const handover = async (until?: number) => {
        run.signIn = threadId;
        let opened: Awaited<ReturnType<SignIn>>;
        try { opened = await signIn({ site: PORTAL, reason: `Refresh the ${LIST[run.kind]} from REI`, signal, threadId, ...(account.urlValue ? { account: account.urlValue } : {}), ...(until === undefined ? {} : { until }) }); }
        finally { run.signIn = null; }
        if (signal.aborted) return fail(409, STOPPED);
        if (opened.outcome === "wrong_account") return fail(409, `REI is signed in to a different account than ${account.marker}. Switch account in REI, then refresh again. Nothing was saved.`);
        if (opened.outcome === "timed_out" && until !== undefined) return fail(409, SUPPLIER_MISSED);
        if (opened.outcome !== "signed_in") return fail(409, "Sign in to REI Cloud in the work browser, then refresh again. Nothing was saved.");
        return attempt(run, signal, account);
      };
      done = run.origin !== "schedule" ? await handover()
        // The scheduled check: REI's sign-in page stays open until the office day ends, saved so a restart reopens it.
        : await withReiSignInWait({ waits, loop: "rei-supplier-check", runId: "rei-supplier-check", now, timeZone: await deps.timeZone?.(), note, copy: WAIT_COPY,
          ...(deps.waitPollMs !== undefined ? { pollMs: deps.waitPollMs } : {}), work: handover });
    }
    if (!done) return fail(409, NO_BROWSER);
    if (signal.aborted || done.outcome === "stopped") return fail(409, STOPPED);
    const read = done.results.find(item => item.recipe === RECIPE[run.kind]);
    if (done.outcome !== "completed" || !read || read.table === "unread") return fail(502, endedBecause(run.kind, done, account.marker));
    // The grid as read, as CSV in its own column order, read by the import's own CSV parser.
    const text = gridCsv(read.rows);
    const footer = read.footer ?? null;
    let preview: Omit<ReiDirectoryPreview, "file" | "footer" | "countMatches">;
    if (run.kind === "tenants") {
      const list = parseTenantList(text), saved = deps.tenants.read();
      parsed = { kind: "tenants", tenants: list.tenants };
      preview = { rows: read.rows.length, accepted: list.tenants.length, rejected: list.rejected, ...diff(saved.directory?.tenants ?? [], list.tenants), baseRevision: saved.revision };
    } else {
      let table: string[][], list: ReturnType<typeof normalizeSupplierRows>;
      try { table = parseCsvTable(text); list = normalizeSupplierRows(table); }
      catch (error) { return fail(502, `${error instanceof Error && error.message !== "csv has an unclosed quote" ? error.message : "The supplier list could not be read."} Nothing was saved.`); }
      if (!list.suppliers.length) return fail(502, "No supplier rows could be used. Nothing was saved.");
      const saved = await deps.suppliers.read();
      parsed = { kind: "suppliers", csv: text };
      const next = importedSuppliers(list.suppliers);
      preview = { rows: read.rows.length, accepted: list.suppliers.length, rejected: list.rejected.map(r => ({ row: r.row, reason: redactSecretsInText(r.reason) })),
        withoutEmail: list.suppliers.filter(s => !s.emails.length).length, ...diff(saved.suppliers, next), baseRevision: saved.revision, changes: supplierChanges(saved.suppliers, next) };
    }
    // Complete only when the rows read equal REI's own "N records": a short read, or none to compare, is never saved.
    run.preview = { file: { name: SOURCE[run.kind], size: Buffer.byteLength(text), sha256: sha256(text) }, footer, countMatches: footer === preview.rows, ...preview };
    run.phase = "preview";
    // A complete read that shows the saved tenant list unchanged still renews its freshness for bank imports (W1).
    if (run.kind === "tenants" && run.preview.countMatches && parsed?.kind === "tenants") deps.tenants.markChecked(parsed.tenants);
    run.message = footer === null ? `REI's record count could not be read, so Bud cannot tell the whole ${LIST[run.kind]} was read. Nothing can be saved from it; refresh again.`
      : !run.preview.countMatches ? `Bud read ${preview.rows} rows but REI's list shows ${footer} records. Nothing can be saved from it; refresh again.` : null;
  }

  function start(kind: unknown, origin: Run["origin"] = "person", note?: (detail: string) => void): Run {
    if (kind !== "tenants" && kind !== "suppliers") return fail(400, "Choose the tenant list or the supplier list.");
    if (working) return fail(409, "A refresh from REI is already running. Stop it or wait.");
    const run: Run = { id: `reidir_${randomUUID()}`, kind, origin, phase: "working", startedAt: new Date().toISOString(), message: null, ask: null, signIn: null, preview: null, saved: null };
    const controller = new AbortController();
    current = run; parsed = null; stop = controller;
    const job = execute(run, controller.signal, note).catch(error => {
      run.phase = controller.signal.aborted ? "stopped" : "failed";
      run.message = controller.signal.aborted ? STOPPED : redactSecretsInText(message(error)).slice(0, 600);
      run.preview = null; parsed = null;
    }).finally(() => { run.ask = null; run.signIn = null; if (working === job) { working = null; stop = null; } });
    working = job;
    return run;
  }
  const own = (id: string) => current?.id === id ? current : fail(404, "That refresh has ended. Refresh again.");

  async function save(id: string, expectedRevision: unknown, acknowledgeDrop = false) {
    const run = own(id);
    if (working || run.phase !== "preview" || !run.preview || !parsed) return fail(409, "There is no preview to save. Refresh from REI again.");
    if (!run.preview.countMatches) return fail(409, run.message ?? "The rows read do not match REI's list. Nothing was saved.");
    if (run.preview.changes?.bigDrop && !acknowledgeDrop) return fail(409, SUPPLIER_BIG_DROP);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== run.preview.baseRevision) return fail(409, "The saved list changed since this preview. Refresh from REI again.");
    const source = { name: run.preview.file.name, sha256: run.preview.file.sha256, rows: run.preview.rows };
    let result: { revision: number; changed: boolean };
    if (parsed.kind === "tenants") {
      const saved = deps.tenants.save({ tenants: parsed.tenants, source, expectedRevision });
      result = { revision: saved.revision, changed: saved.saved };
    } else {
      const directory = await deps.suppliers.read();
      if (directory.revision !== expectedRevision) return fail(409, "The saved supplier list changed since this preview. Refresh from REI again.");
      // An unchanged list writes nothing, so a repeat refresh adds no revision.
      if (run.preview.unchanged) result = { revision: directory.revision, changed: false };
      else result = { revision: (await deps.suppliers.importCsv({ csv: parsed.csv, expectedRevision })).directory.revision, changed: true };
    }
    run.phase = "saved"; run.saved = result; parsed = null;
    run.message = result.changed ? `Saved the ${LIST[run.kind]} from REI.` : `The ${LIST[run.kind]} in REI matches the saved one. Nothing changed.`;
  }

  async function handle(path: string, method: string, readBody: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
    if (path === "/api/rei-directory/status" && method === "GET") return { status: 200, body: await status() };
    if (path === "/api/rei-directory/runs" && method === "POST") {
      const body = await readBody();
      if (!object(body) || Object.keys(body).join() !== "kind") return { status: 400, body: { error: "Choose the tenant list or the supplier list." } };
      start(body.kind);
      return { status: 200, body: await status() };
    }
    const match = path.match(/^\/api\/rei-directory\/runs\/(reidir_[a-f0-9-]{36})\/(stop|answer|save)$/);
    if (!match || method !== "POST") return { status: 404, body: { error: "Unknown REI refresh action." } };
    const [, id, action] = match, body = await readBody(), run = own(id);
    if (action === "stop") {
      // Always allowed: ends the browser step in flight (and its open ask or sign-in wait), or discards a preview.
      if (working) { stop?.abort(); await working; }
      else if (run.phase === "preview") { run.phase = "stopped"; run.preview = null; parsed = null; run.message = STOPPED; }
    }
    if (action === "answer") {
      if (!object(body) || typeof body.requestId !== "string" || typeof body.allowed !== "boolean") return { status: 400, body: { error: "Answer the request with allow or don't allow." } };
      if (run.ask?.requestId !== body.requestId || !answerPortalRecipeAsk(`rei-dir:${id}`, body.requestId, body.allowed)) return { status: 409, body: { error: "This request has already been answered or has ended." } };
    }
    if (action === "save") {
      if (!object(body) || !("expectedRevision" in body) || ("acknowledgeDrop" in body && typeof body.acknowledgeDrop !== "boolean")) return { status: 400, body: { error: "Send the saved list's revision." } };
      await save(id, body.expectedRevision, body.acknowledgeDrop === true);
    }
    return { status: 200, body: await status() };
  }
  /** The scheduled Supplier list check (loop rei-supplier-check): the same refresh up to its preview, never saved
   * without the person. Sign-in and every per-run ask wait for the person (`note` tells Schedule); an unchanged
   * list ends quietly; a change, a big drop or a count mismatch waits in Maintenance checks for Approve or Dismiss. */
  async function checkSuppliers(note: (detail: string) => void): Promise<SupplierCheckResult> {
    let run: Run;
    try { run = start("suppliers", "schedule", note); }
    catch (error) { return { ok: false, status: "failed", detail: `${message(error)} The supplier check did not start.` }; }
    let said = "";
    while (working) {
      // While it waits for sign-in the wait itself tells Schedule (once, and at most one midday reminder).
      if (run.signIn) said = "";
      else {
        const detail = run.ask ? `Waiting for you to allow a step in REI. Answer in ${WHERE}.` : "Reading REI's supplier list. Nothing in REI changes.";
        if (detail !== said) { said = detail; note(detail); }
      }
      await Promise.race([working, new Promise(resolve => setTimeout(resolve, deps.pollMs ?? 250))]);
    }
    const preview = run.preview;
    if (run.message === SUPPLIER_MISSED) return { ok: false, status: "missed", detail: SUPPLIER_MISSED };
    if (run.phase !== "preview" || !preview) return { ok: false, status: "failed", detail: run.message ?? "The supplier check could not finish. Nothing was saved." };
    if (!preview.countMatches) return { ok: true, status: "awaiting-approval", detail: `${run.message} Dismiss it in ${WHERE}.` };
    if (preview.unchanged) {
      await save(run.id, preview.baseRevision);
      return { ok: true, status: "completed", quiet: true, detail: "REI's supplier list has not changed." };
    }
    if (preview.changes?.bigDrop) return { ok: true, status: "awaiting-approval", detail: `${SUPPLIER_BIG_DROP} Review it in ${WHERE}.` };
    const emails = preview.changes?.emails.length ?? 0;
    const parts = [preview.added && `${preview.added} added`, preview.removed && `${preview.removed} removed`, emails && `${emails} email${emails === 1 ? "" : "s"} changed`].filter(Boolean);
    return { ok: true, status: "awaiting-approval", detail: `Supplier list changed in REI: ${parts.length ? parts.join(", ") : "supplier details changed"} — review in ${WHERE}.` };
  }
  /** Settles when the run in flight ends (tests). */
  const settled = async () => { await working; };
  return { handle, status, settled, checkSuppliers };
}
export type ReiDirectorySync = ReturnType<typeof createReiDirectorySync>;
