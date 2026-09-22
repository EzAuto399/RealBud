import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync, writeFileSync, linkSync } from 'node:fs';
import { plantPrivateFile, privateTempRoot, removeFixture, windowsAdmissionTimeout } from './testing/private-fixture.ts';
import type { CustomerPack, CustomerPackArchivePreview, CustomerPackChangePreview, CustomerPackInstallation } from '../shared/customer-packs.ts';
const control=vi.hoisted(()=>{const root=`${process.env.TMPDIR ?? '/tmp'}/rb-pack-archive-recipes-${process.pid}-${Date.now()}`;process.env.REALBUD_DATA_DIR=root;return {root,fault:undefined as undefined|((path:string,value:any,stage:'before'|'after')=>void)};});
vi.mock('./private-json.ts',async importOriginal=>{const original=await importOriginal<typeof import('./private-json.ts')>();return {...original,
  writePrivateJson:async(path:string,value:unknown)=>{control.fault?.(path,value,'before');await original.writePrivateJson(path,value);control.fault?.(path,value,'after');}};});
const {createCustomerPackService,validateCustomerPackArchiveSet,validateCustomerPackHistoryArchive}=await import('./customer-packs.ts');
const {loadRecipes}=await import('./recipes.ts');
const roots:string[]=[];
beforeEach(async()=>{await mkdir(control.root,{recursive:true});await rm(join(control.root,'recipes.json'),{force:true});});
afterEach(async()=>{control.fault=undefined;for(const root of roots.splice(0))await removeFixture(root);});
afterAll(async()=>{await rm(control.root,{recursive:true,force:true});});
const pack=():CustomerPack=>({format:'realbud-customer-pack',version:1,id:'fixture-office',revision:1,title:'Fictional office',
  recipes:[{id:'wf-fixture-inbox',title:'Review inbox',description:'Published description 1.',steps:['Read the supplied fictional sources.'],evidence:'Source references.',capabilities:['read-files','analyse','draft'],limits:{maxRuntimeMinutes:2,maxTurns:6},siteNotes:null,schedule:null,allowedOrigins:[]}],
  workflows:[{id:'inbox',title:'Review supplied inbox',recipeIds:['wf-fixture-inbox'],checks:['input-coverage']}],
  skills:[{id:'fixture-guidance',name:'Fictional guidance',description:'Review fictional supplied sources.',instructions:'# Fictional guidance\nRead the source first.\n',license:'Fictional test license.'}],
  dependencies:{runtime:'hermes-property',mode:'supplied-source-preparation',schedules:'off',permissions:'local-review-required'}});
const changeRequest=(p:CustomerPackChangePreview)=>({pack:p.pack,expectedInstalledDigest:p.installedDigest,expectedInstalledRevision:p.installedRevision,expectedDigest:p.digest,expectedPreviewDigest:p.previewDigest});
const archiveRequest=(p:CustomerPackArchivePreview)=>({expectedInstalledDigest:p.installedDigest,expectedInstalledRevision:p.installedRevision,expectedPreviewDigest:p.previewDigest});
async function fixture(initial=pack()) {
  const root=privateTempRoot(join(realpathSync(tmpdir()),'rb-pack-archive-'));roots.push(root);
  const options={directory:root,profileDirectory:()=>join(root,'profile'),workroomDirectory:()=>join(root,'vault')};
  const service=createCustomerPackService(options),preview=await service.preview(initial);await service.install(initial,preview.digest);
  let current=initial;
  const route=(action:string)=>`/api/customer-packs/${initial.id}/${action}`;
  const upgrade=async(revision:number)=>{current=structuredClone(current);current.revision=revision;current.recipes[0].description=`Published description ${revision}.`;return service.upgrade(changeRequest(await service.previewUpgrade(current)));};
  return {root,options,service,route,upgrade,initial,reopen:()=>createCustomerPackService(options),
    async reach(revision:number){for(let n=current.revision+1;n<=revision;n++)await upgrade(n);},
    async preview(){return (await service.handle(route('archive-preview'),'POST',{}))!.body as CustomerPackArchivePreview;},
    async archive(body:unknown){return (await service.handle(route('archive'),'POST',body))!.body as CustomerPackInstallation;},
    async journal(){return JSON.parse(await readFile(join(root,'customer-packs.json'),'utf8'));}};
}
async function archiveFiles(f:Awaited<ReturnType<typeof fixture>>) {
  const journal=await f.journal(), files=new Map<string,unknown>();let head=journal.installs[f.initial.id].archiveHead;
  while(head){const path=`customer-pack-history/${f.initial.id}/${head.digest}.json`,record=JSON.parse(await readFile(join(f.root,path),'utf8'));files.set(path,record);head=record.previous;}
  return {journal,files,reader:{get:(path:string)=>files.get(path),paths:()=>files.keys()}};
}

describe('durable private workflow-pack history archives',()=>{
  it('keeps two recent rollback configurations, preserves every older byte, enables later upgrades and reconciles old retries after further archives',windowsAdmissionTimeout(287),async()=>{
    const f=await fixture();await f.reach(9);const before=await f.journal(),recipes=loadRecipes(true);
    const p=await f.preview();expect(p.canArchive).toBe(true);expect(p.archive.map(s=>s.installationRevision)).toEqual([1,2,3,4,5,6]);expect(p.keep.map(s=>s.installationRevision)).toEqual([7,8]);
    expect(await f.journal()).toEqual(before);
    const body=archiveRequest(p),done=await f.archive(body);expect(done.history?.map(s=>s.installationRevision)).toEqual([7,8]);expect(done.archivedHistory).toMatchObject({batches:1,configurations:6,throughRevision:6});
    expect(loadRecipes(true)).toEqual(recipes);
    const first=await archiveFiles(f);expect([...first.files.values()][0]).toMatchObject({snapshots:before.installs[f.initial.id].history.slice(0,6)});validateCustomerPackArchiveSet(first.journal,first.reader);
    await f.reach(15);await f.archive(archiveRequest(await f.preview()));const current=await f.journal();
    expect((await f.reopen().handle(f.route('archive'),'POST',body))!.body).toMatchObject({revision:15,archivedHistory:{batches:2,configurations:12}});
    expect(await f.journal()).toEqual(current);
    const all=await archiveFiles(f);validateCustomerPackArchiveSet(all.journal,all.reader);expect(all.files.size).toBe(2);
    const page=(await f.service.handle(f.route('archived-history'),'POST',{}))!.body as any;expect(page.history.map((h:any)=>h.installationRevision)).toEqual([7,8,9,10,11,12]);
    const older=(await f.service.handle(f.route('archived-history'),'POST',{head:page.head,cursor:page.nextCursor}))!.body as any;expect(older.history.map((h:any)=>h.installationRevision)).toEqual([1,2,3,4,5,6]);expect(older.nextCursor).toBeNull();
    const exported=(await f.service.handle(f.route('history-export'),'POST',{installationRevision:1}))!.body;expect(exported).toEqual(before.installs[f.initial.id].history[0].pack);
    const rollback=(await f.service.handle(f.route('rollback-preview'),'POST',{installationRevision:1}))!.body as CustomerPackChangePreview;
    expect(rollback.canApply).toBe(true);const {pack:_,...request}=changeRequest(rollback);
    expect(await f.service.rollback({...request,packId:f.initial.id,installationRevision:1})).toMatchObject({revision:1,installationRevision:16});
    expect(loadRecipes(true)[0]).toMatchObject({description:'Published description 1.',status:'shadow',schedule:null,approvedRevision:null});
  });

  it('refuses stale and cross-profile previews without writing intent or files',async()=>{
    const f=await fixture();await f.reach(4);const body=archiveRequest(await f.preview());await f.upgrade(5);const before=await f.journal();
    await expect(f.archive(body)).rejects.toThrow(/changed after preview/);expect(await f.journal()).toEqual(before);
    const fresh=archiveRequest(await f.preview()),other=createCustomerPackService({...f.options,profileDirectory:()=>join(f.root,'other-profile')});
    await expect(other.handle(f.route('archive'),'POST',fresh)).rejects.toThrow(/changed after preview/);expect(await f.journal()).toEqual(before);
  });

  it.each(['before-archive','after-archive','before-commit','after-commit'] as const)('recovers a %s interruption after cold reopen without losing history or touching plan approvals',windowsAdmissionTimeout(137),async point=>{
    const f=await fixture();await f.reach(9);const before=await f.journal(),recipes=loadRecipes(true),body=archiveRequest(await f.preview());
    let fired=false;
    control.fault=(path,value,stage)=>{const archive=path.includes('customer-pack-history/'),commit=path.endsWith('customer-packs.json')&&value.installs[f.initial.id].archiveHead&&!value.installs[f.initial.id].archiveIntent;
      if(!fired&&((point==='before-archive'&&archive&&stage==='before')||(point==='after-archive'&&archive&&stage==='after')||(point==='before-commit'&&commit&&stage==='before')||(point==='after-commit'&&commit&&stage==='after'))){fired=true;throw new Error(`Synthetic ${point} interruption`);}};
    await expect(f.archive(body)).rejects.toThrow('Synthetic');expect(fired).toBe(true);control.fault=undefined;
    const interrupted=await f.journal();if(point!=='after-commit'){expect(interrupted.installs[f.initial.id].history).toEqual(before.installs[f.initial.id].history);expect(interrupted.installs[f.initial.id].archiveIntent).toBeDefined();
      expect(()=>validateCustomerPackArchiveSet(interrupted,{get:()=>undefined,paths:()=>[]})).toThrow(/Finish/);}
    const reopened=f.reopen();const done=await reopened.handle(f.route('resume-archive'),'POST',body);expect(done).toMatchObject({status:200,body:{localReady:true,archivedHistory:{configurations:6},history:[{installationRevision:7},{installationRevision:8}]}});
    expect(loadRecipes(true)).toEqual(recipes);expect(await reopened.handle(f.route('resume-archive'),'POST',body)).toEqual(done);
    const all=await archiveFiles(f);validateCustomerPackArchiveSet(all.journal,all.reader);
  });

  it('holds pending archives against upgrade, repair, stale resume and profile changes',async()=>{
    const f=await fixture();await f.reach(4);const body=archiveRequest(await f.preview());control.fault=(path,_value,stage)=>{if(path.includes('customer-pack-history/')&&stage==='before')throw new Error('Synthetic write failure');};
    await expect(f.archive(body)).rejects.toThrow('Synthetic');control.fault=undefined;const before=await f.journal();
    await expect(f.service.install(before.installs[f.initial.id].pack,before.installs[f.initial.id].digest)).rejects.toThrow(/pending/);
    await expect(f.upgrade(5)).rejects.toThrow(/recover/);
    await expect(f.service.handle(f.route('resume-archive'),'POST',{...body,expectedInstalledRevision:2})).rejects.toThrow(/different archive/);
    const other=createCustomerPackService({...f.options,workroomDirectory:()=>join(f.root,'other-vault')});
    await expect(other.handle(f.route('resume-archive'),'POST',body)).rejects.toThrow(/different archive/);expect(await f.journal()).toEqual(before);
    await expect(f.service.assertReadyForRecipe(f.initial.recipes[0].id)).rejects.toThrow(/recovery/);
  });

  it('holds a profile switch after durable archive bytes and resumes only in the original profile',async()=>{
    const f=await fixture();await f.reach(4);let workroom=join(f.root,'vault');
    const service=createCustomerPackService({...f.options,workroomDirectory:()=>workroom});
    const preview=(await service.handle(f.route('archive-preview'),'POST',{}))!.body as CustomerPackArchivePreview,body=archiveRequest(preview);
    control.fault=(path,_value,stage)=>{if(path.includes('customer-pack-history/')&&stage==='after')workroom=join(f.root,'other-vault');};
    await expect(service.handle(f.route('archive'),'POST',body)).rejects.toThrow(/same private workspace/);control.fault=undefined;
    const journal=await f.journal();expect(journal.installs[f.initial.id].history).toHaveLength(3);expect(journal.installs[f.initial.id].archiveHead).toBeUndefined();
    workroom=join(f.root,'vault');await expect(service.handle(f.route('resume-archive'),'POST',body)).resolves.toMatchObject({body:{localReady:true,archivedHistory:{configurations:1}}});
  });

  it('rejects altered durable archive intent without rewriting the journal or touching saved plans',async()=>{
    const f=await fixture();await f.reach(4);const body=archiveRequest(await f.preview());control.fault=(path,_value,stage)=>{if(path.includes('customer-pack-history/')&&stage==='before')throw new Error('Synthetic interruption');};
    await expect(f.archive(body)).rejects.toThrow('Synthetic');control.fault=undefined;
    const journal=await f.journal();journal.installs[f.initial.id].archiveIntent.digest='f'.repeat(64);const damaged=JSON.stringify(journal),recipes=loadRecipes(true);
    await writeFile(join(f.root,'customer-packs.json'),damaged,{mode:0o600});await expect(f.reopen().handle(f.route('resume-archive'),'POST',body)).rejects.toThrow(/recovery/);
    expect(await readFile(join(f.root,'customer-packs.json'),'utf8')).toBe(damaged);expect(loadRecipes(true)).toEqual(recipes);
  });

  it.each(['foreign','hardlink','changed-during-recovery'] as const)('preserves %s staging files and holds the saved intent instead of deleting unrelated bytes',async kind=>{
    const f=await fixture();await f.reach(4);const body=archiveRequest(await f.preview());let temporary='';
    control.fault=(path,_value,stage)=>{if(path.includes('customer-pack-history/')&&stage==='before'){
      temporary=`${path}.11111111-1111-4111-8111-111111111111.tmp`;
      plantPrivateFile(temporary,kind==='foreign' ? 'Preserve unrelated data.' : '{"format":"realbud-pack-');
      if(kind==='hardlink')linkSync(temporary,join(f.root,'held-evidence.txt'));
      throw new Error('Synthetic interruption');}};
    await expect(f.archive(body)).rejects.toThrow('Synthetic');
    control.fault=kind==='changed-during-recovery' ? (path,_value,stage)=>{if(path.includes('customer-pack-history/')&&stage==='after')writeFileSync(temporary,'Newer unrelated data.',{mode:0o600});} : undefined;
    await expect(f.reopen().handle(f.route('resume-archive'),'POST',body)).rejects.toThrow(/staging/);
    expect((await f.journal()).installs[f.initial.id].history).toHaveLength(3);
    expect(await readFile(temporary,'utf8')).toBe(kind==='foreign'?'Preserve unrelated data.':kind==='hardlink'?'{"format":"realbud-pack-':'Newer unrelated data.');
  });

  it('compares staging bytes exactly when an interruption ends within a multibyte character',async()=>{
    const initial=pack();initial.title='Fictional 辦公室';const f=await fixture(initial);await f.reach(4);const body=archiveRequest(await f.preview());
    let temporary='',partial=Buffer.alloc(0);
    control.fault=(path,value,stage)=>{if(path.includes('customer-pack-history/')&&stage==='before'){
      temporary=`${path}.11111111-1111-4111-8111-111111111111.tmp`;
      const expected=Buffer.from(JSON.stringify(value)),index=expected.findIndex(byte=>byte>=0x80);expect(index).toBeGreaterThan(0);
      partial=Buffer.from(expected.subarray(0,index+1));plantPrivateFile(temporary,partial);throw new Error('Synthetic interruption');}};
    await expect(f.archive(body)).rejects.toThrow('Synthetic');
    control.fault=(path,_value,stage)=>{if(path.includes('customer-pack-history/')&&stage==='after'){
      const changed=Buffer.from(partial);changed[changed.length-1]^=1;expect(changed.toString('utf8')).toBe(partial.toString('utf8'));
      writeFileSync(temporary,changed,{mode:0o600});}};
    await expect(f.reopen().handle(f.route('resume-archive'),'POST',body)).rejects.toThrow(/staging changed/);
    expect((await f.journal()).installs[f.initial.id].history).toHaveLength(3);expect(await readFile(temporary)).not.toEqual(partial);
  });

  it('preserves retired plan reservations after their snapshot moves into an archive',async()=>{
    const initial=pack();initial.recipes.push({...initial.recipes[0],id:'wf-fixture-retired'});initial.workflows[0].recipeIds.push('wf-fixture-retired');
    const f=await fixture(initial),next=structuredClone(initial);next.revision=2;next.recipes.pop();next.workflows[0].recipeIds.pop();await f.service.upgrade(changeRequest(await f.service.previewUpgrade(next)));
    for(let n=3;n<=5;n++){next.revision=n;await f.service.upgrade(changeRequest(await f.service.previewUpgrade(next)));}
    await f.archive(archiveRequest(await f.preview()));const other=pack();other.id='other-office';other.recipes=[initial.recipes[1]];other.workflows[0].recipeIds=['wf-fixture-retired'];other.skills=[];
    expect((await f.service.preview(other)).canInstall).toBe(false);await expect(f.service.assertReadyForRecipe('wf-fixture-retired')).rejects.toThrow(/retired/);
  });

  it('rejects tampered, missing, foreign and orphan archives in live reads and complete backup admission',async()=>{
    const f=await fixture();await f.reach(5);await f.archive(archiveRequest(await f.preview()));const all=await archiveFiles(f),[path,record]=[...all.files.entries()][0];
    const digest=path.split('/').at(-1)!.slice(0,-5);expect(()=>validateCustomerPackHistoryArchive(record,'other-office',digest)).toThrow(/recovery/);
    const bad=structuredClone(record) as any;bad.snapshots[0].pack.title='Changed bytes';expect(()=>validateCustomerPackHistoryArchive(bad,f.initial.id,digest)).toThrow(/recovery/);
    expect(()=>validateCustomerPackArchiveSet(all.journal,{get:()=>undefined,paths:()=>all.files.keys()})).toThrow(/recovery/);
    expect(()=>validateCustomerPackArchiveSet(undefined,all.reader)).toThrow(/no installation/);
    const extra=new Map(all.files);extra.set(`customer-pack-history/other-office/${digest}.json`,record);expect(()=>validateCustomerPackArchiveSet(all.journal,{get:p=>extra.get(p),paths:()=>extra.keys()})).toThrow(/Unreferenced/);
    await writeFile(join(f.root,path),JSON.stringify(bad),{mode:0o600});await expect(f.reopen().list()).rejects.toThrow(/recovery/);
    expect(await readFile(join(f.root,path),'utf8')).toBe(JSON.stringify(bad));
    await rm(join(f.root,path));await expect(f.reopen().list()).rejects.toThrow(/recovery/);
  });

  it('rejects another pack’s history cursor and a stale archive head',async()=>{
    const f=await fixture();await f.reach(5);const done=await f.archive(archiveRequest(await f.preview()));
    const other=pack();other.id='other-office';other.skills=[];other.recipes[0].id='wf-other-inbox';other.workflows[0].recipeIds=['wf-other-inbox'];await f.service.install(other,(await f.service.preview(other)).digest);
    await expect(f.service.handle('/api/customer-packs/other-office/archived-history','POST',{head:done.archivedHistory!.head,cursor:done.archivedHistory!.head})).rejects.toThrow(/Refresh/);
    await expect(f.service.handle(f.route('archived-history'),'POST',{head:'f'.repeat(64),cursor:done.archivedHistory!.head})).rejects.toThrow(/Refresh/);
  });
});
