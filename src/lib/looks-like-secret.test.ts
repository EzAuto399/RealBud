import { describe, expect, it } from "vitest";

import { looksLikeProviderKey } from "./looks-like-secret";

describe("looksLikeProviderKey", () => {
  it("catches a pasted provider key and leaves book talk alone", () => {
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    expect(looksLikeProviderKey(`sk-ant-api03-${alpha}`)).toBe(true);
    expect(looksLikeProviderKey(`xai-${alpha}${alpha}`)).toBe(true);
    expect(looksLikeProviderKey(`ntn_${alpha}`)).toBe(true);
    expect(looksLikeProviderKey("What needs me on Oak?")).toBe(false);
    expect(looksLikeProviderKey("the keyboard shortcut is cmd-k")).toBe(false);
  });
});
