import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowDatabase } from './workflow-database.ts';
import { SourceBillRegister, previewBillSource } from './source-bills.ts';
import type { BillMailSource } from '../shared/source-bills.ts';
import type { ExpectedBill } from './expected-bills.ts';
import { expectedBillsPage } from './expected-bills-page.ts';

const resources: { dir: string; db: WorkflowDatabase }[] = [];
afterEach(() => { for (const {dir,db} of resources.splice(0)) { db.close(); rmSync(dir,{recursive:true,force:true}); } });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'rb-bill-page-')), db = new WorkflowDatabase({dir,key:Buffer.alloc(32,11)});
  resources.push({dir,db});
  let now = Date.parse('2026-09-21T01:00:00Z'), ordinal = 0;
  const store = new SourceBillRegister(db,{dataDir:dir,now:()=>now});
  const add = (propertyId = 'one', note = '', kind = 'Water') => {
    const source: BillMailSource = {accountId:'mail',receiptId:'synthetic',threadId:(++ordinal).toString(16),message:{id:ordinal.toString(16),at:now-1,
      from:'billing@example.test',subject:'Fictional invoice',body:'Private body excluded from summary.',attachments:[]}};
    return store.accept({sourceReviewed:true,expectedSourceDigest:previewBillSource(source).digest,facts:{propertyId,kind,vendor:'Fictional utility',amountCents:null,currency:'AUD',invoiceDate:null,dueDate:null,note},reviewReason:'Reviewed synthetic source.'},source,'local');
  };
  const legacy: ExpectedBill[] = [{id:'legacy-one',propertyId:'one',kind:'Council',status:'hold',windowStartAt:null,windowEndAt:null,amountCents:null,note:'Check reference',sourceRef:null,createdAt:now-100,updatedAt:now-100}];
  const page = (query = '') => expectedBillsPage(new URLSearchParams(query),()=>structuredClone(legacy),()=>store);
  return {dir,store,legacy,add,page,advance:()=>now++};
}

describe('bounded expected bills projections',()=>{
  it('reports complete matching counts and only current-page groups, without source bodies or old full readers',()=>{
    const f=fixture(); f.add('one','Review wording'); f.add('two','Review wording'); f.add('one','Other wording');
    vi.spyOn(f.store,'snapshot').mockImplementation(()=>{throw new Error('No full snapshot');});
    vi.spyOn(f.store,'expectedRows').mockImplementation(()=>{throw new Error('No full rows');});
    expect(f.page('limit=1')).toMatchObject({version:2,total:4,counts:{legacy:1,source:3},bills:expect.any(Array),nextCursor:expect.any(String)});
    const filtered=f.page('propertyId=one&group=due-soon&query=review&limit=1');
    expect(filtered.total).toBe(1); expect(filtered.bills).toHaveLength(1); expect(filtered.groups['due-soon']).toEqual(filtered.bills);
    expect(filtered.groups['needs-you']).toEqual([]); expect(JSON.stringify(filtered)).not.toContain('Private body');
    expect(f.page('group=needs-you')).toMatchObject({total:1,counts:{legacy:1,source:0}});
    expect(f.page('origin=source')).toMatchObject({total:3,counts:{legacy:0,source:3}});
  });

  it('keeps insertion snapshots stable while new bills arrive and permits a different page size',()=>{
    const f=fixture(); const old=[];
    for(let i=0;i<6;i++){old.push(f.add());f.advance();}
    const first=f.page('origin=source&limit=2');
    const added=f.add();
    let cursor=first.nextCursor, ids=first.bills.map(row=>row.id);
    while(cursor){const next=f.page(`origin=source&limit=1&cursor=${cursor}`); expect(next.total).toBe(6); ids.push(...next.bills.map(row=>row.id));cursor=next.nextCursor;}
    expect(new Set(ids)).toEqual(new Set(old.map(row=>row.id)));expect(ids).not.toContain(added.id);expect(ids).toHaveLength(6);
    expect(f.page('origin=source').total).toBe(7);
  });

  it('rejects cross-view, changed legacy, malformed and duplicated cursor options without erasing records',()=>{
    const f=fixture();f.add();f.add();
    const cursor=f.page('limit=1').nextCursor!;
    for(const change of ['origin=source','propertyId=one','group=due-soon','query=water']) expect(()=>f.page(`${change}&cursor=${cursor}`)).toThrow(/Refresh/);
    for(const query of ['cursor=bad','limit=101','limit=0','limit=1&limit=2','propertyId=','query=%00','group=all','origin=unknown','extra=1']) expect(()=>f.page(query)).toThrow();
    f.legacy[0].note='Changed elsewhere';expect(()=>f.page(`cursor=${cursor}`)).toThrow(/Refresh/);
    expect(f.page().total).toBe(3);
  });

  it('allows the legacy-only view independently of a held source register',()=>{
    const f=fixture();const source=vi.fn(()=>{throw new Error('Source register needs recovery');});
    expect(expectedBillsPage(new URLSearchParams('origin=legacy'),()=>f.legacy,source)).toMatchObject({total:1,counts:{legacy:1,source:0},nextCursor:null});
    expect(source).not.toHaveBeenCalled();
  });

  it('bounds cursors without introducing an incompatible length limit for existing legacy IDs',()=>{
    const f=fixture();f.legacy[0].id='old-office-label-'.repeat(1000);f.legacy[0].createdAt+=0.5;f.legacy.push({...f.legacy[0],id:'second',createdAt:f.legacy[0].createdAt-1});
    const first=f.page('origin=legacy&limit=1');expect(first.bills[0].id).toBe(f.legacy[0].id);
    expect(first.nextCursor!.length).toBeLessThan(1000);
    expect(f.page(`origin=legacy&cursor=${first.nextCursor}`).bills.map(row=>row.id)).toEqual(['second']);
  });

  it('continues through an empty filtered physical page instead of reporting false absence',()=>{
    const f=fixture();const saved=f.add('historical-property','Needle');
    for(let i=0;i<105;i++) f.add('other-property');
    const page=f.page('origin=source&propertyId=historical-property&query=Needle');
    expect(page.total).toBe(1); expect(page.bills.map(row=>row.id)).toEqual([saved.id]);expect(page.nextCursor).toBeNull();
  });

  it('shows current corrections without reintroducing already returned immutable ordering keys',()=>{
    const f=fixture();const saved=f.add();f.advance();f.add();f.advance();f.add();
    const first=f.page('origin=source&limit=1');
    f.store.correct(saved.id,{expectedRevision:saved.revision,expectedSourceDigest:saved.source.digest,sourceReviewed:true,
      facts:{...saved.facts,note:'Corrected after first page'},state:'hold',reviewReason:'Corrected synthetic bill.'},saved.source,'local');
    const second=f.page(`origin=source&limit=100&cursor=${first.nextCursor}`);
    expect(second.bills.some(row=>row.id===first.bills[0].id)).toBe(false);
    expect(second.bills.find(row=>row.id===saved.id)).toMatchObject({note:'Corrected after first page',status:'hold',revision:2});
    expect(second.revision).not.toBe(first.revision);
  });

  it('refuses a mixed-time summary when another database handle commits between bounded page reads',()=>{
    const f=fixture(), original=f.add();
    for(let i=0;i<100;i++) f.add();
    const otherDb=new WorkflowDatabase({dir:f.dir,key:Buffer.alloc(32,11)}),other=new SourceBillRegister(otherDb,{dataDir:f.dir});
    const read=f.store.occurrencePage.bind(f.store);let changed=false;
    const page=vi.spyOn(f.store,'occurrencePage').mockImplementation(query=>{
      const result=read(query);
      if(!changed){changed=true;other.correct(original.id,{expectedRevision:1,sourceReviewed:true,expectedSourceDigest:original.source.digest,
        facts:{...original.facts,note:'External correction'},state:'hold',reviewReason:'Reviewed on the other handle.'},original.source,'local');}
      return result;
    });
    try {
      expect(()=>f.page()).toThrow(expect.objectContaining({status:409}));
      page.mockRestore();
      expect(f.page('query=External+correction')).toMatchObject({total:1,bills:[{id:original.id,note:'External correction',revision:2}]});
    } finally {otherDb.close();}
  });
});
