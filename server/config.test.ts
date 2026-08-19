import { describe, expect, it } from "vitest";

import { instanceConfigs } from "./config.ts";

describe("instanceConfigs", () => {
  it("defaults the fleet to the pinned Hermes worker only", () => {
    const map = instanceConfigs({});
    expect(Object.keys(map)).toEqual(["hermes"]);
    expect(map.hermes?.driver).toBe("hermesAgent");
  });

  it("keeps an explicit instances map", () => {
    const map = instanceConfigs({ instances: { ghost: { driver: "not-a-real-driver" } } });
    expect(Object.keys(map)).toEqual(["ghost"]);
  });
});
