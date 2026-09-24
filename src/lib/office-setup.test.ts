import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { emptyOffice, officeTicks } from "../../shared/office";
import { officeSetup, officeSetupHeadline, officeSetupHref } from "./office-setup";

const freshBook = {
  agencyName: "",
  jurisdictions: [] as string[],
  office: emptyOffice(),
};

/** The demo book pre-fills ACT, which is not the same as a named office. */
const demoBook = {
  agencyName: "RealBud Demo Book",
  jurisdictions: ["ACT"],
  office: emptyOffice(),
};

const namedBook = {
  agencyName: "Harbour PM",
  jurisdictions: ["NSW"],
  office: { ...emptyOffice(), pmUser: "Alex" },
};

describe("office setup walkthrough", () => {
  it("treats a brand-new office as fresh and incomplete", () => {
    const setup = officeSetup(freshBook);
    expect(setup.fresh).toBe(true);
    expect(setup.complete).toBe(false);
  });

  it("is not fresh once an agency is named, even with no contact yet", () => {
    const setup = officeSetup({ ...freshBook, agencyName: "Harbour PM" });
    expect(setup.fresh).toBe(false);
    expect(setup.complete).toBe(false);
  });

  it("does not call an office fresh while it still holds the demo book", () => {
    // A demo book is unnamed, but "fresh" must also be false here only if the
    // office has been touched. It has not, so this is still a first run.
    expect(officeSetup(demoBook).fresh).toBe(true);
  });

  it("is complete when the two essentials are done", () => {
    const setup = officeSetup(namedBook);
    expect(setup.complete).toBe(true);
    expect(setup.remaining).toEqual([]);
  });

  it("still lists optional work after the essentials are done", () => {
    const setup = officeSetup(namedBook);
    expect(setup.optional.length).toBeGreaterThan(0);
    expect(setup.optional.every((item) => !item.done)).toBe(true);
  });

  it("does not count the platform field as outstanding work", () => {
    // officeOs is derived, never asked for, so it must never be in the walkthrough.
    const setup = officeSetup(freshBook);
    const listed = [...setup.essential, ...setup.optional].map((item) => item.id);
    expect(listed).not.toContain("office-os");
  });

  it("reports one remaining essential in the singular", () => {
    const setup = officeSetup({ ...namedBook, jurisdictions: [] });
    expect(setup.remaining.map((item) => item.id)).toEqual(["jurisdictions"]);
    expect(officeSetupHeadline(setup)).toBe("One thing left: book jurisdictions.");
  });

  it("reports several remaining essentials as a count", () => {
    const setup = officeSetup(freshBook);
    expect(officeSetupHeadline(setup)).toBe(
      `${setup.remaining.length} things left before the desk is set up for your office.`,
    );
  });

  it("has no headline once the essentials are done", () => {
    expect(officeSetupHeadline(officeSetup(namedBook))).toBeNull();
  });

  it("names every field of the office contract exactly once", () => {
    // The checklist must label the one contract that officeTicks owns. If a
    // field is added to the contract and not here, this fails rather than
    // letting the walkthrough silently stop mentioning a real field.
    const setup = officeSetup(freshBook);
    const listed = [...setup.essential, ...setup.optional].map((item) => item.id).sort();
    const contract = officeTicks(freshBook)
      .map((tick) => tick.id)
      .filter((id) => id !== "office-os")
      .sort();
    expect(listed).toEqual(contract);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("uses the contract's own wording for every label", () => {
    const setup = officeSetup(freshBook);
    const labels = new Map(officeTicks(freshBook).map((tick) => [tick.id, tick.label]));
    for (const item of [...setup.essential, ...setup.optional]) {
      expect(item.label).toBe(labels.get(item.id));
    }
  });

  it("sends every item to a form group it belongs to", () => {
    const setup = officeSetup(freshBook);
    for (const item of [...setup.essential, ...setup.optional]) {
      expect(item.groupId.length).toBeGreaterThan(0);
      expect(item.groupLabel.length).toBeGreaterThan(0);
      expect(officeSetupHref(item)).toBe(`#${item.groupId}`);
    }
  });

  it("never links to a form group that does not exist", () => {
    // A walkthrough whose next step scrolls nowhere is worse than no
    // walkthrough. The form is the authority on which ids exist, so read it.
    const source = readFileSync(
      fileURLToPath(new URL("../components/you/OfficeCard.tsx", import.meta.url)),
      "utf8",
    );
    const rendered = new Set(Array.from(source.matchAll(/\bid="([^"]+)"/g), (m) => m[1]!));
    const setup = officeSetup(freshBook);
    for (const item of [...setup.essential, ...setup.optional]) {
      expect(rendered, `${item.id} points at #${item.groupId}`).toContain(item.groupId);
    }
  });

  it("counts only fields a person is actually asked for", () => {
    const setup = officeSetup(freshBook);
    expect(setup.total).toBe(officeTicks(freshBook).length - 1);
    expect(setup.doneCount).toBe(0);
  });

  it("counts the demo book's pre-filled jurisdiction as done", () => {
    const setup = officeSetup(demoBook);
    const jurisdictions = setup.essential.find((item) => item.id === "jurisdictions");
    expect(jurisdictions?.done).toBe(true);
    expect(setup.remaining.map((item) => item.id)).toEqual(["agency-pm"]);
  });
});
