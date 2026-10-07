import { describe, expect, it, vi, type Mock } from "vitest";

import { LOOP_CATALOG } from "./routines.ts";
import { dispatchLoop, EVALUATOR_CATALOG, evaluatorForLoop, type EvaluatorId } from "../shared/workflow-catalog.ts";

type Handler = () => Promise<{ ok: boolean; detail: string }>;
const spies = () => Object.fromEntries(EVALUATOR_CATALOG.map(({ id }) =>
  [id, vi.fn<Handler>(async () => ({ ok: true, detail: `handled by ${id}` }))])) as Record<EvaluatorId, Mock<Handler>>;
const called = (handlers: Record<string, Mock<Handler>>) => Object.keys(handlers).filter((id) => handlers[id].mock.calls.length);

describe("evaluator registry", () => {
  // The branch each loop took in the clock's former if-chain (server/index.ts execute).
  it.each([
    ["morning-arrears", "morning-money"],
    ["owner-letter", "owner-letter"],
    ["inbound-triage", "inbound-triage"],
    ["bank-references", "bank-references"],
    ["weekly-bills", "weekly-bills"],
    ["maintenance-review", "maintenance-review"],
    ["rei-supplier-check", "rei-supplier-check"],
    ["rei-morning-refresh", "rei-morning-refresh"],
    ["inspection-draft", "inspection-draft"],
    ["recipe-wf-austin-accounts-bank", "recipe"],
  ])("%s dispatches to the %s handler, and only that one", async (loopId, handler) => {
    const handlers = spies();
    await expect(dispatchLoop(loopId, handlers)).resolves.toEqual({ ok: true, detail: `handled by ${handler}` });
    expect(called(handlers)).toEqual([handler]);
  });

  it("registers every catalog loop, and its saved evaluator id and version", () => {
    for (const loop of LOOP_CATALOG) expect(evaluatorForLoop(loop.id), loop.id).toMatchObject({ id: loop.evaluatorId, version: loop.evaluatorVersion, loopId: loop.id });
  });

  it("refuses an unknown or unregistered evaluator with a reason and runs nothing", async () => {
    const handlers = spies();
    await expect(dispatchLoop("retired-loop", handlers)).resolves.toEqual({ ok: false, detail: expect.stringMatching(/^Not started: .*no evaluator/) });
    await expect(dispatchLoop("recipe", handlers)).resolves.toMatchObject({ ok: false });
    const { "weekly-bills": _missing, ...partial } = handlers;
    await expect(dispatchLoop("weekly-bills", partial as typeof handlers)).resolves.toEqual({ ok: false, detail: expect.stringMatching(/^Not started: .*not available/) });
    expect(called(handlers)).toEqual([]);
  });

  it("checks the spec before the handler: an evaluator that may launch Cua is refused", async () => {
    const spec = evaluatorForLoop("owner-letter") as unknown as { mayLaunchCua: boolean };
    const handlers = spies();
    spec.mayLaunchCua = true;
    try {
      await expect(dispatchLoop("owner-letter", handlers)).resolves.toEqual({ ok: false, detail: "the clock must not launch a browser" });
    } finally { spec.mayLaunchCua = false; }
    expect(called(handlers)).toEqual([]);
    expect(EVALUATOR_CATALOG.every((row) => row.mayLaunchCua === false)).toBe(true);
  });

  it("carries the traits the hard-coded lists held, unchanged", () => {
    const ids = (trait: (row: (typeof EVALUATOR_CATALOG)[number]) => boolean) => EVALUATOR_CATALOG.filter(trait).map((row) => row.loopId ?? "recipe-*").sort();
    const workflowLoops = ["inbound-triage", "weekly-bills", "bank-references", "maintenance-review", "rei-supplier-check", "rei-morning-refresh", "inspection-draft"].sort();
    expect(ids((row) => row.optIn)).toEqual(workflowLoops); // server/routines.ts OPT_IN_LOOPS
    expect(ids((row) => !row.pulse)).toEqual(workflowLoops); // Desk digest skip list
    expect(ids((row) => row.requestId)).toEqual(workflowLoops); // POST /api/loops/:id/run
    expect(ids((row) => row.notify)).toEqual(["weekly-bills", "inbound-triage", "maintenance-review", "rei-supplier-check", "inspection-draft"].sort()); // chat card + desktop notification
    expect(ids((row) => row.runWhileOff)).toEqual(["inbound-triage", "weekly-bills"]);
    expect(ids((row) => row.cadenceEditable)).toEqual(["bank-references", "rei-supplier-check", "weekly-bills"]);
    expect(ids((row) => row.agencyTimed)).toEqual(["inbound-triage"]);
    expect(evaluatorForLoop("recipe-job-1")).toMatchObject({ id: "recipe", pulse: true, optIn: false, requestId: false, notify: false });
  });
});
