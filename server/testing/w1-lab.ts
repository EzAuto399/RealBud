// TEST LAB ONLY (REALBUD_TEST_LAB=1 + REALBUD_TEST_W1_FICTIONAL_REI=1): the W1
// host drives the FICTIONAL REI-style portal (fictional-rei-portal.ts) through
// the real BrowserRuntime, broker and recipe runner instead of the person's
// browser. POST /api/w1/lab plays the person's side: sign in, process the
// receipts in REI, or make the next preview/upload misbehave. A pass proves
// RealBud's wiring and guards, never REI Cloud behaviour.
// The bank feed is a FICTIONAL provider over a local fake Redbark that speaks
// the live REST shapes (REALBUD_TEST_REDBARK_BASE, loopback http only), read
// through redbark-source.ts's validating client with a synthetic key.
import { join } from "node:path";
import { restBankProvider, type BankProvider } from "../bank-provider.ts";
import { createRedbarkClient, REDBARK_API_BASE, type RedbarkClientOptions } from "../redbark-source.ts";
import { BrowserRuntime } from "../browser-runtime.ts";
import { FICTIONAL_REI_ORIGIN, fictionalReiPack, fictionalReiPortal, type FictionalReiOptions } from "./fictional-rei-portal.ts";

/** Redbark REST calls go to the loopback fake instead of api.redbark.com. */
export function labRedbarkFetch(base: string, real: RedbarkClientOptions["fetch"] = globalThis.fetch): RedbarkClientOptions["fetch"] {
  const lab = new URL(base);
  if (lab.protocol !== "http:" || lab.hostname !== "127.0.0.1" || !lab.port) throw new Error("The fictional Redbark must be a loopback http address.");
  return (input, init) => input.startsWith(`${REDBARK_API_BASE}/`) ? real(`${lab.origin}/v2/${input.slice(REDBARK_API_BASE.length + 1)}`, init) : Promise.reject(new Error("Not the fictional Redbark."));
}
/** Synthetic key the fake Redbark accepts; it is never stored. */
export const FICTIONAL_REDBARK_KEY = "rbk_live_fictional_w1_simulation_0000";

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
  // After sign-in the address carries no reicid; the business is the top-bar code.
  const dashboard = `${FICTIONAL_REI_ORIGIN}/customers/dashboard`;
  return {
    provider,
    runtime,
    load: async () => fictionalReiPack(),
    browserId: async () => "work",
    async handle(body: unknown) {
      const action = (body as { action?: unknown } | null)?.action;
      if (action === "sign-in") { mock.signIn(); await mock.command(["navigate", dashboard]); }
      else if (action === "mismatch") options.previewEdit = rows => rows.map((row, index) => index === 0 ? [...row.slice(0, 4), (Number(row[4]) + 10).toFixed(2), row[5]] : row);
      // The portal never accepted the file: nothing pending, nothing receipted.
      else if (action === "lost-reply") options.unknownUpload = "before";
      // The portal accepted the file (it stays pending in Bulk receipting) but the reply is lost.
      else if (action === "lost-reply-after") options.unknownUpload = "after";
      else if (action === "clear") delete options.previewEdit;
      // The person switches REI to another business (top-bar code FICT2), then back.
      else if (action === "switch-business") mock.setBusiness("FICT2");
      else if (action === "restore-business") mock.setBusiness();
      // The person processes the pending import in REI (Bud never presses it).
      else if (action === "process") mock.post();
      else if (action !== "status") throw Object.assign(new Error("Unknown lab action."), { status: 400 });
      return { uploads, effects: [...mock.effects], receipts: mock.receipts().length, pending: Boolean(mock.pendingUpload()) };
    },
  };
}
