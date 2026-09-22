// In-process ownership for the bounded portal adapter. This is not an OS lock.
import { randomUUID } from "node:crypto";
export class ComputerLeaseManager {
    lease = null;
    hold(owner, now, ttlMs, workItemId, revision) {
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
    release(lease) {
        if (this.lease?.id === lease.id)
            this.lease = null;
    }
    current() {
        return this.lease;
    }
    assertHeld(lease, now) {
        if (!Number.isSafeInteger(now) || this.lease?.id !== lease.id || this.lease.expiresAt <= now) {
            throw Object.assign(new Error("computer lease is stale or expired"), { status: 409 });
        }
    }
}
export const computerLease = new ComputerLeaseManager();
