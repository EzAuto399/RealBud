import { expect, it } from "vitest";
import { resolveTimingDraft } from "./workspace-view-state";

it("retains unfinished timing when returning to the same saved schedule", () => {
  const draft = { ...resolveTimingDraft("09:00", [1, 3]), time: "10:30", days: [2, 4] };
  expect(resolveTimingDraft("09:00", [1, 3], draft)).toBe(draft);
});
it("does not reuse a draft against a changed server schedule", () => {
  const draft = { ...resolveTimingDraft("09:00", [1, 3]), time: "10:30" };
  expect(resolveTimingDraft("08:00", [1, 3], draft).time).toBe("08:00");
  expect(resolveTimingDraft("09:00", [2], draft).days).toEqual([2]);
});
it("does not mutate the saved days when creating a draft", () => {
  const days = [1, 3];
  const draft = resolveTimingDraft("09:00", days);
  draft.days.push(5);
  expect(days).toEqual([1, 3]);
});
