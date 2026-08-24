// Fail-closed recovery after a load or V2→V3 commit miss.
// Writes, schedules and browser work stay stopped until the PM resumes.
import type { RecoveryState } from "../shared/contracts.ts";

export interface DeskOperationalLocks {
  writes: boolean;
  schedules: boolean;
  browser: boolean;
}

export function idleRecovery(): RecoveryState {
  return { active: false, reason: null, quarantined: [] };
}

export function failClosedRecovery(reason: string, quarantined: string[] = []): RecoveryState {
  return { active: true, reason, quarantined };
}

export function locksForRecovery(recovery: RecoveryState): DeskOperationalLocks {
  if (!recovery.active) return { writes: true, schedules: true, browser: true };
  return { writes: false, schedules: false, browser: false };
}

export function assertOperational(recovery: RecoveryState, kind: keyof DeskOperationalLocks): void {
  if (!locksForRecovery(recovery)[kind]) {
    throw Object.assign(new Error(`${kind} are paused while Desk is in recovery`), { status: 409 });
  }
}
