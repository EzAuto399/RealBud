import { createHash, randomUUID } from 'node:crypto';
import { LedgerDatabase } from './database.ts';
import { canonical, id, integer, nano, requireThat, type ServiceEntitlement, type Tenant, type IssuerEnrollment, type RateCard, type PortalPrincipal, type ExecutionGrant, type RequestRecord, type UsageEvidence, type Units } from './contracts.ts';
import { callId, callAuthorization, parentEnvelope } from './attempts.ts';
import { modelRate, periodAt, price, twoMonthsAfter, validateRateCard, validateUnits, withinBound } from './money.ts';

export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
type Body = { body: string };
const parse = <T>(row: Body | undefined): T | undefined => row ? JSON.parse(row.body) as T : undefined;
export class UsageLedger {
  readonly db: LedgerDatabase;
  readonly now: () => number;
  constructor(db: LedgerDatabase, now: () => number = Date.now) { this.db = db; this.now = now; }
  tenant(companyId: string): Tenant {
    const found = parse<Tenant>(this.db.get<Body>('SELECT body FROM tenants WHERE id=?',companyId)); requireThat(found, 'tenant_unavailable', 403); return found;
  }
  /** Trusted operator provisioning only. Never exposed as a portal or host HTTP route. */
  provisionTenant(tenant: Tenant) {
    this.validateEntitlement(tenant);
    this.validateCaps(tenant);
    this.db.transaction(() => {
      requireThat(!this.db.get('SELECT id FROM tenants WHERE id=?',tenant.companyId), 'tenant_already_provisioned',409);
      this.db.run('INSERT INTO tenants(id,body) VALUES(?,?)',tenant.companyId,canonical(tenant));
      this.db.append(tenant.companyId,'tenant_provisioned',null,this.now(),tenant);
    });
  }
  private validateEntitlement(tenant: Tenant) {
    [tenant.companyId,tenant.licenseId,tenant.goLiveEvidence].forEach(id);
    integer(tenant.goLiveAt, Number.MAX_SAFE_INTEGER); integer(tenant.serviceExpiresAt, Number.MAX_SAFE_INTEGER);
    requireThat(typeof tenant.active === 'boolean' && tenant.goLiveAt <= this.now() && tenant.includedUntil === twoMonthsAfter(tenant.goLiveAt), 'invalid_go_live');
    requireThat(tenant.serviceExpiresAt > tenant.goLiveAt, 'invalid_service_expiry');
    requireThat(typeof tenant.customerName === 'string' && tenant.customerName.trim().length > 0 && tenant.customerName.length <= 200 && typeof tenant.customerAddress === 'string' && tenant.customerAddress.trim().length > 0 && tenant.customerAddress.length <= 500, 'customer_identity_required');
    requireThat(tenant.customerAbn === undefined || /^\d{11}$/.test(tenant.customerAbn), 'invalid_customer_abn');
  }
  /**
   * Trusted operator only (`entitlement-cli.ts`); never an HTTP route. Creates or
   * updates one company's service entitlement: whether its RealBud service is
   * active, its licence, go-live and expiry. Validated exactly like
   * `provisionTenant`. AI caps are Modelvia's: a new record stores inert zero
   * caps and an existing record keeps whatever it stored; neither drives
   * anything. The licence is fixed once created, because every issued connector
   * device carries it.
   */
  putEntitlement(entitlement: ServiceEntitlement, evidence: string): { created: boolean; tenant: Tenant } {
    id(evidence);
    const fields = { companyId: entitlement.companyId, licenseId: entitlement.licenseId, active: entitlement.active, serviceExpiresAt: entitlement.serviceExpiresAt,
      customerName: entitlement.customerName, customerAddress: entitlement.customerAddress, ...(entitlement.customerAbn === undefined ? {} : { customerAbn: entitlement.customerAbn }),
      goLiveAt: entitlement.goLiveAt, goLiveEvidence: entitlement.goLiveEvidence };
    return this.db.transaction(() => {
      const current = parse<Tenant>(this.db.get<Body>('SELECT body FROM tenants WHERE id=?',fields.companyId));
      if (!current) {
        const tenant: Tenant = { ...fields, includedUntil: typeof fields.goLiveAt === 'number' ? twoMonthsAfter(fields.goLiveAt) : NaN, monthlyCapNanoAud: '0', requestCapNanoAud: '0', maxConcurrent: 1 };
        this.validateEntitlement(tenant); this.validateCaps(tenant);
        this.db.run('INSERT INTO tenants(id,body) VALUES(?,?)',tenant.companyId,canonical(tenant));
        this.db.append(tenant.companyId,'tenant_provisioned',null,this.now(),{...tenant,evidence});
        return { created: true, tenant };
      }
      requireThat(current.licenseId === fields.licenseId, 'license_id_immutable', 409);
      const { customerAbn: _previousAbn, ...kept } = current;
      const tenant: Tenant = { ...kept, ...fields, includedUntil: typeof fields.goLiveAt === 'number' ? twoMonthsAfter(fields.goLiveAt) : NaN };
      this.validateEntitlement(tenant);
      this.db.run('UPDATE tenants SET body=? WHERE id=?',canonical(tenant),tenant.companyId);
      this.db.append(tenant.companyId,'service_entitlement_updated',null,this.now(),{...fields,evidence});
      return { created: false, tenant };
    });
  }
  private validateCaps(caps: Pick<Tenant,'monthlyCapNanoAud'|'requestCapNanoAud'|'maxConcurrent'>) {
    requireThat(nano(caps.requestCapNanoAud) <= nano(caps.monthlyCapNanoAud), 'invalid_caps'); integer(caps.maxConcurrent,100); requireThat(caps.maxConcurrent > 0,'invalid_concurrency');
    requireThat(nano(caps.monthlyCapNanoAud) % 10_000_000n === 0n, 'cap_requires_whole_cents');
  }
  setService(companyId: string, active: boolean, serviceExpiresAt: number, evidence: string) {
    id(evidence); integer(serviceExpiresAt, Number.MAX_SAFE_INTEGER); requireThat(typeof active === 'boolean','invalid_service_state');
    this.db.transaction(() => { const t = this.tenant(companyId); t.active = active; t.serviceExpiresAt = serviceExpiresAt;
      this.db.run('UPDATE tenants SET body=? WHERE id=?',canonical(t),companyId); this.db.append(companyId,'service_updated',null,this.now(),{active,serviceExpiresAt,evidence}); });
  }
  setCaps(actor: PortalPrincipal, caps: Pick<Tenant,'monthlyCapNanoAud'|'requestCapNanoAud'|'maxConcurrent'>) {
    requireThat(actor.role === 'billing_owner','forbidden',403); this.validateCaps(caps);
    this.db.transaction(() => {
      const t = this.tenant(actor.companyId); const exposure = this.exposure(actor.companyId,periodAt(this.now()));
      requireThat(exposure <= nano(caps.monthlyCapNanoAud), 'cap_below_committed_spend',409);
      Object.assign(t,caps); this.db.run('UPDATE tenants SET body=? WHERE id=?',canonical(t),actor.companyId);
      this.db.append(actor.companyId,'caps_accepted',null,this.now(),{subject:actor.subject,...caps});
    });
  }
  enrollIssuer(issuer: IssuerEnrollment) {
    [issuer.kid,issuer.companyId,issuer.hostInstallationId].forEach(id); this.tenant(issuer.companyId);
    integer(issuer.expiresAt, Number.MAX_SAFE_INTEGER); requireThat(typeof issuer.publicKeyPem === 'string' && issuer.publicKeyPem.length <= 1000 && typeof issuer.revoked === 'boolean','invalid_issuer');
    this.db.transaction(() => {
      requireThat(!this.db.get('SELECT id FROM issuers WHERE id=?',issuer.kid), 'issuer_exists',409);
      this.db.run('INSERT INTO issuers(id,body) VALUES(?,?)',issuer.kid,canonical(issuer)); this.db.append(issuer.companyId,'issuer_enrolled',null,this.now(),issuer);
    });
  }
  issuer(kid: string): IssuerEnrollment | undefined { return parse(this.db.get<Body>('SELECT body FROM issuers WHERE id=?',kid)); }
  revokeIssuer(kid: string) {
    this.db.transaction(() => { const item = this.issuer(kid); requireThat(item,'unknown_issuer',404); item.revoked = true;
      this.db.run('UPDATE issuers SET body=? WHERE id=?',canonical(item),kid); this.db.append(item.companyId,'issuer_revoked',null,this.now(),{kid}); });
  }
  publishCard(card: RateCard) {
    validateRateCard(card); requireThat(card.publishedAt <= this.now(),'future_publication');
    this.db.transaction(() => { this.db.run('INSERT INTO cards(id,digest,body) VALUES(?,?,?)',card.version,digest(card),canonical(card)); this.db.append('operator','rate_card_published',null,this.now(),{version:card.version,digest:digest(card)}); });
  }
  card(version: string): RateCard {
    const found = parse<RateCard>(this.db.get<Body>('SELECT body FROM cards WHERE id=?',version)); requireThat(found,'unknown_rate_card',409); return found;
  }
  cards(): {card:RateCard;digest:string}[] { return this.db.all<Body & {digest:string}>('SELECT body,digest FROM cards ORDER BY id').map(row => ({card:JSON.parse(row.body),digest:row.digest})); }
  acceptCard(actor: PortalPrincipal, version: string, expectedDigest: string) {
    requireThat(actor.role === 'billing_owner','forbidden',403); this.tenant(actor.companyId); const card = this.card(version);
    requireThat(digest(card) === expectedDigest,'rate_card_changed',409);
    return this.db.transaction(() => {
      const previous = parse(this.db.get<Body>('SELECT body FROM acceptances WHERE tenant=? AND version=?',actor.companyId,version)); if (previous) return previous;
      const accepted = {subject:actor.subject,companyId:actor.companyId,version,digest:expectedDigest,acceptedAt:this.now()};
      this.db.run('INSERT INTO acceptances(tenant,version,body) VALUES(?,?,?)',actor.companyId,version,canonical(accepted));
      this.db.append(actor.companyId,'rates_accepted',null,this.now(),accepted); return accepted;
    });
  }
  assertService(grant: ExecutionGrant) {
    const t = this.tenant(grant.companyId), now = this.now();
    requireThat(t.active && t.licenseId === grant.licenseId && t.serviceExpiresAt > now && now >= t.goLiveAt, 'service_unavailable',403);
    const issuer = this.issuer(this.findKid(grant));
    // Signature verification checks issuer too; this rechecks the persisted registry at dispatch.
    if (issuer) requireThat(!issuer.revoked && issuer.expiresAt > now,'issuer_revoked',403);
  }
  private findKid(grant: ExecutionGrant): string { return this.db.get<{kid:string}>('SELECT kid FROM requests WHERE tenant=? AND job=? AND attempt=?',grant.companyId,grant.jobId,grant.attemptId)?.kid ?? ''; }
  requests(companyId: string): RequestRecord[] { return this.db.all<Body>('SELECT body FROM requests WHERE tenant=? ORDER BY rowid',companyId).map(r => JSON.parse(r.body)); }
  request(requestId: string): RequestRecord {
    const found = parse<RequestRecord>(this.db.get<Body>('SELECT body FROM requests WHERE id=?',requestId)); requireThat(found,'request_not_found',404); return found;
  }
  private save(r: RequestRecord) { this.db.run('UPDATE requests SET body=? WHERE id=?',canonical(r),r.id); }
  exposure(companyId: string, period: string): bigint {
    return this.requests(companyId).reduce((sum,r) => sum + (r.state === 'reserved' || r.state === 'dispatched' || r.state === 'unknown' ? nano(r.reservedNanoAud) : r.period === period ? nano(r.retailNanoAud) : 0n),0n);
  }
  reserve(grant: ExecutionGrant, kid: string, fingerprint: string, idem: string, bound: Units): {record:RequestRecord;duplicate:boolean} {
    id(idem); validateUnits(bound);
    return this.db.transaction(() => {
      this.assertService(grant);
      const child=callId(grant), authorization=callAuthorization(grant,kid);
      const siblings=this.db.all<Body>('SELECT body FROM requests WHERE tenant=? AND job=? AND attempt=?',grant.companyId,grant.jobId,grant.attemptId).map(r=>JSON.parse(r.body) as RequestRecord);
      if(grant.schema===2) {
        requireThat(!siblings.some(r=>!r.modelCallId),'legacy_attempt_frozen',409);
        const parent=canonical(parentEnvelope(grant,kid,this.now()));
        const saved=this.db.get<Body>('SELECT body FROM attempts WHERE tenant=? AND job=? AND attempt=?',grant.companyId,grant.jobId,grant.attemptId);
        requireThat(!saved || saved.body===parent,'parent_envelope_conflict',409);
        if(!saved) this.db.run('INSERT INTO attempts(tenant,job,attempt,body) VALUES(?,?,?,?)',grant.companyId,grant.jobId,grant.attemptId,parent);
      } else requireThat(!siblings.some(r=>r.modelCallId),'parent_envelope_conflict',409);
      const prior = parse<RequestRecord>(this.db.get<Body>('SELECT body FROM requests WHERE tenant=? AND member=? AND idem=?',grant.companyId,grant.memberId,idem));
      const sameChild=siblings.find(r=>(r.modelCallId??'legacy')===child);
      if(grant.schema===1 && sameChild && !prior) requireThat(false,'attempt_already_reserved',409);
      if (prior || sameChild) {
        const saved=prior??sameChild!;
        requireThat((!prior || !sameChild || prior.id===sameChild.id) && saved.fingerprint===fingerprint && saved.jobId===grant.jobId && saved.attemptId===grant.attemptId && (saved.modelCallId??'legacy')===child && saved.idempotencyKey===idem && (!saved.authorizationDigest || saved.authorizationDigest===authorization),'idempotency_conflict',409);
        return {record:saved,duplicate:true};
      }
      requireThat(!this.db.get('SELECT id FROM requests WHERE kid=? AND jti=?',kid,grant.jti),'attempt_already_reserved',409);
      const tenant = this.tenant(grant.companyId); const card = this.card(grant.rateVersion); const now = this.now();
      requireThat(card.effectiveAt <= now, 'rate_card_not_effective',409);
      requireThat(this.db.get('SELECT body FROM acceptances WHERE tenant=? AND version=?',grant.companyId,card.version),'rates_not_accepted',409);
      const reserve = price(modelRate(card,grant.model),bound); const period = periodAt(now);
      const source=this.db.get<{mode:string}>('SELECT mode FROM billing_sources WHERE tenant=? AND period=?',tenant.companyId,period);
      requireThat(!source || source.mode==='meter','billing_source_conflict',409);
      if(!source)this.db.run("INSERT INTO billing_sources(tenant,period,mode) VALUES(?,?,'meter')",tenant.companyId,period);
      requireThat(reserve <= nano(grant.maxSpendNanoAud) && reserve <= nano(tenant.requestCapNanoAud),'request_cap_exceeded',402);
      if(grant.schema===2) {
        const used=siblings.reduce((sum,r)=>sum+(['reserved','dispatched','unknown'].includes(r.state)?nano(r.reservedNanoAud):nano(r.retailNanoAud)),0n);
        requireThat(used+reserve<=nano(grant.maxAttemptSpendNanoAud),'attempt_cap_exceeded',402);
      }
      requireThat(this.exposure(tenant.companyId,period) + reserve <= nano(tenant.monthlyCapNanoAud), 'monthly_cap_exceeded',402);
      requireThat(this.requests(tenant.companyId).filter(r => ['reserved','dispatched','unknown'].includes(r.state)).length < tenant.maxConcurrent,'concurrency_limit',429);
      const record: RequestRecord = {id:randomUUID(),companyId:tenant.companyId,memberId:grant.memberId,jobId:grant.jobId,attemptId:grant.attemptId,...(grant.schema===2?{modelCallId:child}:{}),authorizationDigest:authorization,kid,jti:grant.jti,idempotencyKey:idem,fingerprint,model:grant.model,rateVersion:card.version,period,createdAt:now,deadline:grant.exp,state:'reserved',included:now < tenant.includedUntil,bound,reservedNanoAud:reserve.toString(),retailNanoAud:'0',chargedNanoAud:'0',units:{}};
      this.db.run('INSERT INTO requests(id,tenant,member,job,attempt,model_call,idem,kid,jti,body) VALUES(?,?,?,?,?,?,?,?,?,?)',record.id,record.companyId,record.memberId,record.jobId,record.attemptId,child,idem,kid,grant.jti,canonical(record));
      this.db.append(record.companyId,'reserved',record.id,now,{rateVersion:record.rateVersion,bound,reservedNanoAud:record.reservedNanoAud,included:record.included,period});
      return {record,duplicate:false};
    });
  }
  dispatch(requestId: string, grant: ExecutionGrant, providerId:string, usageNamespace=providerId) {
    id(providerId); id(usageNamespace);
    this.db.transaction(() => { const r = this.request(requestId); requireThat(r.state === 'reserved','dispatch_already_claimed',409);
      requireThat(r.companyId===grant.companyId && r.memberId===grant.memberId && r.jobId===grant.jobId && r.attemptId===grant.attemptId && (r.modelCallId??'legacy')===callId(grant) && (!r.authorizationDigest || r.authorizationDigest===callAuthorization(grant,r.kid)),'dispatch_scope_conflict',403);
      if(grant.schema===2) {
        const parent=this.db.get<Body>('SELECT body FROM attempts WHERE tenant=? AND job=? AND attempt=?',grant.companyId,grant.jobId,grant.attemptId);
        requireThat(parent?.body===canonical(parentEnvelope(grant,r.kid,this.now())) && grant.provider===usageNamespace,'dispatch_scope_conflict',403);
      }
      this.assertService(grant); requireThat(this.now() < r.deadline && this.now() < grant.exp,'grant_expired',403);
      const t = this.tenant(r.companyId); requireThat(r.period === periodAt(this.now()) && r.included === (this.now() < t.includedUntil), 'billing_boundary_changed',409);
      r.state = 'dispatched'; r.providerId=providerId; r.providerNamespace=usageNamespace; this.save(r); this.db.append(r.companyId,'dispatched',r.id,this.now(),{providerId,usageNamespace});
    });
  }
  releaseUndispatched(requestId: string) {
    this.db.transaction(() => { const r = this.request(requestId); if (r.state !== 'reserved') return;
      r.state = 'released'; this.save(r); this.db.append(r.companyId,'released_before_dispatch',r.id,this.now(),{}); });
  }
  unknown(requestId: string, reason: 'interrupted' | 'missing_usage' | 'invalid_usage' | 'restart') {
    this.db.transaction(() => { const r = this.request(requestId); if (r.state !== 'dispatched') return;
      r.state = 'unknown'; this.save(r); this.db.append(r.companyId,'usage_unknown',r.id,this.now(),{reason,reservedNanoAud:r.reservedNanoAud}); });
  }
  /** Single-owner startup only. Do not run while another gateway process is streaming.
   * Reserved is provably undispatched; dispatched may have incurred cost and is never retried. */
  recover() {
    for (const row of this.db.all<Body>('SELECT body FROM requests')) {
      const r:RequestRecord = JSON.parse(row.body); if (r.state === 'reserved') this.releaseUndispatched(r.id); else if (r.state === 'dispatched') this.unknown(r.id,'restart');
    }
  }
  settle(requestId: string, provider: string, evidence: UsageEvidence) {
    [provider,evidence.evidenceId,evidence.providerRequestId].forEach(id); validateUnits(evidence.units);
    requireThat(['succeeded','failed','cancelled'].includes(evidence.outcome) && ['final_usage','provider_reconciliation'].includes(evidence.source),'invalid_usage_evidence');
    return this.db.transaction(() => {
      const r = this.request(requestId), hash = digest(evidence); const evidenceKey = `${r.providerNamespace}:${evidence.evidenceId}`;
      requireThat(r.providerId===provider,'provider_route_mismatch',409);
      const previous = this.db.get<{request:string;digest:string}>('SELECT request,digest FROM evidence WHERE id=?',evidenceKey);
      if (previous) { requireThat(previous.request === r.id && previous.digest === hash,'evidence_conflict',409); return r; }
      requireThat(['dispatched','unknown'].includes(r.state),'request_already_final',409);
      requireThat(r.state !== 'unknown' || evidence.source === 'provider_reconciliation','reconciliation_required',409);
      requireThat(withinBound(evidence.units,r.bound) || evidence.source === 'provider_reconciliation','usage_overrun',409);
      const providerKey = `${r.providerNamespace}:${evidence.providerRequestId}`;
      requireThat(!this.db.get('SELECT request FROM provider_requests WHERE id=?',providerKey),'provider_request_reused',409);
      const measured = price(modelRate(this.card(r.rateVersion),r.model),evidence.units);
      // Supplier absorbs provider overruns; customer liability never exceeds the saved authorisation.
      const retail = measured > nano(r.reservedNanoAud) ? nano(r.reservedNanoAud) : measured;
      r.state = 'settled'; r.units = evidence.units; r.retailNanoAud = retail.toString(); r.chargedNanoAud = r.included ? '0' : retail.toString(); r.outcome = evidence.outcome;
      this.save(r); this.db.run('INSERT INTO evidence(id,request,digest) VALUES(?,?,?)',evidenceKey,r.id,hash);
      this.db.run('INSERT INTO provider_requests(id,request) VALUES(?,?)',providerKey,r.id);
      this.db.append(r.companyId,'usage_settled',r.id,this.now(),{period:r.period,model:r.model,rateVersion:r.rateVersion,units:r.units,included:r.included,chargedNanoAud:r.chargedNanoAud,measuredNanoAud:measured.toString(),absorbedNanoAud:(measured-retail).toString(),outcome:r.outcome,evidenceKey,providerRequestId:evidence.providerRequestId});
      return r;
    });
  }
  /** Audited customer credit; never an unapproved debit. Late upward correction is supplier cost.
   * Closed invoices remain immutable; credits flow to the next month or a verified refund. */
  credit(requestId: string, creditId: string, amountNanoAud: string, reason: string) {
    id(creditId); id(reason); const amount = nano(amountNanoAud); requireThat(amount > 0n,'invalid_credit');
    this.db.transaction(() => {
      const r = this.request(requestId); requireThat(r.state === 'settled','unsettled_request',409);
      const key = `credit:${creditId}`; const hash = digest({requestId,amountNanoAud,reason}); const prior = this.db.get<{request:string;digest:string}>('SELECT request,digest FROM evidence WHERE id=?',key);
      if (prior) { requireThat(prior.request === r.id && prior.digest === hash,'credit_conflict',409); return; }
      const credited = this.db.all<Body>("SELECT body FROM events WHERE request=? AND kind='credit'",r.id).reduce((sum,e) => sum + nano(JSON.parse(e.body).amountNanoAud),0n);
      requireThat(credited + amount <= nano(r.chargedNanoAud),'credit_exceeds_charge',409);
      this.db.run('INSERT INTO evidence(id,request,digest) VALUES(?,?,?)',key,r.id,hash);
      this.db.append(r.companyId,'credit',r.id,this.now(),{creditId,reason,period:r.period,amountNanoAud});
    });
  }
  portalUsage(actor: PortalPrincipal) {
    const t = this.tenant(actor.companyId); const period = periodAt(this.now()); const records = this.requests(t.companyId);
    return {companyId:t.companyId,period,currency:'AUD',gstInclusive:true,includedUntil:t.includedUntil,includedRemainingMs:Math.max(0,t.includedUntil-this.now()),monthlyCapNanoAud:t.monthlyCapNanoAud,requestCapNanoAud:t.requestCapNanoAud,maxConcurrent:t.maxConcurrent,committedRetailNanoAud:this.exposure(t.companyId,period).toString(),remainingNanoAud:(nano(t.monthlyCapNanoAud)>this.exposure(t.companyId,period)?nano(t.monthlyCapNanoAud)-this.exposure(t.companyId,period):0n).toString(),acceptances:this.db.all<Body>('SELECT body FROM acceptances WHERE tenant=?',t.companyId).map(r=>JSON.parse(r.body)),requests:records.map(r=>({id:r.id,memberId:r.memberId,model:r.model,rateVersion:r.rateVersion,period:r.period,state:r.state,included:r.included,units:r.units,reservedNanoAud:r.reservedNanoAud,chargedNanoAud:r.chargedNanoAud,createdAt:r.createdAt,outcome:r.outcome}))};
  }
}
