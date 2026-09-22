import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkflowDatabase} from './workflow-database.ts';
import {BankReferenceStore,type SavedBankBatch} from './bank-reference-store.ts';
import {bankDigest,createBankReferenceBatch,reviewBankReferences,type BankReferenceUpload} from './bank-reference.ts';
import {validateBankReviewLinks} from './bank-reference-validation.ts';

const fixtures:{dir:string;db:WorkflowDatabase[]}[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const f of fixtures.splice(0)){for(const db of f.db)db.close();rmSync(f.dir,{recursive:true,force:true});}});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'bank-amend-')),key=Buffer.alloc(32,38),db=new WorkflowDatabase({dir,key}),f={dir,db:[db]};fixtures.push(f);
  return {dir,db,bank:new BankReferenceStore(db),reopen:()=>{const another=new WorkflowDatabase({dir,key});f.db.push(another);return new BankReferenceStore(another);}};}
const input=():BankReferenceUpload=>({source:{filename:'Fictional original.csv',bytesBase64:Buffer.from('\uFEFFDate,Amount,Narrative,Reference,Extra\r\n2026-09-21,500.00,"Fictional café 🏡","old",保留\n2026-09-21,-1.00,Fee,,保留\r\n').toString('base64')},
  columns:{date:'Date',amount:'Amount',narrative:'Narrative',reference:'Reference'},dateFormat:'YYYY-MM-DD',rules:[{propertyId:'Unit 1',reference:'00127',aliases:['Fictional']}]});
const decisions=(value:SavedBankBatch)=>value.batch.rows.map((row,index)=>({rowId:row.id,action:index?'keep' as const:'assign' as const,...(!index?{propertyId:'Unit 1'}:{}),reason:index?'Fee retained unchanged.':'Fictional directory checked.'}));
const amendment=(revision:number,reference='00234')=>{const {source:_,...mapping}=input();mapping.rules[0].reference=reference;return {revision,mapping,reason:'Corrected reference from confirmed property directory.'};};

describe('bank correction review versions',()=>{
  it('keeps both exact artifacts and every decision, preserves captured source, and reconciles retries after restart',()=>{
    const f=fixture(),first=f.bank.create(input()),reviewed=f.bank.review(first.id,first.revision,decisions(first.value));
    const original=f.bank.export(first.id,true),old=f.bank.export(first.id),request=amendment(reviewed.revision);
    const amended=f.bank.amend(first.id,request);
    expect(amended.id).toBe(`${first.id}:r2`);expect(amended.value.result).toBeUndefined();expect(amended.value.decisions).toBeUndefined();
    expect(f.bank.export(first.id)).toEqual(old);expect(f.bank.export(amended.id,true)).toEqual(original);
    expect(f.bank.get(first.id).value.decisions).toEqual(decisions(first.value));
    expect(()=>f.bank.export(amended.id)).toThrow(/Review every/);
    expect(()=>f.bank.review(first.id,f.bank.get(first.id).revision,decisions(first.value))).toThrow(/changed/);
    const corrected=f.bank.review(amended.id,amended.revision,decisions(amended.value)),out=f.bank.export(amended.id);
    expect(Buffer.from(out.bytesBase64,'base64')).toEqual(Buffer.from(Buffer.from(original.bytesBase64,'base64').toString().replace('"old"','"00234"')));
    const reopened=f.reopen();expect(reopened.get(corrected.id)).toEqual(corrected);expect(reopened.amend(first.id,request)).toEqual(corrected);
    expect(reopened.export(first.id)).toEqual(old);expect(reopened.export(corrected.id,true)).toEqual(original);
  });

  it('reopens exact old and corrected reference-only outputs, with retry recovery after a later correction',()=>{
    const f=fixture(),row=f.bank.create(input()),first=f.bank.review(row.id,row.revision,decisions(row.value)),old=f.bank.export(row.id);
    const request=amendment(first.revision),draft=f.bank.amend(row.id,request),second=f.bank.review(draft.id,draft.revision,decisions(draft.value));
    const output=f.bank.export(second.id),original=f.bank.export(row.id,true);
    expect(Buffer.from(output.bytesBase64,'base64').toString()).toBe(Buffer.from(input().source.bytesBase64,'base64').toString().replace('"old"','"00234"'));
    const third=f.bank.amend(second.id,amendment(second.revision,'00345'));
    const reopened=f.reopen();expect(reopened.amend(row.id,request)).toEqual(reopened.get(second.id));
    expect(reopened.export(row.id)).toEqual(old);expect(reopened.export(second.id)).toEqual(output);expect(reopened.export(third.id,true)).toEqual(original);
    expect(reopened.list()).toHaveLength(3);expect(reopened.settings()?.rules[0].reference).toBe('00345');
    expect(readFileSync(join(f.dir,'workflow-state.sqlite')).includes(Buffer.from('Fictional café'))).toBe(false);
    expect(()=>reopened.amend(row.id,{...request,reason:'A different attempt'})).toThrow(/changed/);
    expect(()=>reopened.amend(third.id,amendment(third.revision+1))).toThrow(/changed/);
  });

  it('permits corrected decisions with an unchanged mapping and abandons only the earlier unfinished review',()=>{
    const f=fixture(),row=f.bank.create(input()),amended=f.bank.amend(row.id,amendment(row.revision,'00127'));
    expect(amended.value.batch).toEqual(row.value.batch);expect(()=>f.bank.review(row.id,2,decisions(row.value))).toThrow(/changed/);
    const kept=amended.value.batch.rows.map(row=>({rowId:row.id,action:'keep' as const,reason:'Confirmed existing source reference.'}));
    f.bank.review(amended.id,amended.revision,kept);expect(f.bank.export(amended.id).bytesBase64).toBe(input().source.bytesBase64);
  });

  it('rolls back the new version if linking its predecessor fails',()=>{
    const f=fixture(),row=f.bank.create(input());vi.spyOn(f.db,'update').mockImplementationOnce(()=>{throw Object.assign(new Error('Synthetic failure before parent commit'),{status:503});});
    expect(()=>f.bank.amend(row.id,amendment(row.revision))).toThrow(/Synthetic/);expect(f.db.count('bank')).toBe(1);expect(f.bank.get(row.id)).toEqual(row);
    expect(f.bank.amend(row.id,amendment(row.revision)).id).toBe(`${row.id}:r2`);
  });

  it.each([{reason:''},{revision:0},{source:input().source},{mapping:{...amendment(1).mapping,csv:'replacement bytes'}}])('rejects malformed/source-replacing amendment %j without writes',patch=>{
    const f=fixture(),row=f.bank.create(input());expect(()=>f.bank.amend(row.id,{...amendment(row.revision),...patch})).toThrow();expect(f.db.count('bank')).toBe(1);expect(f.bank.get(row.id)).toEqual(row);
  });

  it('retains legacy quote-removing prepared bytes and never upgrades reconstructed text into captured bytes',()=>{
    const f=fixture(),{source,...mapping}=input(),batch=createBankReferenceBatch({...mapping,csv:Buffer.from(source.bytesBase64,'base64').toString()}),value:SavedBankBatch={version:1,createdAt:1,batch};
    const output=reviewBankReferences(batch,decisions(value)),csv=output.csv.replace('"00127"','00127');
    const row=f.db.create('bank',`bank:${batch.originalDigest}`,{...value,result:{csv,changes:output.changes,originalDigest:output.originalDigest,outputDigest:bankDigest(csv)}});
    const old=f.bank.export(row.id),next=f.bank.amend(row.id,amendment(row.revision));
    expect(f.bank.export(row.id)).toEqual(old);expect(f.bank.export(next.id,true).originalBytesCaptured).toBe(false);expect(next.value.batch.version).toBe(1);
    expect(f.bank.get(row.id).value.legacyDecisionsUnavailable).toBe(true);
  });

  it('holds a new reviewed record with missing complete decisions rather than treating it as historical',()=>{
    const f=fixture(),row=f.bank.create(input()),saved=f.bank.review(row.id,row.revision,decisions(row.value));
    const broken=f.db.update<SavedBankBatch>('bank',row.id,saved.revision,value=>{delete value.decisions;return value;});
    expect(()=>f.bank.export(row.id)).toThrow(/integrity/);expect(f.db.get('bank',row.id)).toEqual(broken);
  });

  it('holds detached or tampered history through reads, reviews and shared backup validation without overwriting it',()=>{
    const f=fixture(),row=f.bank.create(input()),next=f.bank.amend(row.id,amendment(row.revision));
    expect(()=>validateBankReviewLinks(next,()=>undefined)).toThrow(/integrity/);
    const changed=f.db.update<SavedBankBatch>('bank',next.id,next.revision,value=>({...value,amends:{...value.amends!,reason:'Tampered reason'}}));
    for(const action of [()=>f.bank.get(row.id),()=>f.bank.get(next.id),()=>f.bank.review(next.id,changed.revision,decisions(next.value)),()=>f.bank.amend(next.id,amendment(changed.revision)),()=>f.bank.page()])expect(action).toThrow(/integrity/);
    expect(f.db.get('bank',next.id)).toEqual(changed);
  });
});
