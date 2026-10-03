/** A member's own Bud ↔ Hermios CRM connection, as the renderer sees it.
 * The server owns tokens and verification; nothing here grants CRM access by
 * itself. Any Hermios organization can connect: RealBud registers its own
 * public OAuth client, and the verified Hermios profile/workspace is bound to
 * this RealBud company member only — never shared office-wide, never matched
 * by email. A reconnect or account/workspace switch starts a new generation. */

export const HERMIOS_CONNECTION_API = '/api/hermios/connection';
export const HERMIOS_CONNECTION_START_API = `${HERMIOS_CONNECTION_API}/start`;
export const HERMIOS_CONNECTION_CHECK_API = `${HERMIOS_CONNECTION_API}/check`;
export const HERMIOS_CONNECTION_DISCONNECT_API = `${HERMIOS_CONNECTION_API}/disconnect`;
/** Loopback OAuth redirect. Reached by the person's browser, not the renderer:
 * authenticated by the single-use `state`, not by a RealBud session. */
export const HERMIOS_OAUTH_CALLBACK_PATH = '/api/hermios/oauth/callback';

export const HERMIOS_CONNECTION_STATUSES = ['not_connected', 'connecting', 'connected', 'needs_reconnect', 'unavailable'] as const;
export type HermiosConnectionStatus = typeof HERMIOS_CONNECTION_STATUSES[number];

/** The only sentences the server puts in `reason`. Fixed text, never provider
 * output, so nothing from Hermios (or a token) can reach the renderer here. */
export const HERMIOS_CONNECTION_REASONS = {
  signInAgain: 'Hermios needs you to sign in again. Connect again to continue.',
  accountChanged: 'Your Hermios account changed. Connect again to choose it.',
  unreachable: 'Hermios could not be reached. Try again shortly.',
  registrationLimited: 'Hermios is limiting new connections right now. Try again in about an hour.',
  notVerified: 'Hermios sign-in details could not be verified. Try again later.',
} as const;

export interface HermiosConnectedAccount {
  /** Hermios display name, for showing only. */
  displayName: string;
  /** Workspace label (organization), for showing only. */
  workspaceLabel: string;
  /** Ids from `get_hermios_profile`; the binding authority. `profileId` is the
   * Hermios workspace-membership id (one per user × workspace) and identifies
   * the member. `workspaceId` is Hermios's workspace UUID: the organization
   * binding and the key for cross-member record locks. A connection saved
   * before Hermios returned it holds `membership:<profileId>` until its next
   * check binds the real workspace (a new generation). */
  workspaceId: string;
  profileId: string;
  verifiedAt: number;
}

export interface HermiosConnectionState {
  version: 1;
  status: HermiosConnectionStatus;
  /** Present only when status is `connected` or `needs_reconnect`. */
  account: HermiosConnectedAccount | null;
  /** Increments on every connect, reconnect, switch or disconnect. */
  generation: number;
  /** One fixed, human sentence for `needs_reconnect`/`unavailable`; else null. */
  reason: string | null;
}

export interface HermiosConnectionStart { authorizeUrl: string }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const time = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

export function parseHermiosConnectionState(v: unknown): HermiosConnectionState | null {
  if (!object(v) || !exact(v, ['version', 'status', 'account', 'generation', 'reason']) || v.version !== 1) return null;
  if (!HERMIOS_CONNECTION_STATUSES.includes(v.status as HermiosConnectionStatus)) return null;
  if (!Number.isSafeInteger(v.generation) || (v.generation as number) < 0) return null;
  if (v.reason !== null && !text(v.reason, 300)) return null;
  const status = v.status as HermiosConnectionStatus;
  let account: HermiosConnectedAccount | null = null;
  if (v.account !== null) {
    const a = v.account;
    if (!object(a) || !exact(a, ['displayName', 'workspaceLabel', 'workspaceId', 'profileId', 'verifiedAt'])) return null;
    if (!text(a.displayName, 200) || !text(a.workspaceLabel, 200) || !text(a.workspaceId, 200) || !text(a.profileId, 200) || !time(a.verifiedAt)) return null;
    account = a as unknown as HermiosConnectedAccount;
  }
  if ((status === 'connected') !== (account !== null) && status !== 'needs_reconnect') return null;
  return { version: 1, status, account, generation: v.generation as number, reason: v.reason as string | null };
}

export function parseHermiosConnectionStart(v: unknown): HermiosConnectionStart | null {
  if (!object(v) || !exact(v, ['authorizeUrl']) || typeof v.authorizeUrl !== 'string') return null;
  try {
    const url = new URL(v.authorizeUrl);
    return url.protocol === 'https:' && (url.hostname === 'hermios.app' || url.hostname.endsWith('.hermios.app')) ? { authorizeUrl: url.toString() } : null;
  } catch { return null; }
}
