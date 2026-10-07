// The office's REI Cloud account: the business code shown in REI's top bar and,
// only when an office saved one, the reicid from REI's addresses. Every REI read
// and the W1 bank import take the account from here (rei-morning-refresh,
// rei-directory-sync, Ask's REI reads, w1-host), so an office with no bank
// connected can still read REI. Before this store existed the account lived in
// the W1 bank settings (`rei` in w1/settings.json); until the office saves it
// here, that copy is read as revision 0.
// GET/PUT /api/rei/account; index.ts applies the session gate and the JSON rule.
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";
import { serializeFile, W1_DESTINATION } from "./w1-state.ts";

/** `marker`: the business code in REI's top bar (the account scope). `urlValue`: a reicid, only when the office saved one. */
export interface ReiAccountRef { marker: string; urlValue?: string }
export interface ReiAccount extends ReiAccountRef { revision: number; savedAt: string | null }
interface Saved { version: 1; kind: "rei-account"; marker: string; urlValue?: string; revision: number; savedAt: string }

export const REI_ACCOUNT_CONFLICT = "The REI business code changed. Reload it and try again.";
export const REI_ACCOUNT_NEEDED = "Save the REI business code first (Schedule → Bank reference review → Refresh from REI → REI business code). Bud reads REI only for the business you name there.";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const plain = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
const accountPath = (dataDir: string) => join(dataDir, "rei", "account.json");

/** The W1 rules for an REI account: a plain business code, an optional reicid, and the run's key (reicid, else the code) usable as a destination. */
export function validReiRef(v: unknown): v is ReiAccountRef {
  if (!object(v) || Object.keys(v).some(key => key !== "marker" && key !== "urlValue")) return false;
  if (v.urlValue !== undefined && (typeof v.urlValue !== "string" || !W1_DESTINATION.test(v.urlValue))) return false;
  return plain(v.marker, 100) && W1_DESTINATION.test((v.urlValue as string | undefined) || v.marker);
}
const ref = (v: ReiAccountRef): ReiAccountRef => ({ marker: v.marker, ...(v.urlValue ? { urlValue: v.urlValue } : {}) });

/** The saved account, else the one the W1 bank settings held before (revision 0), else null. */
export async function readReiAccount(dataDir: string): Promise<ReiAccount | null> {
  const saved = await readPrivateJson(accountPath(dataDir));
  if (saved !== undefined) {
    if (!object(saved) || saved.version !== 1 || saved.kind !== "rei-account" || !Number.isSafeInteger(saved.revision) || Number(saved.revision) < 1 || typeof saved.savedAt !== "string" ||
        !validReiRef({ marker: saved.marker, ...(saved.urlValue !== undefined ? { urlValue: saved.urlValue } : {}) }) || Object.keys(saved).some(key => !["version", "kind", "marker", "urlValue", "revision", "savedAt"].includes(key))) {
      return fail(503, "The saved REI business code needs recovery. Nothing was changed.");
    }
    return { ...ref(saved as unknown as Saved), revision: Number(saved.revision), savedAt: saved.savedAt };
  }
  // Migration: an office that set up bank imports before this store kept its REI account in the W1 settings.
  const w1 = await readPrivateJson(join(dataDir, "w1", "settings.json"));
  return object(w1) && validReiRef(w1.rei) ? { ...ref(w1.rei), revision: 0, savedAt: null } : null;
}

/** Just the account (business code and optional reicid) for a read's grant and recipes, or null before it is saved. */
export async function readReiAccountRef(dataDir: string): Promise<ReiAccountRef | null> {
  const account = await readReiAccount(dataDir);
  return account && ref(account);
}

/** Compare-and-set on `expectedRevision` (0 before the first save here). Throws 409 with `code: "settings_changed"` when stale. */
export function saveReiAccount(dataDir: string, input: { marker: unknown; urlValue?: unknown }, expectedRevision: number): Promise<ReiAccount> {
  const marker = typeof input.marker === "string" ? input.marker.trim() : input.marker;
  const urlValue = typeof input.urlValue === "string" ? input.urlValue.trim() : input.urlValue;
  const next = { marker, ...(urlValue === undefined || urlValue === "" ? {} : { urlValue }) };
  if (!validReiRef(next)) return Promise.reject(Object.assign(new Error("Enter the business code shown at the top of REI (letters, numbers, dots, dashes or underscores)."), { status: 400 }));
  return serializeFile(accountPath(dataDir), async () => {
    const current = await readReiAccount(dataDir);
    if ((current?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error(REI_ACCOUNT_CONFLICT), { status: 409, code: "settings_changed" });
    const saved: Saved = { version: 1, kind: "rei-account", ...ref(next), revision: expectedRevision + 1, savedAt: new Date().toISOString() };
    await writePrivateJson(accountPath(dataDir), saved);
    return { ...ref(saved), revision: saved.revision, savedAt: saved.savedAt };
  });
}

/** GET and PUT /api/rei/account. PUT takes {marker, urlValue?, expectedRevision}. */
export async function handleReiAccount(dataDir: string, method: string, readBody: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  if (method === "GET") return { status: 200, body: { account: await readReiAccount(dataDir) } };
  if (method !== "PUT") return { status: 405, body: { error: "Use GET or PUT." } };
  const body = await readBody();
  if (!object(body) || !Number.isSafeInteger(body.expectedRevision) || Object.keys(body).some(key => !["marker", "urlValue", "expectedRevision"].includes(key))) {
    return { status: 400, body: { error: "Send the REI business code and the current revision." } };
  }
  try { return { status: 200, body: { account: await saveReiAccount(dataDir, { marker: body.marker, urlValue: body.urlValue }, Number(body.expectedRevision)) } }; }
  catch (error) { const status = (error as { status?: number }).status; if (status === 400 || status === 409) return { status, body: { error: (error as Error).message } }; throw error; }
}
