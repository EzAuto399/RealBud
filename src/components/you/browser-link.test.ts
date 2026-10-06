import { describe, expect, it, vi } from "vitest";
import { linkedAfterLostAnswer } from "./browser-link";

vi.mock("@/state/store", () => ({ api: vi.fn() }));
import type { OfficeLinkStatus } from "../../../server/office-link";

const unlinked = { state: "unlinked" } as OfficeLinkStatus;
const linked = { state: "linked", agencyLabel: "Fictional Realty" } as OfficeLinkStatus;
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

describe("a pasted code whose answer was lost", () => {
  it("waits for the service to finish the link it was still saving", async () => {
    const read = vi.fn().mockResolvedValueOnce(unlinked).mockRejectedValueOnce(new Error("busy")).mockResolvedValue(linked);
    await expect(linkedAfterLostAnswer(new Error("not responding"), read, { ms: 60_000, every: 5_000, ...clock() })).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("gives up after the wait when the link never lands", async () => {
    const read = vi.fn().mockResolvedValue(unlinked);
    await expect(linkedAfterLostAnswer(new Error("not responding"), read, { ms: 20_000, every: 5_000, ...clock() })).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("treats an answered refusal as final, after showing the current link", async () => {
    const read = vi.fn().mockResolvedValue(linked);
    const refused = Object.assign(new Error("Disconnect the current website link before linking another office."), { status: 409 });
    await expect(linkedAfterLostAnswer(refused, read, clock())).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
