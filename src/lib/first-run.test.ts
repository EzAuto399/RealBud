import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { firstRunDone, markFirstRunDone, officeContactNamed } from "./first-run";

const mem = new Map<string, string>();

beforeEach(() => {
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => void mem.set(key, value),
      removeItem: (key: string) => void mem.delete(key),
    },
  });
});

afterEach(() => {
  mem.clear();
});

describe("first-run flag", () => {
  it("is unset on a wiped profile", () => {
    expect(firstRunDone()).toBe(false);
  });

  it("sticks after the three-rules screen", () => {
    markFirstRunDone();
    expect(firstRunDone()).toBe(true);
  });
});

describe("a restored book already records the office contact", () => {
  it("reads a saved person as recorded", () => {
    expect(officeContactNamed({ book: { office: { pmUser: "Alex" } } })).toBe(true);
  });

  it("reads a saved person as recorded on a book whose agency is still unnamed", () => {
    expect(officeContactNamed({ book: { agency: { name: "" }, office: { pmUser: "Alex" } } })).toBe(true);
  });

  it.each([
    // The contact is the only field first run writes. A named agency with an
    // empty contact is a blank to fill, so it must not skip the write.
    { name: "a named agency with no contact yet", snapshot: { book: { agency: { name: "Harbour PM" }, office: { pmUser: "" } } } },
    { name: "an empty book", snapshot: { book: { office: { pmUser: "" } } } },
    { name: "whitespace standing in for a name", snapshot: { book: { office: { pmUser: "\t" } } } },
    { name: "the sample person", snapshot: { book: { office: { pmUser: "Sample PM" } } } },
    { name: "the sample person in other casing", snapshot: { book: { office: { pmUser: " sample pm " } } } },
    { name: "the demo person", snapshot: { book: { office: { pmUser: "Demo PM" } } } },
    { name: "a book that has not loaded", snapshot: {} },
    { name: "no snapshot at all", snapshot: null },
  ])("does not read $name as a recorded contact", ({ snapshot }) => {
    expect(officeContactNamed(snapshot)).toBe(false);
  });
});
