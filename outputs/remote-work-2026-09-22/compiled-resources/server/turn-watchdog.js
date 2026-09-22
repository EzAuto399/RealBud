export class TurnWatchdog {
    turns = new Map();
    timer = null;
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    now() {
        return this.opts.now?.() ?? Date.now();
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => this.sweep(), this.opts.checkMs);
        this.timer.unref?.();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        this.turns.clear();
    }
    watch(threadId, botId) {
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
    touch(threadId) {
        const turn = this.turns.get(threadId);
        if (turn)
            turn.lastEventAt = this.now();
    }
    setWaitingOnHuman(threadId, waiting) {
        const turn = this.turns.get(threadId);
        if (!turn)
            return;
        turn.waitingOnHuman = waiting;
        turn.lastEventAt = this.now();
    }
    noteTool(threadId, fingerprint, opts) {
        const turn = this.turns.get(threadId);
        if (!turn || turn.waitingOnHuman)
            return;
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
            }
            else if (turn.lastToolFingerprint === normalized) {
                turn.repeatedToolCount += 1;
                if (this.opts.maxRepeatedTool !== undefined && turn.repeatedToolCount > this.opts.maxRepeatedTool) {
                    this.expire(turn, "repeated-tool");
                    return;
                }
            }
            else {
                turn.lastToolFingerprint = normalized;
                turn.repeatedToolCount = 1;
            }
        }
        else {
            turn.lastToolFingerprint = undefined;
            turn.repeatedToolCount = 0;
        }
        if (this.opts.maxTools !== undefined && turn.toolCount > this.opts.maxTools) {
            this.expire(turn, "tool-budget");
        }
    }
    settle(threadId) {
        this.turns.delete(threadId);
    }
    watching(threadId) {
        return this.turns.has(threadId);
    }
    sweep() {
        const at = this.now();
        for (const turn of this.turns.values()) {
            if (turn.waitingOnHuman)
                continue;
            if (this.opts.maxMs !== undefined && at - turn.startedAt >= this.opts.maxMs) {
                this.expire(turn, "deadline");
                continue;
            }
            if (at - turn.lastEventAt < this.opts.stallMs)
                continue;
            this.expire(turn, "stall");
        }
    }
    expire(turn, reason) {
        if (!this.turns.delete(turn.threadId))
            return;
        this.opts.onStall(turn, reason);
    }
}
