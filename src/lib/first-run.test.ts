import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { firstRunDone, markFirstRunDone } from "./first-run";

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
