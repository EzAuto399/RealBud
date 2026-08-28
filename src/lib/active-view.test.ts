import { describe, expect, it } from "vitest";

import { ACTIVE_VIEW_SESSION_KEY, readActiveView, writeActiveView } from "./active-view";

describe("active product view", () => {
  it("starts a new or invalid session on Desk", () => {
    expect(readActiveView(undefined)).toBe("desk");
    expect(readActiveView({ getItem: () => "chat", setItem: () => undefined })).toBe("desk");
  });

  it.each(["desk", "ask", "schedule", "you"] as const)("restores %s during the same window session", (view) => {
    expect(readActiveView({ getItem: () => view, setItem: () => undefined })).toBe(view);
  });

  it("persists only the explicit product view and tolerates blocked storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    writeActiveView("schedule", storage);
    expect(values.get(ACTIVE_VIEW_SESSION_KEY)).toBe("schedule");
    expect(readActiveView(storage)).toBe("schedule");

    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => writeActiveView("ask", blocked)).not.toThrow();
    expect(readActiveView(blocked)).toBe("desk");
  });
});
