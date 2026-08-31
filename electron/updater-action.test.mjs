import { describe, expect, it, vi } from "vitest";

import { runUpdaterAction } from "./updater-action.mjs";

describe("updater action boundary", () => {
  it("reports synchronous updater failures", () => {
    const onError = vi.fn();
    runUpdaterAction(() => {
      throw new Error("missing updater metadata");
    }, onError);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "missing updater metadata" }));
  });

  it("observes rejected updater promises", async () => {
    const onError = vi.fn();
    runUpdaterAction(() => Promise.reject(new Error("missing app-update.yml")), onError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "missing app-update.yml" }));
  });
});
