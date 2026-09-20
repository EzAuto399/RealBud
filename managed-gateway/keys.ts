// Project-scoped API keys: the credential a customer's application presents to
// the managed service (base URL + key + model `auto`), as distinct from the
// Ed25519 execution grant, which carries the RealBud worker's signed scope.
//
// Properties this module is responsible for, and the tests pin:
//
//   * The secret is displayed ONCE and never stored. Only SHA-256(secret) is
//     persisted, and verification compares in constant time.
//   * A key binds one company + project + environment. It can only narrow an
//     account, never widen it: nothing here can grant what the tenant lacks.
//   * Revoked and expired keys fail closed with distinguishable reasons;
//     unknown, malformed and wrong-secret inputs are a single refusal, so
//     probing learns nothing.
//   * last-used is telemetry, not an audit event: it updates in place and never
//     appends to the ledger (it sits on the request hot path).
//
// Trusted operator provisioning only — like `provisionTenant`, this is never
// exposed as a portal or host HTTP route. Mint from an operator script or the
// admin surface, never from the desktop.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonical, id, integer, requireThat } from './contracts.ts';
import { UsageLedger } from './ledger.ts';

/** Wire format: `rbk_<id>_<secret>` — the id is the lookup, the secret is hashed. */
export const KEY_PREFIX = 'rbk';
const SECRET_BYTES = 32;
const KEY_ID_CHARS = 16;
const SECRET_CHARS = 43; // 32 random bytes, base64url, unpadded

export interface ProjectKeyRecord {
  id: string;
  companyId: string;
  project: string;
  environment: string;
  label?: string;
  /** SHA-256 of the secret, hex. The secret itself is never stored. */
  hash: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  /** Telemetry only; updated in place on a successful verify. */
  lastUsedAt?: number;
}

/** The record without its hash — everything an operator or UI may see. */
export interface ProjectKeyPublic extends Omit<ProjectKeyRecord, 'hash'> {}

export interface MintKeyInput {
  companyId: string;
  project: string;
  environment: string;
  /** Who or what this key is for — a person's email, a service name. */
  label?: string;
  expiresAt?: number;
}

type Body = { body: string };

function publicView(record: ProjectKeyRecord): ProjectKeyPublic {
  return {
    id: record.id,
    companyId: record.companyId,
    project: record.project,
    environment: record.environment,
    ...(record.label === undefined ? {} : { label: record.label }),
    createdAt: record.createdAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
    ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
  };
}

export class ProjectKeys {
  private readonly ledger: UsageLedger;
  constructor(ledger: UsageLedger) { this.ledger = ledger; }

  /** Mint a key. The returned `key` string is the only time the secret exists. */
  mint(input: MintKeyInput): { key: string; record: ProjectKeyRecord } {
    id(input.companyId); id(input.project); id(input.environment);
    this.ledger.tenant(input.companyId);
    if (input.label !== undefined) {
      requireThat(typeof input.label === 'string' && input.label.trim().length > 0 && input.label.length <= 200, 'invalid_key_label');
    }
    if (input.expiresAt !== undefined) {
      integer(input.expiresAt, Number.MAX_SAFE_INTEGER);
      requireThat(input.expiresAt > this.ledger.now(), 'key_expiry_in_past');
    }
    const keyId = randomBytes(KEY_ID_CHARS / 2).toString('hex');
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const record: ProjectKeyRecord = {
      id: keyId,
      companyId: input.companyId,
      project: input.project,
      environment: input.environment,
      ...(input.label === undefined ? {} : { label: input.label }),
      hash: createHash('sha256').update(secret).digest('hex'),
      createdAt: this.ledger.now(),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    };
    this.ledger.db.transaction(() => {
      this.ledger.db.run('INSERT INTO project_keys(id,company,body) VALUES(?,?,?)', record.id, record.companyId, canonical(record));
      this.ledger.db.append(record.companyId, 'key_minted', null, this.ledger.now(), publicView(record));
    });
    return { key: `${KEY_PREFIX}_${record.id}_${secret}`, record };
  }

  /** Verify a presented key and return its record, or fail closed. */
  verify(presented: string): ProjectKeyRecord {
    const parsed = this.parse(presented);
    const record = this.row(parsed.keyId);
    requireThat(record, 'invalid_key', 401);
    const given = createHash('sha256').update(parsed.secret).digest();
    const stored = Buffer.from(record.hash, 'hex');
    requireThat(stored.length === given.length && timingSafeEqual(stored, given), 'invalid_key', 401);
    requireThat(record.revokedAt === undefined, 'key_revoked', 401);
    requireThat(record.expiresAt === undefined || record.expiresAt > this.ledger.now(), 'key_expired', 401);
    record.lastUsedAt = this.ledger.now();
    this.ledger.db.run('UPDATE project_keys SET body=? WHERE id=?', canonical(record), record.id);
    return record;
  }

  /** Idempotent: the first revocation timestamp wins and one event is appended. */
  revoke(keyId: string): ProjectKeyPublic {
    id(keyId);
    return this.ledger.db.transaction(() => {
      const record = this.row(keyId);
      requireThat(record, 'unknown_key', 404);
      if (record.revokedAt === undefined) {
        record.revokedAt = this.ledger.now();
        this.ledger.db.run('UPDATE project_keys SET body=? WHERE id=?', canonical(record), keyId);
        this.ledger.db.append(record.companyId, 'key_revoked', null, this.ledger.now(), { keyId });
      }
      return publicView(record);
    });
  }

  /** Revoke and replace in one step, preserving the binding (project, env, label). */
  rotate(keyId: string, overrides: { expiresAt?: number; label?: string } = {}): { key: string; record: ProjectKeyRecord; replaced: string } {
    id(keyId);
    const previous = this.ledger.db.transaction(() => {
      const record = this.row(keyId);
      requireThat(record, 'unknown_key', 404);
      if (record.revokedAt === undefined) {
        record.revokedAt = this.ledger.now();
        this.ledger.db.run('UPDATE project_keys SET body=? WHERE id=?', canonical(record), keyId);
        this.ledger.db.append(record.companyId, 'key_revoked', null, this.ledger.now(), { keyId, rotated: true });
      }
      return record;
    });
    const input: MintKeyInput = { companyId: previous.companyId, project: previous.project, environment: previous.environment };
    if (overrides.label !== undefined) input.label = overrides.label;
    else if (previous.label !== undefined) input.label = previous.label;
    if (overrides.expiresAt !== undefined) input.expiresAt = overrides.expiresAt;
    else if (previous.expiresAt !== undefined) input.expiresAt = previous.expiresAt;
    const minted = this.mint(input);
    return { key: minted.key, record: minted.record, replaced: keyId };
  }

  get(keyId: string): ProjectKeyPublic {
    id(keyId);
    const record = this.row(keyId);
    requireThat(record, 'unknown_key', 404);
    return publicView(record);
  }

  list(companyId: string): ProjectKeyPublic[] {
    id(companyId);
    return this.ledger.db.all<Body>('SELECT body FROM project_keys WHERE company=? ORDER BY rowid', companyId)
      .map((row) => publicView(JSON.parse(row.body) as ProjectKeyRecord));
  }

  private row(keyId: string): ProjectKeyRecord | undefined {
    const found = this.ledger.db.get<Body>('SELECT body FROM project_keys WHERE id=?', keyId);
    return found ? (JSON.parse(found.body) as ProjectKeyRecord) : undefined;
  }

  // The secret is base64url, whose alphabet INCLUDES `_`, so a key cannot be
  // parsed by splitting on underscores — a valid secret would tear in half.
  // Take the prefix and the fixed-width hex id by position instead; the
  // remainder is the secret, underscores and all.
  private parse(presented: string): { keyId: string; secret: string } {
    requireThat(typeof presented === 'string' && presented.length <= 512, 'invalid_key', 401);
    const first = presented.indexOf('_');
    const second = first === -1 ? -1 : presented.indexOf('_', first + 1);
    const prefix = first === -1 ? '' : presented.slice(0, first);
    const keyId = second === -1 ? '' : presented.slice(first + 1, second);
    const secret = second === -1 ? '' : presented.slice(second + 1);
    requireThat(
      prefix === KEY_PREFIX
        && new RegExp(`^[0-9a-f]{${KEY_ID_CHARS}}$`).test(keyId)
        && new RegExp(`^[A-Za-z0-9_-]{${SECRET_CHARS}}$`).test(secret),
      'invalid_key', 401,
    );
    return { keyId, secret };
  }
}
