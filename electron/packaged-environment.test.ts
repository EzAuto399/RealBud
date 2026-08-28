import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { packagedServerEnvironment } = require("./packaged-environment.cjs") as {
  packagedServerEnvironment(source: Record<string, string>): Record<string, string>;
};

describe("packaged server environment", () => {
  it("keeps runtime coordinates but strips model, integration, shell and release credentials", () => {
    const result = packagedServerEnvironment({
      HOME: "/isolated/home",
      PATH: "/bin",
      REALBUD_DATA_DIR: "/isolated/data",
      XAI_API_KEY: "model-secret",
      COMPOSIO_KEY: "integration-secret",
      SESSION_COOKIE: "browser-secret",
      GITHUB_TOKEN: "source-secret",
      CSC_KEY_PASSWORD: "release-secret",
      APPLE_APP_SPECIFIC_PASSWORD: "notarization-secret",
    });
    expect(result).toEqual({
      HOME: "/isolated/home",
      PATH: "/bin",
      REALBUD_DATA_DIR: "/isolated/data",
      REALBUD_PACKAGED: "1",
    });
  });

  it("does not mutate the parent environment object", () => {
    const source = { PATH: "/bin", OPENAI_API_KEY: "secret" };
    expect(packagedServerEnvironment(source)).toEqual({ PATH: "/bin", REALBUD_PACKAGED: "1" });
    expect(source.OPENAI_API_KEY).toBe("secret");
  });

  it("drops an inherited test fleet flag and forces packaged product mode", () => {
    expect(packagedServerEnvironment({ OMB_TEST_FLEET: "1", REALBUD_PACKAGED: "0" })).toEqual({
      REALBUD_PACKAGED: "1",
    });
  });
});
