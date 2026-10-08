// Per-task desktop capability: Bud works in the ONE app window its grant names,
// through the cua-driver proxy (server/cua-client.ts), and sees only these
// typed tools. Every step re-reads the live window list and is decided by
// decideDesktopAction (server/desktop-fence.ts); pid, window and session are
// injected here, never taken from Bud. Cards follow browser-broker: the broker
// decides, the host only shows the card, once per instance; Stop aborts a
// waiting card and ends the driver session. pick_control asks Jev (labels and
// roles only) and, when that is not enough, GPT-6 Luna Decisions with ONE
// screenshot of the granted window; both are suggestions, never approvals, and
// only for a person's own attended Ask (the host's `decisions` binding).
// Nothing here logs or records a screenshot, typed text or model state.
import { decideDesktopAction, desktopCandidates, desktopSnapshot, type DesktopCandidate, type DesktopDecision, type DesktopSnapshot } from "./desktop-fence.ts";
import { startCuaClient, type CuaClient, type CuaToolName, type CuaToolResult } from "./cua-client.ts";
import { readCuaConnection, type LocalComputerConnection } from "./local-computer.ts";
import { startLoopbackToolServer, toolError, type LoopbackToolResult, type LoopbackToolServer } from "./web-research-broker.ts";
import { secretKeyName } from "./decide-broker.ts";
import { containsCredential, redactSecretsInText } from "./redact.ts";
import { countJevUsage, type RecordedRunUsage } from "./run-cost.ts";
import { lunaModel, MAX_IMAGE_BYTES, type JevRequest, type JevResult } from "./jev-client.ts";
import { canonicalText, CREDENTIAL_FIELD, type BrowserFenceProjection } from "./browser-authority.ts";
import { parseBrowserTaskGrant, type BrowserTaskGrant } from "../shared/browser-task.ts";
import type { DesktopTarget } from "../shared/desktop-task.ts";

export const DESKTOP_SERVER = "workdesktop";
/** Jev's pick is offered at or above this confidence. Tune from live eval. */
export const PICK_MIN_CONFIDENCE = 0.75;
/** Luna's pick is offered at or above this confidence. Tune from live eval. */
export const LUNA_MIN_CONFIDENCE = 0.8;
/** Model calls (Jev or Luna) one task may make for pick_control. */
export const MAX_PICKS_PER_TASK = 10;
const LUNA_TIMEOUT_MS = 20_000;
/** Long edge of the smaller window capture asked for when the first one is over MAX_IMAGE_BYTES (0.34
 * `get_window_state` `max_dimension`). Luna reads images at "low" detail, about this size, so nothing is lost. */
const LUNA_MAX_DIMENSION = 512;
const MAX_TEXT_TO_BUD = 40_000;
/** Jev and Luna take at most 64 options; one is "none". */
const MAX_PICK_OPTIONS = 63;

export const SUGGESTION_ONLY = "Suggestion only — not an approval. Bud still clicks it through the usual checks.";
export const PICK_NONE = "none — use screenshot: no confident match. Read the window with include_screenshot and choose the control yourself, or ask the person.";
export const PICK_TOO_LARGE = "none — screenshot too large for the vision fallback. Read the window and choose the control yourself, or ask the person.";
const PARTIAL_LIST = "Chosen from a partial list: Bud could not read the whole window.";
const STOPPED = "Desktop work stopped. Nothing more was done in the window.";
const NOT_APPROVED = "This step was not approved, so nothing was pressed. Do not retry it without a new request from the person.";
const CHANGED_WHILE_ASKING = "The window changed while the person was deciding, so the approval no longer matches this step and nothing was pressed. Read the window again and ask afresh.";
const ASKED_ONCE = "Bud already asked about this exact step once. Read the window again before asking about it afresh.";
const UNCONFIRMED = "The desktop helper did not confirm this step; it may or may not have happened. Read the window again before the next step.";
const CREDENTIAL_STATE = "This goal or window looks like it carries a password, code, session or token. Describe the control without those words. Nothing was sent.";
const NO_HELPER = "The desktop helper is not set up on this computer, so Bud cannot work in app windows.";

/** The host's binding for a person's own attended Ask while Jev is ready (as for `decide`). */
export interface DesktopDecisions {
  sameMember(): boolean;
  /** `jevReady()` now. */
  ready(): boolean;
  /** `lunaReady()` now. */
  lunaReady(): boolean;
  /** jev-client `decide`. */
  decide(request: JevRequest, options: { signal?: AbortSignal; timeoutMs?: number; model?: string; image?: string }): Promise<JevResult>;
}
/** The card's projection: the host emits request.opened with it, as for browser-broker cards. */
export interface DesktopApprovalProjection { fence: BrowserFenceProjection; approvalPolicy: "once"; remote: "desktop-only" }
export interface DesktopStep { at: number; tool: string; outcome: "allowed" | "asked" | "approved" | "refused" | "denied" | "ended" | "failed"; note: string }
export interface DesktopBroker {
  descriptor: LoopbackToolServer["descriptor"];
  /** Actions dispatched under this grant (the fence's budget count). */
  readonly used: number;
  /** Stop: aborts a waiting card, ends the driver session, closes everything. */
  stop(): Promise<void>;
}

const TOKEN = { type: "string", pattern: "^s[0-9a-f]{8}:[0-9]+$", description: "An element_token from the latest get_window_state or pick_control." };
const props = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
const TOOLS = [
  { name: "get_window_state", description: "Read the app window this task was given: its controls (element_token, role, label) and the window's text. Every read replaces the tokens. Ask for include_screenshot only when the tree is not enough; the image is of this window only.",
    inputSchema: props({ include_screenshot: { type: "boolean" } }) },
  { name: "pick_control", description: "Suggest the one control in the window that does a goal (e.g. \"open the March statement\"). Reads the window fresh. Returns an element_token with its label, or a point to click, or none. Suggestion only: clicking still goes through the usual checks. Never describe passwords, codes or tokens.",
    inputSchema: props({ goal: { type: "string", minLength: 1, maxLength: 500 } }, ["goal"]) },
  { name: "click", description: "Press a control by element_token (preferred), or click x,y in the last screenshot's pixels. Consequential presses (pay, sign, send, notice, delete, account change) ask the person once.",
    inputSchema: props({ element_token: TOKEN, x: { type: "number" }, y: { type: "number" } }) },
  { name: "type_text", description: "Type into a named field. Passwords, codes and bank or card details stay with the person.",
    inputSchema: props({ element_token: TOKEN, text: { type: "string", maxLength: 2000 } }, ["element_token", "text"]) },
  { name: "scroll", description: "Scroll the window, or the control under element_token.",
    inputSchema: props({ direction: { enum: ["up", "down", "left", "right"] }, by: { enum: ["line", "page"] }, amount: { type: "integer", minimum: 1, maximum: 20 }, element_token: TOKEN }, ["direction"]) },
  { name: "press_key", description: "Press Tab, Escape, an arrow, Page Up, Page Down or Return (on element_token, or the focused control).",
    inputSchema: props({ key: { type: "string", maxLength: 20 }, element_token: TOKEN }, ["key"]) },
  { name: "release", description: "Stop working in the window and hand it back to the person. This task cannot use it again.", inputSchema: props({}) },
];

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: string): LoopbackToolResult => ({ content: [{ type: "text", text: value }] });

/** Only the fields each tool takes, type-checked. Bud's pid, window_id, session, target, modifiers and anything else are dropped. */
function argsFor(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const take = (key: string, ok: (value: unknown) => boolean) => { if (ok(args[key])) out[key] = args[key]; };
  const str = (value: unknown) => typeof value === "string";
  if (tool === "get_window_state") take("include_screenshot", value => typeof value === "boolean");
  if (["click", "type_text", "scroll", "press_key"].includes(tool)) take("element_token", str);
  // A click is a token OR a point: with a token, any x,y is dropped so the driver presses exactly what the fence judged.
  if (tool === "click" && typeof args.element_token !== "string") { take("x", finite); take("y", finite); }
  if (tool === "type_text") take("text", str);
  if (tool === "scroll") { take("direction", str); take("by", str); take("amount", value => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 20); }
  if (tool === "press_key") take("key", str);
  return out;
}

/** The window's PNG and its pixel size, from an image content block. UNVERIFIED for 0.34: assumed {type:"image", data, mimeType}. */
function screenshotOf(result: CuaToolResult): { data: string; width: number; height: number } | null {
  const block = result.content?.find(item => item.type === "image" && typeof item.data === "string");
  if (!block) return null;
  const data = block.data as string;
  const head = Buffer.from(data.slice(0, 32), "base64");
  if (head.length < 24 || head.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  return { data, width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** The driver's own short note on a step (effect, stale token), redacted and bounded. */
const driverNote = (result: CuaToolResult) => redactSecretsInText(String(result.content?.find(item => item.type === "text")?.text ?? "")).slice(0, 500);

/** A goal Bud may not send: credential-shaped text, a word that names a secret (decide-broker's check),
 * or a credential or bank-detail field (the fence's own pattern). */
const credentialGoal = (goal: string) => containsCredential(goal) || secretKeyName(goal) || CREDENTIAL_FIELD.test(canonicalText(goal));

export async function startDesktopBroker(options: {
  runId: string;
  grant: BrowserTaskGrant;
  isActive(): boolean;
  approve(tool: string, params: Record<string, unknown>, summary: string, signal: AbortSignal, projection: DesktopApprovalProjection): Promise<boolean>;
  /** The person's own attended Ask binding; absent (or the grant not an Ask) means no pick_control. */
  decisions?: () => DesktopDecisions | undefined;
  /** The run's usage: every Jev and Luna call is counted here (countJevUsage). */
  usage?: RecordedRunUsage;
  step?: (step: DesktopStep) => void;
  /** Defaults to readCuaConnection(). */
  connection?: LocalComputerConnection | null;
  now?: () => number;
}): Promise<DesktopBroker> {
  const grant = parseBrowserTaskGrant(structuredClone(options.grant));
  if (grant.runId !== options.runId) throw new Error("This desktop task permission belongs to another run. Start the task again.");
  const target = grant.desktop;
  if (!target) throw new Error("This task was not given an app window. Choose the window again.");
  const now = options.now ?? Date.now;
  const session = `rb-desk-${grant.id.replace(/[^\w-]/g, "-").slice(0, 100)}`;
  const inject = { pid: target.pid, window_id: target.windowId, session };
  const halt = new AbortController();
  let stopped = false, used = 0, picks = 0;
  let client: Promise<CuaClient> | null = null;
  let snapshot: DesktopSnapshot | null = null, snapshotId = "";
  /** Screenshot pixels per screen point, from the last screenshot (0.22 sends no scale). */
  let scale: number | null = null;
  /** Instances already carded (allowed and used, or refused): "once" means once. */
  const carded = new Set<string>();
  const note = (tool: string, outcome: DesktopStep["outcome"], message: string) => { try { options.step?.({ at: now(), tool, outcome, note: message }); } catch { /* evidence never changes the outcome */ } };

  /** The one proxy for this task. Never started after Stop or release; one that fails to start a session, or is
   * stopped while starting, ends its session (best effort) and closes before anything else can use it. */
  const ensure = (): Promise<CuaClient> => stopped ? Promise.reject(new Error(STOPPED)) : client ??= (async () => {
    const connection = options.connection === undefined ? readCuaConnection() : options.connection;
    if (!connection) throw new Error(NO_HELPER);
    const started = await startCuaClient(connection);
    try {
      if (stopped) throw new Error(STOPPED);
      // capture_scope is deprecated in 0.22.1 (accepted, ignored) and assumed so in 0.34; a driver that refuses it gets the session without it.
      const first = await started.call("start_session", { session, capture_scope: "window" }, { signal: halt.signal });
      if (first.isError && (await started.call("start_session", { session }, { signal: halt.signal })).isError) throw new Error("The desktop helper would not start a session.");
      return started;
    } catch (error) {
      if (!started.closed) await started.call("end_session", { session }, { timeoutMs: 3_000 }).catch(() => undefined);
      started.close();
      throw error;
    }
  })();
  const call = async (tool: CuaToolName, args: Record<string, unknown>, signal: AbortSignal) => (await ensure()).call(tool, args, { signal });

  /** The granted app's windows now, as fence targets with their screen bounds. 0.22 list_windows has no bundle id:
   * the grant's id stands only for the same pid, window and app name (a reused pid gets new window ids). UNVERIFIED for 0.34. */
  const liveWindows = async (signal: AbortSignal) => {
    const result = await call("list_windows", { pid: target.pid }, signal);
    const rows = result.structuredContent && Array.isArray(result.structuredContent.windows) ? result.structuredContent.windows : [];
    const windows: DesktopTarget[] = [];
    let bounds: { x: number; y: number; width: number } | null = null;
    for (const row of rows) {
      if (!record(row) || !finite(row.pid) || !finite(row.window_id)) continue;
      const appName = typeof row.app_name === "string" ? row.app_name : "";
      const same = row.pid === target.pid && row.window_id === target.windowId && appName === target.appName;
      windows.push({ appName, pid: row.pid, windowId: row.window_id, title: typeof row.title === "string" ? row.title : "",
        bundleId: typeof row.bundle_id === "string" ? row.bundle_id : same ? target.bundleId : "" });
      const b = record(row.bounds) ? row.bounds : null;
      if (row.window_id === target.windowId && b && finite(b.x) && finite(b.y) && finite(b.width) && b.width > 0) bounds = { x: b.x, y: b.y, width: b.width };
    }
    return { windows, bounds };
  };

  const active = (signal?: AbortSignal) => !stopped && options.isActive() && !signal?.aborted;
  let ended = false;
  /** Ends the driver session once; the tool server stays up to answer (the host's stop closes it). */
  const endSession = async () => {
    stopped = true;
    halt.abort();
    if (ended) return;
    ended = true;
    const live = client ? await client.catch(() => null) : null;
    if (live && !live.closed) await live.call("end_session", { session }, { timeoutMs: 3_000 }).catch(() => undefined);
    live?.close();
  };
  const stop = async () => { await endSession(); server.cancelPending(); server.close(); };

  /**
   * One fenced step. `allowed` runs after the fence (and the person, for a card) allowed it. Returns Bud's result.
   */
  const fenced = async (tool: string, args: Record<string, unknown>, signal: AbortSignal, card: Record<string, unknown>,
    allowed: (decision: DesktopDecision, bounds: { x: number; y: number; width: number } | null) => Promise<LoopbackToolResult>): Promise<LoopbackToolResult> => {
    const decideNow = async () => {
      const live = await liveWindows(signal);
      const view = snapshot && !snapshot.window && live.bounds && scale ? { ...snapshot, window: { x: live.bounds.x, y: live.bounds.y, scale } } : snapshot;
      return { decision: decideDesktopAction({ grant, now: now(), used, stopped, windows: live.windows, snapshot: view }, { tool, args: { ...args, ...inject } }), bounds: live.bounds };
    };
    let { decision, bounds } = await decideNow();
    if (decision.decision === "end") { note(tool, "ended", decision.reason); await endSession(); return toolError(decision.reason); }
    if (decision.decision === "deny") { note(tool, "denied", decision.reason); return toolError(decision.reason); }
    if (decision.decision === "ask" || decision.decision === "card") {
      const instance = `${snapshotId}|${tool}|${JSON.stringify(args)}`;
      if (carded.has(instance)) { note(tool, "refused", ASKED_ONCE); return toolError(ASKED_ONCE); }
      carded.add(instance);
      note(tool, "asked", decision.reason);
      const surface = tool === "get_window_state" || tool === "scroll" ? "portal-read" : "portal-submit";
      const yes = await options.approve(tool, { app: target.appName, window: target.title, ...card }, decision.reason, AbortSignal.any([signal, halt.signal]),
        { fence: { surface, origin: target.appName, ruleOffer: null }, approvalPolicy: "once", remote: "desktop-only" }).catch(() => false);
      if (!active(signal)) { note(tool, "ended", STOPPED); return toolError(STOPPED); }
      if (!yes) { note(tool, "refused", NOT_APPROVED); return toolError(NOT_APPROVED); }
      // The window may have changed while the card waited: the fence decides again. The approval covers only the
      // decision the person saw; anything other than that same decision, or a plain allow, presses nothing.
      const seen = decision;
      ({ decision, bounds } = await decideNow());
      if (decision.decision === "end") { note(tool, "ended", decision.reason); await endSession(); return toolError(decision.reason); }
      if (decision.decision === "deny") { note(tool, "denied", decision.reason); return toolError(decision.reason); }
      if (decision.decision !== "allow" && (decision.decision !== seen.decision || decision.reason !== seen.reason || decision.kind !== seen.kind)) {
        note(tool, "refused", CHANGED_WHILE_ASKING); return toolError(CHANGED_WHILE_ASKING);
      }
      note(tool, "approved", decision.reason);
    } else note(tool, "allowed", decision.reason);
    if (!active(signal)) return toolError(STOPPED);
    return allowed(decision, bounds);
  };

  /** A fenced read of the window. Replaces the token map; a screenshot also sets the pixel scale. */
  const readWindow = async (screenshot: boolean, signal: AbortSignal, maxDimension?: number) => {
    const read: { value?: { result: CuaToolResult; image: ReturnType<typeof screenshotOf> } } = {};
    const asked = maxDimension ? { max_dimension: maxDimension } : {};
    const answer = await fenced("get_window_state", screenshot ? { include_screenshot: true, ...asked } : {}, signal, {}, async (_decision, bounds) => {
      // timeout_ms is not sent: 0.22.1 refuses unknown fields; the client's own timeout bounds the read.
      // max_dimension (0.34) is sent only for the vision fallback's smaller capture; a driver that refuses it fails that read alone.
      const result = await call("get_window_state", { ...inject, include_screenshot: screenshot, ...(screenshot ? asked : {}) }, signal);
      if (result.isError) return toolError(`The desktop helper could not read the window. ${driverNote(result)}`.trim());
      const raw = result.structuredContent ?? result;
      snapshot = desktopSnapshot(raw);
      snapshotId = record(raw) && typeof raw.snapshot_id === "string" ? raw.snapshot_id : "";
      const image = screenshot ? screenshotOf(result) : null;
      if (image && bounds) scale = image.width / bounds.width;
      read.value = { result, image };
      return text("read");
    });
    return read.value ? { ok: true as const, ...read.value } : { ok: false as const, answer };
  };

  /** The binding's `decide`, each answer counted into the run's usage. */
  const asker = (binding: DesktopDecisions) => options.usage ? countJevUsage(options.usage, binding.decide.bind(binding)) : binding.decide.bind(binding);
  const choice = (result: JevResult) => {
    const answer = result.ok ? result.answers.control : undefined;
    return answer?.type === "choice" ? { choice: answer.choice, confidence: answer.confidence ?? 0 } : null;
  };
  const controlQuestion = (candidates: DesktopCandidate[], how: string): JevRequest["questions"] => ({ control: { type: "choice",
    instructions: `Which one control in this app window does the goal? ${how} Answer none if no control clearly fits.`,
    criteria: { ...Object.fromEntries(candidates.map((row, i) => [`c${i}`, `${row.role} "${row.label}"`])), none: "None of these controls does the goal." } } });
  const suggestion = (row: DesktopCandidate, confidence: number, by: "jev" | "luna") =>
    text(JSON.stringify({ element_token: row.token, label: row.label, role: row.role, confidence, by, note: snapshot?.complete ? SUGGESTION_ONLY : `${SUGGESTION_ONLY} ${PARTIAL_LIST}` }));

  const pick = async (goal: unknown, signal: AbortSignal): Promise<LoopbackToolResult> => {
    const binding = grant.route === "ask" ? options.decisions?.() : undefined;
    if (!binding) return toolError("Control suggestions are available only in the person's own Ask. Choose from get_window_state.");
    if (!binding.sameMember()) return toolError("The RealBud member changed, so no suggestion was asked.");
    if (typeof goal !== "string" || !goal.trim() || goal.length > 500) return toolError("pick_control takes a goal of 1 to 500 characters.");
    if (credentialGoal(goal)) { note("pick_control", "refused", CREDENTIAL_STATE); return toolError(CREDENTIAL_STATE); }
    const luna = binding.lunaReady() ? lunaModel() : null;
    const ask = asker(binding);
    if (!binding.ready() && !luna) return text(PICK_NONE);
    const first = await readWindow(false, signal);
    if (!first.ok) return first.answer;
    const candidatesOf = () => desktopCandidates(snapshot!, goal).slice(0, MAX_PICK_OPTIONS);
    const unsafe = (rows: DesktopCandidate[]) => rows.some(row => containsCredential(row.label));
    let candidates = candidatesOf();
    if (unsafe(candidates)) { note("pick_control", "refused", CREDENTIAL_STATE); return toolError(CREDENTIAL_STATE); }
    // Jev first whenever there is anything labelled to choose from, even from a partial tree (the answer says so); Luna's eyes only after.
    if (candidates.length && binding.ready() && picks < MAX_PICKS_PER_TASK) {
      picks += 1;
      const picked = choice(await ask({ state: { goal, controls: candidates.map(({ label, role }, i) => ({ id: `c${i}`, role, label })) },
        questions: controlQuestion(candidates, "Options are its labelled controls.") }, { signal }));
      const row = picked && picked.choice !== "none" && picked.confidence >= PICK_MIN_CONFIDENCE ? candidates[Number(picked.choice.slice(1))] : undefined;
      if (row) { note("pick_control", "allowed", `Jev suggested '${row.label}'.`); return suggestion(row, picked!.confidence, "jev"); }
    }
    if (!luna || picks >= MAX_PICKS_PER_TASK || !active(signal)) return text(PICK_NONE);
    // ONE screenshot of the granted window, sent only to Luna; never returned, logged or recorded.
    const second = await readWindow(true, signal);
    if (!second.ok) return second.answer;
    const tooLarge = (shot: typeof second.image) => !!shot && Math.floor(shot.data.length * 3 / 4) > MAX_IMAGE_BYTES;
    let image = second.image;
    if (tooLarge(image)) {
      // Ask the driver once for a smaller capture; if it cannot, say why instead of a bare none.
      const smaller = await readWindow(true, signal, LUNA_MAX_DIMENSION);
      if (!smaller.ok && !active(signal)) return smaller.answer;
      image = smaller.ok ? smaller.image : null;
      if (!image || tooLarge(image)) { note("pick_control", "refused", PICK_TOO_LARGE); return text(PICK_TOO_LARGE); }
    }
    if (!image || !image.width || !image.height) return text(PICK_NONE);
    candidates = candidatesOf();
    if (unsafe(candidates)) { note("pick_control", "refused", CREDENTIAL_STATE); return toolError(CREDENTIAL_STATE); }
    picks += 1;
    if (candidates.length) {
      const picked = choice(await ask({ state: { goal, controls: candidates.map(({ label, role }, i) => ({ id: `c${i}`, role, label })) },
        questions: controlQuestion(candidates, "The image is the window; options are its labelled controls.") }, { signal, model: luna, image: image.data, timeoutMs: LUNA_TIMEOUT_MS }));
      const row = picked && picked.choice !== "none" && picked.confidence >= LUNA_MIN_CONFIDENCE ? candidates[Number(picked.choice.slice(1))] : undefined;
      if (row) { note("pick_control", "allowed", `Luna suggested '${row.label}'.`); return suggestion(row, picked!.confidence, "luna"); }
      return text(PICK_NONE);
    }
    const cells = Object.fromEntries([1, 2, 3].flatMap(r => [1, 2, 3].map(c => [`r${r}c${c}`, `Row ${r} of 3 (top to bottom), column ${c} of 3 (left to right) of the window image.`])));
    const picked = choice(await ask({ state: { goal, window: "The image is the whole app window, split into a 3 by 3 grid." },
      questions: { control: { type: "choice", instructions: "Which grid cell holds the centre of the one control that does the goal? Answer none if no control clearly fits.",
        criteria: { ...cells, none: "No control in the window does the goal." } } } }, { signal, model: luna, image: image.data, timeoutMs: LUNA_TIMEOUT_MS }));
    const cell = picked && picked.choice !== "none" && picked.confidence >= LUNA_MIN_CONFIDENCE ? /^r([1-3])c([1-3])$/.exec(picked.choice) : null;
    if (!cell) return text(PICK_NONE);
    const x = Math.round((Number(cell[2]) - 0.5) * image.width / 3), y = Math.round((Number(cell[1]) - 0.5) * image.height / 3);
    note("pick_control", "allowed", `Luna suggested a point (${picked!.choice}).`);
    return text(JSON.stringify({ x, y, cell: picked!.choice, confidence: picked!.confidence, by: "luna",
      note: `${SUGGESTION_ONLY} An unlabelled point in the last screenshot's pixels: clicking it asks the person once unless it lands on a named control.` }));
  };

  const run = async (name: string, raw: Record<string, unknown>, signal: AbortSignal): Promise<LoopbackToolResult> => {
    if (name === "release") { note(name, "ended", STOPPED); await endSession(); return text("Desktop work stopped. The window is the person's again."); }
    if (name === "pick_control") return pick(raw.goal, signal);
    const args = argsFor(name, raw);
    if (name === "get_window_state") {
      const read = await readWindow(args.include_screenshot === true, signal);
      if (!read.ok) return read.answer;
      const rows = snapshot!.elements.filter(row => row.token && !row.menuBar).map(row => ({ element_token: row.token, role: row.role, label: redactSecretsInText(row.label).slice(0, 200), ...(row.enabled ? {} : { enabled: false }) }));
      const body = JSON.stringify({ complete: snapshot!.complete, elements: rows, text: redactSecretsInText(snapshot!.text ?? "").slice(0, MAX_TEXT_TO_BUD) });
      // The screenshot goes to Bud's own model as before; nothing here keeps it.
      return read.image ? { content: [{ type: "image", data: read.image.data, mimeType: "image/png" }, { type: "text", text: body }] } as unknown as LoopbackToolResult : text(body);
    }
    const element = typeof args.element_token === "string" ? snapshot?.elements.find(row => row.token === args.element_token) : undefined;
    const card = { ...(element ? { control: { role: element.role, label: redactSecretsInText(element.label).slice(0, 200) } } : {}),
      ...(finite(args.x) ? { point: { x: args.x, y: args.y } } : {}), ...(typeof args.key === "string" ? { key: args.key } : {}),
      ...(typeof args.text === "string" ? { text: redactSecretsInText(args.text) } : {}) };
    return fenced(name, args, signal, card, async decision => {
      used += 1; // counted before dispatch: a step that fails in transit may still have acted
      let result: CuaToolResult;
      try { result = await call(name as CuaToolName, { ...args, ...inject }, signal); }
      catch { note(name, "failed", UNCONFIRMED); if ((await client)?.closed) await endSession(); return toolError(UNCONFIRMED); }
      if (result.isError) { note(name, "failed", "The desktop helper refused this step."); return toolError(`The desktop helper refused this step. ${driverNote(result)}`.trim()); }
      return text(`${decision.reason} Read the window again to confirm what changed. ${driverNote(result)}`.trim());
    });
  };

  const decisionsOffered = grant.route === "ask" && !!options.decisions?.();
  const server = await startLoopbackToolServer({
    name: DESKTOP_SERVER,
    serverName: "Bud desktop",
    tools: TOOLS.filter(tool => tool.name !== "pick_control" || decisionsOffered),
    maxConcurrent: 1,
    isActive: () => active(),
    async call(name, args, signal) {
      try { return await run(name, args, signal); }
      catch (error) {
        const gone = client ? (await client.catch(() => null))?.closed !== false : false;
        if (gone) await endSession();
        const message = error instanceof Error ? error.message : "";
        return toolError(message === NO_HELPER ? NO_HELPER : gone || message === STOPPED ? STOPPED : UNCONFIRMED);
      }
    },
  });
  return { descriptor: server.descriptor, get used() { return used; }, stop };
}
