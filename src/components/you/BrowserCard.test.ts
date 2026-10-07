import { isValidElement, type ReactElement, type ReactNode, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserStatus } from "../../../shared/browser";
import { api } from "@/state/store";
import { BrowserCard } from "./BrowserCard";

// Observe the actual async effect and its state writes without a live browser.
// This node-only harness does not replace installed renderer verification.
const observed = vi.hoisted(() => ({ connected: true, preview: null as string | null, cursor: 0, values: [] as unknown[], writes: 0, refCursor: 0, refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<() => void | (() => void)>, cleanups: [] as Array<() => void> }));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { observed.effects.push(effect); },
  useCallback: <T,>(callback: T) => callback,
  useRef: <T,>(initial: T) => {
    const index = observed.refCursor++;
    return observed.refs[index] ??= { current: initial };
  },
  useState: <T,>(initial: T | (() => T)) => {
    const index = observed.cursor++;
    if (!(index in observed.values)) observed.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [observed.values[index] as T, (next: SetStateAction<T>) => {
      observed.writes++;
      observed.values[index] = typeof next === "function" ? (next as (value: T) => T)(observed.values[index] as T) : next;
    }];
  },
}));
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: { connected: observed.connected } }) }));
vi.mock("@/lib/design-preview", () => ({ get DESIGN_PREVIEW_REASON() { return observed.preview; } }));

const ready: BrowserStatus = { state: "ready", enabled: true, detail: "Fictional ready connection detail", browsers: [{ id: "fictional-work", name: "Work browser", label: "This computer", compatible: true }], selectedBrowserId: "fictional-work", active: false, checkedAt: Date.parse("2026-10-01T06:00:00Z"), version: "fixture", port: 0 };
let tree: ReactElement;
function render(props: Parameters<typeof BrowserCard>[0] = {}) {
  observed.cursor = 0; observed.refCursor = 0; observed.effects.length = 0;
  tree = BrowserCard(props);
  return renderToStaticMarkup(tree);
}
function mount(props: Parameters<typeof BrowserCard>[0] = {}) {
  const browser = new EventTarget(); vi.stubGlobal("window", browser);
  render(props);
  for (const effect of observed.effects) { const cleanup = effect(); if (cleanup) observed.cleanups.push(cleanup); }
  return browser;
}
type NodeProps = { children?: ReactNode; disabled?: boolean; onClick?: () => void };
function findButton(node: ReactNode, label: string): ReactElement<NodeProps> | undefined {
  if (Array.isArray(node)) return node.map(child => findButton(child, label)).find(Boolean);
  if (!isValidElement<NodeProps>(node)) return;
  if (node.type === "button" && renderToStaticMarkup(node).includes(label)) return node;
  return findButton(node.props.children, label);
}
async function click(label: string) {
  const target = findButton(tree, label);
  expect(target, label).toBeDefined();
  expect(target!.props.disabled).not.toBe(true);
  target!.props.onClick!();
  await Promise.resolve(); await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
beforeEach(() => {
  observed.connected = true; observed.preview = null; observed.cursor = 0; observed.values.length = 0; observed.effects.length = 0; observed.writes = 0; observed.refCursor = 0; observed.refs.length = 0;
  vi.mocked(api).mockReset();
});
afterEach(() => { for (const cleanup of observed.cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });

describe("work browser connection state", () => {
  it("does not present a retained ready result as current while RealBud is offline", async () => {
    vi.mocked(api).mockResolvedValue(ready);
    mount(); await Promise.resolve();
    expect(render()).toContain("Tell Bud what you want to do in Work");
    observed.connected = false;
    const html = render();
    expect(html).toContain("RealBud is offline");
    expect(html).not.toContain("Fictional ready connection detail");
    expect(html).not.toContain("Tell Bud what you want to do in Work");
    expect(buttons(html).length).toBeGreaterThan(0);
    expect(buttons(html).every(button => button.includes('disabled=""'))).toBe(true);
    expect(html).toMatch(/datetime="2026-10-01T06:00:00.000Z"/i);
  });

  it("replaces stale ready instructions after a failed status read but leaves the stop action available", async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...ready, active: true }).mockRejectedValueOnce(new Error("Fictional check failure"));
    const browser = mount(); await Promise.resolve();
    browser.dispatchEvent(new Event("focus")); await Promise.resolve();
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Fictional ready connection detail");
    expect(html).not.toContain("Tell Bud what you want to do in Work");
    const stop = html.match(/<button\b[^>]*>Stop browser work and take over<\/button>/)?.[0];
    expect(stop).toBeDefined();
    expect(stop).not.toContain('disabled=""');
  });

  it("routes a ready browser to Ask with one primary action and keeps options collapsed", async () => {
    const onAsk = vi.fn();
    vi.mocked(api).mockResolvedValue(ready);
    mount({ onAsk }); await Promise.resolve();
    const html = render({ onAsk });
    expect(buttons(html.split('<details class="border-t')[0])).toHaveLength(1);
    expect(html).toContain('Browser options and sign-in help</summary>');
    expect(html).not.toMatch(/<details[^>]*open[^>]*><summary[^>]*>Browser options/);
    await click("Ask Bud to use a website");
    expect(onAsk).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledOnce();
  });

  it.each(["build", "prop"])("does not contact the browser service in a %s-disabled preview", async source => {
    const reason = "Design preview. Use the desktop app for real browser connections.";
    if (source === "build") observed.preview = reason;
    const props = source === "prop" ? { disabledReason: reason } : {};
    const browser = mount(props); await Promise.resolve();
    browser.dispatchEvent(new Event("focus")); await Promise.resolve();
    const html = render(props);
    expect(html).toContain("Preview only");
    expect(html).toContain(reason);
    expect(buttons(html)).toHaveLength(0);
    expect(api).not.toHaveBeenCalled();
  });

  it("explains a blocked fixture action without displaying the internal QA exception", async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...ready, state: "off", enabled: false, active: false })
      .mockRejectedValueOnce(new Error("QA denied non-connector fetch: http://localhost/private-test-path"));
    mount(); await Promise.resolve(); render();
    await click("Open work browser");
    const html = render();
    expect(html).toContain("Open the RealBud desktop app to connect your browser");
    expect(html).not.toContain("QA denied");
    expect(html).not.toContain("private-test-path");
    expect(api).toHaveBeenLastCalledWith("/api/browser/connect", { method: "POST", body: "{}" }, { timeoutMs: 90_000 });
  });

  it("keeps takeover unconfirmed when stop fails and offers the connection check", async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...ready, active: true })
      .mockRejectedValueOnce(new Error("Internal controller error /fictional/private-path"));
    mount(); await Promise.resolve(); render();
    await click("Stop browser work and take over");
    const html = render();
    expect(html).toContain("Browser release could not be confirmed");
    expect(html).not.toContain("You can take over in the browser");
    expect(html).not.toContain("private-path");
    expect(findButton(tree, "Stop browser work and take over")?.props.disabled).toBe(false);
    expect(findButton(tree, "Check browser connection")).toBeDefined();
  });

  it("checks only the connection endpoint and ignores older and unmounted replies", async () => {
    const old = deferred<BrowserStatus>(), fresh = deferred<BrowserStatus>(), afterClose = deferred<BrowserStatus>();
    vi.mocked(api).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise).mockReturnValueOnce(afterClose.promise);
    const browser = mount();
    browser.dispatchEvent(new Event("focus"));
    fresh.resolve(ready); await fresh.promise; await Promise.resolve();
    old.resolve({ ...ready, state: "off", detail: "Old connection" }); await old.promise; await Promise.resolve();
    expect(observed.values[0]).toEqual(ready);
    expect(observed.values[4]).toBe(false);
    browser.dispatchEvent(new Event("focus"));
    for (const cleanup of observed.cleanups.splice(0)) cleanup();
    const writes = observed.writes;
    afterClose.resolve({ ...ready, state: "disconnected" }); await afterClose.promise; await Promise.resolve();
    expect(observed.writes).toBe(writes);
    expect(api).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(api).mock.calls) expect(call).toEqual(["/api/browser", undefined, { timeoutMs: 10_000 }]);
  });
});
