import { describe, expect, it } from "vitest";

import { presentStoredWorkerModel } from "./worker-model-presentation";

describe("stored worker model presentation", () => {
  it("confirms persistence without exposing a credential fingerprint", () => {
    const result = presentStoredWorkerModel({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      keyPresent: true,
      keyHint: "DEEPSEEK_API_KEY sk-a…4ca4",
    });

    expect(result).toEqual({
      ready: true,
      text: "DeepSeek · deepseek-v4-flash · key stored securely",
    });
    expect(result.text).not.toContain("sk-");
    expect(result.text).not.toContain("API_KEY");
  });

  it("distinguishes a selected model whose key is missing", () => {
    expect(
      presentStoredWorkerModel({ provider: "deepseek", model: "deepseek-v4-flash", keyPresent: false }),
    ).toEqual({ ready: false, text: "DeepSeek · deepseek-v4-flash · key required" });
    expect(presentStoredWorkerModel(null)).toEqual({ ready: false, text: "not attached" });
  });
});
