import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dialogFocusables, trapDialogTab, useDialogKeyboard } from "./use-dialog-keyboard";

// No renderer runs here: effects run at once and their cleanups are kept, so the hook is callable directly.
const effects = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useRef: <T,>(current: T) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => { const cleanup = effect(); if (cleanup) effects.cleanups.push(cleanup); },
}));

// Minimal element stand-ins: the renderer tests run in node without a DOM.
const doc = { activeElement: null as unknown };
type Fake = {
  tag: string; name: string; parentElement: Fake | null; children: Fake[]; open?: boolean; inert?: boolean; tabindex?: string; rendered?: boolean; visible?: boolean;
  autofocus?: boolean; isConnected?: boolean; ownerDocument: typeof doc; listeners: Map<string, (event: unknown) => void>;
  getClientRects(): unknown[]; getAttribute(name: string): string | null; closest(selector: string): Fake | null; contains(other: Fake): boolean;
  querySelector(selector: string): Fake | null; querySelectorAll(selector: string): Fake[]; checkVisibility(): boolean; focus(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void; removeEventListener(type: string): void;
};
function el(tag: string, name: string, options: Partial<Fake> = {}, children: Fake[] = []): Fake {
  const node: Fake = {
    tag, name, parentElement: null, children, isConnected: true, ownerDocument: doc, listeners: new Map(), ...options,
    getClientRects: () => node.rendered === false ? [] : [{}],
    getAttribute: attr => attr === "tabindex" ? node.tabindex ?? null : null,
    closest(selector) {
      for (let at: Fake | null = node; at; at = at.parentElement) {
        if (selector === "details" && at.tag === "details") return at;
        if (selector === "[inert]" && at.inert) return at;
      }
      return null;
    },
    contains: other => { for (let at: Fake | null = other; at; at = at.parentElement) if (at === node) return true; return false; },
    querySelector: selector => selector === ":scope > summary" ? node.children.find(child => child.tag === "summary") ?? null
      : selector === "[data-dialog-autofocus]" ? controls(node).find(child => child.autofocus) ?? null : null,
    querySelectorAll: () => controls(node),
    checkVisibility: () => node.visible !== false,
    focus: () => { doc.activeElement = node; },
    addEventListener: (type, listener) => { node.listeners.set(type, listener); },
    removeEventListener: type => { node.listeners.delete(type); },
  };
  for (const child of children) child.parentElement = node;
  return node;
}
const controls = (root: Fake) => {
  const out: Fake[] = [];
  const walk = (node: Fake) => { if (node.tag === "button" || node.tag === "summary") out.push(node); node.children.forEach(walk); };
  walk(root); return out;
};
const names = (root: Fake) => dialogFocusables({ querySelectorAll: () => controls(root) } as unknown as ParentNode).map(node => (node as unknown as Fake).name);
const key = (name: string, shiftKey = false) => ({ key: name, shiftKey, isComposing: false, keyCode: 0, preventDefault: vi.fn(), stopPropagation: vi.fn() });
const press = (root: Fake, shiftKey = false) => { const event = key("Tab", shiftKey); trapDialogTab(root as unknown as HTMLElement, event); return event; };
const active = () => (doc.activeElement as Fake | null)?.name;

describe("dialogFocusables", () => {
  it("skips controls inside a closed details but keeps its summary", () => {
    const root = el("div", "dialog", {}, [
      el("button", "Close"),
      el("details", "browser", { open: false }, [
        el("summary", "Work browser"),
        el("button", "Open work browser"),
        el("details", "options", { open: false }, [el("summary", "Browser options"), el("button", "Check browser connection")]),
      ]),
    ]);
    expect(names(root)).toEqual(["Close", "Work browser"]);
  });

  it("includes nested controls once every details around them is open", () => {
    const root = el("div", "dialog", {}, [
      el("button", "Close"),
      el("details", "browser", { open: true }, [
        el("summary", "Work browser"),
        el("details", "options", { open: false }, [el("summary", "Browser options"), el("button", "Check browser connection")]),
      ]),
    ]);
    expect(names(root)).toEqual(["Close", "Work browser", "Browser options"]);
  });

  it("still excludes unrendered, inert, tabindex=-1 and invisible controls", () => {
    const root = el("div", "dialog", {}, [
      el("button", "Close"),
      el("button", "Unrendered", { rendered: false }),
      el("div", "hidden section", { inert: true }, [el("button", "Inert")]),
      el("button", "Skipped", { tabindex: "-1" }),
      el("button", "Invisible", { visible: false }),
      el("button", "Last"),
    ]);
    expect(names(root)).toEqual(["Close", "Last"]);
  });
});

describe("trapDialogTab", () => {
  const dialog = () => el("div", "dialog", {}, [
    el("button", "Close"),
    el("button", "Search"),
    el("details", "filters", { open: false }, [el("summary", "Filters"), el("button", "Case type")]),
    el("button", "Next page", { visible: false }),
  ]);

  it("wraps Tab from the last reachable control to the first, and Shift+Tab back, a summary included", () => {
    const root = dialog();
    root.children[2]!.children[0]!.focus();
    const forward = press(root);
    expect(forward.preventDefault).toHaveBeenCalledOnce();
    expect(active()).toBe("Close");
    const back = press(root, true);
    expect(back.preventDefault).toHaveBeenCalledOnce();
    expect(active()).toBe("Filters");
  });

  it("leaves Tab between inner controls to the browser", () => {
    const root = dialog();
    root.children[0]!.focus();
    expect(press(root).preventDefault).not.toHaveBeenCalled();
    root.children[1]!.focus();
    expect(press(root, true).preventDefault).not.toHaveBeenCalled();
    expect(active()).toBe("Search");
  });

  it("moves in from the dialog itself, holds focus on it when nothing inside can take focus, and ignores other keys", () => {
    const root = dialog();
    root.focus();
    press(root, true);
    expect(active()).toBe("Filters");
    root.focus();
    press(root);
    expect(active()).toBe("Close");

    const empty = el("div", "empty dialog", {}, [el("button", "Hidden", { rendered: false })]);
    doc.activeElement = null;
    expect(press(empty).preventDefault).toHaveBeenCalledOnce();
    expect(active()).toBe("empty dialog");

    const escape = key("Escape");
    trapDialogTab(root as unknown as HTMLElement, escape);
    expect(escape.preventDefault).not.toHaveBeenCalled();
  });
});

describe("useDialogKeyboard", () => {
  class FakeHTMLElement {}
  const opened = (options: { busy?: boolean; open?: boolean; opener?: Partial<Fake> } = {}) => {
    const opener = Object.setPrototypeOf(el("button", "Opener", options.opener), FakeHTMLElement.prototype) as Fake;
    opener.focus();
    const root = el("div", "dialog", {}, [el("button", "Close"), el("button", "Name", { autofocus: true }), el("button", "Save")]);
    const onClose = vi.fn();
    useDialogKeyboard({ current: root as unknown as HTMLElement }, onClose, options.busy, options.open);
    return { root, onClose, opener, send: (event: ReturnType<typeof key>) => { root.listeners.get("keydown")?.(event); return event; } };
  };
  beforeEach(() => { effects.cleanups = []; vi.stubGlobal("document", doc); vi.stubGlobal("HTMLElement", FakeHTMLElement); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("focuses the autofocus control, closes on Escape, wraps Tab and returns focus to the opener", () => {
    const { root, onClose, send } = opened();
    expect(active()).toBe("Name");
    const escape = send(key("Escape"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(escape.stopPropagation).toHaveBeenCalledOnce();
    root.children[2]!.focus();
    expect(send(key("Tab")).preventDefault).toHaveBeenCalledOnce();
    expect(active()).toBe("Close");
    send(key("Tab", true));
    expect(active()).toBe("Save");
    effects.cleanups.forEach(cleanup => cleanup());
    expect(root.listeners.size).toBe(0);
    expect(active()).toBe("Opener");
  });

  it("keeps a busy dialog open on Escape and leaves focus alone when the opener is gone", () => {
    const { onClose, send } = opened({ busy: true, opener: { isConnected: false } });
    const escape = send(key("Escape"));
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    effects.cleanups.forEach(cleanup => cleanup());
    expect(active()).toBe("Name");
  });

  it("does nothing while closed", () => {
    const { root } = opened({ open: false });
    expect(active()).toBe("Opener");
    expect(root.listeners.size).toBe(0);
    expect(effects.cleanups).toHaveLength(0);
  });
});
