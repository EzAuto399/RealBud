export class WorkerOperationGate {
    active = null;
    snapshot() {
        if (!this.active)
            return null;
        const { kind, detail, startedAt } = this.active;
        return { kind, detail, startedAt };
    }
    acquire(kind, detail) {
        if (this.active) {
            throw Object.assign(new Error(`Bud is ${this.active.detail}. Let it finish before starting another worker task.`), { status: 409, code: "worker-operation-busy" });
        }
        const token = Symbol(kind);
        this.active = { kind, detail, startedAt: Date.now(), token };
        let released = false;
        return {
            release: () => {
                if (released)
                    return;
                released = true;
                // A stale or duplicate callback must never release a newer lease.
                if (this.active?.token === token)
                    this.active = null;
            },
        };
    }
}
