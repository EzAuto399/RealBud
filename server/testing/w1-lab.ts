// TEST LAB ONLY (REALBUD_TEST_LAB=1 + REALBUD_TEST_W1_FICTIONAL_REI=1): the W1
// host drives the FICTIONAL REI-style portal (fictional-rei-portal.ts) through
// the real BrowserRuntime, broker and recipe runner instead of the person's
// browser. POST /api/w1/lab plays the person's side: sign in, process the
// receipts in REI, or make the next preview/upload misbehave. "handover" turns
// on the real sign-in handover (browser-sign-in.ts) over a tab that follows the
// portal's address, so a signed-out run waits for "sign-in" and carries on by
// itself; without it sign-in stays a stop the person continues. The same portal
// serves the REI directory refresh (server/rei-directory-sync.ts). "clock" moves
// the lab's clock for scheduled sign-in waits (server/w1-sign-in-wait.ts); the
// handover and the clock survive a service restart, as the person's browser and
// time would, while the portal starts signed out again. A pass proves
// RealBud's wiring and guards, never REI Cloud behaviour.
// The bank feed is a FICTIONAL provider over a local fake Redbark that speaks
// the live REST shapes (REALBUD_TEST_REDBARK_BASE, loopback http only), read
// through redbark-source.ts's validating client with a synthetic key.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restBankProvider, type BankProvider } from "../bank-provider.ts";
import { createRedbarkClient, REDBARK_API_BASE, type RedbarkClientOptions } from "../redbark-source.ts";
import { BrowserRuntime } from "../browser-runtime.ts";
import { openForSignIn, siteFromMap, type SignInSite } from "../browser-sign-in.ts";
import type { W1HostDeps } from "../w1-host.ts";
import { FICTIONAL_REI_ORIGIN, FICTIONAL_REI_SIGNIN, FICTIONAL_SUPPLIER_LIST, fictionalReiPack, fictionalReiPortal, type FictionalReiOptions } from "./fictional-rei-portal.ts";

/** Redbark REST calls go to the loopback fake instead of api.redbark.com. */
export function labRedbarkFetch(base: string, real: RedbarkClientOptions["fetch"] = globalThis.fetch): RedbarkClientOptions["fetch"] {
  const lab = new URL(base);
  if (lab.protocol !== "http:" || lab.hostname !== "127.0.0.1" || !lab.port) throw new Error("The fictional Redbark must be a loopback http address.");
  return (input, init) => input.startsWith(`${REDBARK_API_BASE}/`) ? real(`${lab.origin}/v2/${input.slice(REDBARK_API_BASE.length + 1)}`, init) : Promise.reject(new Error("Not the fictional Redbark."));
}
/** Synthetic key the fake Redbark accepts; it is never stored. */
export const FICTIONAL_REDBARK_KEY = "rbk_live_fictional_w1_simulation_0000";

/** FICTIONAL report names for the "rename-reports" lab action. */
export const FICTIONAL_LEARNED_REPORTS = { tenants: "Tenant Contact Export (fictional)", suppliers: "Supplier Contact Export (fictional)" } as const;

export async function createW1Lab(dataDir: string, bank: { redbarkBase?: string; fetch?: RedbarkClientOptions["fetch"] } = {}) {
  const base = bank.redbarkBase ?? process.env.REALBUD_TEST_REDBARK_BASE;
  const provider: BankProvider | null = bank.fetch || base
    ? restBankProvider(createRedbarkClient({ key: FICTIONAL_REDBARK_KEY, fetch: bank.fetch ?? labRedbarkFetch(base!), sleep: async () => {} })) : null;
  // Signed out until the "person" signs in; the portal keeps its seeded receipt history.
  const options: FictionalReiOptions = { signedOut: true };
  const mock = fictionalReiPortal(options);
  let uploads = 0;
  const command: typeof mock.command = async args => {
    if (args[0] !== "upload") return mock.command(args);
    uploads += 1;
    // A lost reply rehearses one upload only.
    try { return await mock.command(args); } finally { delete options.unknownUpload; }
  };
  const runtime = new BrowserRuntime({ root: join(dataDir, "w1-lab-browser"), command, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
  await runtime.connect(); await runtime.select("work");
  // The person's side that outlives a service restart: the handover switch and the clock offset.
  const statePath = join(dataDir, "w1-lab-browser", "lab-state.json");
  const saved = (() => { try { return JSON.parse(readFileSync(statePath, "utf8")) as { handover?: unknown; offsetMs?: unknown }; } catch { return {}; } })();
  let offsetMs = Number.isSafeInteger(saved.offsetMs) ? Number(saved.offsetMs) : 0, signInTabs = 0, signInReloads = 0, signInShows = 0;
  const now = () => Date.now() + offsetMs;
  const persist = () => writeFileSync(statePath, JSON.stringify({ handover: lab.openForSignIn !== undefined, offsetMs }), { mode: 0o600 });
  // Ask browser tasks in the lab (server/ask-browser-lab.ts) treat this fictional browser as RealBud's own work
  // browser, as the native one is, so the task-local read allowance applies; saved jobs and recipe runs ignore it.
  Object.defineProperty(runtime, "ownsProfile", { value: true });
  // After sign-in the address carries no reicid; the business is the top-bar code.
  const dashboard = `${FICTIONAL_REI_ORIGIN}/customers/dashboard`;
  const signInSites: SignInSite[] = [siteFromMap("rei-cloud", { origin: FICTIONAL_REI_ORIGIN, signIn: { host: new URL(FICTIONAL_REI_SIGNIN).host }, scope: { urlParam: "reicid" } })!];
  // The sign-in tab reads only the portal's address, as the real handover does; a long wait's refresh and a
  // "bring it forward" (Desk's Sign in to REI) are counted.
  const signInTab = { openSignInTab: async () => { signInTabs += 1; return "fictional-rei-sign-in"; }, signInTabUrl: async () => mock.url(),
    reloadSignInTab: async () => { signInReloads += 1; }, showSignInTab: async () => { signInShows += 1; return true; } };
  const handover: NonNullable<W1HostDeps["openForSignIn"]> = input => openForSignIn(input, { runtime: signInTab, sites: signInSites, pollMs: 50, now });
  const lab = {
    provider,
    runtime,
    signInTab,
    load: async () => fictionalReiPack(),
    browserId: async () => "work",
    openForSignIn: saved.handover === true ? handover : undefined as W1HostDeps["openForSignIn"],
    now,
    async handle(body: unknown) {
      const action = (body as { action?: unknown } | null)?.action;
      if (action === "handover") { lab.openForSignIn = handover; persist(); }
      // The lab's clock jumps to `at` (an ISO time) and runs on from there.
      else if (action === "clock") {
        const at = Date.parse(String((body as { at?: unknown }).at));
        if (!Number.isFinite(at)) throw Object.assign(new Error("Give the lab clock an ISO time."), { status: 400 });
        offsetMs = at - Date.now(); persist();
      }
      else if (action === "sign-in") { mock.signIn(); await mock.command(["navigate", dashboard]); }
      // The REI session ends (as it does overnight): the portal shows its sign-in page again.
      else if (action === "sign-out") mock.signOut();
      else if (action === "mismatch") options.previewEdit = rows => rows.map((row, index) => index === 0 ? [...row.slice(0, 4), (Number(row[4]) + 10).toFixed(2), row[5]] : row);
      // The portal never accepted the file: nothing pending, nothing receipted.
      else if (action === "lost-reply") options.unknownUpload = "before";
      // The portal accepted the file (it stays pending in Bulk receipting) but the reply is lost.
      else if (action === "lost-reply-after") options.unknownUpload = "after";
      else if (action === "clear") { delete options.previewEdit; delete options.directoryRows; delete options.suppliers; }
      // REI's Suppliers list changes: FS-PAINT is added, FS-ROOF removed, and FS-ELEC's invoices address changes.
      else if (action === "change-suppliers") options.suppliers = [...FICTIONAL_SUPPLIER_LIST.filter(row => row.cells[0] !== "FS-ROOF").map(row => row.cells[0] !== "FS-ELEC" ? row
        : { ...row, cells: row.cells.map(cell => cell.replace("invoices@fictional-electrical.test", "billing@fictional-electrical.test")) }),
        { status: "Active", cells: ["FS-PAINT", "Fictional Painting", "07 0000 0006", "", "", "", "paint@fictional-painting.test", "6 Fictional St, Brisbane", "Painter"] }];
      // REI's Suppliers list loses most of its rows (a big drop to hold for the person).
      else if (action === "drop-suppliers") options.suppliers = FICTIONAL_SUPPLIER_LIST.slice(0, 2);
      // REI's tenant and supplier report exports carry names Bud can only learn in Ask (Refresh from REI reads the grids instead).
      else if (action === "rename-reports") options.reports = { tenants: FICTIONAL_LEARNED_REPORTS.tenants, suppliers: FICTIONAL_LEARNED_REPORTS.suppliers };
      // The next tenant or supplier list read shows one row fewer than REI's own record count.
      else if (action === "short-export") options.directoryRows = rows => rows.slice(1);
      // The person switches REI to another business (top-bar code FICT2), then back.
      else if (action === "switch-business") mock.setBusiness("FICT2");
      else if (action === "restore-business") mock.setBusiness();
      // The person processes the pending import in REI (Bud never presses it).
      else if (action === "process") mock.post();
      else if (action !== "status") throw Object.assign(new Error("Unknown lab action."), { status: 400 });
      return { uploads, effects: [...mock.effects], receipts: mock.receipts().length, pending: Boolean(mock.pendingUpload()), signInTabs, signInReloads, signInShows, now: new Date(now()).toISOString() };
    },
  };
  return lab;
}
