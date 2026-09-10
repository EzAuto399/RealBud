// Stall watchdog for dispatched turns.
//
// A wedged CLI left its bot busy forever. This watches ACTIVITY, not
// duration: a turn may run for an hour while events keep flowing, but a
// turn whose thread has emitted nothing for `stallMs` is wedged. Turns
// parked on a human approval are exempt.
export interface WatchedTurn {
  threadId: string;
  botId: string;
  startedAt: number;
  lastEventAt: number;
  waitingOnHuman: boolean;
  toolCount: number;
  lastToolFingerprint?: string;
  repeatedToolCount: number;
}

export type TurnExpiryReason = "stall" | "deadline" | "tool-budget" | "repeated-tool";

export interface TurnWatchdogOptions {
  stallMs: number;
  checkMs: number;
  maxMs?: number;
  maxTools?: number;
  maxRepeatedTool?: number;
  onStall: (turn: WatchedTurn, reason: TurnExpiryReason) => void;
  now?: () => number;
}

export class TurnWatchdog {
  private turns = new Map<string, WatchedTurn>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: TurnWatchdogOptions;

  constructor(opts: TurnWatchdogOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.opts.checkMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.turns.clear();
  }

  watch(threadId: string, botId: string): void {
    const at = this.now();
    this.turns.set(threadId, {
      threadId,
      botId,
      startedAt: at,
      lastEventAt: at,
      waitingOnHuman: false,
      toolCount: 0,
      repeatedToolCount: 0,
    });
  }

  touch(threadId: string): void {
    const turn = this.turns.get(threadId);
    if (turn) turn.lastEventAt = this.now();
  }

  setWaitingOnHuman(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.waitingOnHuman = waiting;
    turn.lastEventAt = this.now();
  }

  noteTool(threadId: string, fingerprint?: string, opts?: { allowRepeat?: boolean }): void {
    const turn = this.turns.get(threadId);
    if (!turn || turn.waitingOnHuman) return;
    turn.toolCount += 1;
    turn.lastEventAt = this.now();
    const normalized = fingerprint?.trim();
    if (normalized) {
      // Attended portal runs intentionally re-check the same page while the
      // person signs in. Count the work toward the tool budget; do not treat
      // that wait loop as a stuck provider, and do not bank repeats that would
      // instantly trip the limit once the fence ends mid-turn.
      if (opts?.allowRepeat) {
        turn.lastToolFingerprint = undefined;
        turn.repeatedToolCount = 0;
      } else if (turn.lastToolFingerprint === normalized) {
        turn.repeatedToolCount += 1;
        if (this.opts.maxRepeatedTool !== undefined && turn.repeatedToolCount > this.opts.maxRepeatedTool) {
          this.expire(turn, "repeated-tool");
          return;
        }
      } else {
        turn.lastToolFingerprint = normalized;
        turn.repeatedToolCount = 1;
      }
    } else {
      turn.lastToolFingerprint = undefined;
      turn.repeatedToolCount = 0;
    }
    if (this.opts.maxTools !== undefined && turn.toolCount > this.opts.maxTools) {
      this.expire(turn, "tool-budget");
    }
  }

  settle(threadId: string): void {
    this.turns.delete(threadId);
  }

  watching(threadId: string): boolean {
    return this.turns.has(threadId);
  }

  sweep(): void {
    const at = this.now();
    for (const turn of this.turns.values()) {
      if (turn.waitingOnHuman) continue;
      if (this.opts.maxMs !== undefined && at - turn.startedAt >= this.opts.maxMs) {
        this.expire(turn, "deadline");
        continue;
      }
      if (at - turn.lastEventAt < this.opts.stallMs) continue;
      this.expire(turn, "stall");
    }
  }

  private expire(turn: WatchedTurn, reason: TurnExpiryReason): void {
    if (!this.turns.delete(turn.threadId)) return;
    this.opts.onStall(turn, reason);
  }
}
