import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { privateBackupTargetPaths } from './private-backup-capture.ts';
import { plantPrivateFile, privateTempRoot, removeFixture, windowsAdmissionTimeout } from './testing/private-fixture.ts';
import type { CustomerPack, CustomerPackArchivePreview, CustomerPackChangePreview, CustomerPackInstallation } from '../shared/customer-packs.ts';
const control=vi.hoisted(()=>{const root=`${process.env.TMPDIR ?? '/tmp'}/rb-pack-archive-recipes-${process.pid}-${Date.now()}`;process.env.REALBUD_DATA_DIR=root;return {root,fault:undefined as undefined|((path:string,value:any,stage:'before'|'after')=>void)};});
vi.mock('./private-json.ts',async importOriginal=>{const original=await importOriginal<typeof import('./private-json.ts')>();return {...original,
  writePrivateJson:async(path:string,value:unknown)=>{control.fault?.(path,value,'before');await original.writePrivateJson(path,value);control.fault?.(path,value,'after');}};});
const {createCustomerPackService,validateCustomerPackArchiveSet}=await import('./customer-packs.ts');
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

describe('independent pack archival recovery review',()=>{
  it('refuses a missing recent generation even when committed archive bytes and counters are intact',windowsAdmissionTimeout(129),async()=>{
    const f=await fixture();await f.reach(9);await f.archive(archiveRequest(await f.preview()));
    const before=await f.journal();expect(before.installs[f.initial.id].history.map((s:any)=>s.generation)).toEqual([7,8]);
    before.installs[f.initial.id].history.shift();
    await writeFile(join(f.root,'customer-packs.json'),JSON.stringify(before),{mode:0o600});
    // The archive still covers 1..6; absence of generation 7 must not be accepted
    // as a complete configuration history by live service or backup admission.
    const all=await archiveFiles(f);
    expect(()=>validateCustomerPackArchiveSet(all.journal,all.reader)).toThrow(/recovery/);
    await expect(f.reopen().list()).rejects.toThrow(/recovery/);
  });

  it('resumes an archive interrupted during its atomic temp write without permanently breaking backup discovery',windowsAdmissionTimeout(137),async()=>{
    const f=await fixture();await f.reach(9);const body=archiveRequest(await f.preview());
    let temporary='';
    control.fault=(path,_value,stage)=>{
      if(/customer-pack-history[\\/]/.test(path)&&stage==='before'){
        // Exact sibling naming/permissions used by writePrivateJson. A process
        // death after the first write bypasses that helper's finally cleanup.
        temporary=`${path}.11111111-1111-4111-8111-111111111111.tmp`;
        plantPrivateFile(temporary,'{"format":"realbud-pack-');
        throw new Error('Synthetic process termination during archive temp write');
      }
    };
    await expect(f.archive(body)).rejects.toThrow('Synthetic');control.fault=undefined;
    expect(temporary).not.toBe('');
    const done=await f.reopen().handle(f.route('resume-archive'),'POST',body);
    expect(done).toMatchObject({status:200,body:{localReady:true,archivedHistory:{configurations:6}}});
    // Uses the real v2 source/restore filesystem discovery, not a mock of backup.
    await expect(privateBackupTargetPaths(f.root)).resolves.toContain('customer-packs.json');
  });
});
