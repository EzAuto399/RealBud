import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, FIXTURE_TIME } from './testing.ts';
import { LedgerDatabase } from './database.ts';
import { UsageLedger, digest } from './ledger.ts';
import { cents, gstCents, modelRate, periodAt, price, retailProposal, twoMonthsAfter, validateRateCard } from './money.ts';
import type { ExecutionGrant } from './contracts.ts';

const cleanups:(()=>void)[]=[];
function setup(path?:string) { const f=fixture(path); cleanups.push(f.close); return f; }
afterEach(()=>{while(cleanups.length)cleanups.pop()!();});
test('exact decimal metering separates cached input and reasoning-inclusive output',()=>{
  const f=setup(); assert.equal(price(modelRate(f.card,'fixture-text'),f.evidence().units),19_250_000n);
  assert.equal(cents(19_250_000n),2n); assert.equal(gstCents(12500n),1136n);
  assert.throws(()=>price(modelRate(f.card,'fixture-text'),{tool_calls:1}),/unpriced_unit/);
  assert.throws(()=>price(modelRate(f.card,'fixture-text'),{input_tokens:-1}),/invalid_integer/);
});
test('rate cards cannot silently omit tax or mutate published amounts',()=>{
  const f=setup(); assert.throws(()=>validateRateCard({...f.card,gstInclusive:false} as never),/invalid_tax_currency/);
  assert.throws(()=>f.ledger.publishCard({...f.card,models:[]}),/invalid_rate_card/);
  assert.throws(()=>f.db.run("UPDATE cards SET body='{}'"),/immutable_record/);
  assert.throws(()=>f.ledger.publishCard(f.card),/UNIQUE/);
});
test('customer rate acceptance is tenant scoped, owner-only and digest-bound',()=>{
  const f=setup(); const second={...f.card,version:'fixture-r2'}; f.ledger.publishCard(second);
  assert.throws(()=>f.ledger.acceptCard({...f.owner,role:'billing_reader'},second.version,digest(second)),/forbidden/);
  assert.throws(()=>f.ledger.acceptCard(f.owner,second.version,'bad'),/rate_card_changed/);
  assert.throws(()=>f.ledger.reserve(f.grant({...f.request,rateVersion:second.version}),'fixture-host-key','fp','idem',{input_tokens:1}),/rates_not_accepted/);
  f.ledger.acceptCard(f.owner,second.version,digest(second)); assert.equal(f.db.all('SELECT * FROM acceptances').length,2);
});
test('private margin and FX helper requires explicit inputs and does not publish',()=>{
  const f=setup(); assert.equal(retailProposal({costNano:'1000000000',fxNumerator:'3',fxDenominator:'2',method:'markup',basisPoints:2000}),'1980000000');
  assert.equal(retailProposal({costNano:'1000000000',fxNumerator:'3',fxDenominator:'2',method:'margin',basisPoints:2000}),'2062500000');
  assert.throws(()=>retailProposal({costNano:'1',fxNumerator:'1',fxDenominator:'0',method:'margin',basisPoints:2000}),/invalid_fx/);
  assert.throws(()=>retailProposal({costNano:'1',fxNumerator:'1',fxDenominator:'1',method:'margin',basisPoints:10000}),/invalid_margin/);
  assert.equal(f.ledger.cards().length,1);
});
test('two included months are anchored to accepted go-live and Brisbane civil dates',()=>{
  assert.equal(new Date(twoMonthsAfter(Date.parse('2026-12-31T01:00:00Z'))).toISOString(),'2027-02-28T01:00:00.000Z');
  assert.equal(periodAt(Date.parse('2026-09-30T13:59:59Z')),'2026-09'); assert.equal(periodAt(Date.parse('2026-09-30T14:00:00Z')),'2026-10');
  const f=setup(); f.setTime(f.tenant.goLiveAt+1);
  const card={...f.card,version:'included-fixture',publishedAt:f.tenant.goLiveAt,effectiveAt:f.tenant.goLiveAt}; f.ledger.publishCard(card); f.ledger.acceptCard(f.owner,card.version,digest(card));
  const grant=f.grant({...f.request,rateVersion:card.version}); const record=f.ledger.reserve(grant,'fixture-host-key','fp','i',{input_tokens:20}).record;
  assert.equal(record.included,true); f.ledger.dispatch(record.id,grant,f.provider.id); const settled=f.ledger.settle(record.id,f.provider.id,f.evidence({units:{input_tokens:10}})); assert.equal(settled.chargedNanoAud,'0');
});
test('concurrent reservations cannot exceed cap, including unknown prior-month exposure',()=>{
  const f=setup(); f.ledger.setCaps(f.owner,{monthlyCapNanoAud:'200000000',requestCapNanoAud:'200000000',maxConcurrent:4});
  const bound=f.provider.bound(f.request); const first=f.ledger.reserve(f.grant(),'fixture-host-key','fp','one',bound).record;
  const next=f.grant(f.request,{jti:'grant-two',attemptId:'attempt-two'});
  assert.throws(()=>f.ledger.reserve(next,'fixture-host-key','fp2','two',bound),/monthly_cap_exceeded/);
  f.ledger.dispatch(first.id,f.grant(),f.provider.id); f.ledger.unknown(first.id,'interrupted'); f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  assert.throws(()=>f.ledger.reserve(f.grant(f.request,{jti:'grant-two',attemptId:'attempt-two'}),'fixture-host-key','fp2','two',bound),/monthly_cap_exceeded/);
  assert.equal(f.ledger.exposure('company-a','2026-10'),165_000_000n);
});
test('idempotency rejects changed bodies, member crossover, jti and attempt reuse',()=>{
  const f=setup(); const g=f.grant(); const r=f.ledger.reserve(g,'fixture-host-key','fp','idem',{input_tokens:1});
  assert.equal(f.ledger.reserve(g,'fixture-host-key','fp','idem',{input_tokens:1}).record.id,r.record.id);
  assert.throws(()=>f.ledger.reserve(g,'fixture-host-key','different','idem',{input_tokens:1}),/idempotency_conflict/);
  assert.throws(()=>f.ledger.reserve({...g,memberId:'member-b'},'fixture-host-key','fp','idem',{input_tokens:1}),/attempt_already_reserved/);
  assert.throws(()=>f.ledger.reserve({...g,jti:'new-jti'},'fixture-host-key','fp','new-key',{input_tokens:1}),/attempt_already_reserved/);
});
test('dispatch claims are once-only and undispatched release never erases uncertain cost',()=>{
  const f=setup(); const g=f.grant(),r=f.ledger.reserve(g,'fixture-host-key','fp','idem',f.provider.bound(f.request)).record;
  f.ledger.dispatch(r.id,g,f.provider.id); assert.throws(()=>f.ledger.dispatch(r.id,g,f.provider.id),/dispatch_already_claimed/);
  f.ledger.releaseUndispatched(r.id); assert.equal(f.ledger.request(r.id).state,'dispatched');
  f.ledger.unknown(r.id,'interrupted'); assert.equal(f.ledger.request(r.id).state,'unknown');
});
test('unknown usage requires independent reconciliation; zero confirmed usage costs zero',()=>{
  const f=setup(); const g=f.grant(),r=f.ledger.reserve(g,'fixture-host-key','fp','idem',f.provider.bound(f.request)).record;
  f.ledger.dispatch(r.id,g,f.provider.id); f.ledger.unknown(r.id,'missing_usage');
  assert.throws(()=>f.ledger.settle(r.id,f.provider.id,f.evidence()),/reconciliation_required/);
  const result=f.ledger.settle(r.id,f.provider.id,f.evidence({source:'provider_reconciliation',outcome:'failed',units:{input_tokens:0,cache_read_tokens:0,output_tokens:0}}));
  assert.equal(result.chargedNanoAud,'0'); assert.equal(f.ledger.exposure('company-a','2026-09'),0n);
});
test('late provider overruns are audited and absorbed above the customer authorisation',()=>{
  const f=setup(); const g=f.grant(),r=f.ledger.reserve(g,'fixture-host-key','fp','idem',{input_tokens:20}).record;
  f.ledger.dispatch(r.id,g,f.provider.id);
  assert.throws(()=>f.ledger.settle(r.id,f.provider.id,f.evidence({units:{input_tokens:100}})),/usage_overrun/);
  f.ledger.unknown(r.id,'invalid_usage'); const result=f.ledger.settle(r.id,f.provider.id,f.evidence({source:'provider_reconciliation',units:{input_tokens:100}}));
  assert.equal(result.chargedNanoAud,'20000000'); const e=f.db.get<{body:string}>("SELECT body FROM events WHERE kind='usage_settled'")!;
  assert.equal(JSON.parse(e.body).absorbedNanoAud,'80000000');
});
test('evidence is immutable/idempotent and provider request IDs cannot bill two tenants',()=>{
  const f=setup(); const first=f.ledger.reserve(f.grant(),'fixture-host-key','fp','idem',f.provider.bound(f.request)).record;
  f.ledger.dispatch(first.id,f.grant(),f.provider.id); f.ledger.settle(first.id,f.provider.id,f.evidence()); f.ledger.settle(first.id,f.provider.id,f.evidence());
  assert.equal(f.db.all("SELECT * FROM events WHERE kind='usage_settled'").length,1);
  assert.throws(()=>f.ledger.settle(first.id,f.provider.id,f.evidence({units:{input_tokens:1}})),/evidence_conflict/);
  const g=f.grant(f.request,{jti:'j2',attemptId:'a2'}); const r=f.ledger.reserve(g,'fixture-host-key','fp2','idem2',f.provider.bound(f.request)).record; f.ledger.dispatch(r.id,g,f.provider.id);
  assert.throws(()=>f.ledger.settle(r.id,f.provider.id,f.evidence({evidenceId:'new'})),/provider_request_reused/);
});
test('credits cannot exceed settled charges or mutate prior ledger events',async()=>{
  const f=setup(); await f.run(); const r=f.ledger.requests('company-a')[0];
  f.ledger.credit(r.id,'credit-1','10000000','service-credit'); f.ledger.credit(r.id,'credit-1','10000000','service-credit');
  assert.throws(()=>f.ledger.credit(r.id,'credit-2','10000000','service-credit'),/credit_exceeds_charge/);
  assert.throws(()=>f.ledger.credit(r.id,'credit-1','1','service-credit'),/credit_conflict/);
  assert.throws(()=>f.db.run('DELETE FROM events'),/immutable_record/); f.db.verify();
});
test('restart preserves reservations and history without retaining prompt text',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'realbud-ledger-')); cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'gateway.sqlite'); const f=fixture(path);
  const r=f.ledger.reserve(f.grant(),'fixture-host-key','opaque-hmac','idem',f.provider.bound(f.request)).record; f.ledger.dispatch(r.id,f.grant(),f.provider.id); f.close();
  const db=new LedgerDatabase(path); cleanups.push(()=>db.close()); const ledger=new UsageLedger(db,()=>FIXTURE_TIME); ledger.recover();
  assert.equal(ledger.request(r.id).state,'unknown'); assert.equal(ledger.exposure('company-a','2026-09'),165000000n);
  assert.equal(readFileSync(path).includes(Buffer.from(f.request.messages[0].content!)),false);
});
test('monthly rounding preserves total cents and fractional caps never permit excess',()=>{
  for(let cap=0n;cap<100n;cap++) { for(let residual=0n;residual<10n;residual++) { const committed=cap*10000000n-residual; if(committed>=0n) assert(cents(committed)<=cap); } }
});
test('lowered caps and revoked entitlements block admission without deleting history',()=>{
  const f=setup(), g=f.grant(); f.ledger.reserve(g,'fixture-host-key','fp','idem',f.provider.bound(f.request));
  assert.throws(()=>f.ledger.setCaps(f.owner,{monthlyCapNanoAud:'10000000',requestCapNanoAud:'10000000',maxConcurrent:1}),/cap_below_committed_spend/);
  f.ledger.setService('company-a',false,FIXTURE_TIME+10000,'suspension-fixture');
  assert.throws(()=>f.ledger.reserve({...g,jti:'2',attemptId:'2'} as ExecutionGrant,'fixture-host-key','fp2','idem2',{input_tokens:1}),/service_unavailable/);
  assert.equal(f.ledger.requests('company-a').length,1);
});
test('foreign databases and unknown schema versions are rejected without migration',()=>{
  const dir=mkdtempSync(join(tmpdir(),'realbud-foreign-db-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'office.sqlite');const foreign=new DatabaseSync(path);foreign.exec("CREATE TABLE office_record(value TEXT); INSERT INTO office_record VALUES('preserve me');");foreign.close();
  assert.throws(()=>new LedgerDatabase(path),/foreign_or_unsupported_database/);
  const verify=new DatabaseSync(path);try{assert.equal(verify.prepare('SELECT value FROM office_record').get()!.value,'preserve me');assert.equal(verify.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='events'").get()!.n,0);}finally{verify.close();}
  const ownPath=join(dir,'gateway.sqlite');const own=new LedgerDatabase(ownPath);own.sql.exec('PRAGMA user_version=99');own.close();assert.throws(()=>new LedgerDatabase(ownPath),/foreign_or_unsupported_database/);
});
test('tampered ledger history fails startup verification',()=>{
  const dir=mkdtempSync(join(tmpdir(),'realbud-corrupt-ledger-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'ledger.sqlite');
  const f=fixture(path);f.close();const corrupt=new DatabaseSync(path);corrupt.exec("DROP TRIGGER immutable_events_UPDATE; UPDATE events SET hash='tampered' WHERE seq=1");corrupt.close();
  assert.throws(()=>new LedgerDatabase(path),/ledger_integrity_failure/);
});
test('a provider request cannot be rebilled through a different model route',async()=>{
  const f=setup();await f.run();const g=f.grant(f.request,{jti:'cross-route',attemptId:'cross-route'});
  const r=f.ledger.reserve(g,'fixture-host-key','fp2','route-two',f.provider.bound(f.request)).record;
  f.ledger.dispatch(r.id,g,'different-model-route',f.provider.usageNamespace);
  assert.throws(()=>f.ledger.settle(r.id,'different-model-route',f.evidence({evidenceId:'different-evidence'})),/provider_request_reused/);
});
