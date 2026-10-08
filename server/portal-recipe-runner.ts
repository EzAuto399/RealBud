// Deterministic portal recipe runner. Replays a workflow pack's recipes
// (server/portal-recipe.ts documents) without a model call per click, as an
// MCP client of the SAME BrowserBroker a Hermes worker uses: every step is a
// broker tool call, so the grant's sites and action classes, the fence's
// classification, per-instance approval of consequential steps, the sign-in
// pause, the budget and Stop all apply unchanged. The runner adds the pack's
// own guards on top (account scope on every read, stop_before and
// consequential labels, forbidden areas, pagination progress, one upload,
// never a retry of an unknown result). It never widens anything: a step the
// broker refuses ends the run.
//
// Approvals: the broker asks through `approve`. A routine ask (no "once"
// policy) for exactly the step the recipe is dispatching is answered by the
// recipe the person started; everything else (consequential or unclassified
// steps, uploads, downloads, anything unexpected) goes to the person's own
// approval channel, and without one it is refused. An upload also needs the
// run's `approved_sha256` input to equal the grant's hash for that file name,
// and the private copy to still hash the same, before the person is asked.
//
// Account scope: the page marker (REI's top-bar business code) must equal the
// selected account on every read; a mismatch always ends the run. The URL
// parameter is checked only when the task names a value and the page shows
// one: REI's addresses carry no reicid after sign-in (seen 2 Oct 2026), so a
// missing parameter is never out of scope by itself.
//
// Portal names never live here: origin, account marker, sign-in hosts,
// routes and labels come from the pack's recipes document.
//
// Drifted controls (Ask only): when a select, type, radio, paginate or read-safe
// click step finds its named control missing or more than once, an injected
// chooser (TypeSafe Jev, server/jev-client.ts) may pick one of the same-role
// controls in the dialog or main region. It sees role and name only, never a
// value or a table's rows. Its pick is data: accepted only above the margin,
// re-guarded by name, never recipe-covered (every ask goes to the person), and
// never under a loop's read, for an upload, download or menu, or for a label
// the recipe stops before.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startBrowserBroker, type BrowserApprovalProjection, type BrowserBroker } from "./browser-broker.ts";
import { accessibleName, consequentialKind, jobBrowserUrl, learnedPressable, portalAccountName, type BrowserPortalControls } from "./browser-authority.ts";
import type { JevRequest, JevResult } from "./jev-client.ts";
import { browserTaskWorkroom, grantedUploadPath, type BrowserJson } from "./browser-runtime.ts";
import type { BrowserSessionRuntime } from "./browser-session.ts";
import { connectedAppOperations, type ConnectedAppOperationStore } from "./connected-app-operations.ts";
import type { BrowserApprovalStore } from "./browser-authority.ts";
import { redactSecretsInText } from "./redact.ts";
import type { PortalPackRecipe, PortalRecipePack } from "./portal-recipe.ts";
import type { BrowserActionClass, BrowserTaskGrant } from "../shared/browser-task.ts";

// ── outcomes ─────────────────────────────────────────────────────────────
export type PortalRunOutcome = "completed" | "handover" | "stopped" | "stopped-before" | "hold" | "blocked";
class RunEnd extends Error {
  readonly outcome: Exclude<PortalRunOutcome, "completed">; readonly reason: string; readonly detail: string;
  constructor(outcome: Exclude<PortalRunOutcome, "completed">, reason: string, detail = "") { super(reason); this.outcome = outcome; this.reason = reason; this.detail = detail; }
}
const handover = (reason: string, detail = "") => new RunEnd("handover", reason, detail);
/** The `choose-tab` detail when no tab is on the portal or its sign-in page (other tabs, such as about:blank, never count). */
export const PORTAL_TAB_MISSING = "Open the portal in your browser and sign in, then start again.";
const blocked = (reason: string, detail = "") => new RunEnd("blocked", reason, detail);

export interface PortalRecipeResult {
  recipe: string;
  outcome: PortalRunOutcome | "not-run";
  rows: Array<Record<string, string>>;
  /** Field values shown on the page when the table was read (the filter state). */
  filters: Record<string, string>;
  table: "rows" | "empty" | "unread";
  pages: number;
  /** The page the table was read from came back cut short (the helper's size cap): its rows may be incomplete. */
  truncated?: true;
  /** The grid's own record count when the table was read, if the page shows one ("N records", or DataTables' "of N entries"; a filtered DataTable gives its unfiltered total). */
  footer?: number;
  controls?: string[];
  /** stop_before labels present on the last page: reached, never pressed. */
  stopBefore: string[];
  download?: { name: string; size: number; sha256: string; contentType: string; rows: string[][] };
  sub?: Record<string, PortalRecipeResult>;
}
/** One chooser question for a drifted control: what was offered (role and name only) and what came of it. */
export interface PortalChooserReceipt {
  model: string | null; questionSha256: string; candidates: Array<{ role: string; name: string }>;
  /** The option id answered ("c0".."c15" or "none"), or null without an answer. */
  pick: string | null; confidence: number | null; top3: number[];
  outcome: "picked" | "below-threshold" | "no-answer" | "refused-by-guard"; ms: number;
}
export interface PortalStepReceipt { recipe: string; index: number; verb: string; target?: string; valueSha256?: string; ok: boolean; ms: number; chooser?: PortalChooserReceipt }
export type PortalChooser = (request: JevRequest, options: { signal?: AbortSignal }) => Promise<JevResult>;
export interface PortalRunReceipt {
  portal: string; origin: string; grantId: string; runId: string; startedAt: number; endedAt: number;
  steps: PortalStepReceipt[];
  /** Broker tool calls by name. */
  tools: Record<string, number>;
  /** Broker asks answered by the recipe the person started, and asks sent to the person. */
  approvals: { recipe: number; person: number };
  accountChecks: number;
  flags: string[];
}
export interface PortalRunResult {
  outcome: PortalRunOutcome;
  reason?: string;
  /** A user-facing sentence from the broker or runner, redacted. */
  detail?: string;
  results: PortalRecipeResult[];
  receipt: PortalRunReceipt;
}
export type PersonApprove = (tool: string, params: BrowserJson, summary: string, signal: AbortSignal, projection?: BrowserApprovalProjection) => Promise<boolean>;
export interface PortalRunRequest { recipe: string; inputs?: Record<string, string> }
export interface PortalRunOptions {
  pack: PortalRecipePack;
  runs: PortalRunRequest[];
  /** The account the person selected for this task: the page marker, and the URL parameter's value when one was saved. */
  account: { urlValue?: string; marker: string };
  /** The task's explicit grant (host-issued). The runner never creates or widens one. */
  grant: BrowserTaskGrant;
  threadId: string;
  runtime: BrowserSessionRuntime;
  /** The person's approval channel. Without it, anything the recipe does not cover is refused. */
  approve?: PersonApprove;
  signal?: AbortSignal;
  isActive?: () => boolean;
  tabId?: number;
  operations?: ConnectedAppOperationStore;
  approvals?: BrowserApprovalStore;
  rules?: () => ReadonlyArray<{ key: string; decision: "allow" | "deny" }>;
  assertCapability?: () => void;
  now?: () => number;
  workroom?: string;
  /** Menu clicks instead of direct routes (for a screen whose route is unknown this happens anyway). */
  menuOnly?: boolean;
  /** Paths the pack's site map calls read-class (a loop's read): the only pages whose grid a loop may scroll. */
  readRoutes?: readonly string[];
  /** Labels the person confirmed while teaching Bud, for the learned recipes this task runs (server/portal-recipe-task.ts).
   * Kept apart from the pack's readSafe: each is clicked only when learnedPressable, and a loop's read never uses them. */
  learnedReadSafe?: readonly string[];
  /** Ask recipe tasks only (server/portal-recipe-task.ts): picks a drifted control (see the header). Ignored under a loop's read. */
  chooser?: PortalChooser;
  pollMs?: number;
  maxWaitReads?: number;
}

// ── the pack's grant needs ───────────────────────────────────────────────
function recipeNames(pack: PortalRecipePack, name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return []; seen.add(name);
  const recipe = pack.recipes[name];
  return [name, ...(recipe?.steps ?? []).flatMap(step => "run" in step ? recipeNames(pack, String(step.run), seen) : [])];
}
/** What a task must grant for these recipes: exact sites and action classes. The host shows and issues it. */
export function portalRecipeGrantNeeds(pack: PortalRecipePack, runs: PortalRunRequest[], menuOnly = false): { sites: string[]; actions: BrowserActionClass[] } {
  const actions = new Set<BrowserActionClass>(["read", "click"]);
  for (const name of new Set(runs.flatMap(run => recipeNames(pack, run.recipe)))) {
    const recipe = pack.recipes[name]; if (!recipe) continue;
    for (const step of recipe.steps) {
      const verb = Object.keys(step)[0];
      if (verb === "nav" && !menuOnly) actions.add("navigate");
      if (verb === "type") { actions.add("fill"); actions.add("keys"); }
      if (verb === "select") actions.add("fill");
      // Next is one of the pack's declared read-safe controls: a click, never a submit.
      if (verb === "upload") actions.add("upload");
      if (verb === "download") actions.add("download");
    }
  }
  return { sites: [new URL(pack.origin).origin, ...pack.signIn.hosts.map(host => `https://${host}`)], actions: [...actions] };
}
/** The pack's declared controls, bound to its origin, for the broker's classifier
 * (server/browser-authority.ts). Menu names come from the pack's screens, never a
 * forbidden area; sign-in hosts are for waiting only. */
export function portalRecipeControls(pack: PortalRecipePack, readRoutes?: readonly string[], learnedReadSafe?: readonly string[]): BrowserPortalControls {
  const forbidden = new Set(pack.labels.forbiddenAreas);
  const menu = new Set(pack.screens.flatMap(screen => screen.menu.filter((_, index) => !forbidden.has(screen.menu.slice(0, index + 1).join(" › ")))));
  // The pager's buttons are read-safe only in a pager beside a table (server/browser-authority.ts).
  const pagination = [pack.pagination.next, ...(pack.pagination.previous ? [pack.pagination.previous] : [])];
  return { origin: new URL(pack.origin).origin, readSafe: [...pack.labels.readSafe], menu: [...menu], pagination,
    ...(pack.pagination.landmark ? { pager: { ...pack.pagination.landmark } } : {}), consequential: [...pack.labels.consequential],
    signInHosts: [...pack.signIn.hosts], accountMarker: { ...pack.account.pageMarker },
    ...(pack.financialRoutes ? { financialRoutes: [...pack.financialRoutes] } : {}), ...(pack.grid ? { gridScroll: pack.grid.scrollContainer } : {}),
    ...(readRoutes ? { readRoutes: [...readRoutes] } : {}), ...(learnedReadSafe?.length ? { learnedReadSafe: [...learnedReadSafe] } : {}) };
}

// ── page model (the helper's VOM text) ───────────────────────────────────
interface Node { indent: number; ref: string | null; role: string; name: string | null; value: string | null; disabled: boolean; parent: Node | null; children: Node[] }
const NODE = /^(?:(@e\d+)\s+)?([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;
const unquote = (raw: string) => { try { return JSON.parse(`"${raw}"`) as string; } catch { return raw.replace(/\\(.)/g, "$1"); } };
function parsePage(text: string): Node {
  const root: Node = { indent: -1, ref: null, role: "root", name: null, value: null, disabled: false, parent: null, children: [] };
  const stack: Node[] = [root];
  for (const raw of text.split("\n")) {
    const body = raw.trimStart(); const indent = raw.length - body.length;
    if (!body || /^@(?:vom|view|layers)\b/.test(body)) continue;
    const match = body.match(NODE); if (!match) continue;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const rest = match[4] ?? ""; const value = rest.match(/value="((?:[^"\\]|\\.)*)"/);
    const node: Node = { indent, ref: match[1] ?? null, role: match[2].toLowerCase(), name: match[3] === undefined ? null : unquote(match[3]),
      value: value ? unquote(value[1]) : null, disabled: /\[disabled\]/i.test(rest), parent: stack[stack.length - 1], children: [] };
    node.parent!.children.push(node); stack.push(node);
  }
  return root;
}
const all = (node: Node, test: (n: Node) => boolean, out: Node[] = []): Node[] => { for (const child of node.children) { if (test(child)) out.push(child); all(child, test, out); } return out; };
const first = (node: Node, test: (n: Node) => boolean) => all(node, test)[0];
const texts = (node: Node): string => [node.name ?? "", ...node.children.map(texts)].join(" ");
const controlName = (label: unknown) => typeof label === "string" ? unquote(label.match(/^\S+\s+"((?:[^"\\]|\\.)*)"/)?.[1] ?? "") : "";
const FOOTER_RECORDS = /^\d[\d,]* records?\b/i;
const FOOTER_ENTRIES = /^Showing [\d,]+ to [\d,]+ of ([\d,]+) entries(?: \(filtered from ([\d,]+) total entries\))?/i;
const TEMPLATE_CELL = /(?:^|\s+)is template cell column header (.*)$/s;
interface PageView { text: string; root: Node; url: string | null }
const FIELD = new Set(["textbox", "searchbox", "textarea", "combobox"]);
const ROWS = new Set(["table", "grid", "treegrid", "row", "rowgroup"]);
/** A chooser's pick counts only when it is not "none", confidence ≥ 0.95, and it leads every other option by ≥ 0.3. */
const CHOOSER_OPTIONS = 16, CHOOSER_CONFIDENCE = 0.95, CHOOSER_MARGIN = 0.3;

// ── tab URL tap ──────────────────────────────────────────────────────────
/** The broker withholds URLs from its tool results (a query can carry tokens).
 * The account check needs the borrowed tab's query parameter, so the runner
 * keeps the URL from the broker's own tab listings: it issues no command and
 * sees only tabs on the grant's sites. */
function tappedRuntime(runtime: BrowserSessionRuntime, sites: string[]) {
  const urls = new Map<number, string>();
  const listTabs: BrowserSessionRuntime["listTabs"] = async (owner, signal) => {
    const result = await runtime.listTabs(owner, signal);
    for (const tab of result) if (jobBrowserUrl(tab.url, sites)) urls.set(tab.id, tab.url);
    return result;
  };
  const proxy = new Proxy(runtime, { get(target, key) {
    if (key === "listTabs") return listTabs;
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { runtime: proxy, url: (tabId: number) => urls.get(tabId) ?? null };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const emptyResult = (recipe: string): PortalRecipeResult => ({ recipe, outcome: "not-run", rows: [], filters: {}, table: "unread", pages: 0, stopBefore: [] });

export async function runPortalRecipes(options: PortalRunOptions): Promise<PortalRunResult> {
  const { pack, account, grant } = options;
  const now = options.now ?? Date.now;
  const operations = options.operations ?? connectedAppOperations;
  const pollMs = options.pollMs ?? 250; const maxWaitReads = options.maxWaitReads ?? 20;
  const receipt: PortalRunReceipt = { portal: pack.portal, origin: pack.origin, grantId: grant.id, runId: grant.runId, startedAt: now(), endedAt: 0, steps: [], tools: {}, approvals: { recipe: 0, person: 0 }, accountChecks: 0, flags: [] };
  const results: PortalRecipeResult[] = options.runs.map(run => emptyResult(run.recipe));
  const finish = (outcome: PortalRunOutcome, reason?: string, detail?: string): PortalRunResult =>
    ({ outcome, ...(reason ? { reason } : {}), ...(detail ? { detail: redactSecretsInText(detail).slice(0, 400) } : {}), results, receipt: { ...receipt, endedAt: now() } });

  // Refuse before opening anything when the task's grant cannot cover the recipes.
  for (const run of options.runs) if (!pack.recipes[run.recipe]) return finish("blocked", "unknown-recipe", `No recipe named ${run.recipe}.`);
  const needs = portalRecipeGrantNeeds(pack, options.runs, options.menuOnly);
  const missing = needs.actions.filter(action => !grant.actions.includes(action));
  if (missing.length) return finish("blocked", "grant-too-narrow", `This task's permission does not include: ${missing.join(", ")}.`);
  if (!jobBrowserUrl(`${pack.origin}/`, grant.sites)) return finish("blocked", "grant-site-missing", "This task's permission does not include the portal's site.");

  // Stop reaches a run three ways: its signal, its owner going inactive, or the global Stop closing every broker.
  let live: BrowserBroker | null = null;
  const stopped = () => Boolean(options.signal?.aborted) || (options.isActive ? !options.isActive() : false) || Boolean(live?.stopped);
  const tap = tappedRuntime(options.runtime, grant.sites);
  let inflight: { tool: string; name?: string; recipe: boolean } | null = null;
  const approve: PersonApprove = async (tool, params, summary, signal, projection) => {
    const step = inflight;
    // A read recipe never answers for a submit: that ask always goes to the person.
    const covered = step?.recipe && projection?.approvalPolicy !== "once" && tool === step.tool &&
      (step.name === undefined || accessibleName(controlName(params.label)) === accessibleName(step.name)) &&
      projection?.fence.surface !== "portal-submit";
    if (covered) { receipt.approvals.recipe += 1; return true; }
    receipt.approvals.person += 1;
    return options.approve ? options.approve(tool, params, summary, signal, projection) : false;
  };
  // A loop's unattended read never sees labels confirmed while teaching Bud.
  const learned = grant.route === "loop-read" ? [] : [...options.learnedReadSafe ?? []];
  // Nor a chooser: unattended, a missing control stays a map-drift block.
  const chooser = grant.route === "loop-read" ? undefined : options.chooser;
  let broker: BrowserBroker;
  try {
    broker = await startBrowserBroker({
      threadId: options.threadId, runId: grant.runId, grant, runtime: tap.runtime,
      context: { allowedOrigins: grant.sites, capabilities: [] },
      isActive: () => !stopped(), approve, portal: portalRecipeControls(pack, options.readRoutes, learned),
      ...(options.operations ? { operations: options.operations } : {}), ...(options.approvals ? { approvals: options.approvals } : {}),
      ...(options.rules ? { rules: options.rules } : {}), ...(options.assertCapability ? { assertCapability: options.assertCapability } : {}),
      ...(options.now ? { now: options.now } : {}), ...(options.workroom ? { workroom: options.workroom } : {}),
    });
  } catch (error) { return finish("blocked", "broker-refused", error instanceof Error ? error.message : ""); }
  live = broker;
  const workroom = options.workroom ?? browserTaskWorkroom(options.runtime.root, grant.id);
  const onStop = () => broker.close();
  options.signal?.addEventListener("abort", onStop, { once: true });

  // ── broker client ──
  let requestId = 0;
  const unknownOps = () => new Set(operations.list(options.threadId).filter(op => op.status === "unknown").map(op => op.id));
  const tool = async (name: string, args: BrowserJson, expect: { tool?: string; name?: string; recipe?: boolean } = {}): Promise<string> => {
    if (stopped()) throw new RunEnd("stopped", "stop");
    receipt.tools[name] = (receipt.tools[name] ?? 0) + 1;
    const before = unknownOps();
    inflight = { tool: expect.tool ?? name, recipe: expect.recipe ?? true, ...(expect.name !== undefined ? { name: expect.name } : {}) };
    let body: { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    try {
      const response = await fetch(broker.descriptor.url, { method: "POST", headers: { "content-type": "application/json", [broker.descriptor.headers[0].name]: broker.descriptor.headers[0].value },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }) });
      if (response.status !== 200) throw new Error(`The browser broker answered ${response.status}.`);
      body = await response.json() as typeof body;
    } catch (error) {
      if (stopped()) throw new RunEnd("stopped", "stop");
      throw blocked("broker-unreachable", error instanceof Error ? error.message : "");
    } finally { inflight = null; }
    const text = body.result?.content?.[0]?.text ?? "";
    if (!body.result?.isError) return text;
    // Never retried: stop, unknown effect, sign-in and refusals each end the run.
    if (stopped()) throw new RunEnd("stopped", "stop", text);
    if ([...unknownOps()].some(id => !before.has(id))) throw new RunEnd("hold", "unknown-result", text);
    if (/sign-in or security fields/i.test(text)) throw handover("sign-in", text);
    if (/Choose and verify the intended account/i.test(text)) throw handover("sign-in", text);
    if (/verified account label is no longer visible/i.test(text)) throw handover("account-marker-changed", text);
    if (/was not approved/i.test(text)) throw handover("not-approved", text);
    throw blocked("broker-refused", text);
  };

  // ── page state ──
  let tabId = 0; let view: PageView | null = null; let stale = true; let drift = false; let uploads = 0; let cut = false;
  const signInOrigins = pack.signIn.hosts.map(host => `https://${host}`);
  const assertAccount = (page: PageView) => {
    if (!page.url) throw handover("account-url-unavailable");
    const at = new URL(page.url);
    if (at.origin !== pack.origin) throw handover("origin-changed");
    // A parameter shown on the page must be the saved one; its absence proves nothing either way.
    const value = at.searchParams.get(pack.account.urlParam);
    if (value !== null && account.urlValue && value !== account.urlValue) throw handover("account-url-changed");
    // One reading of the account marker for the broker and the runner (browser-authority.ts portalAccountName).
    const marker = portalAccountName(page.text, pack.account.pageMarker);
    if (!marker) throw handover("account-marker-missing");
    if (marker !== account.marker) throw handover("account-marker-changed");
    receipt.accountChecks += 1;
  };
  /** Every read is a load check: sign-in pages hand over, then the account must still be the selected one.
   * `allRows`: the broker scrolls the portal's declared lazy grid until every row has loaded (the `read: table` step only). */
  const read = async (allRows = false): Promise<PageView> => {
    const raw = await tool("browser_read", { tab_id: tabId, ...(allRows ? { all_rows: true } : {}) });
    let text = raw;
    try {
      const parsed = JSON.parse(raw) as { text?: unknown; truncated?: unknown };
      if (typeof parsed.text === "string") text = parsed.text;
      // A cut-off page cannot prove a complete table; the caller sees the flag.
      cut = parsed.truncated === true;
      if (cut && !receipt.flags.includes("page-truncated")) receipt.flags.push("page-truncated");
    } catch { /* plain text */ }
    const page: PageView = { text, root: parsePage(text), url: tap.url(tabId) };
    const at = page.url ? new URL(page.url).origin : null;
    if ((at && signInOrigins.includes(at)) || pack.signIn.texts.some(marker => first(page.root, node => (node.role === "heading" || node.role === "rootwebarea") && (node.name ?? "").includes(marker)))) throw handover("sign-in");
    assertAccount(page);
    view = page; stale = false; return page;
  };
  const current = async (allRows = false) => (stale || !view ? read(allRows) : view);
  /** The content a recipe acts in: an open dialog, else the main region; never the menu or header. */
  const scope = (page: PageView) => first(page.root, node => node.role === "dialog" || node.role === "alertdialog") ?? first(page.root, node => node.role === "main") ?? page.root;
  const matching = (page: PageView, roles: string[], name: string) =>
    all(scope(page), node => node.ref !== null && roles.includes(node.role) && node.name !== null && accessibleName(node.name) === accessibleName(name));
  const control = (page: PageView, roles: string[], name: string): Node | null => {
    const found = matching(page, roles, name);
    if (found.length > 1) throw blocked("ambiguous-control", `More than one ${name} control is on the page.`);
    return found[0] ?? null;
  };
  /** What a chooser may be offered: same-role named controls in an open dialog or the main region (never the page's
   * menus), outside any table's rows (row data never leaves), at most CHOOSER_OPTIONS. */
  const choices = (page: PageView, roles: string[]) => {
    const where = scope(page);
    const inRows = (node: Node) => { for (let at = node.parent; at && at !== where; at = at.parent) if (ROWS.has(at.role)) return true; return false; };
    return where === page.root ? [] : all(where, node => node.ref !== null && roles.includes(node.role) && accessibleName(node.name) !== "" && !inRows(node)).slice(0, CHOOSER_OPTIONS);
  };
  const act = async (name: string, args: BrowserJson, expect: { name?: string; recipe?: boolean } = {}) => {
    stale = true; const text = await tool(name, { tab_id: tabId, ...args }, expect); await read(); return text;
  };
  const tableOf = (page: PageView) => {
    const table = first(scope(page), node => node.role === "table" || node.role === "grid");
    if (!table) return null;
    // A grid's rows may sit inside rowgroups (Syncfusion's header and body; any thead/tbody), never inside another row.
    const rowsOf = (node: Node): Node[] => node.children.flatMap(child => child.role === "row" ? [child] : rowsOf(child));
    const rows = rowsOf(table);
    const header = rows.find(row => row.children.some(cell => cell.role === "columnheader"));
    const cols = header ? header.children.filter(cell => cell.role === "columnheader").map(cell => cell.name ?? "") : [];
    // A Syncfusion template cell is named "<text> is template cell column header <Col>": the text, keyed by that column.
    const data = rows.filter(row => row !== header).map(row => row.children.filter(cell => cell.role === "cell" || cell.role === "gridcell" || cell.ref !== null).map(cell => {
      const shown = (cell.name ?? texts(cell)).trim(); const template = TEMPLATE_CELL.exec(shown);
      return template ? { text: shown.slice(0, template.index).trim(), col: template[1].trim() } : { text: shown, col: undefined };
    }));
    const loading = data.length === 1 && data[0].length === 1 && /^loading/i.test(data[0][0].text);
    const empty = data.length === 1 && data[0].length === 1 && /no (?:records|matching|data)/i.test(data[0][0].text);
    // A column with no header name (Syncfusion's hidden first column) is not a field.
    const records = loading || empty ? [] : data.map(cells => Object.fromEntries(cells.map((cell, index) => [cell.col ?? cols[index] ?? String(index), cell.text]).filter(([key]) => key !== "")));
    // A grid footer such as "N records · 0 row(s) selected", or DataTables' "Showing 1 to 10 of N entries", is the load-complete marker.
    const footer = all(table.parent ?? scope(page), node => FOOTER_RECORDS.test(node.name ?? "") || FOOTER_ENTRIES.test(node.name ?? ""))[0];
    const numeral = (text: string | undefined) => text === undefined ? null : Number(text.replaceAll(",", ""));
    const entries = footer ? FOOTER_ENTRIES.exec(footer.name!) : null;
    // `count`: rows the grid holds under its current filter (settles the wait, so an empty search settles at 0).
    // `whole`: the completeness count. A filtered DataTable counts its unfiltered total: a filtered list is not the whole list.
    const count = !footer ? null : entries ? numeral(entries[1]) : numeral(footer.name!.match(/^[\d,]+/)![0]);
    const whole = entries?.[2] !== undefined ? numeral(entries[2]) : count;
    return { loading, empty, records, count, whole };
  };
  const waitTable = async (allRows = false) => {
    if (allRows) stale = true;
    for (let attempt = 0; attempt <= maxWaitReads; attempt++) {
      const page = await current(allRows); const table = tableOf(page);
      // A grid can show "No records to display" before it fills: an empty grid is settled once its
      // footer counts it, and one without a footer is re-read until the wait runs out.
      const settled = table && !table.loading && (table.count === null ? table.records.length > 0 || attempt === maxWaitReads : table.count === 0 || table.records.length > 0);
      if (settled) return table;
      if (!table && attempt === maxWaitReads) break;
      if (table && !table.loading && attempt === maxWaitReads) break;
      await sleep(pollMs); stale = true;
    }
    throw blocked("table-did-not-settle");
  };
  const filters = (page: PageView) => Object.fromEntries(all(scope(page), node => FIELD.has(node.role) && node.name !== null).map(node => [node.name!, node.value ?? ""]));

  // ── recipes ──
  const readSafe = new Set(pack.labels.readSafe); const consequential = new Set(pack.labels.consequential);
  const runRecipe = async (name: string, inputs: Record<string, string>, result: PortalRecipeResult): Promise<void> => {
    const recipe: PortalPackRecipe = pack.recipes[name];
    for (const input of recipe.inputs) if (!(input in inputs)) throw blocked("missing-input", `The ${name} recipe needs ${input}.`);
    const fill = (value: unknown): string => String(value).replace(/\{(\w+)\}/g, (_, key: string) => { if (!(key in inputs)) throw blocked("missing-input", `The ${name} recipe needs ${key}.`); return inputs[key]; });
    const stops = new Set([...recipe.stopBefore, ...consequential]);
    /** A consequential word, or a label this recipe stops before (or the pack calls consequential) as a whole phrase in the name. */
    const stopName = (name: string) => consequentialKind(name) !== null || [...stops].some(label =>
      new RegExp(`(?:^|[^\\p{L}\\p{N}])${accessibleName(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}\\p{N}])`, "iu").test(accessibleName(name)));
    const sameAs = (labels: Iterable<string>, name: string) => [...labels].some(label => accessibleName(label) === accessibleName(name));
    /** One chooser question for a drifted step; the offered index when its answer clears the margin and `allowed` passes the pick's own name. */
    const choose = async (entry: PortalStepReceipt, page: PageView, wanted: string, offered: Node[], allowed: (name: string) => boolean): Promise<number | null> => {
      const candidates = offered.map(node => ({ role: node.role, name: redactSecretsInText(accessibleName(node.name)).slice(0, 200) }));
      const criteria: Record<string, string> = Object.fromEntries(candidates.map((item, at) => [`c${at}`, `${item.role} "${item.name}"`]));
      criteria.none = "None of these controls, or not sure.";
      const request: JevRequest = {
        state: { step: entry.verb, wanted, page: { title: redactSecretsInText(first(page.root, node => node.role === "rootwebarea")?.name ?? "").slice(0, 200), path: page.url ? new URL(page.url).pathname : "" }, candidates },
        questions: { control: { type: "choice", criteria,
          instructions: "A saved portal recipe step names a control (wanted) that is not on this page exactly once. Which listed control is that same control, renamed or relabelled? Choose none unless one clearly is." } },
      };
      const started = now();
      let result: JevResult;
      try { result = await chooser!(request, options.signal ? { signal: options.signal } : {}); } catch { result = { ok: false, reason: "http" }; }
      const answer = result.ok && result.answers.control?.type === "choice" ? result.answers.control : null;
      const p = answer?.probabilities ?? {};
      const at = answer && /^c\d{1,2}$/.test(answer.choice) ? Number(answer.choice.slice(1)) : -1;
      // Missing confidence or probabilities count as below the threshold.
      const sure = answer !== null && at >= 0 && at < offered.length && (answer.confidence ?? 0) >= CHOOSER_CONFIDENCE && p[answer.choice] !== undefined &&
        p[answer.choice] - Math.max(0, ...Object.entries(p).filter(([key]) => key !== answer.choice).map(([, value]) => value)) >= CHOOSER_MARGIN;
      const outcome = !answer ? "no-answer" : !sure ? "below-threshold" : allowed(offered[at].name!) ? "picked" : "refused-by-guard";
      entry.chooser = { model: result.ok ? result.model : null, questionSha256: sha256(JSON.stringify(request)), candidates, pick: answer?.choice ?? null,
        confidence: answer?.confidence ?? null, top3: Object.values(p).sort((a, b) => b - a).slice(0, 3), outcome, ms: now() - started };
      if (outcome !== "picked") return null;
      // A drifted page, like a drifted version: no upload or download follows in this run.
      drift = true; receipt.flags.push(`map-drift: "${wanted}" → "${candidates[at].name}"`);
      return at;
    };
    /** The step's named control. On a miss or ambiguity the chooser (Ask only, once per step, never for a label the recipe
     * stops before) may pick a same-role control; the pick's own name must pass `allowed` and stopName. `pick` marks it. */
    const resolve = async (entry: PortalStepReceipt, roles: string[], wanted: string, allowed: (name: string) => boolean = () => true): Promise<{ node: Node; pick?: number } | null> => {
      const page = await current();
      const found = matching(page, roles, wanted);
      if (found.length === 1) return { node: found[0] };
      const offered = chooser && !entry.chooser && !stopName(wanted) ? choices(page, roles) : [];
      const pick = offered.length ? await choose(entry, page, wanted, offered, name => allowed(name) && !stopName(name)) : null;
      if (pick !== null) return { node: offered[pick], pick };
      if (found.length > 1) throw blocked("ambiguous-control", `More than one ${wanted} control is on the page.`);
      return null;
    };
    /** A chosen node goes through the same broker path, but the recipe never answers for it: every ask goes to the person. */
    const by = (found: { node: Node; pick?: number }, name: string) => found.pick === undefined ? { name } : { name: found.node.name!, recipe: false as const };
    for (const [index, step] of recipe.steps.entries()) {
      if (stopped()) throw new RunEnd("stopped", "stop");
      const [verb, raw] = Object.entries(step)[0];
      const started = now(); const entry: PortalStepReceipt = { recipe: name, index, verb, ok: false, ms: 0 };
      receipt.steps.push(entry);
      const arg = (key: string) => fill((raw as Record<string, unknown>)[key]);
      switch (verb) {
        case "check": {
          entry.target = String(raw);
          const page = await current(); // read() already enforced sign-in and account on this page
          if (raw === "origin" && (!page.url || new URL(page.url).origin !== pack.origin)) throw handover("origin-changed");
          if (raw === "account") assertAccount(page);
          if (raw === "version") {
            const landmark = first(page.root, node => node.role === pack.versionMarker.landmark);
            const shown = landmark ? texts(landmark).match(new RegExp(pack.versionMarker.pattern))?.[1] : undefined;
            if (shown !== pack.uiVersion) { drift = true; receipt.flags.push(`map-drift ${shown ?? "unreadable"}`); }
          }
          break;
        }
        case "nav": {
          const path = (raw as unknown[]).map(fill); entry.target = path.join(" › ");
          for (let i = 1; i <= path.length; i++) if (pack.labels.forbiddenAreas.includes(path.slice(0, i).join(" › "))) throw handover("forbidden-area", path.slice(0, i).join(" › "));
          const route = pack.routes[path.join(" › ")];
          if (route && !options.menuOnly) {
            // Direct route (with the saved account parameter, if any); the read after it re-checks the account.
            const target = new URL(route, pack.origin); if (account.urlValue) target.searchParams.set(pack.account.urlParam, account.urlValue);
            await act("browser_navigate", { url: target.href });
          } else {
            for (const label of path) {
              const page = await current();
              const menu = first(page.root, node => node.role === "navigation");
              const links = menu ? all(menu, node => node.ref !== null && node.role === "link" && node.name === label) : [];
              if (links.length !== 1) throw blocked("menu-label-missing", `The menu label ${label} was not found once.`);
              await act("browser_click_semantic", { ref: links[0].ref! }, { name: label });
            }
          }
          // A loop's unattended read acts only on the page it meant to open: a redirect elsewhere (a record's edit
          // form) or a dialog open there ends the run before any field is touched.
          if (grant.route === "loop-read") {
            const page = await current();
            const at = page.url ? new URL(page.url).pathname : null;
            if (!route || at !== new URL(route, pack.origin).pathname || first(page.root, node => node.role === "dialog" || node.role === "alertdialog")) {
              throw blocked("unexpected-page", `${path.join(" › ")} did not open its mapped page, or a dialog is open on it.`);
            }
          }
          break;
        }
        case "wait": {
          entry.target = String(raw);
          if (raw === "modal") {
            let open = false;
            for (let attempt = 0; attempt <= maxWaitReads && !open; attempt++) { const page = await current(); open = Boolean(first(page.root, node => node.role === "dialog")); if (!open) { await sleep(pollMs); stale = true; } }
            if (!open) throw blocked("modal-did-not-open");
          } else await waitTable();
          break;
        }
        case "select": {
          const field = arg("field"); const option = arg("option"); entry.target = field;
          const found = await resolve(entry, ["combobox", "listbox"], field);
          if (!found) throw blocked("field-missing", `No ${field} field on the page.`);
          const box = found.node;
          const options = box.children.filter(node => node.role === "option").map(node => node.name ?? "");
          if (options.length && !options.includes(option)) throw blocked("option-missing", `${field} has no option ${option}.`);
          await act("browser_select", { ref: box.ref!, values: [option] }, by(found, field));
          break;
        }
        case "type": {
          const field = arg("field"); const value = arg("value"); entry.target = field; entry.valueSha256 = sha256(value);
          const roles = ["textbox", "searchbox", "textarea"];
          const found = await resolve(entry, roles, field);
          if (!found) throw blocked("field-missing", `No ${field} field on the page.`);
          await act("browser_fill", { ref: found.node.ref!, value }, by(found, field));
          // Tab commits the typed filter (map trap: an uncommitted filter resets on the next click). A picked field is found again by its place.
          const page = await current();
          const again = found.pick === undefined ? control(page, roles, field) : choices(page, roles)[found.pick];
          if (!again || accessibleName(again.name) !== accessibleName(found.node.name)) throw blocked("field-missing", `The ${field} field went away after typing.`);
          await act("browser_press", { ref: again.ref!, key: "Tab" }, by(found, field));
          if (accessibleName(field) === "Search") {
            const table = await waitTable();
            if (table.records.length && !table.records.some(row => Object.values(row).join(" ").toLowerCase().includes(value.toLowerCase()))) throw blocked("search-not-applied");
          }
          break;
        }
        case "radio": {
          const label = fill(raw); entry.target = label;
          const found = await resolve(entry, ["radio"], label);
          if (!found) throw blocked("field-missing", `No ${label} option on the page.`);
          await act("browser_click_semantic", { ref: found.node.ref! }, by(found, label));
          break;
        }
        case "click": {
          // A learned step the map does not call read-safe (server/portal-path-overrides.ts) goes to the person on every run.
          const eachRun = typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).ask === "each-run";
          const label = fill(eachRun ? (raw as Record<string, unknown>).label : raw); entry.target = label;
          if (stops.has(label)) throw new RunEnd("stopped-before", "consequential-label", label);
          if (!eachRun && !readSafe.has(label) && !(learned.includes(label) && learnedPressable(label))) throw blocked("not-read-safe", label);
          // A picked control must itself be one the pack (or this task's teaching) calls read-safe.
          const found = await resolve(entry, ["button", "link", "tab", "menuitem"], label, name => sameAs(readSafe, name) || sameAs(learned, name) && learnedPressable(name));
          if (!found) throw blocked("control-missing", `No ${label} control on the page.`);
          await act("browser_click_semantic", { ref: found.node.ref! }, { ...by(found, label), ...(eachRun ? { recipe: false } : {}) });
          break;
        }
        case "read": {
          entry.target = String(raw);
          const page = await current();
          if (raw === "controls") result.controls = all(scope(page), node => node.name !== null && (FIELD.has(node.role) || node.role === "radio")).map(node => node.name!);
          else {
            const table = await waitTable(true);
            result.rows = [...table.records]; result.table = table.empty || !table.records.length ? "empty" : "rows"; result.pages = 1; result.filters = filters(await current());
            if (cut) result.truncated = true;
            if (table.whole !== null) result.footer = table.whole;
          }
          break;
        }
        case "paginate": {
          entry.target = pack.pagination.next;
          let previous = JSON.stringify((await waitTable()).records);
          // A picked pager control is then found by its own name on each page, and is never recipe-covered.
          let next = { name: pack.pagination.next } as { name: string; recipe?: false };
          for (let guard = 0; ; guard++) {
            if (guard > 200) throw blocked("pagination-did-not-end");
            const found = await resolve(entry, ["button", "link"], next.name);
            if (!found || found.node.disabled) break;
            if (found.pick !== undefined) next = by(found, next.name);
            await act("browser_click_semantic", { ref: found.node.ref! }, next);
            const table = await waitTable(); const signature = JSON.stringify(table.records);
            // A page identical to the last one means the click raced a re-render; counting it would double rows.
            if (signature === previous) throw blocked("pagination-stalled");
            previous = signature; result.rows.push(...table.records); result.pages += 1;
            if (cut) result.truncated = true;
          }
          break;
        }
        case "upload": {
          const field = arg("field"); const file = arg("file"); entry.target = field; entry.valueSha256 = sha256(file);
          if (drift) throw handover("map-drift-blocks-upload");
          if (operations.list(options.threadId).some(op => op.toolName === "browser_upload" && op.status === "unknown")) throw new RunEnd("hold", "earlier-upload-unknown", recipe.onUnknown ?? "");
          if (uploads >= 1) throw new RunEnd("hold", "second-upload-refused");
          const granted = grant.uploads.find(upload => upload.name === file);
          if (!granted) throw handover("upload-not-granted");
          // Exact artifact binding: the run names the reviewed file's hash, the grant lists the same
          // name and hash, and the private copy still has it now (the broker checks again at dispatch).
          if (inputs.approved_sha256 !== granted.sha256) throw handover("upload-not-bound", `The file '${file}' given to this task is not the reviewed file this upload names.`);
          try { await grantedUploadPath(workroom, granted); }
          catch (error) { throw handover("upload-changed", error instanceof Error ? error.message : ""); }
          const input = control(await current(), ["button", "textbox"], field);
          if (!input) throw blocked("field-missing", `No ${field} control on the page.`);
          uploads += 1;
          // Uploads always go to the person: the recipe never answers for a file.
          try { await act("browser_upload", { ref: input.ref!, file }, { recipe: false }); }
          catch (error) { if (error instanceof RunEnd && error.reason === "unknown-result") throw new RunEnd("hold", "unknown-result", recipe.onUnknown ?? error.detail); throw error; }
          break;
        }
        case "download": {
          const label = arg("label"); entry.target = label;
          if (drift) throw handover("map-drift-blocks-download");
          if (stops.has(label)) throw new RunEnd("stopped-before", "consequential-label", label);
          const target = control(await current(), ["button", "link"], label);
          if (!target) throw blocked("control-missing", `No ${label} control on the page.`);
          const text = await act("browser_download", { ref: target.ref! }, { recipe: false });
          const saved = (JSON.parse(text) as { downloaded?: PortalRecipeResult["download"] }).downloaded;
          if (!saved) throw new RunEnd("hold", "download-unconfirmed", recipe.onUnknown ?? "");
          const rows = saved.contentType === "text/plain" ? (await readFile(join(workroom, "downloads", saved.name), "utf8")).trim().split(/\r?\n/).map(line => line.split(",")) : [];
          result.download = { name: saved.name, size: saved.size, sha256: saved.sha256, contentType: saved.contentType, rows };
          // The file's own account and period are the pack's to verify; the runner only proves it was the approved download.
          receipt.flags.push(`download-contents-unverified ${name}`);
          break;
        }
        case "run": {
          const sub = String(raw); entry.target = sub;
          const inner = emptyResult(sub); (result.sub ??= {})[sub] = inner;
          await runRecipe(sub, inputs, inner); inner.outcome = "completed";
          break;
        }
        default: throw blocked("unknown-verb", verb);
      }
      entry.ok = true; entry.ms = now() - started;
    }
    const page = await current();
    const screen = pack.screens.find(item => pack.routes[item.menu.join(" › ")] && page.url && new URL(page.url).pathname === pack.routes[item.menu.join(" › ")]);
    const watch = new Set([...recipe.stopBefore, ...(screen?.stop ?? [])]);
    result.stopBefore = [...new Set(all(scope(page), node => node.ref !== null && watch.has(node.name ?? "")).map(node => node.name!))];
  };

  try {
    const listing = JSON.parse(await tool("browser_tabs", {})) as { tabs?: Array<{ tab_id: number; site: string }> };
    const candidates = (listing.tabs ?? []).filter(tab => tab.site === pack.origin || signInOrigins.includes(tab.site));
    const chosen = options.tabId !== undefined ? candidates.filter(tab => tab.tab_id === options.tabId) : candidates;
    if (chosen.length !== 1) return finish("handover", "choose-tab", chosen.length ? "More than one portal tab is open. Choose the one Bud should use." : PORTAL_TAB_MISSING);
    tabId = chosen[0].tab_id;
    await tool("browser_borrow", { tab_id: tabId }, { tool: "browser_read" });
    for (const [index, run] of options.runs.entries()) {
      const result = results[index];
      try { await runRecipe(run.recipe, run.inputs ?? {}, result); result.outcome = "completed"; }
      catch (error) { if (error instanceof RunEnd) result.outcome = error.outcome; throw error; }
    }
    return finish("completed");
  } catch (error) {
    if (error instanceof RunEnd) return finish(stopped() ? "stopped" : error.outcome, stopped() ? "stop" : error.reason, error.detail);
    return finish(stopped() ? "stopped" : "blocked", stopped() ? "stop" : "runner-error", error instanceof Error ? error.message : "");
  } finally {
    options.signal?.removeEventListener("abort", onStop);
    broker.close(); await broker.released().catch(() => {});
  }
}
