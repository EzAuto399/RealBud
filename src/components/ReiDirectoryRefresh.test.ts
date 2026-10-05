import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn(() => new Promise(() => {})) }));
import { parseReiDirectoryStatus, ReiDirectoryRefresh, SupplierChangeList } from "./ReiDirectoryRefresh";

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
  it("lists added and removed suppliers and changed emails, and warns on a big drop", () => {
    const changes = { added: [{ reference: "FS-PAINT", description: "Fictional Painting", emails: ["paint@fictional-painting.test"] }],
      removed: [{ reference: "FS-ROOF", description: "Fictional Roofing", emails: ["roof@fictional-roofing.test"] }],
      emails: [{ reference: "FS-ELEC", description: "Fictional Electrical", before: ["a@fictional.test"], after: ["b@fictional.test"] }], bigDrop: false };
    const html = renderToStaticMarkup(createElement(SupplierChangeList, { changes, added: 1, removed: 3 }));
    expect(html).toContain("Added in REI · 1");
    expect(html).toContain("FS-PAINT · Fictional Painting · paint@fictional-painting.test");
    expect(html).toContain("FS-ROOF · Fictional Roofing · roof@fictional-roofing.test will no longer count as listed");
    expect(html).toContain("and 2 more");
    expect(html).toContain("FS-ELEC · Fictional Electrical: a@fictional.test → b@fictional.test");
    expect(html).not.toContain("far fewer");
    expect(renderToStaticMarkup(createElement(SupplierChangeList, { changes: { ...changes, bigDrop: true }, added: 1, removed: 1 }))).toMatch(/role="alert"[^>]*>REI returned far fewer suppliers than before/);
  });
});
