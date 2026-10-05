import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

const stubWindow = (stored: string | null, ogb?: unknown) => vi.stubGlobal("window", {
  ogb, sessionStorage: { getItem: () => stored, setItem: () => {}, removeItem: () => {} },
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
});

async function render() {
  vi.resetModules();
  const { LocalSessionGate } = await import("./LocalSessionGate");
  return renderToStaticMarkup(createElement(LocalSessionGate, null, createElement("p", null, "fictional workspace")));
}

describe("local session gate", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("asks a plain browser tab without a token to connect and does not mount the workspace", async () => {
    stubWindow(null);
    const html = await render();
    expect(html).toContain("Connect this tab to RealBud");
    expect(html).toContain("Connection token");
    expect(html).toContain('type="password"');
    expect(html).not.toContain("fictional workspace");
  });

  it("opens the workspace for a tab holding a token, and always for the desktop window", async () => {
    stubWindow("c".repeat(48));
    expect(await render()).toContain("fictional workspace");
    stubWindow(null, { getLocalSession: async () => "c".repeat(48) });
    const desktop = await render();
    expect(desktop).toContain("fictional workspace");
    expect(desktop).not.toContain("Connection token");
  });
});
