import { describe, expect, it, vi } from "vitest";

import { buildHandoffPayload, deliverToPairedPhone, HANDOFF_CLIP } from "./channel-handoff.ts";
import type { RemoteChannelAdapter } from "./remote-decisions.ts";
import type { Store } from "./store.ts";

function store(messages: Array<{ id?: string; role: "user" | "bot"; kind?: string; text: string }>, busy = false): Store {
  const rows = messages.map((m, i) => ({
    id: m.id ?? `m-${i}`,
    role: m.role,
    kind: (m.kind ?? "text") as "text",
    text: m.text,
    at: i,
  }));
  return {
    productBud: () => ({ threadId: "bud", busy }),
    activePath: () => rows,
  } as unknown as Store;
}

describe("channel handoff", () => {
  it("builds a clipped result from the latest or named bot reply", () => {
    const empty = buildHandoffPayload(store([]), { mode: "result" });
    expect(empty).toEqual({ ok: false, error: expect.stringMatching(/no saved reply/i) });

    const latest = buildHandoffPayload(
      store([
        { role: "user", text: "hi" },
        { role: "bot", text: "old" },
        { id: "ans", role: "bot", text: "latest answer" },
      ]),
      { mode: "result" },
    );
    expect(latest).toMatchObject({ ok: true });
    if (latest.ok) expect(latest.text).toContain("latest answer");

    const named = buildHandoffPayload(
      store([
        { id: "a", role: "bot", text: "first" },
        { id: "b", role: "bot", text: "second" },
      ]),
      { mode: "result", messageId: "a" },
    );
    expect(named).toMatchObject({ ok: true });
    if (named.ok) {
      expect(named.text).toContain("first");
      expect(named.text).not.toContain("second");
    }

    const long = buildHandoffPayload(store([{ role: "bot", text: "x".repeat(5000) }]), { mode: "result" });
    expect(long).toMatchObject({ ok: true });
    if (long.ok) {
      expect(long.text.length).toBeLessThan(HANDOFF_CLIP + 80);
      expect(long.text).toContain("full reply");
    }
  });

  it("builds a deterministic multi-turn summary without a model", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0
        ? { role: "user" as const, text: `[Telegram · Sam] ask-${i}` }
        : { role: "bot" as const, text: `ans-${i}` },
    );
    const built = buildHandoffPayload(store(rows), { mode: "summary" });
    expect(built).toMatchObject({ ok: true });
    if (!built.ok) return;
    expect(built.text).toMatch(/^Ask handoff summary:/);
    expect(built.text).toContain("You: ask-");
    expect(built.text).not.toContain("[Telegram");
    expect(built.text).not.toContain("ask-0");
    expect(built.text).toContain("ask-10");
  });

  it("delivers only to a paired channel with sendDigest", async () => {
    const unpaired: RemoteChannelAdapter = {
      id: "discord",
      label: "Discord",
      pairedKey: () => null,
      sendDecision: vi.fn(),
      sendDigest: vi.fn(),
    };
    const paired: RemoteChannelAdapter = {
      id: "telegram",
      label: "Telegram",
      pairedKey: () => "1",
      sendDecision: vi.fn(),
      sendDigest: vi.fn(async () => undefined),
    };
    expect(await deliverToPairedPhone("hi", [unpaired])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Pair Telegram/i),
    });
    const ok = await deliverToPairedPhone("hi", [unpaired, paired]);
    expect(ok).toEqual({ ok: true, deliveredVia: "telegram", label: "Telegram" });
    expect(paired.sendDigest).toHaveBeenCalledWith("hi");
  });
});
