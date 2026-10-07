// Code-owned evaluator catalog. The clock calls these — never a prompt.
// Each spec carries the traits the clock, Bud's thread, notifications and the
// Schedule drawer read, so a loop's behaviour is declared in one place.
// Dependency-free: the renderer reads the same table.
import type { LoopId } from "./contracts.ts";

export interface EvaluatorSpec {
  id: string;
  version: number;
  /** The built-in loop it serves; null for `recipe`, which serves every `recipe-<id>` loop. */
  loopId: LoopId | null;
  /** Scheduled ticks may collect/evaluate/propose only. Portal reads through the fenced work browser
   * (bank-references, rei-supplier-check, rei-morning-refresh) are not Cua launches. */
  mayLaunchCua: false;
  /** Off until an office turns it on, and runnable from Schedule while off. */
  optIn: boolean;
  /** A settled run posts the Desk digest to channels. False: the loop's own results speak for it. */
  pulse: boolean;
  /** A manual run must carry its request id and current schedule revision. */
  requestId: boolean;
  /** A settled run with something new posts a card in Bud's thread and a desktop notification. */
  notify: boolean;
  /** Schedule drawer: Run stays usable while the loop is off. */
  runWhileOff: boolean;
  /** Schedule drawer: the every-N-days cadence can be changed. */
  cadenceEditable: boolean;
  /** Schedule drawer: timing comes from agency workflow setup, not the timing editor. */
  agencyTimed: boolean;
}

/** The first loops: on by default, results told through the Desk digest. */
const deskDigest = { mayLaunchCua: false, optIn: false, pulse: true, requestId: false, notify: false, runWhileOff: false, cadenceEditable: false, agencyTimed: false } as const;
/** Workflow loops: opt-in, keyed manual runs, and their own results in the app instead of the digest. */
const ownResults = { ...deskDigest, optIn: true, pulse: false, requestId: true } as const;

export const EVALUATOR_CATALOG = [
  { ...deskDigest, id: "morning-money", version: 1, loopId: "morning-arrears" },
  { ...deskDigest, id: "owner-letter", version: 1, loopId: "owner-letter" },
  { ...ownResults, id: "inbound-triage", version: 1, loopId: "inbound-triage", notify: true, runWhileOff: true, agencyTimed: true },
  { ...ownResults, id: "bank-references", version: 1, loopId: "bank-references", cadenceEditable: true },
  { ...ownResults, id: "weekly-bills", version: 1, loopId: "weekly-bills", notify: true, runWhileOff: true, cadenceEditable: true },
  { ...ownResults, id: "maintenance-review", version: 1, loopId: "maintenance-review", notify: true },
  { ...ownResults, id: "rei-supplier-check", version: 1, loopId: "rei-supplier-check", notify: true, cadenceEditable: true },
  { ...ownResults, id: "rei-morning-refresh", version: 1, loopId: "rei-morning-refresh" },
  { ...ownResults, id: "inspection-draft", version: 1, loopId: "inspection-draft", notify: true },
  // Taught and pack jobs: on once their plan is approved (server/routines.ts refreshRecipeLoops).
  { ...deskDigest, id: "recipe", version: 1, loopId: null },
] as const satisfies readonly EvaluatorSpec[];

export type EvaluatorId = (typeof EVALUATOR_CATALOG)[number]["id"];
type CatalogSpec = (typeof EVALUATOR_CATALOG)[number];

export function evaluatorForLoop(loopId: string): CatalogSpec | null {
  return EVALUATOR_CATALOG.find((row) => row.loopId === loopId) ??
    (loopId.startsWith("recipe-") ? EVALUATOR_CATALOG.find((row) => row.id === "recipe")! : null);
}

/** The clock's one door to a handler: the spec is checked before any handler runs, and a loop
 * without a registered evaluator or handler is refused with a reason, never silently skipped. */
export async function dispatchLoop<T extends { ok: boolean; detail: string }>(
  loopId: string,
  handlers: Readonly<Record<EvaluatorId, () => Promise<T>>>,
): Promise<T | { ok: false; detail: string }> {
  const spec = evaluatorForLoop(loopId);
  if (!spec) return { ok: false, detail: "Not started: this version of RealBud has no evaluator for this schedule." };
  if (spec.mayLaunchCua) return { ok: false, detail: "the clock must not launch a browser" };
  if (!Object.hasOwn(handlers, spec.id)) return { ok: false, detail: "Not started: this schedule's evaluator is not available in this version of RealBud." };
  return handlers[spec.id]();
}
