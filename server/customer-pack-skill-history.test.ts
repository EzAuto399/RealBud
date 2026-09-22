import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, symlink } from 'node:fs/promises';
import { realpathSync, writeFileSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { CustomerPack, PackSkillArchivePreview, PackSkillHistoryPage, CustomerPackChangePreview } from '../shared/customer-packs.ts';
import { validateSkillJournalRoot, validateSkillOverride, skillHistoryHash, skillArchivePath, isSkillArchivePath, validateSkillHistoryArchive } from './customer-pack-skill-history.ts';
const control=vi.hoisted(()=>{const root=`${process.env.TMPDIR??'/tmp'}/rb-skill-history-recipes-${process.pid}-${Date.now()}`;process.env.REALBUD_DATA_DIR=root;return {root,fault:undefined as undefined|((path:string,value:any,stage:'before'|'after')=>void)};});
vi.mock('./private-json.ts',async original=>{const actual=await original<typeof import('./private-json.ts')>();return {...actual,writePrivateJson:async(...args:Parameters<typeof actual.writePrivateJson>)=>{control.fault?.(args[0],args[1],'before');await actual.writePrivateJson(...args);control.fault?.(args[0],args[1],'after');}};});
const {createCustomerPackService}=await import('./customer-packs.ts');
const {loadRecipes}=await import('./recipes.ts');
const roots:string[]=[];
beforeEach(async()=>{await mkdir(control.root,{recursive:true});await rm(join(control.root,'recipes.json'),{force:true});});
afterEach(async()=>{control.fault=undefined;for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
afterAll(async()=>{await rm(control.root,{recursive:true,force:true});});
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const pack=():CustomerPack=>({format:'realbud-customer-pack',version:1,id:'fixture-office',revision:1,title:'Fictional office',recipes:[{id:'wf-fixture-inbox',title:'Review inbox',description:'Review supplied data.',steps:['Read sources.'],evidence:'Source references.',capabilities:['read-files','analyse','draft'],limits:{maxRuntimeMinutes:2,maxTurns:6},siteNotes:null,schedule:null,allowedOrigins:[]}],skills:[{id:'fixture-guidance',name:'Fictional guidance',description:'Review supplied sources.',instructions:'Read source references first.',license:'Fictional license.'}],workflows:[{id:'inbox',title:'Review inbox',recipeIds:['wf-fixture-inbox'],checks:['input-coverage']}],dependencies:{runtime:'hermes-property',mode:'supplied-source-preparation',schedules:'off',permissions:'local-review-required'}});
const confirmation=(p:PackSkillArchivePreview)=>({expectedInstalledDigest:p.installedDigest,expectedInstalledRevision:p.installedRevision,expectedActiveDigest:p.activeDigest,expectedActiveRevision:p.activeRevision,expectedHead:p.head,expectedPreviewDigest:p.previewDigest});
const change=(p:CustomerPackChangePreview)=>({pack:p.pack,expectedInstalledDigest:p.installedDigest,expectedInstalledRevision:p.installedRevision,expectedDigest:p.digest,expectedPreviewDigest:p.previewDigest});
async function fixture(count=6,padding=0){
 const root=await mkdtemp(join(realpathSync(tmpdir()),'rb-skill-history-'));roots.push(root);const initial=pack(),active:string[]=[],pause=vi.fn(async()=>{});
 const options={directory:root,profileDirectory:()=>join(root,'profile'),workroomDirectory:()=>join(root,'vault'),activeRecipeIds:()=>active,pauseSchedules:pause};const service=createCustomerPackService(options);
 await service.install(initial,(await service.preview(initial)).digest);
 const native=join(root,'profile/skills/realbud-fixture-office-fixture-guidance/SKILL.md'),baseline=await readFile(native,'utf8'),journalPath=join(root,'customer-packs.json');
 const journal=()=>readFile(journalPath,'utf8').then(JSON.parse);const saved=await journal(),entry=saved.installs[initial.id];
 const versions=Array.from({length:count},(_,i)=>{const content=i===0?baseline:`${baseline}\nReviewed improvement ${i+1}.\n${'x'.repeat(padding)}`;return {revision:i+1,digest:hash(content),content,createdAt:'2026-09-22T00:00:00.000Z',reason:i===0?'Published pack baseline':`Reviewed revision ${i+1}`};});
 entry.overrides={[initial.skills[0].id]:{activeRevision:count,versions}};await writeFile(journalPath,JSON.stringify(saved),{mode:0o600});await writeFile(native,versions.at(-1)!.content,{mode:0o600});pause.mockClear();
 const route=(action:string)=>`/api/customer-packs/${initial.id}/skills/${initial.skills[0].id}/${action}`;
 const call=async(action:string,body:unknown={},which=service)=>(await which.handle(route(action),'POST',body))!.body as any;
 const preview=async()=>await call('archive-preview') as PackSkillArchivePreview;
 async function proposal(n:number){const content=`${baseline}\nReviewed improvement ${n}.\n`;const id=n.toString(16).padStart(8,'0'),folder=join(root,'profile/pending/skills');await mkdir(folder,{recursive:true});await writeFile(join(folder,`${id}.json`),JSON.stringify({id,subsystem:'skills',action:'edit',summary:'Review fictional guidance',origin:'background_review',created_at:'2026-09-22T00:00:00Z',payload:{action:'edit',name:'realbud-fixture-office-fixture-guidance',content,replace_all:false}}));const item=(await service.proposals()).proposals[0];await service.reviewProposal({id:item.id,pendingDigest:item.pendingDigest,currentDigest:item.currentDigest,decision:'approve'});}
 async function select(revision:number,installationRevision?:number){let page=await call('history',installationRevision?{installationRevision}:{}) as PackSkillHistoryPage;for(;;){const found=page.revisions.find(v=>v.revision===revision);if(found)return {installationRevision:page.installationRevision,head:page.head,sourceDigest:page.sourceDigest,revision,digest:found.digest};if(!page.nextCursor)throw new Error('Missing revision');page=await call('history',{installationRevision:page.installationRevision,head:page.head,sourceDigest:page.sourceDigest,cursor:page.nextCursor});}}
 return {root,initial,active,pause,options,service,reopen:()=>createCustomerPackService(options),native,baseline,journalPath,journal,versions,route,call,preview,proposal,select};
}

describe('reviewed instruction history archival',()=>{
 it('archives 100 versions without changing active instructions, plan approvals, schedules or binding; continues through proposal101 and archived revert102',async()=>{
  const f=await fixture(100);const before=await f.journal(),native=await readFile(f.native),recipes=loadRecipes(true),binding=await f.service.packRecipeBinding(f.initial.id,f.initial.recipes[0].id),context=await f.service.instructionContext(f.initial.recipes[0].id);
  const p=await f.preview();expect(p.canArchive).toBe(true);expect(p.archive).toHaveLength(98);expect(p.keep.map(v=>v.revision)).toEqual([99,100]);expect(JSON.stringify(p)).not.toContain('Reviewed improvement 100.');expect(await f.journal()).toEqual(before);
  await f.call('archive',confirmation(p));let journal=await f.journal(),override=journal.installs[f.initial.id].overrides[f.initial.skills[0].id],head=override.archiveHead;
  expect(journal.version).toBe(2);expect(override.versions.map((v:any)=>v.revision)).toEqual([99,100]);expect(head).toMatchObject({batches:1,revisions:98,throughRevision:98});expect(await readFile(f.native)).toEqual(native);expect(loadRecipes(true)).toEqual(recipes);expect(f.pause).not.toHaveBeenCalled();expect(await f.service.packRecipeBinding(f.initial.id,f.initial.recipes[0].id)).toBe(binding);expect(await f.service.instructionContext(f.initial.recipes[0].id)).toBe(context);
  const meta=await f.service.proposals();expect(meta.revisions).toHaveLength(2);expect(meta.revisions.every(v=>!('content'in v))).toBe(true);expect(meta.skillHistories[0]).toMatchObject({archivedRevisions:98,hotRevisions:2});
  let page=await f.call('history');const revisions:number[]=[];for(;;){expect(page.revisions.length).toBeLessThanOrEqual(20);revisions.push(...page.revisions.map((v:any)=>v.revision));if(!page.nextCursor)break;page=await f.call('history',{installationRevision:page.installationRevision,head:page.head,sourceDigest:page.sourceDigest,cursor:page.nextCursor});}expect(revisions).toEqual(Array.from({length:100},(_,i)=>100-i));
  await f.proposal(101);expect((await f.journal()).installs[f.initial.id].overrides[f.initial.skills[0].id].archiveHead).toEqual(head);
  const review=await f.call('revert-preview',await f.select(1));expect(review.proposed).toBe(f.baseline);expect(review.current).toContain('101');const body={...review.selection,expectedReviewDigest:review.reviewDigest};await f.call('revert',body);expect(await readFile(f.native,'utf8')).toBe(f.baseline);
  journal=await f.journal();override=journal.installs[f.initial.id].overrides[f.initial.skills[0].id];expect(override.activeRevision).toBe(102);expect(override.archiveHead).toEqual(head);expect(loadRecipes(true).every(r=>r.approvedRevision===null&&r.schedule===null)).toBe(true);
  expect(await f.call('revert',body,f.reopen())).toMatchObject({localReady:true});expect(await f.journal()).toEqual(journal);
  await f.call('archive',confirmation(await f.preview()));expect((await f.journal()).installs[f.initial.id].overrides[f.initial.skills[0].id].archiveHead).toMatchObject({batches:2,revisions:100,throughRevision:100});
 });

 it.each(['before-intent','after-intent','before-file','after-file','before-head','after-head'] as const)('recovers %s with a cold retry and one immutable batch',async point=>{
  const f=await fixture(),body=confirmation(await f.preview()),before=await f.journal(),recipes=loadRecipes(true);let fired=false;
  control.fault=(path,value,stage)=>{const intent=path===f.journalPath&&!!value.installs[f.initial.id].skillArchiveIntent,file=path.includes('/customer-skill-history/'),head=path===f.journalPath&&!!value.installs[f.initial.id].overrides[f.initial.skills[0].id].archiveHead&&!intent;
   if(!fired&&((point==='before-intent'&&intent&&stage==='before')||(point==='after-intent'&&intent&&stage==='after')||(point==='before-file'&&file&&stage==='before')||(point==='after-file'&&file&&stage==='after')||(point==='before-head'&&head&&stage==='before')||(point==='after-head'&&head&&stage==='after'))){fired=true;throw new Error(`Synthetic ${point}`);}};
  await expect(f.call('archive',body)).rejects.toThrow('Synthetic');expect(fired).toBe(true);control.fault=undefined;
  const saved=await f.journal();if(point==='before-intent')expect(saved).toEqual(before);else if(point!=='after-head'){expect(saved.version).toBe(2);expect(saved.installs[f.initial.id].overrides).toEqual(before.installs[f.initial.id].overrides);expect((await f.reopen().list()).installations[0].localReady).toBe(false);}
  const reopened=f.reopen(),done=await f.call(point==='before-intent'?'archive':'resume-archive',body,reopened);expect(done).toMatchObject({localReady:true});const final=await f.journal();await f.call('archive',body,f.reopen());expect(await f.journal()).toEqual(final);expect(loadRecipes(true)).toEqual(recipes);expect(await readdir(join(f.root,'customer-skill-history',f.initial.id))).toHaveLength(1);
 });

 it('admits only a compact validated intent over an otherwise admitted near-2MB legacy root, then completes using the actual private writer after restart',async()=>{
  const f=await fixture(100,18000),j=await f.journal();j.installs[f.initial.id].receipt.note='';j.installs[f.initial.id].receipt.note='x'.repeat(1_999_950-Buffer.byteLength(JSON.stringify(j)));await writeFile(f.journalPath,JSON.stringify(j));expect(Buffer.byteLength(JSON.stringify(j))).toBe(1_999_950);
  const body=confirmation(await f.preview());control.fault=(path,_value,stage)=>{if(path.includes('/customer-skill-history/')&&stage==='before')throw new Error('Synthetic interrupted archive');};await expect(f.call('archive',body)).rejects.toThrow('Synthetic');control.fault=undefined;
  const pending=await f.journal(),size=Buffer.byteLength(JSON.stringify(pending));expect(size).toBeGreaterThan(2_000_000);expect(size).toBeLessThanOrEqual(2_016_384);expect(()=>validateSkillJournalRoot(pending)).not.toThrow();
  const invalid=structuredClone(pending);invalid.installs[f.initial.id].skillArchiveIntent.digest='f'.repeat(64);expect(()=>validateSkillJournalRoot(invalid)).toThrow();const unrelated=structuredClone(pending);delete unrelated.installs[f.initial.id].skillArchiveIntent;unrelated.installs[f.initial.id].receipt.note+='x'.repeat(1000);expect(()=>validateSkillJournalRoot(unrelated)).toThrow();
  await f.call('resume-archive',body,f.reopen());expect(Buffer.byteLength(JSON.stringify(await f.journal()))).toBeLessThan(2_000_000);expect((await f.reopen().list()).installations[0].localReady).toBe(true);
 });

 it('rejects stale pages, current-digest-only legacy reverts, ABA reviews and changed installation generations',async()=>{
  const f=await fixture();await f.call('archive',confirmation(await f.preview()));const selection=await f.select(1),review=await f.call('revert-preview',selection);await f.proposal(7);
  await expect(f.call('revert',{...review.selection,expectedReviewDigest:review.reviewDigest})).rejects.toThrow(/changed/);
  await expect(f.service.revertSkill({packId:f.initial.id,skillId:f.initial.skills[0].id,revision:1,currentDigest:review.activeDigest})).rejects.toThrow(/older review/);
  await expect(f.call('history',{installationRevision:selection.installationRevision,head:selection.head,sourceDigest:selection.sourceDigest,cursor:'hot:0'})).rejects.toThrow(/changed/);
  const fresh=await f.call('revert-preview',await f.select(1)),next=structuredClone(f.initial);next.revision=2;next.title='Updated fictional office';await f.service.upgrade(change(await f.service.previewUpgrade(next)));await expect(f.call('revert',{...fresh.selection,expectedReviewDigest:fresh.reviewDigest})).rejects.toThrow(/changed/);
 });

 it('holds pending archives against pack/proposal preparation and a profile switch after durable file creation',async()=>{
  const f=await fixture();let profile=f.options.profileDirectory();const service=createCustomerPackService({...f.options,profileDirectory:()=>profile});const body=confirmation(await f.call('archive-preview',{},service));
  control.fault=(path,_value,stage)=>{if(path.includes('/customer-skill-history/')&&stage==='after')profile=join(f.root,'other-profile');};await expect(f.call('archive',body,service)).rejects.toThrow(/instructions changed|workspace/);control.fault=undefined;
  expect((await f.journal()).installs[f.initial.id].skillArchiveIntent).toBeDefined();await expect(f.service.assertReadyForRecipe(f.initial.recipes[0].id)).rejects.toThrow(/recovery/);
  const next=structuredClone(f.initial);next.revision=2;await expect(f.service.previewUpgrade(next)).rejects.toThrow(/recover/);await expect(f.service.install(f.initial,(await f.journal()).installs[f.initial.id].digest)).rejects.toThrow(/pending/);
  await expect(f.call('resume-archive',body,service)).rejects.toThrow(/different instruction archive/);profile=f.options.profileDirectory();await f.call('resume-archive',body,service);
 });

 it.each(['foreign','hardlink','changed'] as const)('preserves %s temporary evidence and retains complete inline versions',async kind=>{
  const f=await fixture(),body=confirmation(await f.preview());let temp='';control.fault=(path,value,stage)=>{if(path.includes('/customer-skill-history/')&&stage==='before'){temp=`${path}.11111111-1111-4111-8111-111111111111.tmp`;writeFileSync(temp,kind==='foreign'?'Unrelated evidence':JSON.stringify(value).slice(0,50),{mode:0o600});if(kind==='hardlink')linkSync(temp,join(f.root,'linked-evidence'));throw new Error('Synthetic fault');}};
  await expect(f.call('archive',body)).rejects.toThrow('Synthetic');control.fault=kind==='changed'?(path,_value,stage)=>{if(path.includes('/customer-skill-history/')&&stage==='after')writeFileSync(temp,'Changed evidence',{mode:0o600});}:undefined;
  await expect(f.call('resume-archive',body,f.reopen())).rejects.toThrow(/staging/);expect((await f.journal()).installs[f.initial.id].overrides[f.initial.skills[0].id].versions).toHaveLength(6);expect(await readFile(temp,'utf8')).not.toBe('');
 });

 it('holds ambiguous legacy ordering, tampered archive commitments and linked archive storage',async()=>{
  const f=await fixture(),j=await f.journal(),o=j.installs[f.initial.id].overrides[f.initial.skills[0].id];[o.versions[0],o.versions[1]]=[o.versions[1],o.versions[0]];await writeFile(f.journalPath,JSON.stringify(j));expect((await f.preview()).canArchive).toBe(false);expect(()=>validateSkillOverride(o,true)).toThrow();[o.versions[0],o.versions[1]]=[o.versions[1],o.versions[0]];await writeFile(f.journalPath,JSON.stringify(j));
  const body=confirmation(await f.preview());await symlink(join(f.root,'profile'),join(f.root,'customer-skill-history'));await expect(f.call('archive',body)).rejects.toThrow(/linked|Private/);await rm(join(f.root,'customer-skill-history'));await f.call('resume-archive',body,f.reopen());await f.proposal(7);
  const saved=await f.journal(),override=saved.installs[f.initial.id].overrides[f.initial.skills[0].id];const v=override.versions.find((v:any)=>v.revision===6);v.content+='\nContradictory text';v.digest=hash(v.content);await writeFile(f.journalPath,JSON.stringify(saved));await expect(f.reopen().list()).rejects.toThrow(/archived active digest/);
 });

 it('requires root v2 forever and validates portable path and immutable batch identity',async()=>{
  const f=await fixture();await f.call('archive',confirmation(await f.preview()));const j=await f.journal(),head=j.installs[f.initial.id].overrides[f.initial.skills[0].id].archiveHead,path=skillArchivePath(f.initial.id,head.digest),record=JSON.parse(await readFile(join(f.root,path),'utf8'));
  expect(isSkillArchivePath(path)).toBe(true);expect(isSkillArchivePath(path.replace(f.initial.id,'../escape'))).toBe(false);expect(()=>validateSkillHistoryArchive(record,f.initial.id,f.initial.skills[0].id,head.digest)).not.toThrow();expect(()=>validateSkillHistoryArchive(record,'foreign-office',f.initial.skills[0].id,head.digest)).toThrow();
  j.version=1;expect(()=>validateSkillJournalRoot(j)).toThrow();record.versions[0].content+='tampered';expect(skillHistoryHash(record)).not.toBe(head.digest);expect(()=>validateSkillHistoryArchive(record,f.initial.id,f.initial.skills[0].id,head.digest)).toThrow();
 });
 it('preserves shared archive roots in configuration snapshots, removal, reintroduction and rollback, and reconciles an older archive retry',async()=>{
  const f=await fixture(),first=confirmation(await f.preview());await f.call('archive',first);const head=(await f.journal()).installs[f.initial.id].overrides[f.initial.skills[0].id].archiveHead;
  await f.proposal(7);await f.proposal(8);await f.call('archive',confirmation(await f.preview()));const second=(await f.journal()).installs[f.initial.id].overrides[f.initial.skills[0].id].archiveHead;expect(second.batches).toBe(2);
  const current=await f.journal();await f.call('archive',first,f.reopen());expect(await f.journal()).toEqual(current);
  const absent=structuredClone(f.initial);absent.revision=2;absent.skills=[];await f.service.upgrade(change(await f.service.previewUpgrade(absent)));expect((await f.journal()).installs[f.initial.id].history[0].overrides[f.initial.skills[0].id].archiveHead).toEqual(second);
  const reintroduced=structuredClone(f.initial);reintroduced.revision=3;reintroduced.skills[0].instructions='A new published baseline, not the removed lineage.';await f.service.upgrade(change(await f.service.previewUpgrade(reintroduced)));
  let state=(await f.journal()).installs[f.initial.id];expect(state.overrides?.[f.initial.skills[0].id]).toBeUndefined();expect((await f.call('history')).revisions[0].revision).toBe(1);
  const oldSelection=await f.select(6,1),oldReview=await f.call('revert-preview',oldSelection);expect(oldReview.proposed).toBe(f.versions[5].content);await f.call('revert',{...oldReview.selection,expectedReviewDigest:oldReview.reviewDigest});state=(await f.journal()).installs[f.initial.id];expect(state.overrides[f.initial.skills[0].id].activeRevision).toBe(2);expect(state.overrides[f.initial.skills[0].id].archiveHead).toBeUndefined();
  // Roll back through the absent configuration, then to the old configuration:
  // that recovers the archived lineage instead of inventing a numeric merge.
  const rollback=async(generation:number)=>{const p=(await f.service.handle(`/api/customer-packs/${f.initial.id}/rollback-preview`,'POST',{installationRevision:generation}))!.body as CustomerPackChangePreview;const {pack:_,...body}=change(p);await f.service.rollback({...body,packId:f.initial.id,installationRevision:generation});};
  await rollback(2);await rollback(1);state=(await f.journal()).installs[f.initial.id];expect(state.overrides[f.initial.skills[0].id].archiveHead).toEqual(second);expect(state.overrides[f.initial.skills[0].id].activeRevision).toBe(8);expect(head.digest).not.toBe(second.digest);expect((await f.reopen().list()).installations[0].localReady).toBe(true);
 });

 it('rejects an old review after active text returns to the same bytes, and refuses an archive that cannot free enough completed-journal space',async()=>{
  const f=await fixture(),review=await f.call('revert-preview',await f.select(1));await f.proposal(7);const back=await f.call('revert-preview',await f.select(6));await f.call('revert',{...back.selection,expectedReviewDigest:back.reviewDigest});expect(await readFile(f.native,'utf8')).toBe(f.versions[5].content);
  const before=await f.journal();await expect(f.call('revert',{...review.selection,expectedReviewDigest:review.reviewDigest})).rejects.toThrow(/changed/);expect(await f.journal()).toEqual(before);
  const small=await fixture(3),j=await small.journal();const oldest=j.installs[small.initial.id].overrides[small.initial.skills[0].id].versions[0];oldest.content='---\nname: realbud-fixture-office-fixture-guidance\ndescription: Fictional guidance\n---\nOld review.';oldest.digest=hash(oldest.content);j.installs[small.initial.id].receipt.note='';j.installs[small.initial.id].receipt.note='x'.repeat(2_000_000-Buffer.byteLength(JSON.stringify(j)));await writeFile(small.journalPath,JSON.stringify(j));const p=await small.preview();expect(p.canArchive).toBe(false);expect(p.conflicts.join(' ')).toMatch(/storage limit/);expect(await small.journal()).toEqual(j);
 });

 it('preserves readable legacy metadata without silently canonicalizing it, and rejects a damaged pending revert before approval or file effects',async()=>{
  const f=await fixture(),j=await f.journal(),override=j.installs[f.initial.id].overrides[f.initial.skills[0].id];override.versions[0].createdAt='Legacy undated';override.versions[0].reason='x'.repeat(501);await writeFile(f.journalPath,JSON.stringify(j));expect((await f.reopen().list()).installations[0].localReady).toBe(true);expect((await f.preview()).canArchive).toBe(false);expect(await f.journal()).toEqual(j);
  override.versions[0].createdAt='2026-09-22T00:00:00.000Z';override.versions[0].reason='Restored reviewed metadata';await writeFile(f.journalPath,JSON.stringify(j));const review=await f.call('revert-preview',await f.select(1)),body={...review.selection,expectedReviewDigest:review.reviewDigest};
  f.pause.mockImplementationOnce(async()=>{throw new Error('Synthetic pause interruption');});await expect(f.call('revert',body)).rejects.toThrow('Synthetic');const saved=await f.journal(),native=await readFile(f.native),recipes=loadRecipes(true);saved.installs[f.initial.id].upgrade.target.revision+=2;await writeFile(f.journalPath,JSON.stringify(saved));await expect(f.call('revert',body,f.reopen())).rejects.toThrow(/pending skill revision/);expect(await readFile(f.native)).toEqual(native);expect(loadRecipes(true)).toEqual(recipes);expect(await f.journal()).toEqual(saved);
 });

 it('requires v2 when the only skill history root lives inside an archived removed configuration',async()=>{
  const f=await fixture();await f.call('archive',confirmation(await f.preview()));const absent=structuredClone(f.initial);absent.skills=[];
  for(let revision=2;revision<=5;revision++){absent.revision=revision;await f.service.upgrade(change(await f.service.previewUpgrade(absent)));}
  const preview=(await f.service.handle(`/api/customer-packs/${f.initial.id}/archive-preview`,'POST',{}))!.body as any;
  await f.service.handle(`/api/customer-packs/${f.initial.id}/archive`,'POST',{expectedInstalledDigest:preview.installedDigest,expectedInstalledRevision:preview.installedRevision,expectedPreviewDigest:preview.previewDigest});
  const journal=await f.journal();expect(journal.installs[f.initial.id].history.every((s:any)=>!s.pack.skills.length)).toBe(true);delete journal.installs[f.initial.id].lastSkillArchive;journal.version=1;await writeFile(f.journalPath,JSON.stringify(journal));
  await expect(f.reopen().list()).rejects.toThrow(/version 2/);expect(await f.journal()).toEqual(journal);
 });

});
