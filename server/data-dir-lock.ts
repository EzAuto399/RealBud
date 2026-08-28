import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface LockRecord {
  version: 1;
  pid: number;
  token: string;
  startedAt: number;
}

export interface DataDirLock {
  path: string;
  release: () => void;
}

export class DataDirLockedError extends Error {
  readonly code = "data-dir-locked";
  readonly ownerPid: number | null;

  constructor(ownerPid: number | null) {
    super(ownerPid ? `RealBud data is already open in process ${ownerPid}` : "RealBud data is already open");
    this.name = "DataDirLockedError";
    this.ownerPid = ownerPid;
  }
}

function decodeLock(raw: string): LockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<LockRecord>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.token !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.token) ||
      !Number.isFinite(value.startedAt)
    ) {
      return null;
    }
    return value as LockRecord;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but this user cannot signal it.
    return code === "EPERM";
  }
}

function existingOwner(path: string): LockRecord | null {
  try {
    return decodeLock(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Own the complete RealBud data directory, not merely one TCP port or one
 * Electron window. Creation is exclusive and stale recovery only occurs for
 * a well-formed record whose PID is no longer alive. Malformed ownership is
 * treated as active because guessing could create two writers.
 */
export function acquireDataDirLock(
  dataDir: string,
  opts?: { pid?: number; now?: () => number; token?: string },
): DataDirLock {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "realbud.lock");
  const pid = opts?.pid ?? process.pid;
  const token = opts?.token ?? randomUUID();
  const now = opts?.now ?? Date.now;
  const record: LockRecord = { version: 1, pid, token, startedAt: now() };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd: number | null = null;
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      let released = false;
      return {
        path,
        release: () => {
          if (released) return;
          released = true;
          try {
            const current = existingOwner(path);
            if (current?.token === token && current.pid === pid) unlinkSync(path);
          } catch {
            // Process exit must not be delayed by a best-effort lock cleanup.
          }
        },
      };
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // best effort
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const owner = existingOwner(path);
      if (!owner || processAlive(owner.pid)) throw new DataDirLockedError(owner?.pid ?? null);

      // Rename first so two contenders cannot both delete a replacement lock.
      const stale = `${path}.stale-${now()}-${randomUUID()}`;
      try {
        renameSync(path, stale);
        try {
          unlinkSync(stale);
        } catch {
          // A stale tombstone contains no user data and is harmless.
        }
      } catch {
        if (!existsSync(path)) continue;
        throw new DataDirLockedError(existingOwner(path)?.pid ?? null);
      }
    }
  }

  throw new DataDirLockedError(existingOwner(path)?.pid ?? null);
}
