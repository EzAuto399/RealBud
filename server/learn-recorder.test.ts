import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { LearnRecorder, LEARN_LISTENER } from "./learn-recorder.ts";
import { LEARN_MAX_EVENTS, LEARN_MAX_TEXT } from "../shared/learned-recipes.ts";

const ORIGIN = "https://portal.fictional.test";
const SESSION = "FICTIONALSESSION";
type Json = Record<string, unknown>;
type Listener = { fn: (event: Json) => void; once: boolean };

/** A fake CDP browser socket: answers every command, lets a test emit events. */
function fakeCdp() {
  const listeners = new Map<string, Listener[]>();
  const sent: Json[] = [];
  let readyState = 0;
  const emit = (type: string, event: Json = {}) => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      if (listener.once) listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== listener));
      listener.fn(event);
    }
  };
  const results: Record<string, Json> = {
    "Target.attachToTarget": { sessionId: SESSION },
    "Page.addScriptToEvaluateOnNewDocument": { identifier: "7" },
    "Page.getFrameTree": { frameTree: { frame: { id: "MAIN", url: `${ORIGIN}/dashboard?reicid=fictional-private#top` } } },
    "Runtime.evaluate": { result: { type: "undefined" } },
  };
  const socket = {
    get readyState() { return readyState; },
    addEventListener(type: string, fn: (event: Json) => void, options?: { once?: boolean }) { listeners.set(type, [...(listeners.get(type) ?? []), { fn, once: Boolean(options?.once) }]); },
    send(text: string) {
      if (readyState !== 1) throw new Error("closed");
      const message = JSON.parse(text) as Json; sent.push(message);
      queueMicrotask(() => {
        if (readyState !== 1) return;
        emit("message", { data: JSON.stringify({ id: message.id, result: results[String(message.method)] ?? {} }) });
        // Like Chrome: Runtime.enable reports the existing contexts, the main frame's page world and an iframe's.
        if (message.method === "Runtime.enable") {
          for (const context of [{ id: 1, auxData: { isDefault: true, frameId: "MAIN" } }, { id: 2, auxData: { isDefault: true, frameId: "CHILD" } }, { id: 3, auxData: { isDefault: false, frameId: "MAIN" } }]) {
            emit("message", { data: JSON.stringify({ method: "Runtime.executionContextCreated", params: { context }, sessionId: SESSION }) });
          }
        }
      });
    },
    close() { if (readyState === 3) return; readyState = 3; emit("close"); },
  };
  setTimeout(() => { readyState = 1; emit("open"); });
  const binding = () => String((sent.find(message => message.method === "Runtime.addBinding")?.params as Json).name);
  const event = (method: string, params: Json, sessionId: string = SESSION) => emit("message", { data: JSON.stringify({ method, params, sessionId }) });
  const call = (payload: unknown, name = binding(), executionContextId = 1) => event("Runtime.bindingCalled", { name, payload: typeof payload === "string" ? payload : JSON.stringify(payload), executionContextId });
  const navigate = (url: string) => event("Page.frameNavigated", { frame: { id: "MAIN", loaderId: "L", url } });
  return { socket: socket as unknown as WebSocket, sent, results, call, event, navigate, binding, methods: () => sent.map(message => message.method), close: () => socket.close() };
}

async function recording() {
  const cdp = fakeCdp();
  const open = vi.fn(async (_url: string) => ({ endpoint: "ws://127.0.0.1:49231/devtools/browser/fictional-learn", targetId: "FICTIONALTAB" }));
  const recorder = new LearnRecorder({ open, now: () => 1000, socket: () => cdp.socket });
  const view = await recorder.start("fictional-portal", ORIGIN);
  return { cdp, open, recorder, view };
}
const click = (name: string, landmark = "main") => ({ kind: "click", role: "button", name, landmark });

describe("LearnRecorder", () => {
  it("attaches to the opened tab, installs the binding and listener, and records the first page without its query", async () => {
    const { cdp, open, view } = await recording();
    expect(open).toHaveBeenCalledWith(`${ORIGIN}/`);
    expect(view).toEqual({ state: "recording", portal: "fictional-portal", startedAt: 1000, events: 1 });
    expect(cdp.methods()).toEqual(["Target.attachToTarget", "Runtime.enable", "Page.enable", "Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument", "Page.getFrameTree", "Runtime.evaluate"]);
    expect(cdp.sent[0]).toMatchObject({ params: { targetId: "FICTIONALTAB", flatten: true } });
    expect(cdp.sent[0]).not.toHaveProperty("sessionId");
    expect(cdp.sent.slice(1).every(message => message.sessionId === SESSION)).toBe(true);
    expect(cdp.binding()).toMatch(/^rbLearn_[a-f0-9]{18}$/);
    expect(String((cdp.sent[4].params as Json).source)).toContain(JSON.stringify(cdp.binding()));
  });

  it("accepts events on the portal's origin and drops them anywhere else", async () => {
    const { cdp, recorder } = await recording();
    cdp.call(click("View"));
    cdp.navigate("https://signin.fictional.test/login?user=fictional");
    cdp.call({ kind: "secret", landmark: "main" });
    cdp.navigate(`${ORIGIN}/receipts/bulk?reicid=fictional-private`);
    cdp.call({ kind: "type", field: "Search", landmark: "main" });
    cdp.event("Page.frameNavigated", { frame: { id: "CHILD", parentId: "MAIN", url: "https://ads.fictional.test/frame" } });
    cdp.event("Page.navigatedWithinDocument", { frameId: "MAIN", url: `${ORIGIN}/receipts/bulk#again` });
    cdp.event("Page.navigatedWithinDocument", { frameId: "MAIN", url: `${ORIGIN}/receipts/history` });
    expect(await recorder.stop()).toEqual([
      { kind: "page", url: `${ORIGIN}/dashboard`, table: false },
      { kind: "click", role: "button", name: "View", landmark: "main" },
      { kind: "page", url: "https://signin.fictional.test/", table: false },
      { kind: "page", url: `${ORIGIN}/receipts/bulk`, table: false },
      { kind: "type", field: "Search", landmark: "main" },
      { kind: "page", url: `${ORIGIN}/receipts/history`, table: false },
    ]);
  });

  it("drops malformed, wrong-binding and wrong-session payloads, and cleans what it keeps", async () => {
    const { cdp, recorder } = await recording();
    cdp.call("not json");
    cdp.call({ ...click("View"), extra: "x" });
    cdp.call(click("View", "header"));
    cdp.call({ kind: "click", role: "checkbox", name: "View", landmark: "main" });
    cdp.call(click("   "));
    cdp.call({ kind: "page", url: `${ORIGIN}/fake`, table: true });
    cdp.call({ kind: "type", field: "Search", value: "fictional typed value", landmark: "main" });
    cdp.call({ kind: "select", field: "Status", option: "Vacated", landmark: "main" }); // a chosen option is never accepted
    cdp.call({ kind: "unsupported", control: "Bad Control", name: "x", landmark: "main" });
    cdp.call({ kind: "tables", present: "yes" });
    cdp.call(click("View"), "rbLearn_000000000000000000");
    cdp.event("Runtime.bindingCalled", { name: cdp.binding(), payload: JSON.stringify(click("View")) }, "OTHERSESSION");
    cdp.call(click("Sa​ve\n\u0007 now"));
    cdp.call(click("x".repeat(500)));
    cdp.call({ kind: "radio", name: "Use Bearer fictionalTOKENvalue000000", landmark: "dialog" });
    cdp.call({ kind: "unsupported", control: "unlabelled-field", name: "", landmark: "main" });
    cdp.call({ kind: "select", field: "Status", landmark: "main" });
    const events = await recorder.stop();
    expect(events.slice(1, 3)).toEqual([click("Save now"), click("x".repeat(LEARN_MAX_TEXT))]);
    expect(events[3]).toMatchObject({ kind: "radio", landmark: "dialog" });
    expect(JSON.stringify(events[3])).not.toContain("fictionalTOKENvalue000000");
    expect(events[4]).toEqual({ kind: "unsupported", control: "unlabelled-field", name: "", landmark: "main" });
    expect(events[5]).toEqual({ kind: "select", field: "Status", landmark: "main" });
    expect(events).toHaveLength(6);
    expect(JSON.stringify(events)).not.toContain("Vacated");
  });

  it("lets the page set only the current page's table flag", async () => {
    const { cdp, recorder } = await recording();
    cdp.call({ kind: "tables", present: true });
    cdp.navigate(`${ORIGIN}/next`);
    cdp.results["Runtime.evaluate"] = { result: { type: "boolean", value: true } };
    const events = await recorder.stop();
    expect(events).toEqual([{ kind: "page", url: `${ORIGIN}/dashboard`, table: true }, { kind: "page", url: `${ORIGIN}/next`, table: true }]);
    // The final probe ran before the teardown.
    expect(cdp.methods().slice(-4)).toEqual(["Runtime.evaluate", "Runtime.removeBinding", "Page.removeScriptToEvaluateOnNewDocument", "Target.detachFromTarget"]);
  });

  it(`caps a recording at ${LEARN_MAX_EVENTS} events and ignores the rest`, async () => {
    const { cdp, recorder } = await recording();
    for (let i = 0; i < LEARN_MAX_EVENTS + 20; i++) cdp.call(click(`View ${i}`));
    expect(recorder.view().events).toBe(LEARN_MAX_EVENTS);
    cdp.navigate(`${ORIGIN}/after`);
    expect((await recorder.stop()).at(-1)).toEqual(click(`View ${LEARN_MAX_EVENTS - 2}`));
  });

  it("stop removes the binding and script, detaches and closes; it is idempotent", async () => {
    const { cdp, recorder } = await recording();
    cdp.call(click("View"));
    const events = await recorder.stop();
    expect(events).toHaveLength(2);
    const teardown = cdp.sent.slice(-3);
    expect(teardown).toEqual([
      expect.objectContaining({ method: "Runtime.removeBinding", params: { name: cdp.binding() }, sessionId: SESSION }),
      expect.objectContaining({ method: "Page.removeScriptToEvaluateOnNewDocument", params: { identifier: "7" }, sessionId: SESSION }),
      { id: expect.any(Number), method: "Target.detachFromTarget", params: { sessionId: SESSION } },
    ]);
    expect(recorder.view()).toEqual({ state: "idle", portal: null, startedAt: null, events: 0 });
    const count = cdp.sent.length;
    cdp.call(click("Late"));
    await expect(recorder.stop()).rejects.toMatchObject({ status: 409 });
    await recorder.cancel();
    expect(cdp.sent).toHaveLength(count);
  });

  it("refuses a second recording while one runs, and allows one after cancel", async () => {
    const { recorder } = await recording();
    await expect(recorder.start("fictional-portal", ORIGIN)).rejects.toMatchObject({ status: 409 });
    await recorder.cancel();
    expect(recorder.view().state).toBe("idle");
  });

  it("refuses a non-HTTPS origin and a non-loopback endpoint", async () => {
    const cdp = fakeCdp();
    await expect(new LearnRecorder({ open: async () => ({ endpoint: "ws://127.0.0.1:1/devtools/browser/x", targetId: "T" }), socket: () => cdp.socket }).start("fictional-portal", "http://portal.fictional.test")).rejects.toMatchObject({ status: 400 });
    const remote = new LearnRecorder({ open: async () => ({ endpoint: "ws://fictional.test:1/devtools/browser/x", targetId: "T" }), socket: () => cdp.socket });
    await expect(remote.start("fictional-portal", ORIGIN)).rejects.toThrow();
    expect(remote.view().state).toBe("idle");
  });

  it("keeps the events when the browser connection closes mid-recording", async () => {
    const { cdp, recorder } = await recording();
    cdp.call(click("View"));
    const sent = cdp.sent.length;
    cdp.close();
    expect(recorder.view()).toMatchObject({ state: "recording", events: 2 });
    expect(await recorder.stop()).toHaveLength(2);
    expect(cdp.sent).toHaveLength(sent);
    expect(recorder.view().state).toBe("idle");
  });

  it("accepts binding calls only from the main frame's page world", async () => {
    const { cdp, recorder } = await recording();
    cdp.call(click("Iframe"), undefined, 2);       // an iframe's page world
    cdp.call(click("Isolated"), undefined, 3);     // an isolated world in the main frame
    cdp.call(click("Unknown"), undefined, 99);     // never announced
    cdp.call(click("View"));
    // A cleared main frame (navigation) drops its contexts until the new one is announced.
    cdp.event("Runtime.executionContextsCleared", {});
    cdp.call(click("Stale"));
    cdp.event("Runtime.executionContextCreated", { context: { id: 4, auxData: { isDefault: true, frameId: "MAIN" } } });
    cdp.call(click("Next page world"), undefined, 4);
    cdp.event("Runtime.executionContextDestroyed", { executionContextId: 4 });
    cdp.call(click("Destroyed"), undefined, 4);
    expect((await recorder.stop()).filter(event => event.kind === "click")).toEqual([click("View"), click("Next page world")]);
  });

  it("claims stop once: a concurrent second stop is refused and makes no second draft", async () => {
    const { cdp, recorder } = await recording();
    cdp.call(click("View"));
    const saves: number[] = [];
    const first = recorder.finish(async events => { saves.push(events.length); return "draft"; });
    await expect(recorder.finish(async events => { saves.push(events.length); return "second"; })).rejects.toMatchObject({ status: 409, message: "This recording already finished." });
    expect(await first).toBe("draft");
    expect(saves).toEqual([2]);
    await expect(recorder.finish(async () => "late")).rejects.toMatchObject({ status: 409 });
    expect(recorder.view().state).toBe("idle");
  });

  it("keeps the events when saving the draft fails, so Stop can retry, and Cancel discards them", async () => {
    const { cdp, recorder } = await recording();
    cdp.call(click("View"));
    await expect(recorder.finish(async () => { throw Object.assign(new Error("Fictional disk full"), { status: 500 }); })).rejects.toThrow("Fictional disk full");
    expect(recorder.view()).toMatchObject({ state: "recording", portal: "fictional-portal", events: 2 });
    expect(recorder.recording()).toBe(false); // the tab is released; only the events are held
    await expect(recorder.start("fictional-portal", ORIGIN)).rejects.toMatchObject({ status: 409 });
    expect(await recorder.finish(async (events, portal) => ({ portal, events: events.length }))).toEqual({ portal: "fictional-portal", events: 2 });
    expect(recorder.view().state).toBe("idle");
    const again = await recording();
    await expect(again.recorder.finish(async () => { throw new Error("Fictional failure"); })).rejects.toThrow();
    await again.recorder.cancel();
    expect(again.recorder.view().state).toBe("idle");
  });
});

/** A minimal DOM for the listener: enough to prove what it reports and that it never reads a typed value. */
function fakeDom() {
  const handlers: Record<string, (event: Json) => void> = {};
  const sent: Json[] = [];
  const valueReads: string[] = [];
  const element = (spec: { tag: string; attrs?: Record<string, string>; text?: string; landmark?: string; label?: string; type?: string; options?: string[] }) => {
    const self: Json = {
      tagName: spec.tag, id: "", type: spec.type ?? "", innerText: spec.text ?? "",
      getAttribute: (name: string) => spec.attrs?.[name] ?? null,
      closest: (selector: string) => {
        if (selector.startsWith("button,a[href]")) return self;
        if (selector.startsWith("dialog")) return spec.landmark === "dialog" ? {} : null;
        if (selector.startsWith("nav")) return spec.landmark === "navigation" ? {} : null;
        if (selector.startsWith("main")) return spec.landmark === "main" ? {} : null;
        return null;
      },
      labels: spec.label ? [{ cloneNode: () => ({ querySelectorAll: () => [], textContent: spec.label }) }] : [],
    };
    Object.defineProperty(self, "selectedOptions", { get() { valueReads.push(`${spec.tag} option`); return spec.options ? [{ text: spec.options[0] }] : undefined; } });
    Object.defineProperty(self, "value", { get() { valueReads.push(spec.tag); return "fictional typed value"; } });
    return self;
  };
  const window: Json = {};
  const document = { addEventListener: (type: string, fn: (event: Json) => void) => { handlers[type] = fn; }, querySelector: () => null, getElementById: () => null };
  window.rbLearn_fictional = (payload: string) => sent.push(JSON.parse(payload) as Json);
  runInNewContext(`(${LEARN_LISTENER})("rbLearn_fictional")`, { window, document });
  return { handlers, sent, valueReads, element };
}

describe("LEARN_LISTENER", () => {
  it("reports role, name and landmark for clicks and field labels for typing and selects, never a typed value or chosen option", () => {
    const dom = fakeDom();
    dom.handlers.click({ target: dom.element({ tag: "A", attrs: {}, text: "  Bulk\n receipting ", landmark: "navigation" }) });
    dom.handlers.click({ target: dom.element({ tag: "BUTTON", attrs: { "aria-label": "View" }, landmark: "dialog" }) });
    dom.handlers.change({ target: dom.element({ tag: "INPUT", attrs: { type: "search" }, type: "search", label: "Search", landmark: "main" }) });
    dom.handlers.change({ target: dom.element({ tag: "INPUT", attrs: { type: "password" }, type: "password", label: "Password", landmark: "main" }) });
    dom.handlers.change({ target: dom.element({ tag: "SELECT", attrs: {}, label: "Status", options: ["Pending"], landmark: "main" }) });
    dom.handlers.change({ target: dom.element({ tag: "INPUT", attrs: { type: "checkbox" }, type: "checkbox", label: "Include vacated", landmark: "main" }) });
    dom.handlers.click({ target: null });
    dom.handlers.change({ target: { tagName: "INPUT", closest: () => { throw new Error("hostile page"); } } });
    expect(dom.sent.filter(event => event.kind !== "tables")).toEqual([
      { kind: "click", role: "link", name: "Bulk receipting", landmark: "navigation" },
      { kind: "click", role: "button", name: "View", landmark: "dialog" },
      { kind: "type", field: "Search", landmark: "main" },
      { kind: "secret", landmark: "main" },
      { kind: "select", field: "Status", landmark: "main" },
      { kind: "unsupported", control: "checkbox", name: "Include vacated", landmark: "main" },
    ]);
    expect(dom.valueReads).toEqual([]);
  });

  it("treats one-time-code and PIN fields as secret but records postcode and shipping fields", () => {
    const dom = fakeDom();
    const field = (name: string, label: string) => dom.handlers.change({ target: dom.element({ tag: "INPUT", attrs: { type: "text", name }, type: "text", label, landmark: "main" }) });
    field("otp", "Code"); field("security_code", "Security code"); field("pin", "PIN");
    field("postcode", "Postcode"); field("shipping_address", "Shipping");
    expect(dom.sent.filter(event => event.kind !== "tables")).toEqual([
      { kind: "secret", landmark: "main" }, { kind: "secret", landmark: "main" }, { kind: "secret", landmark: "main" },
      { kind: "type", field: "Postcode", landmark: "main" },
      { kind: "type", field: "Shipping", landmark: "main" },
    ]);
  });
});
