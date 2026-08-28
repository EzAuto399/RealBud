import { describe, expect, it } from "vitest";

import {
  ASK_SUGGESTIONS_HIDDEN_KEY,
  hideAskSuggestions,
  readAskSuggestionsHidden,
} from "./ask-suggestion-visibility";

describe("Ask suggestion visibility", () => {
  it("hides only this thread at this book revision", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(readAskSuggestionsHidden("thread-1", 4, storage)).toBe(false);
    hideAskSuggestions("thread-1", 4, storage);
    expect(values.get(ASK_SUGGESTIONS_HIDDEN_KEY)).toContain("thread-1");
    expect(readAskSuggestionsHidden("thread-1", 4, storage)).toBe(true);
    expect(readAskSuggestionsHidden("thread-1", 5, storage)).toBe(false);
    expect(readAskSuggestionsHidden("thread-2", 4, storage)).toBe(false);
  });

  it("fails open when storage is missing or blocked", () => {
    expect(readAskSuggestionsHidden("thread-1", 1, undefined)).toBe(false);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => hideAskSuggestions("thread-1", 1, blocked)).not.toThrow();
    expect(readAskSuggestionsHidden("thread-1", 1, blocked)).toBe(false);
  });
});
