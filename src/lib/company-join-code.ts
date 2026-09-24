/**
 * One join code = the host code (which computer to reach) + the one-use
 * invitation (who may join), so a colleague pastes a single value.
 *
 *   RBJ1!<host code>!<invitation>!<check>
 *
 * `!` never occurs in a host code (`RB1.` + base64url, the server rule in
 * server/company/host-certificate.ts) or an invitation (`[A-Za-z0-9._~-]`, the
 * rule in src/lib/company-api.ts). `<check>` is an FNV-1a digest of the rest so
 * a truncated or mistyped paste is caught before any network call. It is not a
 * signature: the host still validates the host code and redeems the invitation.
 */

const PREFIX = "RBJ1!";
const SEPARATOR = "!";
const HOST_CODE = /^RB1\.[A-Za-z0-9_-]+$/;
const HOST_CODE_MAX = 12_000;
const INVITATION = /^[A-Za-z0-9._~-]{24,512}$/;
const CHECK = /^[0-9a-f]{8}$/;

/** Longest paste the join field accepts, with room for wrapping whitespace. */
export const JOIN_INPUT_MAX_LENGTH = 16_000;

export const JOIN_CODE_MESSAGES = {
  empty: "Paste the join code from your office owner.",
  damaged: "This join code is incomplete or was changed. Copy the whole code again from your office owner.",
  newer: "This join code is from a newer version of RealBud. Update RealBud on this computer, then paste it again.",
  invitationOnly: "This is a private invitation, not a join code. Paste the join code, or paste the host code first if your owner sent them separately.",
  unknown: "This is not a RealBud join code. Copy the whole code from your office owner, then paste it again.",
  cannotEncode: "A join code could not be made from this host code and invitation. Share them separately.",
} as const;

export type CompanyJoinTarget = { kind: "join-code"; hostCode: string; invitationToken: string } | { kind: "host-code"; hostCode: string };

const compact = (text: string) => text.replace(/\s+/g, "");
const validHostCode = (value: string) => value.length <= HOST_CODE_MAX && HOST_CODE.test(value);
const validInvitation = (value: string) => INVITATION.test(value);

function check(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function isCompanyJoinCode(text: string): boolean {
  return /^RBJ\d+!/.test(compact(text));
}

export function encodeCompanyJoinCode(hostCode: string, invitationToken: string): string {
  if (!validHostCode(hostCode) || !validInvitation(invitationToken)) throw new Error(JOIN_CODE_MESSAGES.cannotEncode);
  const body = `${PREFIX}${hostCode}${SEPARATOR}${invitationToken}`;
  return `${body}${SEPARATOR}${check(body)}`;
}

function decode(value: string): { hostCode: string; invitationToken: string } {
  if (!value.startsWith(PREFIX)) throw new Error(JOIN_CODE_MESSAGES.newer);
  const parts = value.slice(PREFIX.length).split(SEPARATOR);
  if (parts.length !== 3) throw new Error(JOIN_CODE_MESSAGES.damaged);
  const [hostCode, invitationToken, digest] = parts;
  if (!CHECK.test(digest) || check(`${PREFIX}${hostCode}${SEPARATOR}${invitationToken}`) !== digest ||
    !validHostCode(hostCode) || !validInvitation(invitationToken)) throw new Error(JOIN_CODE_MESSAGES.damaged);
  return { hostCode, invitationToken };
}

/** The "connect to a host" field: a join code, or an older host code on its own. */
export function readCompanyJoinTarget(text: string): CompanyJoinTarget {
  const value = compact(text);
  if (!value) throw new Error(JOIN_CODE_MESSAGES.empty);
  if (value.length > JOIN_INPUT_MAX_LENGTH) throw new Error(JOIN_CODE_MESSAGES.damaged);
  if (/^RBJ\d+!/.test(value)) return { kind: "join-code", ...decode(value) };
  if (validHostCode(value)) return { kind: "host-code", hostCode: value };
  if (validInvitation(value)) throw new Error(JOIN_CODE_MESSAGES.invitationOnly);
  throw new Error(JOIN_CODE_MESSAGES.unknown);
}

/**
 * The invitation field: a join code yields its invitation; anything else is
 * passed through trimmed, unchanged from before, for the host to judge.
 */
export function invitationFromJoinInput(text: string): string {
  if (!isCompanyJoinCode(text)) return text.trim();
  return decode(compact(text)).invitationToken;
}

/**
 * Names which part of a join code failed. Only rewrites the replies whose
 * generic wording would mislead someone who pasted one join code.
 */
export function joinCodeFailureMessage(stage: "connect" | "join", status: number | undefined): string | undefined {
  if (stage === "connect" && status === 400) return "This join code no longer matches the office computer. Ask your office owner for a new join code.";
  if (stage === "join" && [401, 404, 410].includes(status ?? 0)) return "This join code has already been used or has expired. Ask your office owner for a new join code, then paste it here.";
  return undefined;
}
