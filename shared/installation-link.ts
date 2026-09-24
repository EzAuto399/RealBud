// Linking a computer through the browser instead of a typed `rb1_` code.
//
// 1. The desktop sends a link request: its own installation id, a token it
//    generated locally (the website stores only the hash, exactly as redeem
//    does), the computer name, platform and app version. No session: the
//    request itself grants nothing.
// 2. The website answers with an approval URL and a short display code. The
//    desktop opens the URL in the person's browser and shows the same code.
// 3. The signed-in owner sees the computer name and the code and approves.
//    The website then issues and redeems a pairing code in one transaction
//    through the existing SQL authority, using only the stored request details
//    and the company from the server session, never from the browser body.
// 4. The desktop polls with `Authorization: Bearer <token>`. Once linked it
//    receives the same `{companyId, agencyLabel, installationId}` redeem
//    returns, and model access arrives through the existing report path, so
//    no secret is ever held for the browser or stored for later pickup.
// 5. The desktop may cancel while waiting: `LinkCancelInput` with the same
//    bearer token. The website turns a pending request into `declined`, so the
//    owner can no longer approve it, and answers with the resulting
//    `LinkStatus`. A linked or expired request is returned unchanged: if the
//    owner approved first the answer is `linked`, and the desktop keeps it.
//
// Dependency-free; the desktop server and the website both import this file.

export const INSTALLATION_LINK_VERSION = 1;
/** A request the owner has not approved expires after ten minutes. */
export const LINK_REQUEST_TTL_MS = 10 * 60 * 1000;
/** How often the desktop asks whether the owner has approved. */
export const LINK_POLL_INTERVAL_MS = 3000;
/** 32 random bytes, base64url: the only handle in the approval URL. */
export const LINK_APPROVAL_ID = /^[A-Za-z0-9_-]{43}$/;
/** Shown on both screens so the owner can see it is the same computer.
 * No 0/O/1/I; eight characters from 32 symbols. Not a secret. */
export const LINK_DISPLAY_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
export const LINK_INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The desktop's locally generated bearer token, as redeem takes it today. */
export const LINK_TOKEN = /^[a-f0-9]{64}$/;
export const LINK_PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export type LinkPlatform = typeof LINK_PLATFORMS[number];

export interface LinkRequestInput {
  version: 1; purpose: 'installation-link-request';
  id: string; token: string; label: string; platform: LinkPlatform; appVersion: string;
}
export interface LinkRequestIssued {
  version: 1; purpose: 'installation-link-issued';
  approvalUrl: string; displayCode: string; expiresAt: string;
}
export interface LinkStatusInput { version: 1; purpose: 'installation-link-status'; id: string }
/** Sent with `Authorization: Bearer <token>`; answered with a `LinkStatus`. */
export interface LinkCancelInput { version: 1; purpose: 'installation-link-cancel'; id: string }
export type LinkStatus =
  | { version: 1; purpose: 'installation-link-status'; state: 'pending'; expiresAt: string }
  | { version: 1; purpose: 'installation-link-status'; state: 'linked'; companyId: string; agencyLabel: string; installationId: string }
  | { version: 1; purpose: 'installation-link-status'; state: 'expired' }
  | { version: 1; purpose: 'installation-link-status'; state: 'declined' };

const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const iso = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const appVersion = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9 ._()+-]{1,100}$/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && LINK_INSTALLATION_ID.test(v);
/** Printable, bounded identifiers the website issues (company id, agency label). */
const issued = (v: unknown, max: number): v is string => text(v, max);

export function isLinkRequestInput(v: unknown): v is LinkRequestInput {
  return exact(v, ['version', 'purpose', 'id', 'token', 'label', 'platform', 'appVersion']) &&
    v.version === 1 && v.purpose === 'installation-link-request' && id(v.id) &&
    typeof v.token === 'string' && LINK_TOKEN.test(v.token) && text(v.label, 80) &&
    (LINK_PLATFORMS as readonly unknown[]).includes(v.platform) && appVersion(v.appVersion);
}

/** `origin` is the website origin the desktop is configured for; the approval
 * URL must stay on it, over https (or http on the loopback test fixture). */
export function isLinkRequestIssued(v: unknown, origin: string): v is LinkRequestIssued {
  if (!exact(v, ['version', 'purpose', 'approvalUrl', 'displayCode', 'expiresAt'])) return false;
  if (v.version !== 1 || v.purpose !== 'installation-link-issued' || !iso(v.expiresAt)) return false;
  if (typeof v.displayCode !== 'string' || !LINK_DISPLAY_CODE.test(v.displayCode)) return false;
  if (typeof v.approvalUrl !== 'string' || v.approvalUrl.length > 300) return false;
  let url: URL;
  try { url = new URL(v.approvalUrl); } catch { return false; }
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !loopback) return false;
  if (url.origin !== origin || url.search || url.hash || url.username || url.password) return false;
  const match = /^\/link\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  return !!match && LINK_APPROVAL_ID.test(match[1]);
}

export function isLinkStatusInput(v: unknown): v is LinkStatusInput {
  return exact(v, ['version', 'purpose', 'id']) && v.version === 1 && v.purpose === 'installation-link-status' && id(v.id);
}

export function isLinkCancelInput(v: unknown): v is LinkCancelInput {
  return exact(v, ['version', 'purpose', 'id']) && v.version === 1 && v.purpose === 'installation-link-cancel' && id(v.id);
}

export function isLinkStatus(v: unknown): v is LinkStatus {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  if (s.version !== 1 || s.purpose !== 'installation-link-status') return false;
  switch (s.state) {
    case 'pending': return exact(s, ['version', 'purpose', 'state', 'expiresAt']) && iso(s.expiresAt);
    case 'linked': return exact(s, ['version', 'purpose', 'state', 'companyId', 'agencyLabel', 'installationId']) &&
      issued(s.companyId, 120) && issued(s.agencyLabel, 200) && id(s.installationId);
    case 'expired':
    case 'declined': return exact(s, ['version', 'purpose', 'state']);
    default: return false;
  }
}

/** Eight characters from an alphabet with no look-alikes, from 5 random bits each. */
export function linkDisplayCode(randomBytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  if (randomBytes.length < 8) throw new Error('A display code needs eight random bytes.');
  const chars = Array.from(randomBytes.slice(0, 8), byte => alphabet[byte & 31]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}
