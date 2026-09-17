import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

// RealBud-owned implementation of inspected QM transaction/revision/claim patterns.
// See docs/REALBUD-QM-REUSE-DECISION-2026-09-14.md. No QM runtime imports.
const INITIAL_SCHEMA = `
CREATE TABLE realbud_company.companies (
  id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE realbud_company.members (
  company_id uuid NOT NULL REFERENCES realbud_company.companies(id), id uuid NOT NULL,
  display_name text NOT NULL, role text NOT NULL CHECK (role IN ('owner','member')),
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,id)
);
CREATE UNIQUE INDEX company_one_owner ON realbud_company.members(company_id) WHERE role='owner';
CREATE TABLE realbud_company.sessions (
  id uuid PRIMARY KEY, company_id uuid NOT NULL, member_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(company_id,member_id) REFERENCES realbud_company.members(company_id,id)
);
CREATE TABLE realbud_company.invitations (
  id uuid PRIMARY KEY, company_id uuid NOT NULL, issued_by uuid NOT NULL,
  display_name text NOT NULL, token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, redeemed_at timestamptz, revoked_at timestamptz,
  FOREIGN KEY(company_id,issued_by) REFERENCES realbud_company.members(company_id,id)
);
CREATE TABLE realbud_company.scopes (
  company_id uuid NOT NULL REFERENCES realbud_company.companies(id), id uuid NOT NULL,
  owner_member_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('private','team','company')),
  name text NOT NULL, revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,owner_member_id) REFERENCES realbud_company.members(company_id,id)
);
CREATE TABLE realbud_company.scope_grants (
  company_id uuid NOT NULL, scope_id uuid NOT NULL, member_id uuid NOT NULL,
  permission text NOT NULL CHECK(permission IN ('read','write')),
  PRIMARY KEY(company_id,scope_id,member_id,permission),
  FOREIGN KEY(company_id,scope_id) REFERENCES realbud_company.scopes(company_id,id),
  FOREIGN KEY(company_id,member_id) REFERENCES realbud_company.members(company_id,id)
);
CREATE TABLE realbud_company.knowledge_revisions (
  company_id uuid NOT NULL, scope_id uuid NOT NULL, key text NOT NULL,
  revision bigint NOT NULL CHECK(revision>0), content text NOT NULL,
  source_refs jsonb NOT NULL CHECK(jsonb_typeof(source_refs)='array'), author_member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,scope_id,key,revision),
  FOREIGN KEY(company_id,scope_id) REFERENCES realbud_company.scopes(company_id,id),
  FOREIGN KEY(company_id,author_member_id) REFERENCES realbud_company.members(company_id,id)
);
CREATE TABLE realbud_company.cases (
  company_id uuid NOT NULL, id uuid NOT NULL, scope_id uuid NOT NULL, title text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','claimed','recovery_required','done')),
  fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0), claim_token_hash text, holder_member_id uuid,
  lease_expires_at timestamptz, outcome jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,scope_id) REFERENCES realbud_company.scopes(company_id,id),
  FOREIGN KEY(company_id,holder_member_id) REFERENCES realbud_company.members(company_id,id),
  CHECK ((status='claimed') = (claim_token_hash IS NOT NULL AND holder_member_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE TABLE realbud_company.claim_receipts (
  company_id uuid NOT NULL, id uuid NOT NULL, case_id uuid NOT NULL, fence bigint NOT NULL,
  actor_member_id uuid NOT NULL, kind text NOT NULL, details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,case_id) REFERENCES realbud_company.cases(company_id,id),
  FOREIGN KEY(company_id,actor_member_id) REFERENCES realbud_company.members(company_id,id)
);
CREATE TABLE realbud_company.audit_events (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES realbud_company.companies(id),
  kind text NOT NULL, actor_member_id uuid, details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(company_id,actor_member_id) REFERENCES realbud_company.members(company_id,id)
);
CREATE FUNCTION realbud_company.actor_company() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('realbud.company_id',true),'')::uuid
$$;
CREATE FUNCTION realbud_company.actor_member() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('realbud.member_id',true),'')::uuid
$$;

-- These fences complement authoritative service authentication and explicit permission
-- checks. The application role cannot bypass them or own the tables.
ALTER TABLE realbud_company.scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE realbud_company.scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_company ON realbud_company.scopes AS RESTRICTIVE
  USING(company_id=realbud_company.actor_company()) WITH CHECK(company_id=realbud_company.actor_company());
CREATE POLICY scope_read ON realbud_company.scopes FOR SELECT USING (
  owner_member_id=realbud_company.actor_member() OR kind='company' OR EXISTS (
    SELECT 1 FROM realbud_company.scope_grants g
    WHERE g.company_id=scopes.company_id AND g.scope_id=scopes.id AND g.member_id=realbud_company.actor_member()
  )
);
CREATE POLICY scope_insert ON realbud_company.scopes FOR INSERT WITH CHECK(owner_member_id=realbud_company.actor_member());
CREATE POLICY scope_update ON realbud_company.scopes FOR UPDATE USING(owner_member_id=realbud_company.actor_member())
  WITH CHECK(owner_member_id=realbud_company.actor_member());

ALTER TABLE realbud_company.scope_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE realbud_company.scope_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY grant_company ON realbud_company.scope_grants
  USING(company_id=realbud_company.actor_company()) WITH CHECK(company_id=realbud_company.actor_company());

CREATE FUNCTION realbud_company.scope_allowed(target uuid, requested text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM realbud_company.scopes s
    WHERE s.company_id=realbud_company.actor_company() AND s.id=target AND (
      s.owner_member_id=realbud_company.actor_member() OR
      (requested='read' AND s.kind='company') OR EXISTS (
        SELECT 1 FROM realbud_company.scope_grants g
        WHERE g.company_id=s.company_id AND g.scope_id=s.id AND g.member_id=realbud_company.actor_member()
          AND (g.permission=requested OR g.permission='write')
      )
    )
  )
$$;
ALTER TABLE realbud_company.knowledge_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE realbud_company.knowledge_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_company ON realbud_company.knowledge_revisions AS RESTRICTIVE
  USING(company_id=realbud_company.actor_company()) WITH CHECK(company_id=realbud_company.actor_company());
CREATE POLICY knowledge_read ON realbud_company.knowledge_revisions FOR SELECT USING(realbud_company.scope_allowed(scope_id,'read'));
CREATE POLICY knowledge_insert ON realbud_company.knowledge_revisions FOR INSERT WITH CHECK(
  author_member_id=realbud_company.actor_member() AND realbud_company.scope_allowed(scope_id,'write')
);
ALTER TABLE realbud_company.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE realbud_company.cases FORCE ROW LEVEL SECURITY;
CREATE POLICY case_company ON realbud_company.cases AS RESTRICTIVE
  USING(company_id=realbud_company.actor_company()) WITH CHECK(company_id=realbud_company.actor_company());
CREATE POLICY case_read ON realbud_company.cases FOR SELECT USING(realbud_company.scope_allowed(scope_id,'read'));
CREATE POLICY case_insert ON realbud_company.cases FOR INSERT WITH CHECK(realbud_company.scope_allowed(scope_id,'write'));
CREATE POLICY case_update ON realbud_company.cases FOR UPDATE USING(realbud_company.scope_allowed(scope_id,'write'))
  WITH CHECK(realbud_company.scope_allowed(scope_id,'write'));
ALTER TABLE realbud_company.claim_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE realbud_company.claim_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY receipt_company ON realbud_company.claim_receipts
  USING(company_id=realbud_company.actor_company() AND EXISTS (
    SELECT 1 FROM realbud_company.cases c WHERE c.company_id=claim_receipts.company_id AND c.id=claim_receipts.case_id
  )) WITH CHECK(company_id=realbud_company.actor_company() AND actor_member_id=realbud_company.actor_member());
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA realbud_company FROM PUBLIC;
`;

const MEMBER_CREDENTIALS_SCHEMA = `
CREATE TABLE realbud_company.member_credentials (
  company_id uuid NOT NULL,
  member_id uuid NOT NULL,
  login_name text NOT NULL CHECK (login_name = lower(login_name) AND login_name ~ '^[a-z0-9._-]{3,80}$'),
  password_verifier text NOT NULL,
  recovery_hash text NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  blocked_until timestamptz,
  PRIMARY KEY (company_id, member_id),
  FOREIGN KEY (company_id, member_id) REFERENCES realbud_company.members (company_id, id),
  UNIQUE (company_id, login_name)
);
`;

const WORKFLOW_TEMPLATE_SCHEMA = `
CREATE TABLE realbud_company.workflow_templates (
  company_id uuid PRIMARY KEY REFERENCES realbud_company.companies(id),
  revision bigint NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 32768),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE realbud_company.workflow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE realbud_company.workflow_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY template_company ON realbud_company.workflow_templates AS RESTRICTIVE
  USING (company_id=realbud_company.actor_company() AND EXISTS (
    SELECT 1 FROM realbud_company.members WHERE company_id=realbud_company.actor_company()
      AND id=realbud_company.actor_member() AND active));
CREATE POLICY template_read ON realbud_company.workflow_templates FOR SELECT USING (true);
CREATE POLICY template_owner ON realbud_company.workflow_templates FOR ALL USING (EXISTS (
  SELECT 1 FROM realbud_company.members WHERE company_id=realbud_company.actor_company()
    AND id=realbud_company.actor_member() AND role='owner' AND active));
`;

/** Install only through an administrative connection, never the runtime pool. */
export async function migrateCompanySchema(pool: Pool, options: { applicationRole: string }): Promise<void> {
  const role = options.applicationRole;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error('Invalid company application role');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('realbud-company-schema',0))");
    const roleResult = await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1', [role]);
    if (!roleResult.rows[0] || roleResult.rows[0].rolsuper || roleResult.rows[0].rolbypassrls) {
      throw new Error('Company application role must exist without superuser or BYPASSRLS');
    }
    await client.query('CREATE SCHEMA IF NOT EXISTS realbud_company');
    await client.query(`CREATE TABLE IF NOT EXISTS realbud_company.schema_migrations(
      id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    const checksum = createHash('sha256').update(INITIAL_SCHEMA).digest('hex');
    const applied = await client.query('SELECT checksum FROM realbud_company.schema_migrations WHERE id=$1', ['0001']);
    if (applied.rows[0] && applied.rows[0].checksum !== checksum) throw new Error('Company migration checksum mismatch');
    if (!applied.rows[0]) {
      await client.query(INITIAL_SCHEMA);
      await client.query('INSERT INTO realbud_company.schema_migrations(id,checksum) VALUES($1,$2)', ['0001', checksum]);
    }
    const credentialsChecksum = createHash('sha256').update(MEMBER_CREDENTIALS_SCHEMA).digest('hex');
    const credentialsApplied = await client.query('SELECT checksum FROM realbud_company.schema_migrations WHERE id=$1', ['0002']);
    if (credentialsApplied.rows[0] && credentialsApplied.rows[0].checksum !== credentialsChecksum) throw new Error('Company migration checksum mismatch');
    if (!credentialsApplied.rows[0]) {
      await client.query(MEMBER_CREDENTIALS_SCHEMA);
      await client.query('INSERT INTO realbud_company.schema_migrations(id,checksum) VALUES($1,$2)', ['0002', credentialsChecksum]);
    }
    const templateChecksum = createHash('sha256').update(WORKFLOW_TEMPLATE_SCHEMA).digest('hex');
    const templateApplied = await client.query('SELECT checksum FROM realbud_company.schema_migrations WHERE id=$1', ['0003']);
    if (templateApplied.rows[0] && templateApplied.rows[0].checksum !== templateChecksum) throw new Error('Company migration checksum mismatch');
    if (!templateApplied.rows[0]) {
      await client.query(WORKFLOW_TEMPLATE_SCHEMA);
      await client.query('INSERT INTO realbud_company.schema_migrations(id,checksum) VALUES($1,$2)', ['0003', templateChecksum]);
    }
    // Role spelling is validated above. It cannot be supplied by a product user.
    await client.query(`GRANT USAGE ON SCHEMA realbud_company TO "${role}"`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA realbud_company TO "${role}"`);
    await client.query(`REVOKE ALL ON realbud_company.schema_migrations FROM "${role}"`);
    await client.query(`REVOKE UPDATE,DELETE ON realbud_company.knowledge_revisions,realbud_company.claim_receipts,realbud_company.audit_events FROM "${role}"`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA realbud_company TO "${role}"`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
