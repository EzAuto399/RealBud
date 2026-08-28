import { afterEach, describe, expect, it, vi } from "vitest";

import { isHttpsUrl, openHttpsUrl } from "./open-https";

describe("https open", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts only https", () => {
    expect(isHttpsUrl("https://platform.composio.dev/auth")).toBe(true);
    expect(isHttpsUrl("http://platform.composio.dev/auth")).toBe(false);
    expect(isHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpsUrl("https://")).toBe(false);
    expect(isHttpsUrl("")).toBe(false);
  });

  it("uses the desktop shell when present and never assigns this window", () => {
    const openExternal = vi.fn(async () => true);
    const open = vi.fn();
    vi.stubGlobal("window", { ogb: { openExternal }, open, location: { assign: vi.fn() } });
    expect(openHttpsUrl("https://platform.composio.dev/auth")).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://platform.composio.dev/auth");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a tab in the browser QA shell without navigating RealBud", () => {
    const open = vi.fn(() => ({}) as Window);
    const assign = vi.fn();
    vi.stubGlobal("window", { open, location: { assign } });
    expect(openHttpsUrl("https://platform.composio.dev/auth")).toBe(true);
    expect(open).toHaveBeenCalledWith("https://platform.composio.dev/auth", "_blank", "noopener,noreferrer");
    expect(assign).not.toHaveBeenCalled();
  });
});
