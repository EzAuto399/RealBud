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
}

export interface TurnWatchdogOptions {
  stallMs: number;
  checkMs: number;
  onStall: (turn: WatchedTurn) => void;
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
    this.turns.set(threadId, { threadId, botId, startedAt: at, lastEventAt: at, waitingOnHuman: false });
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
      if (at - turn.lastEventAt < this.opts.stallMs) continue;
      this.turns.delete(turn.threadId);
      this.opts.onStall(turn);
    }
  }
}
