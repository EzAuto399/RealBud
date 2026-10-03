import { readRoutineResult, type RoutineResult } from '../shared/routine-result.ts';
import type { WorkflowDatabase } from './workflow-database.ts';

export const ROUTINE_RESULT_KIND = 'routine-result';
export function validateRoutineResultRecord(id: string, value: unknown): RoutineResult {
  const result = readRoutineResult(value);
  if (id !== `routine-result:${result.workflow}:${result.runId}`) throw new Error('The routine result identity needs recovery.');
  return result;
}
export function latestRoutineResult(db: WorkflowDatabase, workflow: RoutineResult['workflow']): RoutineResult | null {
  const row = db.page<unknown>(ROUTINE_RESULT_KIND, { prefix: `routine-result:${workflow}:`, limit: 1 }).records[0];
  return row ? validateRoutineResultRecord(row.id, row.value) : null;
}
export function saveRoutineResult(db: WorkflowDatabase, value: RoutineResult): RoutineResult {
  const result = readRoutineResult(value), id = `routine-result:${result.workflow}:${result.runId}`;
  return validateRoutineResultRecord(id, db.create(ROUTINE_RESULT_KIND, id, result, null).value);
}
