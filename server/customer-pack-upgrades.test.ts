import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { privateTempRoot, removeFixture } from './testing/private-fixture.ts';
import type { CustomerPack, CustomerPackChangePreview } from '../shared/customer-packs.ts';
const recipeRoot=vi.hoisted(()=>{const value=`${process.env.TMPDIR ?? '/tmp'}/rb-pack-upgrade-recipes-${process.pid}-${Date.now()}`;process.env.REALBUD_DATA_DIR=value;return value;});
const {createCustomerPackService,validateCustomerPackUpgradeJournal}=await import('./customer-packs.ts');
const {saveRecipe,saveRecipesAtomically,resetRecipeApprovalsAtomically,loadRecipes,getRecipe,patchRecipe}=await import('./recipes.ts');
const roots:string[]=[];
beforeEach(async()=>{await mkdir(recipeRoot,{recursive:true});await rm(join(recipeRoot,'recipes.json'),{force:true});});
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await removeFixture(root);});
afterAll(async()=>{await rm(recipeRoot,{recursive:true,force:true});});
const pack=():CustomerPack=>({format:'realbud-customer-pack',version:1,id:'fixture-office',revision:1,title:'Fictional office',
  recipes:[{id:'wf-fixture-inbox',title:'Review inbox',description:'Published description.',steps:['Read the supplied fictional sources.'],evidence:'Source references.',capabilities:['read-files','analyse','draft'],limits:{maxRuntimeMinutes:2,maxTurns:6},siteNotes:'Earlier published notes.',schedule:null,allowedOrigins:[]}],
  workflows:[{id:'inbox',title:'Review supplied inbox',recipeIds:['wf-fixture-inbox'],checks:['input-coverage']}],
  skills:[{id:'fixture-guidance',name:'Fictional guidance',description:'Review fictional supplied sources.',instructions:'# Fictional guidance\nRead the source first.\n',license:'Fictional test license.'}],
  dependencies:{runtime:'hermes-property',mode:'supplied-source-preparation',schedules:'off',permissions:'local-review-required'}});
async function fixture(initial=pack()) {
  const root=privateTempRoot(join(realpathSync(tmpdir()),'rb-pack-upgrade-'));roots.push(root);
  const active:string[]=[],reset=vi.fn(resetRecipeApprovalsAtomically),save=vi.fn(saveRecipesAtomically);
  const options={directory:root,profileDirectory:()=>join(root,'profile'),workroomDirectory:()=>join(root,'vault'),activeRecipeIds:()=>active,
    resetRecipeApprovals:reset,saveRecipes:save,learningStatus:()=>({supported:true,policyReady:true,enabled:true})};
  const service=createCustomerPackService(options),preview=await service.preview(initial);await service.install(initial,preview.digest);
  const next=structuredClone(initial);next.revision++;next.recipes[0].steps=['Read the sources and name missing facts.'];next.skills[0].instructions+='Record uncertainty.\n';
  return {root,options,service,initial,next,active,reset,save,reopen:()=>createCustomerPackService(options),
    native:join(root,`profile/skills/realbud-${initial.id}-${initial.skills[0].id}/SKILL.md`),
    journal:async()=>JSON.parse(await readFile(join(root,'customer-packs.json'),'utf8'))};
}
const request=(preview:CustomerPackChangePreview)=>({pack:preview.pack,expectedInstalledDigest:preview.installedDigest,expectedInstalledRevision:preview.installedRevision,expectedDigest:preview.digest,expectedPreviewDigest:preview.previewDigest});
const resume=(id:string,installed:any)=>({route:`/api/customer-packs/${id}/resume-change`,body:{expectedInstalledDigest:installed.digest,expectedInstalledRevision:installed.installationRevision,expectedPreviewDigest:installed.pendingChange.previewDigest}});

describe('reviewed customer pack version changes with real recipe writes',()=>{
  it('three-way merges publisher changes with unrelated local edits, clears siteNotes, approvals and schedules, and reconciles exact retry',async()=>{
    const f=await fixture(),id=f.initial.recipes[0].id;
    saveRecipe({...getRecipe(id)!,description:'Keep my local operating note.',schedule:{time:'08:00',weekdays:[1]},status:'active',expectedRevision:getRecipe(id)!.revision});
    patchRecipe(id,{planApproved:true,expectedRevision:getRecipe(id)!.revision});
    f.next.recipes[0].siteNotes=null;
    const preview=await f.service.previewUpgrade(f.next);expect(preview.canApply).toBe(true);
    expect(preview.recipes[0].after.description).toBe('Keep my local operating note.');expect(preview.recipes[0].after.siteNotes).toBeNull();
    const body=request(preview),done=await f.service.upgrade(body);
    expect(done).toMatchObject({revision:2,installationRevision:2,localReady:true});expect(done.history).toHaveLength(1);
    expect(getRecipe(id)).toMatchObject({description:'Keep my local operating note.',steps:f.next.recipes[0].steps,siteNotes:null,status:'shadow',schedule:null,approvedRevision:null,planApprovedAt:null});
    const saved=loadRecipes(true),journal=await f.journal();
    expect(await f.reopen().upgrade(body)).toEqual(done);expect(loadRecipes(true)).toEqual(saved);expect(await f.journal()).toEqual(journal);
    validateCustomerPackUpgradeJournal(journal.installs[f.initial.id]);
  });

  it('rejects conflicting local/published field edits and stale preview without persisting an intent',async()=>{
    const f=await fixture(),id=f.initial.recipes[0].id;
    const preview=await f.service.previewUpgrade(f.next);
    saveRecipe({...getRecipe(id)!,steps:['My conflicting local procedure.'],expectedRevision:getRecipe(id)!.revision});
    await expect(f.service.upgrade(request(preview))).rejects.toThrow(/changed after preview/);
    const conflict=await f.service.previewUpgrade(f.next);expect(conflict.canApply).toBe(false);expect(conflict.conflicts.join(' ')).toContain('changed steps');
    await expect(f.service.upgrade(request(conflict))).rejects.toThrow(/changed steps/);
    expect((await f.journal()).installs[f.initial.id].transition).toBeUndefined();expect(f.reset).not.toHaveBeenCalled();
  });

  it.each(['after-reset','after-recipes'] as const)('resumes after %s without resetting twice or changing the approved target',async fault=>{
    const f=await fixture(),preview=await f.service.previewUpgrade(f.next),body=request(preview);
    const interrupted=createCustomerPackService({...f.options,
      ...(fault==='after-reset'?{resetRecipeApprovals:(expected:Parameters<typeof resetRecipeApprovalsAtomically>[0])=>{f.reset(expected);throw new Error('Synthetic interruption after reset');}}:
        {saveRecipes:(inputs:unknown[])=>{f.save(inputs);throw new Error('Synthetic interruption after recipe write');}})});
    await expect(interrupted.upgrade(body)).rejects.toThrow(/Synthetic interruption/);
    const reopened=f.reopen(),installed=(await reopened.list()).installations[0];expect(installed.pendingChange).toMatchObject({targetRevision:2});expect(installed.localReady).toBe(false);
    await expect(reopened.assertReadyForRecipe(f.initial.recipes[0].id)).rejects.toThrow(/recovery/);
    const r=resume(f.initial.id,installed),done=await reopened.handle(r.route,'POST',r.body);expect(done?.status).toBe(200);
    expect(await reopened.handle(r.route,'POST',r.body)).toEqual(done);
    expect(f.reset).toHaveBeenCalledTimes(1);expect((await reopened.list()).installations[0]).toMatchObject({revision:2,localReady:true});
    expect(await reopened.upgrade(body)).toMatchObject({revision:2,installationRevision:2});
  });

  it.each(['upgrade','rollback'] as const)('holds %s before any file or approval change when pausing a host clock fails, then resumes once',async action=>{
    const f=await fixture();
    if(action==='rollback') await f.service.upgrade(request(await f.service.previewUpgrade(f.next)));
    f.reset.mockClear();f.save.mockClear();
    const preview=action==='upgrade' ? await f.service.previewUpgrade(f.next) :
      (await f.service.handle(`/api/customer-packs/${f.initial.id}/rollback-preview`,'POST',{installationRevision:1}))!.body as CustomerPackChangePreview;
    const {pack:target,...expected}=request(preview);
    const body=action==='upgrade' ? {...expected,pack:target} : {...expected,packId:f.initial.id,installationRevision:1};
    const original=await readFile(f.native),recipes=loadRecipes(true);
    let refuse=true;
    const pauseSchedules=vi.fn(async(packId:string)=>{
      expect(packId).toBe(f.initial.id);
      expect((await f.journal()).installs[packId].transition).toBeDefined();
      expect(await readFile(f.native)).toEqual(original);expect(loadRecipes(true)).toEqual(recipes);
      expect(f.reset).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();
      if(refuse)throw new Error('Synthetic clock persistence failure');
    });
    const service=createCustomerPackService({...f.options,pauseSchedules});
    await expect(service[action](body)).rejects.toThrow('Synthetic clock persistence failure');
    expect((await service.list()).installations[0].localReady).toBe(false);
    await expect(service.assertReadyForRecipe(f.initial.recipes[0].id)).rejects.toThrow(/recovery/);
    refuse=false;
    const reopened=createCustomerPackService({...f.options,pauseSchedules});
    const installed=(await reopened.list()).installations[0],r=resume(f.initial.id,installed);
    const done=await reopened.handle(r.route,'POST',r.body);expect(done).toMatchObject({status:200,body:{localReady:true}});
    expect(pauseSchedules).toHaveBeenCalledTimes(2);expect(f.reset).toHaveBeenCalledTimes(1);
    await expect(reopened[action](body)).resolves.toMatchObject({localReady:true});
    expect(await reopened.handle(r.route,'POST',r.body)).toEqual(done);
    expect(pauseSchedules).toHaveBeenCalledTimes(2);
  });

  it('preserves a reviewed native override while changing its published guidance, including rollback',async()=>{
    const f=await fixture(),old=await readFile(f.native,'utf8'),improved=old+'\nKeep this reviewed local instruction.\n';
    const pending=join(f.root,'profile/pending/skills');await mkdir(pending,{recursive:true});
    await writeFile(join(pending,'1234abcd.json'),JSON.stringify({id:'1234abcd',subsystem:'skills',action:'edit',summary:'Fictional improvement',origin:'background_review',created_at:'2026-09-22T00:00:00Z',payload:{action:'edit',name:'realbud-fixture-office-fixture-guidance',content:improved,replace_all:false}}));
    const proposal=(await f.service.proposals()).proposals[0];
    await f.service.reviewProposal({id:proposal.id,pendingDigest:proposal.pendingDigest,currentDigest:proposal.currentDigest,decision:'approve'});
    const preview=await f.service.previewUpgrade(f.next);expect(preview.skills[0].overrideKept).toBe(true);await f.service.upgrade(request(preview));
    expect(await readFile(f.native,'utf8')).toBe(improved);
    const rollback=(await f.service.handle(`/api/customer-packs/${f.initial.id}/rollback-preview`,'POST',{installationRevision:1}))!.body as CustomerPackChangePreview;
    expect(rollback.canApply).toBe(true);
    const {pack:_,...expected}=request(rollback);await f.service.rollback({...expected,packId:f.initial.id,installationRevision:1});
    expect(await readFile(f.native,'utf8')).toBe(improved);expect((await f.service.list()).installations[0]).toMatchObject({revision:1,installationRevision:3});
    expect(getRecipe(f.initial.recipes[0].id)).toMatchObject({steps:f.initial.recipes[0].steps,approvedRevision:null,schedule:null,status:'shadow'});
  });

  it('retires removed owned plans and skills without deleting work history and can restore them by reviewed rollback',async()=>{
    const initial=pack();initial.recipes.push({...initial.recipes[0],id:'wf-fixture-retiring',title:'Earlier optional task'});initial.workflows[0].recipeIds.push('wf-fixture-retiring');
    initial.skills.push({...initial.skills[0],id:'retiring-guidance',name:'Earlier guidance'});
    const f=await fixture(initial);f.next.recipes=f.next.recipes.filter(r=>r.id!=='wf-fixture-retiring');f.next.workflows[0].recipeIds=f.next.workflows[0].recipeIds.filter(id=>id!=='wf-fixture-retiring');f.next.skills=f.next.skills.filter(s=>s.id!=='retiring-guidance');
    const retired=join(f.root,'profile/skills/realbud-fixture-office-retiring-guidance/SKILL.md'),original=await readFile(retired,'utf8');
    await writeFile(join(f.root,'business-evidence.txt'),'Fictional business evidence; preserve exactly.');
    const preview=await f.service.previewUpgrade(f.next);expect(preview.canApply).toBe(true);await f.service.upgrade(request(preview));
    expect(getRecipe('wf-fixture-retiring')).toMatchObject({status:'shadow',schedule:null,approvedRevision:null});
    await expect(f.service.assertReadyForRecipe('wf-fixture-retiring')).rejects.toThrow(/retired/);await expect(readFile(retired)).rejects.toMatchObject({code:'ENOENT'});
    expect(await readFile(join(f.root,'business-evidence.txt'),'utf8')).toBe('Fictional business evidence; preserve exactly.');
    const rollback=(await f.service.handle('/api/customer-packs/fixture-office/rollback-preview','POST',{installationRevision:1}))!.body as CustomerPackChangePreview;
    expect(rollback.canApply).toBe(true);const {pack:_,...expected}=request(rollback);await f.service.rollback({...expected,packId:initial.id,installationRevision:1});
    expect(await readFile(retired,'utf8')).toBe(original);await expect(f.service.assertReadyForRecipe('wf-fixture-retiring')).resolves.toBeUndefined();
  });

  it('refuses changed files, active jobs and foreign installation versions',async()=>{
    const f=await fixture(),preview=await f.service.previewUpgrade(f.next);
    f.active.push(f.initial.recipes[0].id);await expect(f.service.upgrade(request(preview))).rejects.toThrow(/queued or running/);f.active.length=0;
    await expect(f.service.upgrade({...request(preview),expectedInstalledRevision:12})).rejects.toThrow(/installation changed/);
    await writeFile(f.native,'Local edits must not be overwritten.');const conflict=await f.service.previewUpgrade(f.next);expect(conflict.canApply).toBe(false);
    await expect(f.service.upgrade(request(preview))).rejects.toThrow(/locally edited/);expect(await readFile(f.native,'utf8')).toBe('Local edits must not be overwritten.');
  });

  it('holds recovery when a file or the trusted profile changes after durable intent',async()=>{
    const f=await fixture(),preview=await f.service.previewUpgrade(f.next),body=request(preview),original=await readFile(f.native,'utf8');
    const interrupted=createCustomerPackService({...f.options,resetRecipeApprovals:expected=>{f.reset(expected);throw new Error('Synthetic stop before files');}});
    await expect(interrupted.upgrade(body)).rejects.toThrow(/Synthetic stop/);
    await writeFile(f.native,'Keep the newer local edit.');
    await expect(f.reopen().upgrade(body)).rejects.toThrow(/changed after review/);
    expect(await readFile(f.native,'utf8')).toBe('Keep the newer local edit.');expect(f.reset).toHaveBeenCalledTimes(1);
    await writeFile(f.native,original);
    const wrongProfile=createCustomerPackService({...f.options,profileDirectory:()=>join(f.root,'different-profile')});
    await expect(wrongProfile.upgrade(body)).rejects.toThrow(/same Bud profile/);
    await expect(f.reopen().upgrade(body)).resolves.toMatchObject({revision:2,localReady:true});
  });

  it('holds a customer plan edit made during interrupted recovery rather than overwriting it',async()=>{
    const f=await fixture(),preview=await f.service.previewUpgrade(f.next),body=request(preview);
    const interrupted=createCustomerPackService({...f.options,resetRecipeApprovals:expected=>{f.reset(expected);throw new Error('Synthetic stop');}});
    await expect(interrupted.upgrade(body)).rejects.toThrow(/Synthetic stop/);
    const id=f.initial.recipes[0].id;saveRecipe({...getRecipe(id)!,description:'New customer decision during recovery.',expectedRevision:getRecipe(id)!.revision});
    await expect(f.reopen().upgrade(body)).rejects.toThrow(/Plans changed during/);
    expect(getRecipe(id)?.description).toBe('New customer decision during recovery.');expect((await f.service.list()).installations[0].pendingChange).toBeDefined();
  });

  it('rejects incompatible host-role removal and foreign target bytes with actionable previews',async()=>{
    const {austinCustomerPack}=await import('./customer-pack-definition.ts');
    const f=await fixture(austinCustomerPack());f.next.recipes=f.next.recipes.slice(1);f.next.workflows=f.next.workflows.filter(w=>!w.recipeIds.includes(f.initial.recipes[0].id));
    const preview=await f.service.previewUpgrade(f.next);expect(preview.canApply).toBe(false);expect(preview.conflicts.join(' ')).toContain('host adapter migration');
    const good=structuredClone(f.initial);good.revision++;const accepted=await f.service.previewUpgrade(good);
    const changed=structuredClone(good);changed.title='Another target';
    await expect(f.service.upgrade({...request(accepted),pack:changed})).rejects.toThrow(/target pack changed/);
  });

  it('does not let another pack’s shared support files change or disappear',async()=>{
    const f=await fixture(),other=pack();other.id='second-office';other.recipes=other.recipes.map(r=>({...r,id:`${r.id}-second`}));other.workflows[0].recipeIds=other.recipes.map(r=>r.id);
    const preview=await f.service.preview(other);await f.service.install(other,preview.digest);
    const conflict=await f.service.previewUpgrade(f.next);expect(conflict.canApply).toBe(false);expect(conflict.conflicts.join(' ')).toContain('shared with another');
    f.next.skills=[];const retiring=await f.service.previewUpgrade(f.next);expect(retiring.canApply).toBe(true);await f.service.upgrade(request(retiring));
    expect(await readFile(join(f.root,'vault/workflow-support/fixture-guidance/SKILL.md'),'utf8')).toBe(other.skills[0].instructions);
    expect((await f.service.list()).installations.find(i=>i.id===other.id)?.localReady).toBe(true);
  });

  it('serializes duplicate version changes across service instances and refuses tampered persisted intent',async()=>{
    const f=await fixture(),preview=await f.service.previewUpgrade(f.next),body=request(preview);
    const [one,two]=await Promise.all([f.service.upgrade(body),f.reopen().upgrade(body)]);expect(one).toEqual(two);expect(f.reset).toHaveBeenCalledTimes(1);
    const journal=await f.journal(),entry=journal.installs[f.initial.id];entry.history[0].generation=entry.generation;
    expect(()=>validateCustomerPackUpgradeJournal(entry)).toThrow(/history needs recovery/);
  });

  it('validates saved intent structure and exact plan digest before recovery, preserving corrupt journal bytes',async()=>{
    const f=await fixture(),preview=await f.service.previewUpgrade(f.next),body=request(preview);
    const interrupted=createCustomerPackService({...f.options,resetRecipeApprovals:()=>{throw new Error('Synthetic stop');}});
    await expect(interrupted.upgrade(body)).rejects.toThrow(/Synthetic stop/);
    const journal=await f.journal(),entry=journal.installs[f.initial.id];
    validateCustomerPackUpgradeJournal(entry);
    const changed=structuredClone(entry);changed.transition.recipes[0].after.description='Different unreviewed plan';
    expect(()=>validateCustomerPackUpgradeJournal(changed)).toThrow(/history needs recovery/);
    entry.transition.artifacts[0].key='native:../../config';const raw=JSON.stringify(journal);
    await writeFile(join(f.root,'customer-packs.json'),raw);
    await expect(f.reopen().upgrade(body)).rejects.toThrow(/history needs recovery/);
    expect(await readFile(join(f.root,'customer-packs.json'),'utf8')).toBe(raw);expect(f.reset).not.toHaveBeenCalled();
  });
});
