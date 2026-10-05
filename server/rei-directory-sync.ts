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
// and is refused if that is anything beyond read, navigate, click, choosing an
// option (Output: Export Only) and download. The broker asks the person to
// allow the download; that ask is answered only through this module's answer
// route. Signed out → the existing sign-in handover ("Sign in to REI Cloud"),
// then the same read runs again. The saved file is read with the CSV parsers
// the manual imports use, its sha256 checked against the download receipt, and
// its row count compared with the list's "N records" footer when REI shows one.
// Nothing is saved until the person presses Save on the preview, with the
// directory revision they saw; a count that disagrees with REI's footer cannot
// be saved. Stop ends the run at any step and saves nothing. Cookies and
// passwords stay in the work browser; Bud never sees them.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { browserTaskWorkroom } from "./browser-runtime.ts";
import type { BrowserSessionRuntime } from "./browser-session.ts";
import { parseCsvTable } from "./csv-ledger.ts";
import { HumanHandoffs } from "./human-handoffs.ts";
import { answerPortalRecipeAsk, loadPortalRecipePack, portalRecipeApprovalChannel, type PackLoader } from "./portal-recipe-task.ts";
import { portalRecipeGrantNeeds, runPortalRecipes, type PortalRunResult } from "./portal-recipe-runner.ts";
import { portalPaths, type PortalPathStore } from "./portal-path-overrides.ts";
import { redactSecretsInText } from "./redact.ts";
import type { createSupplierDirectory } from "./supplier-directory.ts";
import { parseTenantList, type TenantDirectoryStore, type TenantEntry, type TenantRejection } from "./tenant-directory.ts";
import type { W1HostDeps } from "./w1-host.ts";
import { workflowDatabase } from "./workflow-services.ts";
import { normalizeSupplierRows, type Supplier } from "../shared/supplier-directory.ts";
import { parseBrowserTaskGrant, type BrowserActionClass } from "../shared/browser-task.ts";

export type ReiDirectoryKind = "tenants" | "suppliers";
const PORTAL = "rei-cloud";
const RECIPE: Record<ReiDirectoryKind, string> = { tenants: "tenant-list", suppliers: "supplier-list" };
const LIST: Record<ReiDirectoryKind, string> = { tenants: "tenant list", suppliers: "supplier list" };
/** What a directory refresh may ever be granted. `fill` is only for choosing the report's Output. */
const ALLOWED: readonly BrowserActionClass[] = ["read", "navigate", "click", "fill", "download"];
const STOPPED = "Stopped. Nothing was saved.";
const SIGN_IN_HOLD = "Finish the saved sign-in handover before starting more browser work.";
const NO_BROWSER = "The work browser could not be opened. Check that Chrome or Edge is installed, then try again.";
const readOnly = async (): Promise<never> => { throw new Error("Read-only sign-in hold check."); };

type SignIn = NonNullable<W1HostDeps["openForSignIn"]>;
type SupplierStore = ReturnType<typeof createSupplierDirectory>;
export interface ReiDirectorySyncDeps {
  runtime: BrowserSessionRuntime & { connect?: () => Promise<unknown> };
  /** The selected browser when it is ready, else null. */
  browserId: () => Promise<string | null>;
  /** The office's REI account: the top-bar business code, and a reicid only when one was saved (W1 settings). */
  account: () => Promise<{ marker: string; urlValue?: string } | null>;
  tenants: TenantDirectoryStore;
  suppliers: SupplierStore;
  load?: PackLoader;
  /** Paths Bud learned and the person allowed (server/portal-path-overrides.ts): the current one replaces the repo's export steps. */
  paths?: PortalPathStore;
  /** The sign-in handover (server/browser-sign-in.ts), read at each use (the test lab turns its own on later). */
  signIn?: () => SignIn | undefined;
  signInHolding?: () => boolean;
  pollMs?: number;
}

export interface ReiDirectoryPreview {
  file: { name: string; size: number; sha256: string };
  /** Data rows in REI's export, and the list's own "N records" footer when it was readable. */
  rows: number; footer: number | null; countMatches: boolean | null;
  accepted: number; rejected: TenantRejection[];
  withoutEmail?: number;
  /** Against the saved directory at `baseRevision`. */
  added: number; removed: number; changed: number; unchanged: boolean; baseRevision: number;
}
type Phase = "working" | "preview" | "saved" | "stopped" | "failed";
interface Run {
  id: string; kind: ReiDirectoryKind; phase: Phase; startedAt: string; message: string | null;
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
  if (run.reason === "control-missing" || run.reason === "menu-label-missing") return `RealBud could not find REI's ${LIST[kind]} export.${detail} The export's place in REI may not be mapped yet. Nothing was saved.`;
  if (run.reason === "sign-in" || run.reason === "choose-tab") return `Sign in to REI Cloud in the work browser, then refresh again. Nothing was saved.`;
  return `REI's ${LIST[kind]} could not be read (${run.reason ?? run.outcome}).${detail} Nothing was saved.`;
}

export function createReiDirectorySync(deps: ReiDirectorySyncDeps) {
  // A learned export path wins over the repo's placeholder; with none, the repo recipe runs unchanged.
  const load: PackLoader = async portal => (deps.paths ?? portalPaths()).apply(await (deps.load ?? loadPortalRecipePack)(portal));
  const signInHolding = deps.signInHolding ?? (() => new HumanHandoffs(workflowDatabase(), { release: readOnly, verify: readOnly }).isHolding());
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
    const id = randomUUID(), workroom = browserTaskWorkroom(deps.runtime.root, id);
    const text = `Refresh the ${LIST[run.kind]} from REI for ${account.marker}: read the list and download its export after your approval. Read only; nothing in REI changes.`;
    const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id, runId: `rei-dir-${run.id}`, route: "schedule",
      request: { text, sha256: sha256(text) }, sites: needs.sites, browser: { id: browserId, accountMarker: account.marker },
      actions: needs.actions, consequential: "ask-each", uploads: [], expiresAt: Date.now() + 30 * 60_000, budget: null });
    const approve = portalRecipeApprovalChannel(`rei-dir:${run.id}`, ask => { run.ask = { requestId: ask.requestId, tool: ask.tool, summary: redactSecretsInText(ask.summary).slice(0, 600) }; },
      requestId => { if (run.ask?.requestId === requestId) run.ask = null; });
    const result = await runPortalRecipes({ pack, runs, account, grant, threadId: `rei-dir-${run.id}-${id}`, runtime: deps.runtime, approve, workroom, signal,
      ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}) });
    return { result, workroom };
  }

  async function execute(run: Run, signal: AbortSignal) {
    const account = await deps.account();
    if (!account) return fail(409, "Save the REI business code (Schedule → Bank reference review → Set up bank imports) before refreshing from REI.");
    // Cold start: open the work browser first; a browser that is still not ready goes to the sign-in handover.
    if (!(await deps.browserId())) {
      try { await deps.runtime.connect?.(); } catch { return fail(409, NO_BROWSER); }
    }
    let done = await attempt(run, signal, account);
    const signIn = deps.signIn?.();
    if ((!done || done.result.outcome === "handover" && ["sign-in", "choose-tab"].includes(done.result.reason ?? "")) && signIn) {
      // The person signs in on REI's own page in the work browser; Bud never sees credentials or codes.
      const threadId = `rei-dir-${run.id}`;
      run.signIn = threadId;
      let opened: Awaited<ReturnType<SignIn>>;
      try { opened = await signIn({ site: PORTAL, reason: `Refresh the ${LIST[run.kind]} from REI`, signal, threadId, ...(account.urlValue ? { account: account.urlValue } : {}) }); }
      finally { run.signIn = null; }
      if (signal.aborted) return fail(409, STOPPED);
      if (opened.outcome === "wrong_account") return fail(409, `REI is signed in to a different account than ${account.marker}. Switch account in REI, then refresh again. Nothing was saved.`);
      if (opened.outcome !== "signed_in") return fail(409, "Sign in to REI Cloud in the work browser, then refresh again. Nothing was saved.");
      // Signed in is not proof of the account: the same read runs again and checks it.
      done = await attempt(run, signal, account);
    }
    if (!done) return fail(409, NO_BROWSER);
    const { result, workroom } = done;
    if (signal.aborted || result.outcome === "stopped") return fail(409, STOPPED);
    const read = result.results.find(item => item.recipe === RECIPE[run.kind]);
    if (result.outcome !== "completed" || !read?.download) return fail(502, endedBecause(run.kind, result, account.marker));
    // The file as saved, checked against the download receipt, read by the import's own CSV parser.
    const bytes = await readFile(join(workroom, "downloads", read.download.name));
    if (sha256(bytes) !== read.download.sha256) return fail(502, "The downloaded file changed after it was saved. Nothing was saved; refresh again.");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail(502, `REI's ${LIST[run.kind]} export is not a UTF-8 CSV. Nothing was saved.`); }
    const footer = read.footer ?? null;
    let preview: Omit<ReiDirectoryPreview, "file" | "footer" | "countMatches">;
    if (run.kind === "tenants") {
      const list = parseTenantList(text), saved = deps.tenants.read();
      parsed = { kind: "tenants", tenants: list.tenants };
      preview = { rows: list.rows, accepted: list.tenants.length, rejected: list.rejected, ...diff(saved.directory?.tenants ?? [], list.tenants), baseRevision: saved.revision };
    } else {
      let table: string[][], list: ReturnType<typeof normalizeSupplierRows>;
      try { table = parseCsvTable(text); list = normalizeSupplierRows(table); }
      catch (error) { return fail(502, `${error instanceof Error && error.message !== "csv has an unclosed quote" ? error.message : "The supplier list could not be read."} Nothing was saved.`); }
      if (!list.suppliers.length) return fail(502, "No supplier rows could be used. Nothing was saved.");
      const saved = await deps.suppliers.read();
      parsed = { kind: "suppliers", csv: text };
      preview = { rows: Math.max(0, table.length - 1), accepted: list.suppliers.length, rejected: list.rejected.map(r => ({ row: r.row, reason: redactSecretsInText(r.reason) })),
        withoutEmail: list.suppliers.filter(s => !s.emails.length).length, ...diff(saved.suppliers, importedSuppliers(list.suppliers)), baseRevision: saved.revision };
    }
    run.preview = { file: { name: read.download.name, size: read.download.size, sha256: read.download.sha256 }, footer, countMatches: footer === null ? null : footer === preview.rows, ...preview };
    run.phase = "preview";
    run.message = run.preview.countMatches === false ? `REI's export has ${preview.rows} rows but its list shows ${footer} records. Nothing can be saved from it; check the export in REI.`
      : run.preview.countMatches === null ? "REI's record count could not be read, so the row count was not compared." : null;
  }

  function start(kind: unknown) {
    if (kind !== "tenants" && kind !== "suppliers") return fail(400, "Choose the tenant list or the supplier list.");
    if (working) return fail(409, "A refresh from REI is already running. Stop it or wait.");
    const run: Run = { id: `reidir_${randomUUID()}`, kind, phase: "working", startedAt: new Date().toISOString(), message: null, ask: null, signIn: null, preview: null, saved: null };
    const controller = new AbortController();
    current = run; parsed = null; stop = controller;
    const job = execute(run, controller.signal).catch(error => {
      run.phase = controller.signal.aborted ? "stopped" : "failed";
      run.message = controller.signal.aborted ? STOPPED : redactSecretsInText(message(error)).slice(0, 600);
      run.preview = null; parsed = null;
    }).finally(() => { run.ask = null; run.signIn = null; if (working === job) { working = null; stop = null; } });
    working = job;
  }
  const own = (id: string) => current?.id === id ? current : fail(404, "That refresh has ended. Refresh again.");

  async function save(id: string, expectedRevision: unknown) {
    const run = own(id);
    if (working || run.phase !== "preview" || !run.preview || !parsed) return fail(409, "There is no preview to save. Refresh from REI again.");
    if (run.preview.countMatches === false) return fail(409, run.message ?? "The export's row count does not match REI's list. Nothing was saved.");
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
      if (!object(body) || !("expectedRevision" in body)) return { status: 400, body: { error: "Send the saved list's revision." } };
      await save(id, body.expectedRevision);
    }
    return { status: 200, body: await status() };
  }
  /** Settles when the run in flight ends (tests). */
  const settled = async () => { await working; };
  return { handle, status, settled };
}
export type ReiDirectorySync = ReturnType<typeof createReiDirectorySync>;
