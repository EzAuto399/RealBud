// Named product loops on the RealBud clock. RealBud owns WHEN and what the
// human sees; Hermes owns HOW (facts only, headless). A loop is "Desk, but
// the clock pressed Recheck" — never a bot, never a free-text prompt.
export type LoopId = "morning-arrears" | "owner-letter" | "inbound-triage";

export type LoopSchedule = { type: "daily"; time: string; weekdays: number[] };

export type LoopRunStatus = "queued" | "running" | "completed" | "failed" | "missed";

export interface Loop {
  id: LoopId;
  name: string;
  description: string;
  /** available = built and runnable now; false = declared, coming later. */
  available: boolean;
  enabled: boolean;
  schedule: LoopSchedule;
  nextRunAt: number | null;
}

export interface LoopRun {
  id: string;
  loopId: LoopId;
  loopName: string;
  scheduledFor: number;
  status: LoopRunStatus;
  manual: boolean;
  /** handsDetail of the desk check, or the failure reason. */
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
  seenAt?: number;
  createdAt: number;
}
