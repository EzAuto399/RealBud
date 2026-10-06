// The portal account an office confirmed in an Ask browser task: the name the
// portal shows where its map says (REI's top-bar business code). A later task
// that finds the same account needs no question; a different one asks again
// (server/browser-broker.ts). A label shown on the page, never a credential.
// A damaged file is kept and refuses reads, so an unknown account always asks
// or stops, never passes.
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";

export interface PortalAccountStore {
  get(portal: string): Promise<string | null>;
  confirm(portal: string, account: string): Promise<void>;
}
type Saved = { version: 1; purpose: "portal-accounts"; accounts: Record<string, string> };
const PORTAL = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A plain on-page label: no control characters, at most 100 characters. */
export const portalAccountLabel = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value);
const RECOVERY = "Saved portal accounts need recovery, so Bud cannot check which account a task works in. Nothing was read on the portal.";

export function portalAccounts(file = join(DATA_DIR, "portal-accounts.json")): PortalAccountStore {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<Saved> => {
    const raw = await readPrivateJson(file);
    if (raw === undefined) return { version: 1, purpose: "portal-accounts", accounts: {} };
    const row = raw as Partial<Saved> | null;
    if (!row || typeof row !== "object" || Object.keys(row).sort().join() !== "accounts,purpose,version" || row.version !== 1 || row.purpose !== "portal-accounts" ||
      !row.accounts || typeof row.accounts !== "object" || Array.isArray(row.accounts) ||
      !Object.entries(row.accounts).every(([portal, account]) => PORTAL.test(portal) && portalAccountLabel(account))) throw Object.assign(new Error(RECOVERY), { status: 503 });
    return row as Saved;
  };
  return {
    async get(portal) { return PORTAL.test(portal) ? (await read()).accounts[portal] ?? null : null; },
    confirm(portal, account) {
      if (!PORTAL.test(portal) || !portalAccountLabel(account)) return Promise.reject(Object.assign(new Error("That account label cannot be saved."), { status: 400 }));
      const next = queue.then(async () => { const saved = await read(); await writePrivateJson(file, { ...saved, accounts: { ...saved.accounts, [portal]: account } }); });
      queue = next.catch(() => {});
      return next;
    },
  };
}
