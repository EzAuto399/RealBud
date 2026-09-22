import { createHash } from 'node:crypto';
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
const MEMBERSHIP_SCHEMA = `
CREATE TABLE realbud_company.ownership_transfers (
  company_id uuid PRIMARY KEY REFERENCES realbud_company.companies(id), id uuid NOT NULL UNIQUE,
  from_member_id uuid NOT NULL, to_member_id uuid NOT NULL,
  expires_at timestamptz NOT NULL, accepted_at timestamptz, revoked_at timestamptz,
  FOREIGN KEY(company_id,from_member_id) REFERENCES realbud_company.members(company_id,id),
  FOREIGN KEY(company_id,to_member_id) REFERENCES realbud_company.members(company_id,id)
);
ALTER TABLE realbud_company.ownership_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE realbud_company.ownership_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY ownership_company ON realbud_company.ownership_transfers
  USING(company_id=realbud_company.actor_company()) WITH CHECK(company_id=realbud_company.actor_company());
CREATE POLICY scope_company_owner_update ON realbud_company.scopes FOR UPDATE
  USING(kind='company' AND EXISTS(SELECT 1 FROM realbud_company.members m WHERE m.company_id=scopes.company_id AND m.id=realbud_company.actor_member() AND m.active AND m.role='owner'))
  WITH CHECK(kind='company' AND owner_member_id=realbud_company.actor_member());
CREATE TABLE realbud_company.departure_receipts (
  operation_hash text PRIMARY KEY, company_id uuid NOT NULL, member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(company_id,member_id) REFERENCES realbud_company.members(company_id,id)
);
`;
// A department is explicitly tagged. Existing team scopes include private
// reviewed-work handoffs and must never be inferred to be departments.
const DEPARTMENTS_SCHEMA = `
ALTER TABLE realbud_company.scopes ADD COLUMN purpose text NOT NULL DEFAULT 'general'
  CHECK(purpose IN ('general','department'));
ALTER TABLE realbud_company.scopes ADD CONSTRAINT department_is_team CHECK(purpose<>'department' OR kind='team');
CREATE UNIQUE INDEX department_name ON realbud_company.scopes(company_id,lower(name)) WHERE purpose='department';
CREATE FUNCTION realbud_company.actor_is_owner() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM realbud_company.members WHERE company_id=realbud_company.actor_company()
    AND id=realbud_company.actor_member() AND active AND role='owner')
$$;
DROP POLICY scope_insert ON realbud_company.scopes;
CREATE POLICY scope_insert ON realbud_company.scopes FOR INSERT WITH CHECK(
  owner_member_id=realbud_company.actor_member() AND (purpose='general' OR realbud_company.actor_is_owner()));
DROP POLICY scope_read ON realbud_company.scopes;
CREATE POLICY scope_read ON realbud_company.scopes FOR SELECT USING (
  (purpose='general' AND (owner_member_id=realbud_company.actor_member() OR kind='company')) OR
  (purpose='department' AND realbud_company.actor_is_owner()) OR EXISTS (
    SELECT 1 FROM realbud_company.scope_grants g WHERE g.company_id=scopes.company_id
      AND g.scope_id=scopes.id AND g.member_id=realbud_company.actor_member())
);
DROP POLICY scope_update ON realbud_company.scopes;
CREATE POLICY scope_update ON realbud_company.scopes FOR UPDATE
  USING((purpose='general' AND owner_member_id=realbud_company.actor_member()) OR (purpose='department' AND realbud_company.actor_is_owner()))
  WITH CHECK((purpose='general' AND owner_member_id=realbud_company.actor_member()) OR (purpose='department' AND realbud_company.actor_is_owner()));
CREATE OR REPLACE FUNCTION realbud_company.scope_allowed(target uuid, requested text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM realbud_company.scopes s
    WHERE s.company_id=realbud_company.actor_company() AND s.id=target AND (
      (s.purpose='general' AND (s.owner_member_id=realbud_company.actor_member() OR (requested='read' AND s.kind='company'))) OR
      (s.purpose='department' AND realbud_company.actor_is_owner()) OR EXISTS (
        SELECT 1 FROM realbud_company.scope_grants g WHERE g.company_id=s.company_id AND g.scope_id=s.id
          AND g.member_id=realbud_company.actor_member() AND (g.permission=requested OR g.permission='write'))))
$$;
REVOKE ALL ON FUNCTION realbud_company.actor_is_owner() FROM PUBLIC;
`;
const DEPARTMENT_LIFECYCLE_SCHEMA = `
ALTER TABLE realbud_company.scopes ADD COLUMN retired_at timestamptz,
  ADD COLUMN retired_by uuid,
  ADD COLUMN retirement_note text NOT NULL DEFAULT '',
  ADD CONSTRAINT department_retirement_member FOREIGN KEY(company_id,retired_by) REFERENCES realbud_company.members(company_id,id),
  ADD CONSTRAINT department_retirement_valid CHECK (
    (retired_at IS NULL AND retired_by IS NULL AND retirement_note='') OR
    (purpose='department' AND retired_at IS NOT NULL AND retired_by IS NOT NULL AND length(retirement_note) BETWEEN 1 AND 2048));
ALTER TABLE realbud_company.cases ADD COLUMN description text NOT NULL DEFAULT '' CHECK(length(description)<=4000),
  ADD COLUMN assignee_member_id uuid,
  ADD CONSTRAINT case_assignee_member FOREIGN KEY(company_id,assignee_member_id) REFERENCES realbud_company.members(company_id,id);
ALTER TABLE realbud_company.cases DROP CONSTRAINT cases_status_check;
ALTER TABLE realbud_company.cases ADD CONSTRAINT cases_status_check CHECK(status IN ('open','claimed','recovery_required','done','cancelled'));
CREATE INDEX department_assigned_open ON realbud_company.cases(company_id,assignee_member_id) WHERE status IN ('open','claimed','recovery_required');
-- Departure must not forget responsibility merely because read access was
-- revoked. Expose only this caller's boolean, never hidden case contents.
CREATE FUNCTION realbud_company.actor_has_department_work() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET row_security=off AS $$
  SELECT EXISTS(SELECT 1 FROM realbud_company.cases c JOIN realbud_company.scopes s
    ON s.company_id=c.company_id AND s.id=c.scope_id
    WHERE c.company_id=realbud_company.actor_company() AND s.purpose='department' AND (
      (c.assignee_member_id=realbud_company.actor_member() AND c.status IN ('open','claimed','recovery_required')) OR
      (c.holder_member_id=realbud_company.actor_member() AND c.status IN ('claimed','recovery_required'))))
$$;
REVOKE ALL ON FUNCTION realbud_company.actor_has_department_work() FROM PUBLIC;
CREATE OR REPLACE FUNCTION realbud_company.scope_allowed(target uuid, requested text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM realbud_company.scopes s
    WHERE s.company_id=realbud_company.actor_company() AND s.id=target
      AND (requested='read' OR s.retired_at IS NULL) AND (
      (s.purpose='general' AND (s.owner_member_id=realbud_company.actor_member() OR (requested='read' AND s.kind='company'))) OR
      (s.purpose='department' AND realbud_company.actor_is_owner()) OR EXISTS (
        SELECT 1 FROM realbud_company.scope_grants g WHERE g.company_id=s.company_id AND g.scope_id=s.id
          AND g.member_id=realbud_company.actor_member() AND (g.permission=requested OR g.permission='write'))))
$$;
`;
const PORTAL_BINDINGS_SCHEMA = `
ALTER TABLE realbud_company.companies ADD COLUMN remote_authority_incarnation uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN portal_issuer text, ADD COLUMN portal_company_id text,
  ADD CONSTRAINT company_portal_anchor CHECK ((portal_issuer IS NULL AND portal_company_id IS NULL) OR
    (portal_issuer='https://realbud.app' AND portal_company_id IS NOT NULL AND length(portal_company_id) BETWEEN 1 AND 200));
CREATE TABLE realbud_company.portal_member_bindings (
  company_id uuid NOT NULL REFERENCES realbud_company.companies(id), id uuid NOT NULL,
  member_id uuid NOT NULL, created_by uuid NOT NULL, begin_body jsonb NOT NULL,
  authority_id uuid NOT NULL, certificate_digest text NOT NULL CHECK(certificate_digest ~ '^[a-f0-9]{64}$'),
  map_challenge_hash text NOT NULL UNIQUE CHECK(map_challenge_hash ~ '^[a-f0-9]{64}$'),
  confirm_challenge_hash text NOT NULL UNIQUE CHECK(confirm_challenge_hash ~ '^[a-f0-9]{64}$'),
  map_redemption_id uuid NOT NULL UNIQUE, confirm_redemption_id uuid NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  map_request jsonb, confirm_request jsonb, candidate_proof jsonb, confirm_proof jsonb,
  confirmed_at timestamptz, revoked_at timestamptz, revoke_request jsonb,
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,member_id) REFERENCES realbud_company.members(company_id,id),
  FOREIGN KEY(company_id,created_by) REFERENCES realbud_company.members(company_id,id),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
  CHECK(map_challenge_hash<>confirm_challenge_hash AND map_redemption_id<>confirm_redemption_id),
  CHECK(confirmed_at IS NULL OR (candidate_proof IS NOT NULL AND confirm_proof IS NOT NULL)),
  CHECK(candidate_proof IS NULL OR map_request IS NOT NULL),
  CHECK(confirm_proof IS NULL OR confirm_request IS NOT NULL)
);
CREATE UNIQUE INDEX portal_binding_member_active ON realbud_company.portal_member_bindings(company_id,member_id) WHERE confirmed_at IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX portal_binding_person_active ON realbud_company.portal_member_bindings(company_id,(candidate_proof->'person'->>'subject')) WHERE confirmed_at IS NOT NULL AND revoked_at IS NULL;
ALTER TABLE realbud_company.portal_member_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE realbud_company.portal_member_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_binding_company ON realbud_company.portal_member_bindings AS RESTRICTIVE USING(company_id=realbud_company.actor_company()) WITH CHECK(company_id=realbud_company.actor_company());
CREATE POLICY portal_binding_read ON realbud_company.portal_member_bindings FOR SELECT USING(member_id=realbud_company.actor_member() OR realbud_company.actor_is_owner());
CREATE POLICY portal_binding_insert ON realbud_company.portal_member_bindings FOR INSERT WITH CHECK(realbud_company.actor_is_owner() AND created_by=realbud_company.actor_member());
CREATE POLICY portal_binding_update ON realbud_company.portal_member_bindings FOR UPDATE USING(member_id=realbud_company.actor_member() OR realbud_company.actor_is_owner()) WITH CHECK(member_id=realbud_company.actor_member() OR realbud_company.actor_is_owner());
CREATE FUNCTION realbud_company.protect_portal_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'portal_binding_immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['revision','map_request','confirm_request','candidate_proof','confirm_proof','confirmed_at','revoked_at','revoke_request']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['revision','map_request','confirm_request','candidate_proof','confirm_proof','confirmed_at','revoked_at','revoke_request'])
    OR OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD
    OR OLD.map_request IS NOT NULL AND NEW.map_request IS DISTINCT FROM OLD.map_request
    OR OLD.confirm_request IS NOT NULL AND NEW.confirm_request IS DISTINCT FROM OLD.confirm_request
    OR OLD.candidate_proof IS NOT NULL AND NEW.candidate_proof IS DISTINCT FROM OLD.candidate_proof
    OR OLD.confirm_proof IS NOT NULL AND NEW.confirm_proof IS DISTINCT FROM OLD.confirm_proof
    OR OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
    OR OLD.revoke_request IS NOT NULL AND NEW.revoke_request IS DISTINCT FROM OLD.revoke_request
    OR NEW.revision<OLD.revision OR NEW.revision>OLD.revision+1
  THEN RAISE EXCEPTION 'portal_binding_immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_binding_immutable BEFORE UPDATE OR DELETE ON realbud_company.portal_member_bindings FOR EACH ROW EXECUTE FUNCTION realbud_company.protect_portal_binding();
CREATE FUNCTION realbud_company.protect_portal_anchor() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.portal_issuer IS NOT NULL AND (NEW.portal_issuer IS DISTINCT FROM OLD.portal_issuer OR NEW.portal_company_id IS DISTINCT FROM OLD.portal_company_id) THEN RAISE EXCEPTION 'portal_anchor_immutable'; END IF;
  IF (NEW.portal_issuer IS DISTINCT FROM OLD.portal_issuer OR NEW.portal_company_id IS DISTINCT FROM OLD.portal_company_id) AND (NEW.id IS DISTINCT FROM realbud_company.actor_company() OR NOT realbud_company.actor_is_owner()) THEN RAISE EXCEPTION 'portal_anchor_forbidden'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_portal_anchor_immutable BEFORE UPDATE ON realbud_company.companies FOR EACH ROW EXECUTE FUNCTION realbud_company.protect_portal_anchor();
REVOKE ALL ON FUNCTION realbud_company.protect_portal_binding(),realbud_company.protect_portal_anchor() FROM PUBLIC;
`;
const DEPARTMENT_EXECUTION_SCHEMA = `
ALTER TABLE realbud_company.members ADD COLUMN execution_epoch bigint NOT NULL DEFAULT 0 CHECK(execution_epoch>=0);
CREATE FUNCTION realbud_company.bump_execution_epoch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.role IS DISTINCT FROM OLD.role OR NEW.active IS DISTINCT FROM OLD.active THEN NEW.execution_epoch:=OLD.execution_epoch+1;
 ELSIF NEW.execution_epoch IS DISTINCT FROM OLD.execution_epoch THEN RAISE EXCEPTION 'execution_epoch_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_execution_epoch BEFORE UPDATE ON realbud_company.members FOR EACH ROW EXECUTE FUNCTION realbud_company.bump_execution_epoch();
CREATE TABLE realbud_company.department_execution_grants (
 company_id uuid NOT NULL,id uuid NOT NULL,member_id uuid NOT NULL,member_epoch bigint NOT NULL,
 department_id uuid NOT NULL,department_revision bigint NOT NULL,case_id uuid NOT NULL,case_fence bigint NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 begin_body jsonb NOT NULL,spec jsonb NOT NULL,source jsonb NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),confirmed_by uuid,confirmed_epoch bigint,confirm_request jsonb,confirmed_at timestamptz,
 revoked_at timestamptz,revoke_request jsonb,consumed_claim_id uuid,
 PRIMARY KEY(company_id,id),FOREIGN KEY(company_id,member_id) REFERENCES realbud_company.members(company_id,id),
 FOREIGN KEY(company_id,confirmed_by) REFERENCES realbud_company.members(company_id,id),
 FOREIGN KEY(company_id,department_id) REFERENCES realbud_company.scopes(company_id,id),
 FOREIGN KEY(company_id,case_id) REFERENCES realbud_company.cases(company_id,id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days'),
 CHECK((confirmed_at IS NULL AND confirmed_by IS NULL AND confirmed_epoch IS NULL AND confirm_request IS NULL) OR
  (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_epoch IS NOT NULL AND confirm_request IS NOT NULL))
);
CREATE TABLE realbud_company.department_execution_claims (
 company_id uuid NOT NULL,id uuid NOT NULL,grant_id uuid NOT NULL,member_id uuid NOT NULL,case_id uuid NOT NULL,case_fence bigint NOT NULL,
 execution_id uuid NOT NULL,secret_hash text NOT NULL CHECK(secret_hash ~ '^[a-f0-9]{64}$'),request_body jsonb NOT NULL,receipt jsonb NOT NULL,lease_receipt jsonb NOT NULL,
 admitted_at timestamptz NOT NULL,dispatch_until timestamptz NOT NULL,lease_expires_at timestamptz NOT NULL,
 settled_at timestamptz,settlement jsonb,
 PRIMARY KEY(company_id,id),UNIQUE(company_id,grant_id),UNIQUE(company_id,execution_id),
 FOREIGN KEY(company_id,grant_id) REFERENCES realbud_company.department_execution_grants(company_id,id),
 FOREIGN KEY(company_id,member_id) REFERENCES realbud_company.members(company_id,id),
 FOREIGN KEY(company_id,case_id) REFERENCES realbud_company.cases(company_id,id),
 CHECK(dispatch_until>admitted_at AND dispatch_until<=admitted_at+interval '60 seconds'),
 CHECK(lease_expires_at>admitted_at),CHECK((settled_at IS NULL)=(settlement IS NULL))
);
CREATE TABLE realbud_company.department_execution_events (
 company_id uuid NOT NULL,id uuid NOT NULL,claim_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('renew','settle')),
 body jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,id),FOREIGN KEY(company_id,claim_id) REFERENCES realbud_company.department_execution_claims(company_id,id)
);
ALTER TABLE realbud_company.department_execution_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE realbud_company.department_execution_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_grant_boundary ON realbud_company.department_execution_grants AS RESTRICTIVE USING(
 company_id=realbud_company.actor_company() OR (realbud_company.actor_company() IS NULL AND token_hash=current_setting('realbud.delegation_hash',true)))
 WITH CHECK(company_id=realbud_company.actor_company());
CREATE POLICY execution_grant_read ON realbud_company.department_execution_grants FOR SELECT USING(
 member_id=realbud_company.actor_member() OR realbud_company.actor_is_owner() OR (realbud_company.actor_company() IS NULL AND token_hash=current_setting('realbud.delegation_hash',true)));
CREATE POLICY execution_grant_insert ON realbud_company.department_execution_grants FOR INSERT WITH CHECK(member_id=realbud_company.actor_member());
CREATE POLICY execution_grant_update ON realbud_company.department_execution_grants FOR UPDATE USING(member_id=realbud_company.actor_member() OR realbud_company.actor_is_owner()) WITH CHECK(member_id=realbud_company.actor_member() OR realbud_company.actor_is_owner());
ALTER TABLE realbud_company.department_execution_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE realbud_company.department_execution_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_claim_boundary ON realbud_company.department_execution_claims AS RESTRICTIVE USING(company_id=realbud_company.actor_company()) WITH CHECK(company_id=realbud_company.actor_company());
CREATE POLICY execution_claim_read ON realbud_company.department_execution_claims FOR SELECT USING(member_id=realbud_company.actor_member() OR realbud_company.actor_is_owner());
CREATE POLICY execution_claim_write ON realbud_company.department_execution_claims FOR ALL USING(member_id=realbud_company.actor_member()) WITH CHECK(member_id=realbud_company.actor_member());
ALTER TABLE realbud_company.department_execution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE realbud_company.department_execution_events FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_event_boundary ON realbud_company.department_execution_events AS RESTRICTIVE USING(company_id=realbud_company.actor_company()) WITH CHECK(company_id=realbud_company.actor_company());
CREATE POLICY execution_event_access ON realbud_company.department_execution_events FOR ALL USING(EXISTS(SELECT 1 FROM realbud_company.department_execution_claims c WHERE c.company_id=department_execution_events.company_id AND c.id=department_execution_events.claim_id));
CREATE FUNCTION realbud_company.protect_execution_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'execution_record_immutable'; END IF;
 IF TG_TABLE_NAME='department_execution_grants' THEN
  IF (to_jsonb(NEW)-ARRAY['revision','confirmed_by','confirmed_epoch','confirm_request','confirmed_at','revoked_at','revoke_request','consumed_claim_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','confirmed_by','confirmed_epoch','confirm_request','confirmed_at','revoked_at','revoke_request','consumed_claim_id'])
   OR OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD
   OR OLD.confirmed_at IS NOT NULL AND (NEW.confirmed_at,NEW.confirmed_by,NEW.confirmed_epoch,NEW.confirm_request) IS DISTINCT FROM (OLD.confirmed_at,OLD.confirmed_by,OLD.confirmed_epoch,OLD.confirm_request)
   OR OLD.consumed_claim_id IS NOT NULL AND NEW.consumed_claim_id IS DISTINCT FROM OLD.consumed_claim_id
   OR OLD.revoke_request IS NOT NULL AND NEW.revoke_request IS DISTINCT FROM OLD.revoke_request
   OR NEW.revision<OLD.revision OR NEW.revision>OLD.revision+1 THEN RAISE EXCEPTION 'execution_record_immutable'; END IF;
 ELSIF TG_TABLE_NAME='department_execution_claims' THEN
  IF (to_jsonb(NEW)-ARRAY['lease_expires_at','lease_receipt','settled_at','settlement']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['lease_expires_at','lease_receipt','settled_at','settlement'])
   OR OLD.settled_at IS NOT NULL AND NEW IS DISTINCT FROM OLD OR NEW.lease_expires_at<OLD.lease_expires_at THEN RAISE EXCEPTION 'execution_record_immutable'; END IF;
 ELSE RAISE EXCEPTION 'execution_record_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_grant_immutable BEFORE UPDATE OR DELETE ON realbud_company.department_execution_grants FOR EACH ROW EXECUTE FUNCTION realbud_company.protect_execution_record();
CREATE TRIGGER execution_claim_immutable BEFORE UPDATE OR DELETE ON realbud_company.department_execution_claims FOR EACH ROW EXECUTE FUNCTION realbud_company.protect_execution_record();
CREATE TRIGGER execution_event_immutable BEFORE UPDATE OR DELETE ON realbud_company.department_execution_events FOR EACH ROW EXECUTE FUNCTION realbud_company.protect_execution_record();
CREATE FUNCTION realbud_company.hold_execution_on_lifecycle() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='members' THEN
  IF NEW.execution_epoch=OLD.execution_epoch THEN RETURN NEW; END IF;
  UPDATE realbud_company.department_execution_grants SET revoked_at=clock_timestamp(),revision=revision+1
   WHERE company_id=NEW.company_id AND revoked_at IS NULL AND (member_id=NEW.id OR confirmed_by=NEW.id);
 ELSE
  IF NEW.revision=OLD.revision AND NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at THEN RETURN NEW; END IF;
  UPDATE realbud_company.department_execution_grants SET revoked_at=clock_timestamp(),revision=revision+1
   WHERE company_id=NEW.company_id AND department_id=NEW.id AND revoked_at IS NULL;
 END IF;
 UPDATE realbud_company.cases c SET status='recovery_required',fence=fence+1,claim_token_hash=NULL,lease_expires_at=NULL
  WHERE c.company_id=NEW.company_id AND c.status='claimed' AND EXISTS(
   SELECT 1 FROM realbud_company.department_execution_claims e JOIN realbud_company.department_execution_grants g ON g.company_id=e.company_id AND g.id=e.grant_id
    WHERE e.company_id=c.company_id AND e.case_id=c.id AND e.case_fence=c.fence AND g.revoked_at IS NOT NULL);
 RETURN NEW;
END $$;
CREATE TRIGGER execution_member_lifecycle AFTER UPDATE ON realbud_company.members FOR EACH ROW EXECUTE FUNCTION realbud_company.hold_execution_on_lifecycle();
CREATE TRIGGER execution_department_lifecycle AFTER UPDATE ON realbud_company.scopes FOR EACH ROW EXECUTE FUNCTION realbud_company.hold_execution_on_lifecycle();
REVOKE ALL ON FUNCTION realbud_company.bump_execution_epoch(),realbud_company.protect_execution_record(),realbud_company.hold_execution_on_lifecycle() FROM PUBLIC;
`;
/** Trusted migration identities for data-only backup compatibility checks. */
export function companySchemaManifest() {
    return [INITIAL_SCHEMA, MEMBER_CREDENTIALS_SCHEMA, WORKFLOW_TEMPLATE_SCHEMA, MEMBERSHIP_SCHEMA, DEPARTMENTS_SCHEMA, DEPARTMENT_LIFECYCLE_SCHEMA, PORTAL_BINDINGS_SCHEMA, DEPARTMENT_EXECUTION_SCHEMA]
        .map((sql, index) => ({ id: String(index + 1).padStart(4, '0'), checksum: createHash('sha256').update(sql).digest('hex') }));
}
/** Install only through an administrative connection, never the runtime pool. */
export async function migrateCompanySchema(pool, options) {
    const role = options.applicationRole;
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role))
        throw new Error('Invalid company application role');
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
        if (applied.rows[0] && applied.rows[0].checksum !== checksum)
            throw new Error('Company migration checksum mismatch');
        if (!applied.rows[0]) {
            await client.query(INITIAL_SCHEMA);
            await client.query('INSERT INTO realbud_company.schema_migrations(id,checksum) VALUES($1,$2)', ['0001', checksum]);
        }
        const credentialsChecksum = createHash('sha256').update(MEMBER_CREDENTIALS_SCHEMA).digest('hex');
        const credentialsApplied = await client.query('SELECT checksum FROM realbud_company.schema_migrations WHERE id=$1', ['0002']);
        if (credentialsApplied.rows[0] && credentialsApplied.rows[0].checksum !== credentialsChecksum)
            throw new Error('Company migration checksum mismatch');
        if (!credentialsApplied.rows[0]) {
            await client.query(MEMBER_CREDENTIALS_SCHEMA);
            await client.query('INSERT INTO realbud_company.schema_migrations(id,checksum) VALUES($1,$2)', ['0002', credentialsChecksum]);
        }
        const templateChecksum = createHash('sha256').update(WORKFLOW_TEMPLATE_SCHEMA).digest('hex');
        const templateApplied = await client.query('SELECT checksum FROM realbud_company.schema_migrations WHERE id=$1', ['0003']);
        if (templateApplied.rows[0] && templateApplied.rows[0].checksum !== templateChecksum)
            throw new Error('Company migration checksum mismatch');
        if (!templateApplied.rows[0]) {
            await client.query(WORKFLOW_TEMPLATE_SCHEMA);
            await client.query('INSERT INTO realbud_company.schema_migrations(id,checksum) VALUES($1,$2)', ['0003', templateChecksum]);
        }
        const membershipChecksum = createHash('sha256').update(MEMBERSHIP_SCHEMA).digest('hex');
        const membershipApplied = await client.query('SELECT checksum FROM realbud_company.schema_migrations WHERE id=$1', ['0004']);
        if (membershipApplied.rows[0] && membershipApplied.rows[0].checksum !== membershipChecksum)
            throw new Error('Company migration checksum mismatch');
        if (!membershipApplied.rows[0]) {
            await client.query(MEMBERSHIP_SCHEMA);
            await client.query('INSERT INTO realbud_company.schema_migrations(id,checksum) VALUES($1,$2)', ['0004', membershipChecksum]);
        }
        const departmentsChecksum = createHash('sha256').update(DEPARTMENTS_SCHEMA).digest('hex');
        const departmentsApplied = await client.query('SELECT checksum FROM realbud_company.schema_migrations WHERE id=$1', ['0005']);
        if (departmentsApplied.rows[0] && departmentsApplied.rows[0].checksum !== departmentsChecksum)
            throw new Error('Company migration checksum mismatch');
        if (!departmentsApplied.rows[0]) {
            await client.query(DEPARTMENTS_SCHEMA);
            await client.query('INSERT INTO realbud_company.schema_migrations(id,checksum) VALUES($1,$2)', ['0005', departmentsChecksum]);
        }
        const lifecycleChecksum = createHash('sha256').update(DEPARTMENT_LIFECYCLE_SCHEMA).digest('hex');
        const lifecycleApplied = await client.query('SELECT checksum FROM realbud_company.schema_migrations WHERE id=$1', ['0006']);
        if (lifecycleApplied.rows[0] && lifecycleApplied.rows[0].checksum !== lifecycleChecksum)
            throw new Error('Company migration checksum mismatch');
        if (!lifecycleApplied.rows[0]) {
            await client.query(DEPARTMENT_LIFECYCLE_SCHEMA);
            await client.query('INSERT INTO realbud_company.schema_migrations(id,checksum) VALUES($1,$2)', ['0006', lifecycleChecksum]);
        }
        const portalChecksum = createHash('sha256').update(PORTAL_BINDINGS_SCHEMA).digest('hex');
        const portalApplied = await client.query('SELECT checksum FROM realbud_company.schema_migrations WHERE id=$1', ['0007']);
        if (portalApplied.rows[0] && portalApplied.rows[0].checksum !== portalChecksum)
            throw new Error('Company migration checksum mismatch');
        if (!portalApplied.rows[0]) {
            await client.query(PORTAL_BINDINGS_SCHEMA);
            await client.query('INSERT INTO realbud_company.schema_migrations(id,checksum) VALUES($1,$2)', ['0007', portalChecksum]);
        }
        const executionChecksum = createHash('sha256').update(DEPARTMENT_EXECUTION_SCHEMA).digest('hex');
        const executionApplied = await client.query('SELECT checksum FROM realbud_company.schema_migrations WHERE id=$1', ['0008']);
        if (executionApplied.rows[0] && executionApplied.rows[0].checksum !== executionChecksum)
            throw new Error('Company migration checksum mismatch');
        if (!executionApplied.rows[0]) {
            await client.query(DEPARTMENT_EXECUTION_SCHEMA);
            await client.query('INSERT INTO realbud_company.schema_migrations(id,checksum) VALUES($1,$2)', ['0008', executionChecksum]);
        }
        // Role spelling is validated above. It cannot be supplied by a product user.
        await client.query(`GRANT USAGE ON SCHEMA realbud_company TO "${role}"`);
        await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA realbud_company TO "${role}"`);
        await client.query(`REVOKE ALL ON realbud_company.schema_migrations FROM "${role}"`);
        await client.query(`REVOKE UPDATE,DELETE ON realbud_company.knowledge_revisions,realbud_company.claim_receipts,realbud_company.audit_events FROM "${role}"`);
        await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA realbud_company TO "${role}"`);
        await client.query(`GRANT EXECUTE ON FUNCTION realbud_company.actor_has_department_work() TO "${role}"`);
        await client.query(`REVOKE DELETE ON realbud_company.portal_member_bindings FROM "${role}"`);
        await client.query(`REVOKE DELETE ON realbud_company.department_execution_grants,realbud_company.department_execution_claims FROM "${role}"`);
        await client.query(`REVOKE UPDATE,DELETE ON realbud_company.department_execution_events FROM "${role}"`);
        await client.query(`REVOKE UPDATE ON realbud_company.companies FROM "${role}"`);
        await client.query(`GRANT UPDATE(name,portal_issuer,portal_company_id) ON realbud_company.companies TO "${role}"`);
        await client.query('COMMIT');
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        client.release();
    }
}
