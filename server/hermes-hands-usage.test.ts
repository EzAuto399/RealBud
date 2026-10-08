// The readiness check's Modelvia requests become a "readiness check" history row
// (server/computer-history.ts recordUsage), so the run cost can attribute them.
// The relay is stubbed to count one request per lease; everything else is real.
import { realpathSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunUsage } from "../shared/contracts.ts";
import { fakeHermes } from "./testing/fake-hermes.ts";

const relay = vi.hoisted(() => ({ calls: 1 }));
vi.mock("./ask-model-relay.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./ask-model-relay.ts")>(),
  applyAskModelRelayEnv: () => null,
  withAskModelRelayLease: async <T>(operation: () => Promise<T>, options: { usage?: RunUsage } = {}) => {
    const result = await operation();
    if (options.usage) { options.usage.calls += relay.calls; for (let i = 0; i < relay.calls; i++) options.usage.requestIds.push(`req-fictional-${i}`); }
    return result;
  },
}));

const { tryHermesPing } = await import("./hermes-hands.ts");
const { listHistory } = await import("./computer-history.ts");

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stub = (answer: string, code = 0) => { const fake = fakeHermes(answer, code); fake.dir = realpathSync(fake.dir); dirs.push(fake.dir); return fake; };

describe("tryHermesPing usage", () => {
  it("records the check's requests as a readiness check row, ok or not, and nothing when it made none", async () => {
    const ok = stub("OK");
    expect((await tryHermesPing({ cli: ok.script, root: ok.dir })).ok).toBe(true);
    expect(listHistory(1)[0]).toMatchObject({ kind: "tool", name: "readiness check", ok: true, detail: "", usage: { calls: 1, requestIds: ["req-fictional-0"] } });

    const refused = stub("Sure, here you go");
    expect((await tryHermesPing({ cli: refused.script, root: refused.dir })).ok).toBe(false);
    expect(listHistory(1)[0]).toMatchObject({ name: "readiness check", ok: false, usage: { calls: 1 } });

    relay.calls = 0;
    const before = listHistory(200).length;
    await tryHermesPing({ cli: ok.script, root: ok.dir });
    expect(listHistory(200)).toHaveLength(before);
  });
});
