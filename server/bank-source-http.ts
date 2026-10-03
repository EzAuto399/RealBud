// Routes for the Redbark bank source. index.ts applies the session gate and
// the JSON content-type rule, then hands over here. The key never leaves the
// host: responses carry only its masked status.
import type { BankCredentials } from "./bank-credentials.ts";
import type { BankReferenceStore, RedbarkCoverage } from "./bank-reference-store.ts";
import { createRedbarkClient, pullRedbarkReview, type RedbarkClientOptions } from "./redbark-source.ts";
import type { W1ImportProof } from "./w1-rei-workflow.ts";

export interface BankSourceDeps {
  credentials: BankCredentials;
  store: () => BankReferenceStore;
  coverage: RedbarkCoverage;
  fetch: RedbarkClientOptions["fetch"];
  today: () => Promise<string>;
  sleep?: RedbarkClientOptions["sleep"];
  /** The host's saved W1 import proof for a batch (issued by w1ImportProof after a complete readback), or null.
   * Never taken from the request body. Without it, confirm-import refuses. */
  importProof?: (batchId: string) => Promise<W1ImportProof | null>;
}
export type BankSourceResult = { status: number; body: unknown };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: unknown, allowed: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).sort().join(",") === [...allowed].sort().join(",");

export async function handleBankSourceRoute(path: string, method: string, readBody: () => Promise<unknown>, deps: BankSourceDeps): Promise<BankSourceResult> {
  if (path === "/api/bank-source/redbark/key") {
    if (method === "GET") return { status: 200, body: { key: await deps.credentials.status() } };
    if (method === "PUT") {
      const body = await readBody();
      if (!keys(body, ["key", "expectedRevision"])) return { status: 400, body: { error: "Send the office's Redbark key and the current key revision." } };
      return { status: 200, body: { key: await deps.credentials.store(body.key, body.expectedRevision) } };
    }
    if (method === "DELETE") {
      const body = await readBody();
      if (!keys(body, ["expectedRevision"])) return { status: 400, body: { error: "Send the current key revision." } };
      return { status: 200, body: { key: await deps.credentials.remove(body.expectedRevision) } };
    }
    return { status: 405, body: { error: "Unsupported Redbark key action." } };
  }
  const client = (key: string) => createRedbarkClient({ key, fetch: deps.fetch, sleep: deps.sleep });
  if (path === "/api/bank-source/redbark/accounts" && method === "GET") {
    const accounts = await deps.credentials.withKey(key => client(key).listAccounts());
    return { status: 200, body: { accounts } };
  }
  if (path === "/api/bank-source/redbark/pull" && method === "POST") {
    const body = await readBody();
    if (!keys(body, ["account"])) return { status: 400, body: { error: "Choose the Redbark bank account to pull." } };
    const store = deps.store(), today = await deps.today();
    const summary = await deps.credentials.withKey(key => pullRedbarkReview({ client: client(key), store, coverage: deps.coverage,
      account: body.account, today, rules: store.settings()?.rules ?? [] }));
    return { status: 200, body: summary };
  }
  if (path === "/api/bank-source/redbark/confirm-import" && method === "POST") {
    const body = await readBody();
    if (!keys(body, ["batchId", "expectedRevision"])) return { status: 400, body: { error: "Choose the reviewed batch and the current coverage revision." } };
    if (typeof body.batchId !== "string") return { status: 400, body: { error: "Choose the reviewed batch and the current coverage revision." } };
    const proof = deps.importProof ? await deps.importProof(body.batchId) : null;
    const result = await deps.store().confirmRedbarkImport(deps.coverage, body.batchId, body.expectedRevision, proof);
    return { status: 200, body: { reused: result.reused, account: result.account, coverage: { coveredThrough: result.coveredThrough, revision: result.revision,
      confirmedAt: result.confirmedAt, lastBatchId: result.lastBatchId } } };
  }
  return { status: 404, body: { error: "Unknown bank source action." } };
}

let services: { credentials: BankCredentials; coverage: RedbarkCoverage } | undefined;
/** One credential store and coverage cursor per server process. */
export async function bankSourceServices(dataDirectory: string, privateStateKey: Buffer) {
  if (!services) {
    const [{ createPrivateVault }, { createBankCredentials }, { RedbarkCoverage }] = await Promise.all([
      import("./private-vault.ts"), import("./bank-credentials.ts"), import("./bank-reference-store.ts")]);
    services ??= { credentials: createBankCredentials(createPrivateVault(dataDirectory, privateStateKey)), coverage: new RedbarkCoverage(dataDirectory) };
  }
  return services;
}
