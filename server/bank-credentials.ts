// The office's own Redbark API key, held on this host only.
//
// Custody: this is the customer office's credential for its own Redbark
// account (a CDR representative reading the office's bank data). It is NOT a
// vendor credential and this is not vendor custody. It lives in the encrypted
// private vault (`company-installation/private`, AES envelope under the
// installation key, 0600 files via writePrivateJson). That vault entry is not
// on the private backup allowlist, it is never written to the Hermes profile,
// worker env, task files or logs, and API responses only ever carry the
// masked form `rbk_live_…abcd`.

export interface CredentialVault {
  read(name: string): Promise<unknown | undefined>;
  write(name: string, value: unknown): Promise<void>;
  remove(name: string): Promise<void>;
}

export const REDBARK_KEY_ENTRY = "bank-source-redbark-key";
const KEY_SHAPE = /^rbk_live_[A-Za-z0-9_-]{16,200}$/;

export type RedbarkKeyStatus = { configured: false; revision: 0 } | { configured: true; masked: string; savedAt: string; revision: number };
interface StoredKey { version: 1; kind: "redbark-api-key"; key: string; savedAt: string; revision: number }

export const maskRedbarkKey = (key: string) => `rbk_live_…${key.slice(-4)}`;
const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };

function stored(value: unknown): StoredKey {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || Object.keys(v).sort().join(",") !== "key,kind,revision,savedAt,version" || v.version !== 1 || v.kind !== "redbark-api-key" ||
      typeof v.key !== "string" || !KEY_SHAPE.test(v.key) || typeof v.savedAt !== "string" || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1) {
    return fail("The saved Redbark key needs recovery. Remove it and save the office's key again.", 503);
  }
  return v as unknown as StoredKey;
}

export function createBankCredentials(vault: CredentialVault, now: () => Date = () => new Date()) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };
  const read = async (): Promise<StoredKey | undefined> => {
    const value = await vault.read(REDBARK_KEY_ENTRY);
    return value === undefined ? undefined : stored(value);
  };
  const status = (value: StoredKey | undefined): RedbarkKeyStatus => value
    ? { configured: true, masked: maskRedbarkKey(value.key), savedAt: value.savedAt, revision: value.revision }
    : { configured: false, revision: 0 };
  const checkRevision = (current: StoredKey | undefined, expected: unknown) => {
    if (!Number.isSafeInteger(expected) || expected !== (current?.revision ?? 0)) fail("The saved Redbark key changed. Refresh before changing it.", 409);
  };
  return {
    async status(): Promise<RedbarkKeyStatus> { return status(await read()); },
    store(key: unknown, expectedRevision: unknown): Promise<RedbarkKeyStatus> {
      // Never echo the submitted value, even when it is malformed.
      if (typeof key !== "string" || !KEY_SHAPE.test(key.trim())) return Promise.reject(Object.assign(new Error("Paste the office's Redbark API key. It starts with rbk_live_."), { status: 400 }));
      const clean = key.trim();
      return serial(async () => {
        const current = await read();
        checkRevision(current, expectedRevision);
        const next: StoredKey = { version: 1, kind: "redbark-api-key", key: clean, savedAt: now().toISOString(), revision: (current?.revision ?? 0) + 1 };
        await vault.write(REDBARK_KEY_ENTRY, next);
        return status(next);
      });
    },
    remove(expectedRevision: unknown): Promise<RedbarkKeyStatus> {
      return serial(async () => {
        const current = await read();
        checkRevision(current, expectedRevision);
        if (current) await vault.remove(REDBARK_KEY_ENTRY);
        return status(undefined);
      });
    },
    /** Host-only use of the key. The callback must not return or persist it. */
    async withKey<T>(work: (key: string) => Promise<T>): Promise<T> {
      const current = await read();
      if (!current) return fail("Save the office's Redbark API key before using the bank source.", 409);
      return work(current.key);
    },
  };
}
export type BankCredentials = ReturnType<typeof createBankCredentials>;
