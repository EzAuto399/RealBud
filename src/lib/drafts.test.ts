import { describe, expect, it } from "vitest";
import { acknowledgeComposerDraft, getDraft, getDraftAttachments, mergeRecoveredFollowUp, setDraft, setDraftAttachments } from "./drafts";
import { composeMessage, fileAttachment } from "./composer-attachments";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("accepted composer drafts", () => {
  it("keeps the complete draft until acceptance, then clears only that conversation", () => {
    const store = storage();
    const attachments = [fileAttachment("quote.md", "/workroom/quote.md", 120)];
    setDraft(store, "bud", "Compare this quote");
    setDraftAttachments(store, "bud", attachments);
    setDraft(store, "other", "Another request");
    expect(getDraft(store, "bud")).toBe("Compare this quote");
    expect(getDraftAttachments(store, "bud")).toEqual(attachments);
    expect(acknowledgeComposerDraft(store, "bud", "Compare this quote", attachments)).toBe(true);
    expect(getDraft(store, "bud")).toBe("");
    expect(getDraftAttachments(store, "bud")).toEqual([]);
    expect(getDraft(store, "other")).toBe("Another request");
  });

  it("does not erase newer text or attachments after a late acceptance", () => {
    const store = storage();
    const attachment = fileAttachment("new.md", "/workroom/new.md", 10);
    setDraft(store, "bud", "Newer request");
    expect(acknowledgeComposerDraft(store, "bud", "Original request", [])).toBe(false);
    expect(getDraft(store, "bud")).toBe("Newer request");
    setDraftAttachments(store, "bud", [attachment]);
    expect(acknowledgeComposerDraft(store, "bud", "Newer request", [])).toBe(false);
    expect(getDraftAttachments(store, "bud")).toEqual([attachment]);
  });

  it("does not treat unavailable or unreadable draft storage as acceptance", () => {
    expect(acknowledgeComposerDraft(undefined, "bud", "Keep me", [])).toBe(false);
    expect(acknowledgeComposerDraft({ getItem: () => { throw new Error("Storage unavailable"); }, setItem: () => {} }, "bud", "Keep me", [])).toBe(false);
  });
});

describe("interrupted PM follow-ups", () => {
  const queued = { id: "owner-update", text: "Prepare the owner update using the revised quote, AUD 1,250. Do not send." };

  it("restores a removed follow-up to an empty composer for editing", () => {
    expect(mergeRecoveredFollowUp("", [], queued)).toEqual({ text: queued.text, attachments: [] });
  });

  it("preserves a newer maintenance draft and its file after a late queue edit", () => {
    const file = fileAttachment("leak.jpg", "/workroom/leak.jpg", 300);
    const recovered = mergeRecoveredFollowUp("Triage this new leak", [file], queued);
    expect(recovered.text).toBe("Triage this new leak");
    expect(recovered.attachments[0]).toEqual(file);
    expect(recovered.attachments[1]).toMatchObject({ label: "Recovered queued follow-up", text: queued.text });
    expect(composeMessage(recovered.text, recovered.attachments)).toContain(queued.text);
  });

  it("keeps an attachment-only draft and does not duplicate a recovered follow-up", () => {
    const file = fileAttachment("inspection.pdf", "/workroom/inspection.pdf", 300);
    const first = mergeRecoveredFollowUp("", [file], queued);
    expect(first.attachments).toHaveLength(2);
    expect(mergeRecoveredFollowUp(first.text, first.attachments, queued)).toEqual(first);
    expect(mergeRecoveredFollowUp(queued.text, [], queued).attachments).toEqual([]);
  });

  it.each(["steer", "queue"])("a late %s acceptance keeps work typed after navigation", () => {
    const store = storage();
    setDraft(store, "bot:bud", queued.text);
    const newFile = fileAttachment("inspection.pdf", "/workroom/inspection.pdf", 300);
    setDraft(store, "bot:bud", "Prepare tomorrow's inspection");
    setDraftAttachments(store, "bot:bud", [newFile]);
    expect(acknowledgeComposerDraft(store, "bot:bud", queued.text, [])).toBe(false);
    expect(getDraft(store, "bot:bud")).toBe("Prepare tomorrow's inspection");
    expect(getDraftAttachments(store, "bot:bud")).toEqual([newFile]);
  });
});
