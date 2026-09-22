import { describe, expect, it } from "vitest";

import { agencyIsNamed, propertyExportRow } from "./go-live";

describe("property export row", () => {
  it("exists only for property-ledger work", () => {
    expect(propertyExportRow({ mode: "demo" })).toBeNull();
    expect(propertyExportRow({ mode: "demo", workflow: "workspace" })).toBeNull();
    expect(propertyExportRow({ mode: "demo", workflow: "morning-priorities" })).toBeNull();
    expect(propertyExportRow({ mode: "demo", workflow: "property-ledger" })).toMatchObject({
      title: "Connect your property export",
      done: false,
      detail: expect.stringMatching(/needs a PMS export on Properties/),
    });
  });

  it("is done only once the book reads live imported facts", () => {
    expect(propertyExportRow({ mode: "live", workflow: "property-ledger" })).toMatchObject({
      done: true,
      detail: "The property ledger uses the imported CSV facts.",
    });
  });
});

describe("agency naming", () => {
  it("does not accept demo or training names", () => {
    expect(agencyIsNamed("Demo agency")).toBe(false);
    expect(agencyIsNamed("RealBud Demo Book")).toBe(false);
    expect(agencyIsNamed("")).toBe(false);
    expect(agencyIsNamed("Harbour PM")).toBe(true);
  });
});
