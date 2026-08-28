/**
 * One in-process lease for every operation that can execute or reconfigure
 * Bud's private worker. The server is single-process, so acquiring this
 * synchronously before the first await closes check-then-act races between
 * Ask, routines, diagnostics, model/pack changes and worker updates.
 */
export interface WorkerOperationLease {
  release(): void;
}

export interface WorkerOperationSnapshot {
  kind: string;
  detail: string;
  startedAt: number;
}

export class WorkerOperationGate {
  private active: (WorkerOperationSnapshot & { token: symbol }) | null = null;

  snapshot(): WorkerOperationSnapshot | null {
    if (!this.active) return null;
    const { kind, detail, startedAt } = this.active;
    return { kind, detail, startedAt };
  }

  acquire(kind: string, detail: string): WorkerOperationLease {
    if (this.active) {
      throw Object.assign(
        new Error(`Bud is ${this.active.detail}. Let it finish before starting another worker task.`),
        { status: 409, code: "worker-operation-busy" },
      );
    }
    const token = Symbol(kind);
    this.active = { kind, detail, startedAt: Date.now(), token };
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        // A stale or duplicate callback must never release a newer lease.
        if (this.active?.token === token) this.active = null;
      },
    };
  }
}

