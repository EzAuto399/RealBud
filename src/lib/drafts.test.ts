import { describe, expect, it } from "vitest";

import { getComposerOutbox, setComposerOutbox } from "./drafts";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("composer outbox", () => {
  it("keeps one retry identity until authoritative acknowledgement clears it", () => {
    const store = memoryStorage();
    const entry = { requestId: "ask_12345678", payloadDigest: "a".repeat(64) };
    setComposerOutbox(store, "bot:bud", entry);
    expect(getComposerOutbox(store, "bot:bud")).toEqual(entry);
    setComposerOutbox(store, "bot:bud", null);
    expect(getComposerOutbox(store, "bot:bud")).toBeNull();
  });

  it("fails closed on malformed persisted identities", () => {
    const store = memoryStorage();
    store.setItem("realbud-composer-outbox-v1", JSON.stringify({ "bot:bud": { requestId: "x", payloadDigest: "secret" } }));
    expect(getComposerOutbox(store, "bot:bud")).toBeNull();
  });
});
