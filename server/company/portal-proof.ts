import { createHash } from 'node:crypto';
import { canonicalWebsiteCommand } from '../../shared/website-commands.ts';
import {
  COMPANY_PORTAL_ORIGIN, isCompanyPortalProof, isCompanyPortalRedeem,
  type CompanyPortalProof, type CompanyPortalRedeem,
} from '../../shared/company-portal.ts';

declare const verifiedPortalProof: unique symbol;
export type VerifiedCompanyPortalProof = CompanyPortalProof & { readonly [verifiedPortalProof]: true };
export class CompanyPortalProofError extends Error {
  readonly code: 'portal_proof_denied' | 'portal_proof_stale' | 'portal_proof_unavailable';
  constructor(code: CompanyPortalProofError['code']) {
    super(code); this.name = 'CompanyPortalProofError'; this.code = code;
  }
}
const verified = new WeakMap<object, string>();
const digest = (value: unknown) => createHash('sha256').update(canonicalWebsiteCommand(value)).digest('hex');
const same = (left: unknown, right: unknown) => canonicalWebsiteCommand(left) === canonicalWebsiteCommand(right);
const MAX_RESPONSE_BYTES = 16 * 1024;

/** Share one gate between host certificate rotation and local mapping commits. */
export function createCompanyPortalCertificateGate() {
  let tail: Promise<void> = Promise.resolve(); let queued = 0;
  return { run<T>(work: () => Promise<T>): Promise<T> {
    if (queued >= 128) return Promise.reject(new CompanyPortalProofError('portal_proof_unavailable'));
    queued++;
    const result = tail.then(work);
    tail = result.then(() => { queued--; }, () => { queued--; });
    return result;
  } };
}

function current(proof: CompanyPortalProof, now: number) {
  // No clock-skew allowance extends the fixed deadline. A host clock ahead of
  // the issuer fails closed until corrected rather than receiving a longer lease.
  if (!Number.isFinite(now) || Date.parse(proof.issuedAt) > now || Date.parse(proof.expiresAt) <= now) {
    throw new CompanyPortalProofError('portal_proof_stale');
  }
}

/** The kernel must call this again after its awaited transaction locks. */
export function assertVerifiedCompanyPortalProof(value: unknown, expected: CompanyPortalRedeem, now = Date.now()): CompanyPortalProof {
  if (!isCompanyPortalRedeem(expected) || !value || typeof value !== 'object' || verified.get(value) !== digest(expected) || !isCompanyPortalProof(value) ||
      !same(value.target, expected.target) || value.redemptionId !== expected.redemptionId) throw new CompanyPortalProofError('portal_proof_denied');
  current(value, now);
  return value;
}

/** A fixed, independently verified HTTPS issuer; no host or reusable credential comes from an HTTP body. */
export function createCompanyPortalProofVerifier(options: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error('Invalid portal verification timeout');
  return async function verify(input: CompanyPortalRedeem): Promise<VerifiedCompanyPortalProof> {
    if (!isCompanyPortalRedeem(input)) throw new CompanyPortalProofError('portal_proof_denied');
    // Snapshot before awaiting. The caller cannot change the target during I/O.
    const expected: CompanyPortalRedeem = JSON.parse(canonicalWebsiteCommand(input));
    const started = now();
    if (Date.parse(expected.target.expiresAt) <= started) throw new CompanyPortalProofError('portal_proof_stale');
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); void reader?.cancel().catch(() => {}); reject(new CompanyPortalProofError('portal_proof_unavailable')); }, timeoutMs);
    });
    try {
      const proof = await Promise.race([timeout, (async () => {
        const response = await request(`${COMPANY_PORTAL_ORIGIN}/api/company-portal/redeem`, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(expected), redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
          signal: abort.signal,
        });
        if (response.redirected || response.url && response.url !== `${COMPANY_PORTAL_ORIGIN}/api/company-portal/redeem`) throw new CompanyPortalProofError('portal_proof_unavailable');
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new CompanyPortalProofError(response.status === 403 || response.status === 401 ? 'portal_proof_denied' : response.status === 409 ? 'portal_proof_stale' : 'portal_proof_unavailable');
        }
        if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || !response.body) throw new CompanyPortalProofError('portal_proof_unavailable');
        const length = response.headers.get('content-length');
        if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new CompanyPortalProofError('portal_proof_unavailable');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let bytes = 0;
        while (true) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new CompanyPortalProofError('portal_proof_unavailable');
          chunks.push(part.value);
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isCompanyPortalProof(value) || !same(value.target, expected.target) || value.redemptionId !== expected.redemptionId) throw new CompanyPortalProofError('portal_proof_denied');
        current(value, now());
        // Freeze every nested authority field; branding is process-local and
        // deliberately cannot survive JSON, a restart, or a database restore.
        Object.freeze(value.target); Object.freeze(value.person); Object.freeze(value);
        verified.set(value, digest(expected));
        return value as VerifiedCompanyPortalProof;
      })()]);
      return assertVerifiedCompanyPortalProof(proof, expected, now()) as VerifiedCompanyPortalProof;
    } catch (error) {
      if (error instanceof CompanyPortalProofError) throw error;
      throw new CompanyPortalProofError('portal_proof_unavailable');
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
      void reader?.cancel().catch(() => {});
    }
  };
}
