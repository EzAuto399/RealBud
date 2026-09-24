/** Coalesce identical in-process work while it is running, then reopen. */
export class SingleFlight {
    active = null;
    run(start) {
        if (this.active)
            return this.active;
        const task = Promise.resolve().then(start);
        const shared = task.finally(() => {
            if (this.active === shared)
                this.active = null;
        });
        this.active = shared;
        return shared;
    }
    running() {
        return this.active !== null;
    }
}
