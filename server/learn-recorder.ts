// Watch and learn recorder (docs/decisions/2026-10-07-watch-and-learn.md).
// Opens its own CDP connection to the work browser RealBud launched, attaches
// to one tab and adds a binding plus a listener script. The page is
// untrusted: every payload is validated to an exact LearnEvent shape, capped
// and redacted, and accepted only while the tab's main frame is on the
// portal's origin. Page changes come from CDP, never from the page. No typed
// value or chosen option is ever read: the listener reports field labels only.
import { randomBytes } from "node:crypto";
import { LEARN_MAX_EVENTS, LEARN_MAX_TEXT, type LearnEvent, type LearnLandmark, type LearnSessionView } from "../shared/learned-recipes.ts";
import { ownedBrowserEndpoint } from "./hermes-browser-transport.ts";
import { redactSecretsInText } from "./redact.ts";
import { learnLabel } from "./learned-recipes.ts";

const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });
type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const COMMAND_MS = 5000;

/** In-page listener: a function expression called with the binding name. It
 * never throws into the page and never reads an input's value or a select's
 * chosen option: only that a labelled field changed. */
export const LEARN_LISTENER = `function (binding) {
  try {
    var mark = "__rbLearn_" + binding;
    if (window[mark]) return;
    Object.defineProperty(window, mark, { value: true });
    var ACTIONABLE = "button,a[href],[role=button],[role=link],[role=tab],[role=menuitem],[role=radio],[role=option],input[type=submit],input[type=button],input[type=radio]";
    var ROLES = ["button", "link", "tab", "menuitem", "option", "radio"];
    var TYPED = ["text", "search", "email", "number", "date", "tel"];
    var send = function (event) { try { var fn = window[binding]; if (typeof fn === "function") fn(JSON.stringify(event)); } catch (e) {} };
    var tables = function () { send({ kind: "tables", present: !!document.querySelector("table,[role=table],[role=grid]") }); };
    var squash = function (text) { return String(text == null ? "" : text).replace(/\\s+/g, " ").trim().slice(0, 300); };
    var bare = function (node) { var copy = node.cloneNode(true); copy.querySelectorAll("input,select,textarea,button").forEach(function (n) { n.remove(); }); return squash(copy.textContent); };
    var landmark = function (el) {
      if (el.closest("dialog,[role=dialog],[role=alertdialog]")) return "dialog";
      if (el.closest("nav,[role=navigation]")) return "navigation";
      if (el.closest("main,[role=main]")) return "main";
      return "other";
    };
    var nameOf = function (el) {
      var name = squash(el.getAttribute("aria-label")); if (name) return name;
      var by = el.getAttribute("aria-labelledby");
      if (by) { name = squash(String(by).split(/\\s+/).map(function (id) { var n = document.getElementById(id); return n ? n.textContent : ""; }).join(" ")); if (name) return name; }
      if (el.labels && el.labels.length) { name = bare(el.labels[0]); if (name) return name; }
      var tag = el.tagName;
      if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") { name = squash(el.innerText); if (name) return name; }
      if (tag === "INPUT" && (el.type === "submit" || el.type === "button")) { name = squash(el.value); if (name) return name; }
      return squash(el.getAttribute("title")) || squash(el.getAttribute("placeholder"));
    };
    var secret = function (el) {
      var auto = String(el.getAttribute("autocomplete") || "").toLowerCase();
      return String(el.getAttribute("type") || "").toLowerCase() === "password" || /one-time-code|current-password|new-password/.test(auto) ||
        /(^|[^a-z])(pass(word|code)?|pwd|otp|totp|mfa|2fa|pin|token|secret|code|(security|verification|auth)[^a-z]?code)([^a-z]|$)/i.test(String(el.getAttribute("name") || "") + " " + String(el.id || ""));
    };
    document.addEventListener("click", function (event) {
      try {
        var target = event.target; if (!target || typeof target.closest !== "function") return;
        var el = target.closest(ACTIONABLE); if (!el) return;
        tables();
        var where = landmark(el); var name = nameOf(el); var tag = el.tagName;
        var role = squash(el.getAttribute("role")).toLowerCase().split(" ")[0] || (tag === "A" ? "link" : tag === "INPUT" && el.type === "radio" ? "radio" : "button");
        if (ROLES.indexOf(role) < 0 || !name) { send({ kind: "unsupported", control: ROLES.indexOf(role) < 0 ? "control" : role, name: name, landmark: where }); return; }
        if (role === "radio") send({ kind: "radio", name: name, landmark: where });
        else send({ kind: "click", role: role, name: name, landmark: where });
      } catch (e) {}
    }, true);
    document.addEventListener("change", function (event) {
      try {
        var el = event.target; if (!el || typeof el.closest !== "function") return;
        var where = landmark(el); var tag = el.tagName;
        if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") return;
        if (tag !== "SELECT" && secret(el)) { send({ kind: "secret", landmark: where }); return; }
        var type = tag === "INPUT" ? String(el.getAttribute("type") || "text").toLowerCase() : tag.toLowerCase();
        if (type === "radio" || type === "submit" || type === "button" || type === "hidden") return;
        var field = nameOf(el);
        if (type === "checkbox" || type === "file") { send({ kind: "unsupported", control: type, name: field, landmark: where }); return; }
        if (!field) { send({ kind: "unsupported", control: "unlabelled-field", name: "", landmark: where }); return; }
        tables();
        if (tag === "SELECT") { send({ kind: "select", field: field, landmark: where }); return; }
        if (tag === "TEXTAREA" || TYPED.indexOf(type) >= 0) send({ kind: "type", field: field, landmark: where });
        else send({ kind: "unsupported", control: "field", name: field, landmark: where });
      } catch (e) {}
    }, true);
  } catch (e) {}
}`;
const TABLE_PROBE = `Boolean(document.querySelector("table,[role=table],[role=grid]"))`;

// ── host-side validation ────────────────────────────────────────────────
const LANDMARKS: readonly string[] = ["navigation", "main", "dialog", "other"];
const CLICK_ROLES: readonly string[] = ["button", "link", "tab", "menuitem", "option"];
const CONTROL = /^[a-z][a-z-]{0,23}$/;
/** learnLabel's one spelling (server/learned-recipes.ts), so a hidden "Sa\u200bve" reads "Save"; redacted and capped. */
function clean(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  const out = learnLabel(redactSecretsInText(learnLabel(value)).slice(0, LEARN_MAX_TEXT));
  return out || allowEmpty ? out : null;
}
type Payload = LearnEvent | { kind: "tables"; present: boolean };
function parsePayload(payload: unknown): Payload | null {
  if (typeof payload !== "string" || payload.length > 8192) return null;
  let raw: unknown; try { raw = JSON.parse(payload); } catch { return null; }
  if (!record(raw)) return null;
  const keys = Object.keys(raw).sort().join();
  const landmark = typeof raw.landmark === "string" && LANDMARKS.includes(raw.landmark) ? raw.landmark as LearnLandmark : null;
  switch (raw.kind) {
    case "tables": return keys === "kind,present" && typeof raw.present === "boolean" ? { kind: "tables", present: raw.present } : null;
    case "click": {
      const name = clean(raw.name);
      return keys === "kind,landmark,name,role" && landmark && typeof raw.role === "string" && CLICK_ROLES.includes(raw.role) && name ? { kind: "click", role: raw.role, name, landmark } : null;
    }
    case "type": { const field = clean(raw.field); return keys === "field,kind,landmark" && landmark && field ? { kind: "type", field, landmark } : null; }
    case "select": { const field = clean(raw.field); return keys === "field,kind,landmark" && landmark && field ? { kind: "select", field, landmark } : null; }
    case "radio": { const name = clean(raw.name); return keys === "kind,landmark,name" && landmark && name ? { kind: "radio", name, landmark } : null; }
    case "secret": return keys === "kind,landmark" && landmark ? { kind: "secret", landmark } : null;
    case "unsupported": {
      const name = clean(raw.name, true);
      return keys === "control,kind,landmark,name" && landmark && typeof raw.control === "string" && CONTROL.test(raw.control) && name !== null ? { kind: "unsupported", control: raw.control, name, landmark } : null;
    }
    default: return null;
  }
}

// ── recorder ─────────────────────────────────────────────────────────────
type PageEvent = Extract<LearnEvent, { kind: "page" }>;
interface Pending { resolve: (value: Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
interface Live {
  portal: string; origin: string; startedAt: number; events: LearnEvent[];
  socket: WebSocket; open: boolean; next: number; pending: Map<number, Pending>;
  binding: string; sessionId: string | null; scriptId: string | null;
  mainFrame: string | null; current: string; lastPage: PageEvent | null;
  /** Default (page-world) execution contexts → their frame id. Only the main frame's may report events. */
  contexts: Map<number, string>;
}
export interface LearnRecorderOptions {
  /** Opens the portal in a new work-browser tab (NativeBrowserRuntime.learnTarget). */
  open(url: string): Promise<{ endpoint: string; targetId: string }>;
  now?: () => number;
  socket?: (url: string) => WebSocket;
}

export class LearnRecorder {
  private readonly options: LearnRecorderOptions;
  private live: Live | null = null;
  private starting: Promise<void> | null = null;
  private stopping = false;
  /** A stopped recording whose draft was not saved yet: kept until a save succeeds or it is discarded. */
  private held: { portal: string; startedAt: number; events: LearnEvent[] } | null = null;
  constructor(options: LearnRecorderOptions) { this.options = options; }

  /** A held recording still shows as recording, so the person can press Stop again to retry saving it. */
  view(): LearnSessionView {
    const live = this.live ?? this.held;
    return live ? { state: "recording", portal: live.portal, startedAt: live.startedAt, events: live.events.length } : { state: "idle", portal: null, startedAt: null, events: 0 };
  }

  /** True while a recording watches (or is opening) a work-browser tab: no browser task may start then. */
  recording(): boolean { return this.live !== null || this.starting !== null; }

  async start(portal: string, origin: string): Promise<LearnSessionView> {
    if (this.live || this.starting || this.held || this.stopping) throw fail("A recording is already running. Stop it before starting another.");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(portal)) throw fail("Choose a portal this office can teach.", 400);
    let at: URL | null = null; try { at = new URL(origin); } catch { /* refused below */ }
    if (!at || at.protocol !== "https:" || at.origin !== origin) throw fail("A recording needs the portal's HTTPS address.", 400);
    this.starting = this.begin(portal, origin);
    try { await this.starting; } finally { this.starting = null; }
    return this.view();
  }

  /** Ends the recording and returns its events. */
  async stop(): Promise<LearnEvent[]> { return this.finish(async events => events); }

  /** Ends the recording and hands its events to `save`. Claimed synchronously: a second call
   * while one runs is refused. The events are kept (and shown as still recording) until `save`
   * succeeds, so a failed save is retried by calling this again. */
  async finish<T>(save: (events: LearnEvent[], portal: string) => Promise<T>): Promise<T> {
    if (this.stopping) throw fail("This recording already finished.");
    this.stopping = true;
    try {
      await this.starting?.catch(() => {});
      const live = this.live;
      if (live) {
        this.live = null;
        // The last page's table, read once more now that the person has finished on it.
        if (live.open && live.lastPage && live.current === live.origin) {
          try {
            const probe = await this.command(live, "Runtime.evaluate", { expression: TABLE_PROBE, returnByValue: true });
            if (record(probe.result) && typeof probe.result.value === "boolean") live.lastPage.table = probe.result.value;
          } catch { /* the earlier value stands */ }
        }
        this.held = { portal: live.portal, startedAt: live.startedAt, events: live.events };
        await this.teardown(live);
      }
      const held = this.held;
      if (!held) throw fail("Bud isn't watching a task right now.");
      const result = await save(held.events, held.portal);
      this.held = null;
      return result;
    } finally { this.stopping = false; }
  }

  /** Ends the recording (or a held one) and discards its events. */
  async cancel(): Promise<void> {
    await this.starting?.catch(() => {});
    if (this.stopping) throw fail("This recording is being saved. Wait for it to finish.");
    this.held = null;
    const live = this.live; if (!live) return;
    this.live = null;
    await this.teardown(live);
  }

  private async begin(portal: string, origin: string): Promise<void> {
    const opened = await this.options.open(`${origin}/`);
    const endpoint = ownedBrowserEndpoint(opened.endpoint);
    if (!endpoint.startsWith("ws:") || typeof opened.targetId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(opened.targetId)) throw fail("The work browser could not open a tab to record.");
    const socket = (this.options.socket ?? (url => new WebSocket(url)))(endpoint);
    const live: Live = { portal, origin, startedAt: (this.options.now ?? Date.now)(), events: [], socket, open: true, next: 0, pending: new Map(),
      binding: `rbLearn_${randomBytes(9).toString("hex")}`, sessionId: null, scriptId: null, mainFrame: null, current: "null", lastPage: null, contexts: new Map() };
    socket.addEventListener("message", event => this.onMessage(live, (event as { data?: unknown }).data));
    socket.addEventListener("close", () => this.ended(live));
    socket.addEventListener("error", () => this.ended(live));
    this.live = live;
    try {
      await new Promise<void>((resolve, reject) => {
        if (socket.readyState === 1) return resolve();
        const timer = setTimeout(() => reject(fail("The work browser did not answer in time.")), COMMAND_MS);
        socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener("close", () => { clearTimeout(timer); reject(fail("The work browser closed the recording connection.")); }, { once: true });
      });
      const attached = await this.command(live, "Target.attachToTarget", { targetId: opened.targetId, flatten: true }, false);
      if (typeof attached.sessionId !== "string" || !attached.sessionId) throw fail("The work browser did not attach to the tab.");
      live.sessionId = attached.sessionId;
      await this.command(live, "Runtime.enable");
      await this.command(live, "Page.enable");
      await this.command(live, "Runtime.addBinding", { name: live.binding });
      const source = `(${LEARN_LISTENER})(${JSON.stringify(live.binding)})`;
      const script = await this.command(live, "Page.addScriptToEvaluateOnNewDocument", { source });
      if (typeof script.identifier === "string") live.scriptId = script.identifier;
      const tree = await this.command(live, "Page.getFrameTree");
      const frame = record(tree.frameTree) && record(tree.frameTree.frame) ? tree.frameTree.frame : null;
      if (frame && typeof frame.id === "string" && typeof frame.url === "string" && !live.mainFrame) { live.mainFrame = frame.id; this.navigated(live, frame.url, true); }
      await this.command(live, "Runtime.evaluate", { expression: source });
    } catch {
      this.live = null;
      await this.teardown(live);
      throw fail("The work browser did not start the recording. Close the new tab and try again.");
    }
  }

  private command(live: Live, method: string, params: Json = {}, scoped = true): Promise<Json> {
    if (!live.open) return Promise.reject(fail("The recording connection closed."));
    const id = ++live.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { live.pending.delete(id); reject(fail("The work browser did not answer in time.")); }, COMMAND_MS);
      live.pending.set(id, { resolve, reject, timer });
      try { live.socket.send(JSON.stringify({ id, method, params, ...(scoped ? { sessionId: live.sessionId } : {}) })); }
      catch { clearTimeout(timer); live.pending.delete(id); reject(fail("The recording connection closed.")); }
    });
  }

  private onMessage(live: Live, data: unknown): void {
    let message: unknown; try { message = JSON.parse(String(data)); } catch { return; }
    if (!record(message)) return;
    if (typeof message.id === "number") {
      const pending = live.pending.get(message.id); if (!pending) return;
      live.pending.delete(message.id); clearTimeout(pending.timer);
      if (record(message.result)) pending.resolve(message.result); else pending.reject(fail("The work browser refused a recording step."));
      return;
    }
    const params = record(message.params) ? message.params : null;
    if (!params || !live.sessionId) return;
    // The tab closed or was detached: the recording ends, its events wait for stop().
    if (message.method === "Target.detachedFromTarget") { if (params.sessionId === live.sessionId) this.ended(live); return; }
    if (message.sessionId !== live.sessionId || this.live !== live) return;
    if (message.method === "Page.frameNavigated") {
      const frame = record(params.frame) ? params.frame : null;
      if (!frame || frame.parentId !== undefined || typeof frame.id !== "string" || typeof frame.url !== "string") return;
      live.mainFrame = frame.id; this.navigated(live, frame.url, false);
    } else if (message.method === "Page.navigatedWithinDocument") {
      if (params.frameId === live.mainFrame && typeof params.url === "string") this.navigated(live, params.url, true);
    } else if (message.method === "Runtime.executionContextCreated") {
      const context = record(params.context) ? params.context : null;
      const aux = context && record(context.auxData) ? context.auxData : null;
      if (context && typeof context.id === "number" && aux && aux.isDefault === true && typeof aux.frameId === "string") live.contexts.set(context.id, aux.frameId);
    } else if (message.method === "Runtime.executionContextDestroyed") {
      if (typeof params.executionContextId === "number") live.contexts.delete(params.executionContextId);
    } else if (message.method === "Runtime.executionContextsCleared") {
      live.contexts.clear();
    } else if (message.method === "Runtime.bindingCalled") {
      if (params.name !== live.binding || live.current !== live.origin) return;
      // Only the main frame's page world: an iframe (ads, a widget) or an isolated world can't add events.
      if (typeof params.executionContextId !== "number" || !live.mainFrame || live.contexts.get(params.executionContextId) !== live.mainFrame) return;
      const event = parsePayload(params.payload);
      if (!event) return;
      // The page's table report only sets the current page's flag, never a URL.
      if (event.kind === "tables") { if (live.lastPage) live.lastPage.table = event.present; return; }
      this.push(live, event);
    }
  }

  /** A host-observed main-frame address: origin + path on the portal (a query or hash can hold data), the origin alone elsewhere. */
  private navigated(live: Live, raw: string, sameDocument: boolean): void {
    let at: URL | null = null; try { at = new URL(raw); } catch { /* not a page */ }
    if (!at || (at.protocol !== "https:" && at.protocol !== "http:")) { live.current = "null"; return; }
    live.current = at.origin;
    const url = at.origin === live.origin ? redactSecretsInText(`${at.origin}${at.pathname}`).slice(0, 512) : `${at.origin}/`;
    if (sameDocument && live.lastPage?.url === url) return;
    const page: PageEvent = { kind: "page", url, table: false };
    live.lastPage = this.push(live, page) ? page : null;
  }

  private push(live: Live, event: LearnEvent): boolean {
    if (live.events.length >= LEARN_MAX_EVENTS) return false;
    live.events.push(event); return true;
  }

  private ended(live: Live): void {
    if (!live.open) return;
    live.open = false;
    for (const pending of live.pending.values()) { clearTimeout(pending.timer); pending.reject(fail("The recording connection closed.")); }
    live.pending.clear();
    try { live.socket.close(); } catch { /* already closed */ }
  }

  /** Removes the binding and the new-document script, detaches and closes. Best effort; idempotent. */
  private async teardown(live: Live): Promise<void> {
    if (live.open && live.sessionId) {
      await this.command(live, "Runtime.removeBinding", { name: live.binding }).catch(() => {});
      if (live.scriptId) await this.command(live, "Page.removeScriptToEvaluateOnNewDocument", { identifier: live.scriptId }).catch(() => {});
      await this.command(live, "Target.detachFromTarget", { sessionId: live.sessionId }, false).catch(() => {});
    }
    this.ended(live);
  }
}
