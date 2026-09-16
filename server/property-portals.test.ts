import { describe, it, expect } from "vitest";
import { propertyPortalView } from "./property-portals.ts";
import type { PortalRecipe, PropertyPortalBinding } from "../shared/contracts.ts";
const recipe: PortalRecipe = { id: "portal", version: 2, published: true, origin: "https://portal.example.test/private?token=secret", steps: [], finalControlFingerprint: "private" };
const binding: PropertyPortalBinding = { propertyId: "p1", recipeId: "portal", recipeVersion: 2, remotePropertyId: "remote-private", remoteAccountId: "account-private" };
describe("display-only portal grouping", () => {
  it("projects only origins and local IDs, deduplicates and excludes archived properties", () => {
    const view = propertyPortalView(new Set(["p1"]), [binding, binding, { ...binding, propertyId: "archived" }], [recipe]);
    expect(view).toEqual([{ propertyId: "p1", origins: ["https://portal.example.test"], unresolved: false }]);
    expect(JSON.stringify(view)).not.toMatch(/secret|private|remoteAccount|steps|Fingerprint/);
  });
  it("requires an exact published recipe version", () => {
    for (const recipes of [[], [{ ...recipe, version: 3 }], [{ ...recipe, published: false }]]) {
      expect(propertyPortalView(new Set(["p1"]), [binding], recipes)[0]).toMatchObject({ origins: [], unresolved: true });
    }
  });
  it.each(["javascript:alert(1)", "file:///private", "https://user:secret@portal.example.test", "not a URL"])("holds invalid origin %s", origin => {
    expect(propertyPortalView(new Set(["p1"]), [binding], [{ ...recipe, origin }])[0]).toMatchObject({ origins: [], unresolved: true });
  });
  it("keeps partial resolution visible and makes no fallback binding", () => {
    expect(propertyPortalView(new Set(["p1", "p2"]), [binding, { ...binding, recipeId: "missing" }], [recipe])).toEqual([{ propertyId: "p1", origins: ["https://portal.example.test"], unresolved: true }]);
  });
});
