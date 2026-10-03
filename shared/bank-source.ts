export interface BankSourceUpload { filename: string; bytesBase64: string; provenance?: RedbarkBatchProvenance }
export interface BankSourceArtifact extends BankSourceUpload {
  encoding: "utf-8" | "utf-8-bom";
  byteLength: number;
  digest: string;
}
export interface BankDownloadArtifact extends BankSourceArtifact {
  csv: string;
  originalBytesCaptured: boolean;
}

/** A batch RealBud generated from Redbark's open-banking API (CDR data read
 * with the office's own key). The CSV bytes are RealBud's canonical rendering
 * of validated API rows, never the bank's own export file, so a batch with
 * this provenance never reports `originalBytesCaptured`. Row dates are each
 * transaction's bank posting date; the run date is batch metadata only. */
export interface RedbarkBatchProvenance {
  kind: "redbark-api";
  version: 1;
  originalBankExport: false;
  apiVersion: string;
  connection: string;
  account: string;
  /** The window RealBud requested (inclusive local dates), not the dates seen. */
  requestedFrom: string;
  requestedTo: string;
  /** Office-local date of the pull. Used for the file name only. */
  runDate: string;
  retrievedAt: string;
  /** sha256 of the canonical JSON of every validated transaction returned. */
  responseDigest: string;
  livemode: true;
  /** Redbark ids of the rows in CSV order (pending items are excluded). */
  transactionIds: string[];
}

export const REDBARK_ACCOUNT_ID = /^acct_[0-9A-Za-z]{1,22}$/;
export const REDBARK_CONNECTION_ID = /^conn_[0-9A-Za-z]{1,40}$/;
export const REDBARK_TRANSACTION_ID = /^txn_[A-Za-z0-9_.:-]{1,200}$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !LOCAL_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && y <= 2200 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const PROVENANCE_KEYS = ["account", "apiVersion", "connection", "kind", "livemode", "originalBankExport", "requestedFrom", "requestedTo", "responseDigest", "retrievedAt", "runDate", "transactionIds", "version"];

/** Exact validator; throws a user-facing sentence. */
export function validateRedbarkProvenance(value: unknown): RedbarkBatchProvenance {
  const bad = (): never => { throw Object.assign(new Error("The bank source record failed its integrity check."), { status: 400 }); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== PROVENANCE_KEYS.join(",")) return bad();
  if (v.kind !== "redbark-api" || v.version !== 1 || v.originalBankExport !== false || v.livemode !== true) return bad();
  if (typeof v.apiVersion !== "string" || !/^\d{4}-\d{2}-\d{2}\.[a-z]{1,40}$/.test(v.apiVersion)) return bad();
  if (typeof v.connection !== "string" || !REDBARK_CONNECTION_ID.test(v.connection)) return bad();
  if (typeof v.account !== "string" || !REDBARK_ACCOUNT_ID.test(v.account)) return bad();
  if (!isLocalDate(v.requestedFrom) || !isLocalDate(v.requestedTo) || !isLocalDate(v.runDate) || v.requestedFrom > v.requestedTo) return bad();
  if (typeof v.retrievedAt !== "string" || Number.isNaN(Date.parse(v.retrievedAt)) || new Date(Date.parse(v.retrievedAt)).toISOString() !== v.retrievedAt) return bad();
  if (typeof v.responseDigest !== "string" || !/^[a-f0-9]{64}$/.test(v.responseDigest)) return bad();
  if (!Array.isArray(v.transactionIds) || !v.transactionIds.length || v.transactionIds.length > 3000 ||
      v.transactionIds.some(id => typeof id !== "string" || !REDBARK_TRANSACTION_ID.test(id)) || new Set(v.transactionIds).size !== v.transactionIds.length) return bad();
  return { kind: "redbark-api", version: 1, originalBankExport: false, apiVersion: v.apiVersion, connection: v.connection, account: v.account,
    requestedFrom: v.requestedFrom as string, requestedTo: v.requestedTo as string, runDate: v.runDate as string, retrievedAt: v.retrievedAt,
    responseDigest: v.responseDigest, livemode: true, transactionIds: [...v.transactionIds as string[]] };
}
