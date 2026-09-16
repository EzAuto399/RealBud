// In-process ownership for the bounded portal adapter. This is not an OS lock.
import { randomUUID } from "node:crypto";

export type LeaseOwner = "portal" | "ask" | "setup";

export interface ComputerLease {
  readonly id: string;
  readonly owner: LeaseOwner;
  readonly workItemId: string;
  readonly revision: number;
  readonly expiresAt: number;
}

export class ComputerLeaseManager {
  private lease: ComputerLease | null = null;

  hold(owner: LeaseOwner, now: number, ttlMs: number, workItemId: string, revision: number): ComputerLease {
    if (!workItemId?.trim() || workItemId.length > 180 || !Number.isSafeInteger(revision) || revision < 1 ||
      !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60_000 || !Number.isSafeInteger(now + ttlMs)) {
      throw Object.assign(new Error("invalid computer lease binding"), { status: 400 });
    }
    // Expiry does not prove the previous adapter stopped. Only its matching
    // release permits a replacement; callers must bound their operations.
    if (this.lease) {
      throw Object.assign(new Error(`computer lease held by ${this.lease.owner}`), { status: 409 });
    }
    this.lease = Object.freeze({ id: randomUUID(), owner, workItemId, revision, expiresAt: now + ttlMs });
    return this.lease;
  }

  release(lease: ComputerLease): void {
    if (this.lease?.id === lease.id) this.lease = null;
  }

  current(): ComputerLease | null {
    return this.lease;
  }

  assertHeld(lease: ComputerLease, now: number): void {
    if (!Number.isSafeInteger(now) || this.lease?.id !== lease.id || this.lease.expiresAt <= now) {
      throw Object.assign(new Error("computer lease is stale or expired"), { status: 409 });
    }
  }
}

export const computerLease = new ComputerLeaseManager();
