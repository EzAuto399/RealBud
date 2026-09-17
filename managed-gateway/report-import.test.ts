import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture,FIXTURE_TIME } from './testing.ts';
import { ReportImports,type ReportPolicy } from './report-import.ts';
import { SquareBilling } from './square.ts';
import { canonical } from './contracts.ts';
import { DeepSeekBalancePoller } from './deepseek-balance.ts';
function setup(){
  const f=fixture(),imports=new ReportImports(f.ledger);imports.mapKey({id:'mapping-1',provider:'deepseek',keyReference:'key-ref-client-a',companyId:f.tenant.companyId,startsAt:Date.parse('2026-06-01T00:00:00Z'),endsAt:FIXTURE_TIME+86400000,evidence:'fictional-key-mapping'});
  const policy:ReportPolicy={version:'fixture-policy',companyId:f.tenant.companyId,model:f.request.model,acceptedPricingRef:'synthetic-pricing-only',pricing:{kind:'verified_cost',currency:'USD',fxNumerator:'3',fxDenominator:'2',fxSource:'fixture-fx',method:'markup',basisPoints:2000}};imports.recordPolicy(policy);
  const report={schema:'realbud-synthetic-report-v1',provider:'deepseek',sourceReference:'fixture-export',rows:[{keyReference:'key-ref-client-a',model:f.request.model,startsAt:Date.parse('2026-08-01T00:00:00Z'),endsAt:Date.parse('2026-08-02T00:00:00Z'),units:{input_tokens:100,output_tokens:20},cost:{amountNanoCurrency:'1000000000',currency:'USD',basis:'before_gst'}}]};
  const policies={[`${f.tenant.companyId}/${f.request.model}`]:policy.version};return {f,imports,policy,report,policies,raw:()=>JSON.stringify(report)};
}
test('synthetic cost import: review, private margin/FX, single immutable commit, GST-inclusive Square statement',()=>{
  const s=setup();try{const preview=s.imports.preview(s.raw(),s.policies);assert.equal(preview.lines[0].retailNanoAud,'1980000000');assert.equal(preview.lines[0].status,'ready');
    const customer=canonical(s.imports.customerPreview(s.f.owner,preview));for(const forbidden of ['key-ref','cost','fxSource','basisPoints','USD'])assert(!customer.includes(forbidden));
    assert.equal(s.imports.customerPreview({...s.f.owner,companyId:'other'},preview).lines.length,0);
    s.imports.commit(s.raw(),s.policies,preview.previewDigest);const repeat=s.imports.preview(s.raw(),s.policies);assert.equal(s.imports.commit(s.raw(),s.policies,repeat.previewDigest).duplicate,true);
    const square=new SquareBilling({ledger:s.f.ledger,secret:async()=>'none',signatureKey:async()=>'none',notificationUrl:'https://example.invalid/square'});const statement=square.closeStatement(s.f.tenant.companyId,'2026-08','agreed-care');assert.equal(statement.totalCents,12698);assert.equal(statement.lines[0].amountNanoAud,'1980000000');assert.equal(s.f.db.all("SELECT seq FROM events WHERE kind='report_usage_accepted'").length,1);s.f.db.verify();
  }finally{s.f.close();}
});
test('imports reject unknown schemas/secrets, overlapping ranges, changed review and ambiguous key ownership',()=>{
  const s=setup();try{
    assert.throws(()=>s.imports.preview('time,key,tokens\n2026,sk-secret,100',s.policies),/invalid_report/);
    assert.throws(()=>s.imports.preview(JSON.stringify({...s.report,schema:'deepseek-csv-v1'}),s.policies),/unverified_report_schema/);
    s.report.rows[0].keyReference='sk-secret';assert.throws(()=>s.imports.preview(s.raw(),s.policies),/nonsecret_key_reference_required/);s.report.rows[0].keyReference='key-ref-client-a';
    assert.throws(()=>s.imports.mapKey({id:'overlap',provider:'deepseek',keyReference:'key-ref-client-a',companyId:s.f.tenant.companyId,startsAt:Date.parse('2026-08-01T00:00:00Z'),endsAt:FIXTURE_TIME,evidence:'fixture'}),/key_mapping_overlap/);
    const preview=s.imports.preview(s.raw(),s.policies);s.report.rows[0].cost.amountNanoCurrency='2000000000';assert.throws(()=>s.imports.commit(s.raw(),s.policies,preview.previewDigest),/report_preview_changed/);s.report.rows[0].cost.amountNanoCurrency='1000000000';s.imports.commit(s.raw(),s.policies,preview.previewDigest);
    s.report.sourceReference='overlapping-export';const overlap=s.imports.preview(s.raw(),s.policies);assert.equal(overlap.lines[0].status,'overlap');assert.throws(()=>s.imports.commit(s.raw(),s.policies,overlap.previewDigest),/report_review_required/);
  }finally{s.f.close();}
});
test('meter and report totals cannot double-bill a customer month in either direction',()=>{
  const s=setup();try{const row=s.report.rows[0];row.startsAt=FIXTURE_TIME-100;row.endsAt=FIXTURE_TIME;const p=s.imports.preview(s.raw(),s.policies);s.imports.commit(s.raw(),s.policies,p.previewDigest);
    assert.throws(()=>s.f.ledger.reserve(s.f.grant(),'fixture-host-key','fp','idem',s.f.provider.bound(s.f.request)),/billing_source_conflict/);
  }finally{s.f.close();}
  const t=setup();try{t.f.ledger.reserve(t.f.grant(),'fixture-host-key','fp','idem',t.f.provider.bound(t.f.request));t.report.rows[0].startsAt=FIXTURE_TIME-100;t.report.rows[0].endsAt=FIXTURE_TIME;const p=t.imports.preview(t.raw(),t.policies);assert.equal(p.lines[0].status,'meter_reconciliation_required');assert.throws(()=>t.imports.commit(t.raw(),t.policies,p.previewDigest),/report_review_required/);assert.equal(t.f.db.all('SELECT * FROM report_imports').length,0);}finally{t.f.close();}
});
test('usage-only imports need accepted unit rates; included usage zeroes the customer charge',()=>{
  const s=setup();try{const policy:ReportPolicy={...s.policy,version:'unit-policy',pricing:{kind:'accepted_unit_rates',rateVersion:s.f.card.version}};s.imports.recordPolicy(policy);const report={...s.report,rows:[{...s.report.rows[0],cost:undefined,startsAt:Date.parse('2026-07-01T00:00:00Z'),endsAt:Date.parse('2026-07-02T00:00:00Z')}]};
    assert.throws(()=>s.imports.preview(JSON.stringify(report),s.policies),/verified_cost_required/);const p=s.imports.preview(JSON.stringify(report),{...s.policies,[`${s.f.tenant.companyId}/${s.f.request.model}`]:policy.version});assert.equal(p.lines[0].retailNanoAud,'140000000');assert.equal(p.lines[0].chargedNanoAud,'0');
  }finally{s.f.close();}
});
test('balance polling stays disabled without transport, coalesces calls, shows stale errors and bounded backoff',async()=>{
  let time=FIXTURE_TIME,secrets=0,calls=0,fail=false;
  const disabled=new DeepSeekBalancePoller({secret:async()=>{secrets++;return 'secret';}});assert.equal((await disabled.poll()).configured,false);assert.equal(secrets,0);
  const poller=new DeepSeekBalancePoller({now:()=>time,secret:async()=>{secrets++;return 'fixture-secret';},fetch:(async(url,init)=>{calls++;assert.equal(String(url),'https://api.deepseek.com/user/balance');assert.equal(init?.method,'GET');if(fail)return new Response('PRIVATE UPSTREAM ERROR',{status:500});return Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'110.00',granted_balance:'10.00',topped_up_balance:'100.00'}]});}) as typeof fetch});
  const [first,parallel]=await Promise.all([poller.poll(),poller.poll()]);assert.equal(calls,1);assert.deepEqual(first,parallel);assert.equal(first.lastUpdatedAt,time);assert.equal(first.stale,false);assert.equal(first.perClientHistory,'unsupported_unconfigured');
  await poller.poll();assert.equal(calls,1);time+=120000;assert.equal(poller.status().stale,true);fail=true;const failed=await poller.poll();assert.equal(failed.error,'balance_sync_failed');assert.equal(failed.snapshot!.balances[0].total,'110.00');assert(!canonical(failed).includes('PRIVATE'));assert.equal(failed.nextAttemptAt,time+60000);
  for(let n=0;n<8;n++){time=poller.status().nextAttemptAt;await poller.poll();}assert.equal(poller.status().nextAttemptAt-time,600000);fail=false;time=poller.status().nextAttemptAt;assert.equal((await poller.poll()).stale,false);assert.equal(poller.status().consecutiveFailures,0);
});
