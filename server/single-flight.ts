/** Coalesce identical in-process work while it is running, then reopen. */
export class SingleFlight<T> {
  private active: Promise<T> | null = null;

  run(start: () => T | Promise<T>): Promise<T> {
    if (this.active) return this.active;
    const task = Promise.resolve().then(start);
    const shared = task.finally(() => {
      if (this.active === shared) this.active = null;
    });
    this.active = shared;
    return shared;
  }

  running(): boolean {
    return this.active !== null;
  }
}
