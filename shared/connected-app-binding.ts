import { MAIL_READS, MAIL_REVIEWS } from './app-tool-policy.ts';
export const MANUAL_MAIL_ACKNOWLEDGEMENT = 'I checked this exact account in the mail app';
export const CHANGED_CONNECTION_MAIL_ACKNOWLEDGEMENT = 'I checked the original reviewed message in this exact account after the connection changed';
/** Unknown mail schemas can hide a delivery in arguments. Only the reviewed
 * mailbox catalogue may run; Outlook's separate calendar/contact tools remain
 * governed by their existing app policy. */
export const unsupportedConnectedMailTool = (name: string): boolean => {
  const mail = name.startsWith('GMAIL_') || (name.startsWith('OUTLOOK_') && !name.split('_').includes('CHAT') &&
    name.split('_').some(token => ['MAIL', 'MAILBOX', 'MESSAGE', 'MESSAGES', 'EMAIL', 'EMAILS', 'DRAFT', 'DRAFTS', 'INBOX', 'REPLY', 'FORWARD', 'SEND', 'RULE', 'RULES'].includes(token)));
  return mail && !MAIL_READS.has(name) && !MAIL_REVIEWS.has(name);
};
/** Server-authored mail authority. Never construct this from worker arguments. */
export interface ConnectedMailBinding {
  provider: "gmail" | "outlook";
  accountId: string;
  /** Gateway current-device tenant, never a caller account label. */
  companyId?: string;
  label?: string;
  /** Exact address from an account-bound fixed provider profile, never its alias. */
  emailAddress?: string;
  generation: string;
}
/** Same scheme/loopback admission as host managedConnectorSettings. Only the
 * canonical origin travels with a review; paths, query and credentials do not. */
export function connectedMailGatewayOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Managed mail issuer needs verification.');
  return url.origin;
}
export const verifiedMailAddress = (value: unknown): value is string => typeof value === 'string' && /^[^\s<>@\u0000-\u001f\u007f]{1,128}@[^\s<>@\u0000-\u001f\u007f]{1,128}$/.test(value);
/** These schemas may select a different sender inside provider arguments even
 * though the outer connected-account envelope is bound. Aliases/other users
 * need a separate provider-verified contract and cannot be granted by metadata. */
export function connectedMailSenderArgsAllowed(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(connectedMailSenderArgsAllowed);
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, row]) => {
    const normalized = key.replaceAll('_', '').toLowerCase();
    if (['userid', 'user'].includes(normalized)) return row === 'me';
    if (normalized.startsWith('from') || normalized.startsWith('sender') || normalized.startsWith('sendas') || normalized.startsWith('mailbox') || ['accountid', 'connectedaccountid'].includes(normalized)) return false;
    return connectedMailSenderArgsAllowed(row);
  });
}
export const opaqueDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function parseConnectedMailBindings(value: unknown): ConnectedMailBinding[] {
  if (!Array.isArray(value) || value.length > 2) throw new Error("Unverified mail binding.");
  const providers = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => !["provider", "accountId", "companyId", "label", "emailAddress", "generation"].includes(key)) ||
      !["gmail", "outlook"].includes(row.provider) || providers.has(row.provider) || typeof row.accountId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.accountId) ||
      (row.companyId !== undefined && (typeof row.companyId !== "string" || !/^[A-Za-z0-9._:@+-]{1,128}$/.test(row.companyId))) ||
      (row.label !== undefined && (typeof row.label !== "string" || !/^[^\r\n\u0000-\u001f\u007f]{1,300}$/.test(row.label))) || (row.emailAddress !== undefined && !verifiedMailAddress(row.emailAddress)) || !opaqueDigest(row.generation)) throw new Error("Unverified mail binding.");
    providers.add(row.provider);
    return { provider: row.provider, accountId: row.accountId, ...(row.companyId ? { companyId: row.companyId } : {}), ...(row.label ? { label: row.label } : {}), ...(row.emailAddress ? { emailAddress: row.emailAddress } : {}), generation: row.generation };
  });
}
/** Stable JSON for reviewed payload identities, independent of object key order. */
export function connectedAppCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(connectedAppCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${connectedAppCanonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Sensitive original review: stored only by the encrypted host vault, never
 * in dispatch receipts, worker artifacts or provider logs. */
export interface ConnectedMailReview {
  version: 1;
  workspaceDigest: string;
  gatewayOrigin: string;
  accountDigest: string;
  bindingDigest: string;
  reviewDigest: string;
  binding: ConnectedMailBinding;
  card: string;
  exact: string;
  approvedAt: number;
  /** Unique host card identity; independent of the stable provider effect. */
  approvalId: string;
}
export interface ConnectedMailReviewArtifacts {
  write(value: ConnectedMailReview): Promise<void>;
  read(reviewDigest: string): Promise<ConnectedMailReview | undefined>;
}
export function parseConnectedMailReview(value: unknown, digest: (value: unknown) => string): ConnectedMailReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Original mail review needs recovery.');
  const row = value as ConnectedMailReview;
  if (Object.keys(row).sort().join(',') !== 'accountDigest,approvalId,approvedAt,binding,bindingDigest,card,exact,gatewayOrigin,reviewDigest,version,workspaceDigest' || row.version !== 1 ||
    ![row.workspaceDigest, row.accountDigest, row.bindingDigest, row.reviewDigest].every(opaqueDigest) ||
    typeof row.approvalId !== 'string' || !/^[a-f0-9]{32}$/.test(row.approvalId) || typeof row.card !== 'string' || !row.card || typeof row.exact !== 'string' || !row.exact ||
    !Number.isSafeInteger(row.approvedAt) || row.approvedAt < 0 || row.approvedAt > 8_640_000_000_000_000 || new TextEncoder().encode(connectedAppCanonical(row)).length > 1_500_000)
    throw new Error('Original mail review needs recovery.');
  const binding = parseConnectedMailBindings([row.binding])[0]!;
  if (!binding.companyId || typeof row.gatewayOrigin !== 'string' || connectedMailGatewayOrigin(row.gatewayOrigin) !== row.gatewayOrigin) throw new Error('Original mail tenant/issuer needs recovery.');
  if (binding.generation !== row.bindingDigest || digest({ provider: binding.provider, accountId: binding.accountId, companyId: binding.companyId, gatewayOrigin: row.gatewayOrigin }) !== row.accountDigest ||
    digest({ summary: row.card, detail: row.exact, approvalId: row.approvalId }) !== row.reviewDigest) throw new Error('Original mail review integrity needs recovery.');
  return { ...row, binding };
}
