// Desktop fence: the one place that decides a desktop task's next step in the
// person's app window. Pure: the caller reads the window list and the window's
// tree, passes them in, and dispatches only what this allows. Consequential
// controls (pay, sign, send, notice, delete, account change) are never allowed
// by the grant: each is a card, once per instance. Sign-in and credential
// fields stay with the person. A truncated tree is partial evidence and never
// proves something is absent.
//
// Raw input. A real cua-driver 0.22.1 capture
// (server/testing/fixtures/cua-0.22.1-calculator-window-state.json) has
// elements[] with element_index, element_token, role, label (optional),
// enabled (optional), selected, frame in screen points and parent_index/depth;
// top-level elements_complete, snapshot_id and tree_markdown, and NO
// `truncated`, `window_bounds` or screenshot scale. Plain text (AXStaticText)
// is only in tree_markdown, and the system menu bar (AXMenuBar → AXMenuBarItem
// → AXMenuItem "About This Mac") is part of the tree. The 0.34.0 fields below
// (UNVERIFIED, see ASSUMED_RAW_0_34 in desktop-fence.test.ts) stay optional,
// from the pinned driver's `describe get_window_state`:
//   { structuredContent?: { ... } } or the structured object itself, with
//   elements: [{ element_index, element_token "s<8 hex>:<n>", role "AXButton",
//     subrole?, label, value?, actions?, frame {x,y,w,h} (assumed screen points),
//     parent_index, depth, enabled?, focused? }],
//   truncated, truncation_reason, elements_complete, degraded_reason,
//   filtered_element_count (only with `query`), window_bounds {x,y,w|width,h|height},
//   screenshot_scale | screenshot_width.
// 0.34.0 has no documented `enabled`, `focused` or `secure` element field; absent
// means enabled and unfocused, and a secure field is recognised by its role.
import { accountMarkerShown, AFFIRMATIVE, canonicalText, consequentialKind, CREDENTIAL_FIELD, FINANCIAL_PAGE, SIGN_IN_CONTROL, SUBMIT_CONTROL } from "./browser-authority.ts";
import { normalizeToolName } from "./portal-fence.ts";
import { containsCredential, redactSecretsInText } from "./redact.ts";
import type { BrowserConsequentialKind, BrowserTaskGrant } from "../shared/browser-task.ts";
import type { DesktopTarget } from "../shared/desktop-task.ts";

export interface DesktopFrame { x: number; y: number; w: number; h: number }
export interface DesktopElement {
  /** The driver's element token, or null when the row cannot be addressed. */
  token: string | null;
  /** The control's name exactly as the app gives it (bounded). */
  label: string;
  /** Readable role: "button", "menu item", "text field", "tab". */
  role: string;
  secure: boolean;
  frame?: DesktopFrame;
  enabled: boolean;
  focused: boolean;
  /** Part of the system menu bar, not the window: never offered, hit or pressed. */
  menuBar?: true;
  /** The parent's position in the snapshot's `elements`, when the tree gives one. */
  parent?: number;
  /** A sheet or dialog (AXSheet, AXDialog/AXSystemDialog subrole, or a window inside the top window): what an
   * affirmative control inside it confirms is read from it alone. */
  dialog?: true;
}
export interface DesktopSnapshot {
  elements: DesktopElement[];
  truncated: boolean;
  /** True only when the whole tree arrived: nothing truncated, degraded, filtered or dropped. */
  complete: boolean;
  /** The tree's own text rendering (0.22 `tree_markdown`, bounded), read only for the account check. */
  text?: string;
  /** Maps a click's window-local screenshot pixels to screen points. */
  window?: { x: number; y: number; scale: number };
}
export interface DesktopCandidate { token: string; label: string; role: string }
export interface DesktopAction { tool: string; args?: Record<string, unknown> }
export type DesktopDecisionKind = "allow" | "ask" | "card" | "deny" | "end";
export interface DesktopDecision { decision: DesktopDecisionKind; reason: string; kind?: BrowserConsequentialKind }
export interface DesktopFenceContext {
  grant: BrowserTaskGrant;
  now: number;
  /** Desktop actions already dispatched under this grant. */
  used: number;
  /** The person pressed Stop. */
  stopped: boolean;
  /** The latest window list for the granted app, read just before this decision. */
  windows: readonly DesktopTarget[];
  /** The latest tree of the granted window; null before the first read. */
  snapshot: DesktopSnapshot | null;
}

export const DESKTOP_CANDIDATE_LIMIT = 64;
const MAX_ELEMENTS = 5000;
const MAX_TEXT = 200_000;
const TOKEN = /^s[0-9a-f]{8}:[0-9]+$/;
const LONG_LABEL = 60;
/** Ordinary named navigation: allowed when the grant may click. */
const NAVIGATION_ROLES = new Set(["button", "link", "tab", "row", "menu item", "menu bar item", "disclosure triangle"]);
const TEXT_ROLES = new Set(["text field", "text area", "search field", "combo box"]);
const ACTIONABLE_ROLES = new Set([...NAVIGATION_ROLES, ...TEXT_ROLES, "check box", "radio button", "pop up button", "menu button", "slider", "incrementor"]);
const DESKTOP_TOOLS = new Set(["get_window_state", "scroll", "click", "type_text", "press_key"]);
const NAVIGATION_KEYS = new Set(["tab", "escape", "up", "down", "left", "right", "pageup", "pagedown"]);
const ENTER_KEYS = new Set(["return", "enter"]);

const STOPPED = "Stopped. Bud is no longer working in this window.";
const EXPIRED = "This task's permission has ended. Ask Bud again to continue.";
const BUDGET = "This task has used all its allowed steps. Ask Bud again to continue.";
const NO_WINDOW = "This task was not given an app window. Choose the window again.";
const WINDOW_GONE = "The window Bud was working in has closed. Choose the window again.";
const APP_CHANGED = "A different app now owns this window. Choose the window again.";
const OTHER_WINDOW = "Bud works only in the window this task was given.";
const NOT_HERE = "Bud does not use this in an app window.";
const MENU_BAR = "Bud does not use the system menu bar. Use a control inside the window.";
const STALE = "Read the window again before choosing a control. The previous reference is no longer current.";
const ACCOUNT_MISSING = "The account this task was given is no longer shown in the window. Check the window and start again.";
const ACCOUNT_UNCONFIRMED = "Bud could not read the whole window, so it could not confirm the account. Check the window before allowing.";
const CREDENTIAL = "Signing in, passwords, codes and bank or card details stay with the person.";
const NAME_A_CONTROL = "Choose a control from the window first.";
const UNLABELLED_POINT = "Bud wants to click an unlabelled point in the window. It asks once.";
const UNKNOWN_CONTROL = "Bud could not tell what this control does. It asks once.";
const ENTER_UNKNOWN = "Bud could not tell what Return would press here. It asks once.";
const LINE_BREAK = "Bud wants to type a line break, which can submit or send. It asks once.";
const LINE_BREAK_DENIED = "A line break in this field could send, pay or delete. Type it yourself.";
const POINT_UNCHECKED = "Bud wants to click a point it could not fully check in the window. It asks once.";
const TOKEN_AND_POINT = "Click a control by its element_token or by a point, not both.";
const MODIFIED = "Bud wants to use a modifier key or another mouse button here. It asks once.";
const OTHER_KEY = "Bud uses Tab, Escape, the arrows, Page Up, Page Down and Return in app windows. Use a named control instead.";
const READ = "Reading the window.";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const str = (value: unknown, max: number): string => typeof value === "string" ? value.slice(0, max) : "";
/** A refusing pattern matches the name as shown OR its canonical form (as in browser-authority). */
const matches = (pattern: RegExp, text: string) => pattern.test(text) || pattern.test(canonicalText(text));
/** Desktop apps delete with these words too ("Move to Trash", "Empty Trash", "Discard", "Erase"); this fence only. */
const DESKTOP_DELETE = /\b(?:trash|discard|erase|empty[ -]?(?:trash|bin))\b/i;
/** A name's consequential kind: the shared table, then this fence's delete words. */
const kindOf = (text: string): BrowserConsequentialKind | null => consequentialKind(text) ?? (matches(DESKTOP_DELETE, text) ? "delete" : null);
const shown = (text: string, max: number) => {
  const plain = redactSecretsInText(canonicalText(text).trim());
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
};

/** "AXPopUpButton" → "pop up button"; a tab button reads "tab". */
function roleName(role: string, subrole: string): string {
  if (subrole === "AXTabButton") return "tab";
  return role.replace(/^AX/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
}

function frameOf(value: unknown): DesktopFrame | undefined {
  if (!record(value)) return undefined;
  const w = value.w ?? value.width, h = value.h ?? value.height;
  return finite(value.x) && finite(value.y) && finite(w) && finite(h) && w >= 0 && h >= 0 ? { x: value.x, y: value.y, w, h } : undefined;
}

const MENU_BAR_ROLES = new Set(["AXMenuBar", "AXMenuBarItem"]);
/** True when a row sits in the system menu bar: it or an ancestor is the menu
 * bar, or it is a menu row whose parent chain breaks (a truncated read drops
 * the AXMenu between a menu bar item and its items). */
function inMenuBar(row: Record<string, unknown>, byIndex: Map<number, Record<string, unknown>>): boolean {
  let at: Record<string, unknown> | undefined = row;
  for (let hops = 0; at && hops < 64; hops++) {
    const role = str(at.role, 100);
    if (MENU_BAR_ROLES.has(role)) return true;
    if (!finite(at.parent_index)) return false;
    const parent = byIndex.get(at.parent_index);
    if (!parent) return /^AXMenu(Item)?$/.test(str(row.role, 100));
    at = parent;
  }
  return true;
}

function elementOf(row: unknown): DesktopElement | null {
  if (!record(row)) return null;
  const rawRole = str(row.role, 100), subrole = str(row.subrole, 100);
  const secure = /secure/i.test(`${rawRole} ${subrole}`) || row.secure === true || row.is_secure === true;
  const role = roleName(secure ? "AXSecureTextField" : rawRole, subrole);
  // A static text's visible words are its value; no other value is ever read, and a secure one never.
  const named = [row.label, row.title, row.description].find(item => typeof item === "string" && item.trim());
  const label = str(named ?? (role === "static text" && !secure ? row.value : ""), 1000);
  const token = typeof row.element_token === "string" && TOKEN.test(row.element_token) ? row.element_token : null;
  const frame = frameOf(row.frame);
  const dialog = role === "sheet" || role === "dialog" || /^AX(?:System)?Dialog$/.test(subrole);
  return { token, label, role, secure, ...(frame ? { frame } : {}), enabled: row.enabled !== false && row.is_enabled !== false, focused: row.focused === true || row.is_focused === true,
    ...(dialog ? { dialog: true as const } : {}) };
}

/** Normalises one get_window_state result. Anything unreadable yields an empty, incomplete snapshot. */
export function desktopSnapshot(raw: unknown): DesktopSnapshot {
  const root = record(raw) && record(raw.structuredContent) ? raw.structuredContent : raw;
  if (!record(root) || !Array.isArray(root.elements)) return { elements: [], truncated: true, complete: false };
  let dropped = root.elements.length > MAX_ELEMENTS;
  const rows = root.elements.slice(0, MAX_ELEMENTS);
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const row of rows) if (record(row) && finite(row.element_index)) byIndex.set(row.element_index, row);
  const elements: DesktopElement[] = [], parents: unknown[] = [], position = new Map<number, number>();
  for (const row of rows) {
    const element = elementOf(row);
    if (!element) { dropped = true; continue; }
    if (record(row) && finite(row.element_index)) position.set(row.element_index, elements.length);
    parents.push(record(row) ? row.parent_index : undefined);
    elements.push(record(row) && inMenuBar(row, byIndex) ? { ...element, menuBar: true } : element);
  }
  parents.forEach((index, at) => {
    const parent = finite(index) ? position.get(index) : undefined;
    // A window inside another element (Windows UIA puts a dialog's window under the app's) is a dialog too.
    if (parent !== undefined && parent !== at) elements[at] = { ...elements[at], parent, ...(elements[at].role === "window" ? { dialog: true as const } : {}) };
  });
  const truncated = root.truncated === true || root.elements_complete === false || dropped;
  const complete = !truncated && root.degraded_reason == null && root.filtered_element_count == null;
  const bounds = frameOf(root.window_bounds);
  const scale = finite(root.screenshot_scale) ? root.screenshot_scale
    : bounds && bounds.w > 0 && finite(root.screenshot_width) ? root.screenshot_width / bounds.w : NaN;
  const window = bounds && scale > 0 && root.screenshot_frame_valid !== false ? { x: bounds.x, y: bounds.y, scale } : undefined;
  const text = typeof root.tree_markdown === "string" ? root.tree_markdown.slice(0, MAX_TEXT) : "";
  return { elements, truncated, complete, ...(text ? { text } : {}), ...(window ? { window } : {}) };
}

/** The labelled, enabled controls Jev may pick from, goal words first, then tree order. Credential fields and sign-in controls are never offered. */
export function desktopCandidates(snapshot: DesktopSnapshot, goal: string): DesktopCandidate[] {
  const words = (text: string) => canonicalText(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2);
  const wanted = new Set(words(goal));
  return snapshot.elements.flatMap((element, index) => {
    const label = canonicalText(element.label).trim();
    if (!element.token || !element.enabled || element.secure || element.menuBar || !ACTIONABLE_ROLES.has(element.role) || !label ||
      matches(CREDENTIAL_FIELD, element.label) || matches(SIGN_IN_CONTROL, element.label) || containsCredential(element.label)) return [];
    return [{ token: element.token, label: label.slice(0, 120), role: element.role, score: words(label).filter(word => wanted.has(word)).length, index }];
  }).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, DESKTOP_CANDIDATE_LIMIT).map(({ token, label, role }) => ({ token, label, role }));
}

type Point = { x: number; y: number };
/** A click's window-local screenshot pixel in screen points, or null when the window cannot be mapped. */
const screenPoint = (snapshot: DesktopSnapshot, x: unknown, y: unknown): Point | null =>
  snapshot.window && finite(x) && finite(y) ? { x: snapshot.window.x + x / snapshot.window.scale, y: snapshot.window.y + y / snapshot.window.scale } : null;
const holds = (f: DesktopFrame | undefined, p: Point) => !!f && p.x >= f.x && p.y >= f.y && p.x < f.x + f.w && p.y < f.y + f.h;
/** Every element outside the menu bar whose frame holds a screen point, smallest first; ties go to the later (deeper) row. */
function containing(snapshot: DesktopSnapshot, p: Point): DesktopElement[] {
  const area = (row: DesktopElement) => row.frame!.w * row.frame!.h;
  return snapshot.elements.map((element, index) => ({ element, index })).filter(({ element }) => !element.menuBar && holds(element.frame, p))
    .sort((a, b) => area(a.element) - area(b.element) || b.index - a.index).map(({ element }) => element);
}

/** The smallest element whose frame holds a click's window-local screenshot pixel, or null when the window cannot be mapped. */
export function hitTest(snapshot: DesktopSnapshot, x: number, y: number): DesktopElement | null {
  const p = screenPoint(snapshot, x, y);
  return p ? containing(snapshot, p)[0] ?? null : null;
}

const named = (element: DesktopElement) => !!canonicalText(element.label).trim();
/** What an unnamed element sits in, nearest first: its ancestors, then every frame holding its centre. A named one is itself. */
function surroundings(snapshot: DesktopSnapshot, element: DesktopElement): DesktopElement[] {
  if (named(element)) return [];
  const found: DesktopElement[] = [];
  for (let at = element.parent, hops = 0; at !== undefined && hops < 64; at = snapshot.elements[at]?.parent, hops++) {
    if (snapshot.elements[at]) found.push(snapshot.elements[at]);
  }
  const f = element.frame;
  return f ? [...found, ...containing(snapshot, { x: f.x + f.w / 2, y: f.y + f.h / 2 })] : found;
}

/** Window roots hold every point, and a window's title is not a control. */
const ROOT_ROLES = new Set(["window", "application"]);
/** The element a press is classified as: the nearest consequential one among the pressed element and what it sits in
 * (so a click inside "Delete" is the Delete card with its real name), else the pressed element. Only a part that is
 * not a control itself (an icon, a caption, a cell) borrows its nearest named surrounding's name: an unnamed button
 * inside a named row stays an unnamed button, which asks. */
function pressedAs(element: DesktopElement, around: readonly DesktopElement[]): DesktopElement {
  if (element.menuBar) return element;
  const near = around.filter(row => row !== element && !row.menuBar && !ROOT_ROLES.has(row.role));
  return [element, ...near].find(row => kindOf(row.label)) ??
    (named(element) || ACTIONABLE_ROLES.has(element.role) ? element : near.find(named) ?? element);
}

/** What the sheet or dialog holding an affirmative control is for: a pay, sign, send, delete or notice word in that
 * container's own names and text (its tree_markdown lines when its row can be found there), nothing else in the
 * window. Account-change words ("Cancel") are on nearly every dialog, so they never count. Null outside a dialog. */
function dialogKind(snapshot: DesktopSnapshot, element: DesktopElement): BrowserConsequentialKind | null {
  const within = (row: DesktopElement, container: number) => {
    for (let at = row.parent, hops = 0; at !== undefined && hops < 64; at = snapshot.elements[at]?.parent, hops++) if (at === container) return true;
    return false;
  };
  let container: number | undefined = element.parent;
  for (let hops = 0; container !== undefined && !snapshot.elements[container]?.dialog && hops < 64; hops++) container = snapshot.elements[container]?.parent;
  const box = container === undefined ? undefined : snapshot.elements[container];
  if (!box?.dialog) return null;
  const words = [box.label, ...snapshot.elements.filter(row => within(row, container!)).map(row => row.label)];
  // The container's rows in tree_markdown: its own "[n]" line and every deeper line under it.
  const index = box.token?.split(":")[1];
  const lines = (snapshot.text ?? "").split("\n");
  const head = index === undefined ? -1 : lines.findIndex(line => line.trimStart().startsWith(`- [${index}] `));
  if (head >= 0) {
    const indent = (line: string) => line.length - line.trimStart().length;
    for (let at = head; at < lines.length && (at === head || indent(lines[at]) > indent(lines[head])); at++) words.push(lines[at]);
  }
  const text = words.join("\n");
  const kind = consequentialKind(text);
  return kind && kind !== "account-change" ? kind : matches(DESKTOP_DELETE, text) ? "delete" : null;
}

const EFFECT: Record<BrowserConsequentialKind, string> = {
  pay: "This makes a payment.",
  sign: "This signs a document.",
  send: "This sends a message.",
  notice: "This gives a formal notice.",
  delete: "This deletes something.",
  "account-change": "This changes an account.",
};
const DIALOG_EFFECT: Record<BrowserConsequentialKind, string> = {
  pay: "The dialog mentions a payment; this may make it.",
  sign: "The dialog mentions signing; this may sign.",
  send: "The dialog mentions sending; this may send.",
  notice: "The dialog mentions a formal notice; this may give it.",
  delete: "The dialog mentions deleting; this may delete.",
  "account-change": "The dialog mentions an account change; this may make it.",
};

/** The card for one consequential press, with the facts the person checks. `fromDialog`: the kind the sheet or
 * dialog around an affirmative control ("OK", "Continue") gives it when its own name has none. */
export function cardSummary(action: DesktopAction, element: DesktopElement, appName: string, windowTitle: string, bundleId: string,
  fromDialog?: BrowserConsequentialKind): { summary: string; details: string[] } {
  const own = kindOf(element.label), kind = own ?? fromDialog ?? null;
  const verb = normalizeToolName(action.tool) === "press_key" ? "Press Return on" : "Press";
  const title = shown(windowTitle, 80);
  const where = `in ${shown(appName, 60)} — ${title ? `window "${title}"` : "untitled window"}.`;
  const effect = own ? EFFECT[own] : kind ? DIALOG_EFFECT[kind] : "";
  const summary = [`${verb} '${shown(element.label, LONG_LABEL)}' (${element.role}) ${where}`, effect, "Once only."].filter(Boolean).join(" ");
  const odd = element.label.length > LONG_LABEL || canonicalText(element.label).trim() !== element.label;
  const details = [
    `App: ${shown(appName, 60)} (${bundleId})`,
    `Control: ${element.role} ${JSON.stringify(redactSecretsInText(element.label))}`,
    ...(odd ? ["Its name has more text than the control shows."] : []),
    ...(kind === "pay" || kind === "send" ? ["Bud could not confirm the amount or recipient in this app; check the window."] : []),
  ];
  return { summary, details };
}

/** Any modifier given, in either spelling, other than an empty list. */
const modified = (args: Record<string, unknown>) => [args.modifier, args.modifiers].some(value => value !== undefined && !(Array.isArray(value) && !value.length));
const decide = (decision: DesktopDecisionKind, reason: string, kind?: BrowserConsequentialKind): DesktopDecision => kind ? { decision, reason, kind } : { decision, reason };

/** Pressing one element (a click, or Return on it). */
function press(ctx: DesktopFenceContext, target: DesktopTarget, action: DesktopAction, element: DesktopElement): DesktopDecision {
  const label = element.label;
  if (element.menuBar) return decide("deny", MENU_BAR);
  const kind = kindOf(label);
  if (kind) return decide("card", cardSummary(action, element, target.appName, target.title, target.bundleId).summary, kind);
  if (element.secure || matches(SIGN_IN_CONTROL, label) || matches(CREDENTIAL_FIELD, label) || containsCredential(label)) return decide("deny", CREDENTIAL);
  // "OK", "Continue", "Save" ask once; inside a sheet or dialog that is for a payment, signature, message, deletion
  // or notice, they are that card. Buttons elsewhere in the window never decide it.
  if (matches(SUBMIT_CONTROL, label) || matches(AFFIRMATIVE, label)) {
    const effect = ctx.snapshot ? dialogKind(ctx.snapshot, element) : null;
    return effect ? decide("card", cardSummary(action, element, target.appName, target.title, target.bundleId, effect).summary, effect)
      : decide("ask", `Bud asks before pressing '${shown(label, LONG_LABEL)}', once.`);
  }
  if (!canonicalText(label).trim() || !NAVIGATION_ROLES.has(element.role)) return decide("ask", UNKNOWN_CONTROL);
  return ctx.grant.actions.includes("click") ? decide("allow", `Press '${shown(label, LONG_LABEL)}' (${element.role}).`)
    : decide("ask", `This task may not click without asking. Bud asks once before pressing '${shown(label, LONG_LABEL)}'.`);
}

/** Decides one desktop step. Every call re-checks the grant, Stop, the window and the account. */
export function decideDesktopAction(ctx: DesktopFenceContext, action: DesktopAction): DesktopDecision {
  const target = ctx.grant.desktop;
  if (!target) return decide("deny", NO_WINDOW);
  if (ctx.stopped) return decide("end", STOPPED);
  if (ctx.grant.expiresAt !== null && ctx.now >= ctx.grant.expiresAt) return decide("end", EXPIRED);
  if (ctx.grant.budget !== null && ctx.used >= ctx.grant.budget) return decide("end", BUDGET);
  // Never-tools, menus, set_value, drag, browser tools and session escalation are all outside this list.
  const tool = normalizeToolName(action.tool);
  if (!DESKTOP_TOOLS.has(tool)) return decide("deny", NOT_HERE);

  const live = ctx.windows.find(window => window.windowId === target.windowId);
  if (!live) return decide("end", WINDOW_GONE);
  if (live.pid !== target.pid || live.bundleId !== target.bundleId) return decide("end", APP_CHANGED);
  const args = action.args ?? {};
  const at = record(args.target) ? args.target : args;
  if (at.pid !== target.pid) return decide("deny", OTHER_WINDOW);
  if (at.window_id !== target.windowId) {
    const other = ctx.windows.find(window => window.windowId === at.window_id && window.pid === target.pid && window.bundleId === target.bundleId);
    return other ? decide("ask", `Bud wants to work in another window of ${shown(target.appName, 60)}, "${shown(other.title, 80) || "untitled"}". It asks once.`) : decide("deny", OTHER_WINDOW);
  }

  const snapshot = ctx.snapshot;
  if (!snapshot) return tool === "get_window_state" ? decide("allow", READ) : decide("deny", STALE);
  const marker = ctx.grant.browser.accountMarker;
  if (marker && !accountMarkerShown([...snapshot.elements.map(element => element.label), snapshot.text ?? ""].join("\n"), marker)) {
    // Only a whole tree can show the account is gone; a partial one asks the person.
    return snapshot.complete ? decide("end", ACCOUNT_MISSING) : decide("ask", ACCOUNT_UNCONFIRMED);
  }
  if (tool === "get_window_state" || tool === "scroll") return decide("allow", READ);

  const token = args.element_token;
  const element = typeof token === "string" ? snapshot.elements.find(row => row.token === token) ?? null : null;
  if (token !== undefined && !element) return decide("deny", STALE);

  if (tool === "click") {
    if (modified(args) || (args.button ?? "left") !== "left" || (args.action ?? "press") !== "press") return decide("ask", MODIFIED);
    if (element && (args.x !== undefined || args.y !== undefined)) return decide("deny", TOKEN_AND_POINT);
    if (element) return press(ctx, target, action, pressedAs(element, surroundings(snapshot, element)));
    if (finite(args.x) && finite(args.y)) {
      const point = screenPoint(snapshot, args.x, args.y);
      const hits = point ? containing(snapshot, point) : [];
      if (!hits.length) return decide("ask", UNLABELLED_POINT);
      const decision = press(ctx, target, action, pressedAs(hits[0], hits));
      // A point may hit something a partial read never showed: it is allowed only on a whole tree, onto a named control.
      const checked = snapshot.complete && named(hits[0]) && ACTIONABLE_ROLES.has(hits[0].role);
      return decision.decision === "allow" && !checked ? decide("ask", POINT_UNCHECKED) : decision;
    }
    return decide("deny", NAME_A_CONTROL);
  }

  if (tool === "type_text") {
    if (!element || typeof args.text !== "string") return decide("deny", NAME_A_CONTROL);
    if (element.secure || [CREDENTIAL_FIELD, SIGN_IN_CONTROL, FINANCIAL_PAGE].some(pattern => matches(pattern, element.label)) ||
      consequentialKind(element.label) === "pay" || containsCredential(element.label) || containsCredential(args.text)) return decide("deny", CREDENTIAL);
    // A line break can submit or send the field's form.
    if (/[\r\n]/.test(args.text)) return kindOf(element.label) ? decide("deny", LINE_BREAK_DENIED) : decide("ask", LINE_BREAK);
    return ctx.grant.actions.includes("fill") ? decide("allow", `Type into '${shown(element.label, LONG_LABEL)}'.`)
      : decide("ask", `This task may not type without asking. Bud asks once before typing into '${shown(element.label, LONG_LABEL)}'.`);
  }

  // press_key
  const key = typeof args.key === "string" ? args.key.toLowerCase().replace(/^arrow/, "").replace(/[\s_-]/g, "") : "";
  if (modified(args)) return decide("ask", MODIFIED);
  if (NAVIGATION_KEYS.has(key)) return ctx.grant.actions.includes("keys") ? decide("allow", "Move around the window.")
    : decide("ask", "This task may not press keys without asking. Bud asks once.");
  if (!ENTER_KEYS.has(key)) return decide("deny", OTHER_KEY);
  const focused = snapshot.elements.filter(row => row.focused);
  const pressed = element ?? (focused.length === 1 ? focused[0] : null);
  return pressed ? press(ctx, target, action, pressedAs(pressed, surroundings(snapshot, pressed))) : decide("ask", ENTER_UNKNOWN);
}
