import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn(() => new Promise(() => {})) }));
import { parseReiDirectoryStatus, ReiDirectoryRefresh } from "./ReiDirectoryRefresh";

describe("Refresh from REI panel", () => {
  it("renders the refresh button disabled until the server's status arrives", () => {
    const html = renderToStaticMarkup(createElement(ReiDirectoryRefresh, { kind: "tenants" }));
    expect(html).toContain('aria-label="Refresh tenant list from REI"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Refresh from REI<\/button>/);
  });
  it("reads the server's status and refuses a malformed one", () => {
    const status = { account: "FICT1", tenants: { revision: 1, count: 9, savedAt: 1 }, suppliers: { revision: 0, count: 0, savedAt: null }, run: null };
    expect(parseReiDirectoryStatus(status)).toEqual(status);
    expect(() => parseReiDirectoryStatus({ ...status, run: { id: "x", kind: "owners" } })).toThrow(/cannot read/);
    expect(() => parseReiDirectoryStatus({ account: null })).toThrow(/cannot read/);
  });
});
