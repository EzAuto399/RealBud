// Code-owned evaluator catalog. The clock calls these — never a prompt.
import type { LoopId } from "../shared/contracts.ts";

export interface EvaluatorSpec {
  id: string;
  version: number;
  loopId: LoopId;
  /** Scheduled ticks may collect/evaluate/propose only. */
  mayLaunchCua: false;
}

export const EVALUATOR_CATALOG: readonly EvaluatorSpec[] = [
  { id: 'inbound-triage', version: 1, loopId: 'inbound-triage', mayLaunchCua: false },
  { id: "morning-money", version: 1, loopId: "morning-arrears", mayLaunchCua: false },
  { id: "owner-letter", version: 1, loopId: "owner-letter", mayLaunchCua: false },
];

export function evaluatorForLoop(loopId: LoopId): EvaluatorSpec | null {
  return EVALUATOR_CATALOG.find((row) => row.loopId === loopId) ?? null;
}
