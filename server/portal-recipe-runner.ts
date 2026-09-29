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
// approval channel, and without one it is refused.
//
// Portal names never live here: origin, account marker, sign-in hosts,
// routes and labels come from the pack's recipes document.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startBrowserBroker, type BrowserApprovalProjection, type BrowserBroker } from "./browser-broker.ts";
import { jobBrowserUrl, type BrowserPortalControls } from "./browser-authority.ts";
import { browserTaskWorkroom, type BrowserCommand, type BrowserJson, type BrowserRuntime } from "./browser-runtime.ts";
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
const blocked = (reason: string, detail = "") => new RunEnd("blocked", reason, detail);

export interface PortalRecipeResult {
  recipe: string;
  outcome: PortalRunOutcome | "not-run";
  rows: Array<Record<string, string>>;
  /** Field values shown on the page when the table was read (the filter state). */
  filters: Record<string, string>;
  table: "rows" | "empty" | "unread";
  pages: number;
  controls?: string[];
  /** stop_before labels present on the last page: reached, never pressed. */
  stopBefore: string[];
  download?: { name: string; size: number; sha256: string; contentType: string; rows: string[][] };
  sub?: Record<string, PortalRecipeResult>;
}
export interface PortalStepReceipt { recipe: string; index: number; verb: string; target?: string; valueSha256?: string; ok: boolean; ms: number }
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
  /** The account the person selected for this task: the URL parameter's value and the page marker. */
  account: { urlValue: string; marker: string };
  /** The task's explicit grant (host-issued). The runner never creates or widens one. */
  grant: BrowserTaskGrant;
  threadId: string;
  runtime: BrowserRuntime;
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
export function portalRecipeControls(pack: PortalRecipePack): BrowserPortalControls {
  const forbidden = new Set(pack.labels.forbiddenAreas);
  const menu = new Set(pack.screens.flatMap(screen => screen.menu.filter((_, index) => !forbidden.has(screen.menu.slice(0, index + 1).join(" › ")))));
  // The pager's buttons are read-safe only in a pager beside a table (server/browser-authority.ts).
  const pagination = [pack.pagination.next, ...(pack.pagination.previous ? [pack.pagination.previous] : [])];
  return { origin: new URL(pack.origin).origin, readSafe: [...pack.labels.readSafe], menu: [...menu], pagination,
    ...(pack.pagination.landmark ? { pager: { ...pack.pagination.landmark } } : {}), consequential: [...pack.labels.consequential],
    signInHosts: [...pack.signIn.hosts], accountMarker: { ...pack.account.pageMarker } };
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
interface PageView { text: string; root: Node; url: string | null }
const FIELD = new Set(["textbox", "searchbox", "textarea", "combobox"]);

// ── tab URL tap ──────────────────────────────────────────────────────────
/** The broker withholds URLs from its tool results (a query can carry tokens).
 * The account check needs the borrowed tab's query parameter, so the runner
 * keeps the URL from the broker's own tab listings: it issues no command and
 * sees only tabs on the grant's sites. */
function tappedRuntime(runtime: BrowserRuntime, sites: string[]) {
  const urls = new Map<number, string>();
  const command: BrowserCommand = async (args, signal) => {
    const result = await runtime.command(args, signal);
    if (args[0] === "tab" && args[1] === "list" && Array.isArray(result.tabs)) {
      for (const row of result.tabs) {
        const tab = row && typeof row === "object" ? row as BrowserJson : {};
        if (Number.isSafeInteger(tab.tab_id) && jobBrowserUrl(tab.url, sites)) urls.set(Number(tab.tab_id), String(tab.url));
      }
    }
    return result;
  };
  const proxy = new Proxy(runtime, { get(target, key) {
    if (key === "command") return command;
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

  const stopped = () => Boolean(options.signal?.aborted) || (options.isActive ? !options.isActive() : false);
  const tap = tappedRuntime(options.runtime, grant.sites);
  let inflight: { tool: string; name?: string; recipe: boolean } | null = null;
  const approve: PersonApprove = async (tool, params, summary, signal, projection) => {
    const step = inflight;
    // A read recipe never answers for a submit: that ask always goes to the person.
    const covered = step?.recipe && projection?.approvalPolicy !== "once" && tool === step.tool &&
      (step.name === undefined || controlName(params.label) === step.name) &&
      projection?.fence.surface !== "portal-submit";
    if (covered) { receipt.approvals.recipe += 1; return true; }
    receipt.approvals.person += 1;
    return options.approve ? options.approve(tool, params, summary, signal, projection) : false;
  };
  let broker: BrowserBroker;
  try {
    broker = await startBrowserBroker({
      threadId: options.threadId, runId: grant.runId, grant, runtime: tap.runtime,
      context: { allowedOrigins: grant.sites, capabilities: [] },
      isActive: () => !stopped(), approve, portal: portalRecipeControls(pack),
      ...(options.operations ? { operations: options.operations } : {}), ...(options.approvals ? { approvals: options.approvals } : {}),
      ...(options.rules ? { rules: options.rules } : {}), ...(options.assertCapability ? { assertCapability: options.assertCapability } : {}),
      ...(options.now ? { now: options.now } : {}), ...(options.workroom ? { workroom: options.workroom } : {}),
    });
  } catch (error) { return finish("blocked", "broker-refused", error instanceof Error ? error.message : ""); }
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
    if (/was not approved/i.test(text)) throw handover("not-approved", text);
    throw blocked("broker-refused", text);
  };

  // ── page state ──
  let tabId = 0; let view: PageView | null = null; let stale = true; let drift = false; let uploads = 0;
  const signInOrigins = pack.signIn.hosts.map(host => `https://${host}`);
  const assertAccount = (page: PageView) => {
    if (!page.url) throw handover("account-url-unavailable");
    const at = new URL(page.url);
    if (at.origin !== pack.origin) throw handover("origin-changed");
    const value = at.searchParams.get(pack.account.urlParam);
    if (!value) throw handover("account-url-missing");
    if (value !== account.urlValue) throw handover("account-url-changed");
    const landmark = first(page.root, node => node.role === pack.account.pageMarker.landmark);
    const marker = landmark ? first(landmark, node => node.role === pack.account.pageMarker.role)?.name?.trim() : undefined;
    if (!marker) throw handover("account-marker-missing");
    if (marker !== account.marker) throw handover("account-marker-changed");
    receipt.accountChecks += 1;
  };
  /** Every read is a load check: sign-in pages hand over, then the account must still be the selected one. */
  const read = async (): Promise<PageView> => {
    const raw = await tool("browser_read", { tab_id: tabId });
    let text = raw;
    try {
      const parsed = JSON.parse(raw) as { text?: unknown; truncated?: unknown };
      if (typeof parsed.text === "string") text = parsed.text;
      // A cut-off page cannot prove a complete table; the caller sees the flag.
      if (parsed.truncated === true && !receipt.flags.includes("page-truncated")) receipt.flags.push("page-truncated");
    } catch { /* plain text */ }
    const page: PageView = { text, root: parsePage(text), url: tap.url(tabId) };
    const at = page.url ? new URL(page.url).origin : null;
    if ((at && signInOrigins.includes(at)) || pack.signIn.texts.some(marker => first(page.root, node => (node.role === "heading" || node.role === "rootwebarea") && (node.name ?? "").includes(marker)))) throw handover("sign-in");
    assertAccount(page);
    view = page; stale = false; return page;
  };
  const current = async () => (stale || !view ? read() : view);
  /** The content a recipe acts in: an open dialog, else the main region; never the menu or header. */
  const scope = (page: PageView) => first(page.root, node => node.role === "dialog" || node.role === "alertdialog") ?? first(page.root, node => node.role === "main") ?? page.root;
  const control = (page: PageView, roles: string[], name: string): Node | null => {
    const found = all(scope(page), node => node.ref !== null && roles.includes(node.role) && node.name === name);
    if (found.length > 1) throw blocked("ambiguous-control", `More than one ${name} control is on the page.`);
    return found[0] ?? null;
  };
  const act = async (name: string, args: BrowserJson, expect: { name?: string; recipe?: boolean } = {}) => {
    stale = true; const text = await tool(name, { tab_id: tabId, ...args }, expect); await read(); return text;
  };
  const tableOf = (page: PageView) => {
    const table = first(scope(page), node => node.role === "table" || node.role === "grid");
    if (!table) return null;
    const rows = table.children.filter(node => node.role === "row");
    const header = rows.find(row => row.children.some(cell => cell.role === "columnheader"));
    const cols = header ? header.children.filter(cell => cell.role === "columnheader").map(cell => cell.name ?? "") : [];
    const data = rows.filter(row => row !== header).map(row => row.children.filter(cell => cell.role === "cell" || cell.role === "gridcell" || cell.ref !== null).map(cell => (cell.name ?? texts(cell)).trim()));
    const loading = data.length === 1 && data[0].length === 1 && /^loading/i.test(data[0][0]);
    const empty = data.length === 1 && data[0].length === 1 && /no (?:records|matching|data)/i.test(data[0][0]);
    const records = loading || empty ? [] : data.map(cells => Object.fromEntries(cells.map((cell, index) => [cols[index] ?? String(index), cell])));
    return { loading, empty, records };
  };
  const waitTable = async () => {
    for (let attempt = 0; attempt <= maxWaitReads; attempt++) {
      const page = await current(); const table = tableOf(page);
      if (table && !table.loading) return table;
      if (!table && attempt === maxWaitReads) break;
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
            // Direct route with the account parameter; the read after it re-checks both markers.
            const target = new URL(route, pack.origin); target.searchParams.set(pack.account.urlParam, account.urlValue);
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
          const box = control(await current(), ["combobox", "listbox"], field);
          if (!box) throw blocked("field-missing", `No ${field} field on the page.`);
          const options = box.children.filter(node => node.role === "option").map(node => node.name ?? "");
          if (options.length && !options.includes(option)) throw blocked("option-missing", `${field} has no option ${option}.`);
          await act("browser_select", { ref: box.ref!, values: [option] }, { name: field });
          break;
        }
        case "type": {
          const field = arg("field"); const value = arg("value"); entry.target = field; entry.valueSha256 = sha256(value);
          const box = control(await current(), ["textbox", "searchbox", "textarea"], field);
          if (!box) throw blocked("field-missing", `No ${field} field on the page.`);
          await act("browser_fill", { ref: box.ref!, value }, { name: field });
          // Tab commits the typed filter (map trap: an uncommitted filter resets on the next click).
          const again = control(await current(), ["textbox", "searchbox", "textarea"], field);
          if (!again) throw blocked("field-missing", `The ${field} field went away after typing.`);
          await act("browser_press", { ref: again.ref!, key: "Tab" }, { name: field });
          if (field === "Search") {
            const table = await waitTable();
            if (table.records.length && !table.records.some(row => Object.values(row).join(" ").toLowerCase().includes(value.toLowerCase()))) throw blocked("search-not-applied");
          }
          break;
        }
        case "radio": {
          const label = fill(raw); entry.target = label;
          const radio = control(await current(), ["radio"], label);
          if (!radio) throw blocked("field-missing", `No ${label} option on the page.`);
          await act("browser_click_semantic", { ref: radio.ref! }, { name: label });
          break;
        }
        case "click": {
          const label = fill(raw); entry.target = label;
          if (stops.has(label)) throw new RunEnd("stopped-before", "consequential-label", label);
          if (!readSafe.has(label)) throw blocked("not-read-safe", label);
          const target = control(await current(), ["button", "link", "tab", "menuitem"], label);
          if (!target) throw blocked("control-missing", `No ${label} control on the page.`);
          await act("browser_click_semantic", { ref: target.ref! }, { name: label });
          break;
        }
        case "read": {
          entry.target = String(raw);
          const page = await current();
          if (raw === "controls") result.controls = all(scope(page), node => node.name !== null && (FIELD.has(node.role) || node.role === "radio")).map(node => node.name!);
          else {
            const table = await waitTable();
            result.rows = [...table.records]; result.table = table.empty || !table.records.length ? "empty" : "rows"; result.pages = 1; result.filters = filters(await current());
          }
          break;
        }
        case "paginate": {
          entry.target = pack.pagination.next;
          let previous = JSON.stringify((await waitTable()).records);
          for (let guard = 0; ; guard++) {
            if (guard > 200) throw blocked("pagination-did-not-end");
            const next = control(await current(), ["button", "link"], pack.pagination.next);
            if (!next || next.disabled) break;
            await act("browser_click_semantic", { ref: next.ref! }, { name: pack.pagination.next });
            const table = await waitTable(); const signature = JSON.stringify(table.records);
            // A page identical to the last one means the click raced a re-render; counting it would double rows.
            if (signature === previous) throw blocked("pagination-stalled");
            previous = signature; result.rows.push(...table.records); result.pages += 1;
          }
          break;
        }
        case "upload": {
          const field = arg("field"); const file = arg("file"); entry.target = field; entry.valueSha256 = sha256(file);
          if (drift) throw handover("map-drift-blocks-upload");
          if (operations.list(options.threadId).some(op => op.toolName === "browser_upload" && op.status === "unknown")) throw new RunEnd("hold", "earlier-upload-unknown", recipe.onUnknown ?? "");
          if (uploads >= 1) throw new RunEnd("hold", "second-upload-refused");
          if (!grant.uploads.some(upload => upload.name === file)) throw handover("upload-not-granted");
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
    if (chosen.length !== 1) return finish("handover", "choose-tab", chosen.length ? "More than one portal tab is open. Choose the one Bud should use." : "Open the portal in your browser and sign in, then start again.");
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
