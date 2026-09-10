import { describe, expect, it } from "vitest";
import { propertyEdits, changePropertyEdits, discardPropertyEdits, savePropertyEdits } from "./property-edits";

describe("property draft recovery", () => {
  it("keeps drafts isolated by property and merges only edited options", () => {
    changePropertyEdits("isolated-a", { notes: "Draft A", options: { graceDays: "4" } });
    changePropertyEdits("isolated-a", { options: { courtesyUntilDay: "9" } });
    changePropertyEdits("isolated-b", { notes: "Draft B" });
    expect(propertyEdits("isolated-a")).toMatchObject({ notes: "Draft A", options: { graceDays: "4", courtesyUntilDay: "9" } });
    discardPropertyEdits("isolated-a", "notes");
    expect(propertyEdits("isolated-a").options?.graceDays).toBe("4");
    expect(propertyEdits("isolated-b").notes).toBe("Draft B");
  });
  it("keeps a failed draft and clears it only after confirmed success", async () => {
    changePropertyEdits("retry", { notes: "Keep this" });
    expect(await savePropertyEdits("retry", "notes", async () => false)).toBe(false);
    expect(propertyEdits("retry")).toMatchObject({ notes: "Keep this", pending: false });
    expect(await savePropertyEdits("retry", "notes", async () => true)).toBe(true);
    expect(propertyEdits("retry").notes).toBeUndefined();
    expect(propertyEdits("retry").notice).toBe("Notes saved");
  });
  it("handles a thrown transport failure without leaking payloads", async () => {
    changePropertyEdits("throw", { notes: "Private note" });
    await savePropertyEdits("throw", "notes", async () => { throw new Error("private transport payload"); });
    expect(propertyEdits("throw").error).not.toContain("private");
    expect(propertyEdits("throw").notes).toBe("Private note");
  });
  it("blocks duplicate saves and edits until the pending save resolves", async () => {
    changePropertyEdits("pending", { notes: "Original", options: { graceDays: "2" } });
    let resolve!: (ok: boolean) => void;
    let calls = 0;
    const first = savePropertyEdits("pending", "notes", () => { calls++; return new Promise<boolean>(done => { resolve = done; }); });
    const second = await savePropertyEdits("pending", "notes", async () => { calls++; return true; });
    changePropertyEdits("pending", { notes: "New" });
    discardPropertyEdits("pending", "notes");
    expect(propertyEdits("pending").notes).toBe("Original");
    expect(second).toBe(false); expect(calls).toBe(1);
    resolve(true); await first;
    expect(propertyEdits("pending").options).toEqual({ graceDays: "2" });
    expect(propertyEdits("pending").notes).toBeUndefined();
  });
});
