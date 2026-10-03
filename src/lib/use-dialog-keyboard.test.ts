import { describe, expect, it } from "vitest";
import { dialogFocusables } from "./use-dialog-keyboard";

// Minimal element stand-ins: the renderer tests run in node without a DOM.
type Fake = {
  tag: string; name: string; parentElement: Fake | null; children: Fake[]; open?: boolean; inert?: boolean; tabindex?: string; rendered?: boolean; visible?: boolean;
  getClientRects(): unknown[]; getAttribute(name: string): string | null; closest(selector: string): Fake | null; contains(other: Fake): boolean;
  querySelector(selector: string): Fake | null; checkVisibility(): boolean;
};
function el(tag: string, name: string, options: Partial<Fake> = {}, children: Fake[] = []): Fake {
  const node: Fake = {
    tag, name, parentElement: null, children, ...options,
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
    querySelector: selector => selector === ":scope > summary" ? node.children.find(child => child.tag === "summary") ?? null : null,
    checkVisibility: () => node.visible !== false,
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
