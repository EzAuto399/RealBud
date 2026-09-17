import { describe, expect, it } from "vitest";
import { resolveProductBud, resolveProductBudId } from "./product-bud";
import type { Bot } from "@/state/store";

function bot(partial: Partial<Bot> & Pick<Bot, "id" | "name">): Bot {
  return {
    threadId: "t",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "hermes", model: "default" },
    resumeCursors: {},
    createdAt: 1,
    tasks: [],
    busy: false,
    ...partial,
  } as Bot;
}

describe("resolveProductBud", () => {
  it("prefers id bud, then name Bud, then first bot", () => {
    expect(resolveProductBudId([bot({ id: "bud", name: "Bud" })])).toBe("bud");
    expect(resolveProductBudId([bot({ id: "c634d570-adaa-420d-b3d2-fee96ac63523", name: "Bud" })])).toBe(
      "c634d570-adaa-420d-b3d2-fee96ac63523",
    );
    expect(resolveProductBud([bot({ id: "other", name: "Helper" })])?.id).toBe("other");
    expect(resolveProductBudId([])).toBeNull();
  });
});
