// One shared computer lease. Ask, setup, and a portal run cannot overlap.

export type LeaseOwner = "portal" | "ask" | "setup";

export interface ComputerLease {
  owner: LeaseOwner;
  workItemId?: string;
  expiresAt: number;
}

export class ComputerLeaseManager {
  private lease: ComputerLease | null = null;

  hold(owner: LeaseOwner, now: number, ttlMs: number, workItemId?: string): ComputerLease {
    if (this.lease && this.lease.expiresAt > now && this.lease.owner !== owner) {
      throw Object.assign(new Error(`computer lease held by ${this.lease.owner}`), { status: 409 });
    }
    this.lease = { owner, workItemId, expiresAt: now + ttlMs };
    return this.lease;
  }

  release(owner: LeaseOwner): void {
    if (this.lease?.owner === owner) this.lease = null;
  }

  current(): ComputerLease | null {
    return this.lease;
  }

  assertFreeOr(owner: LeaseOwner, now: number): void {
    if (this.lease && this.lease.expiresAt > now && this.lease.owner !== owner) {
      throw Object.assign(new Error(`computer lease held by ${this.lease.owner}`), { status: 409 });
    }
  }
}

export const computerLease = new ComputerLeaseManager();
