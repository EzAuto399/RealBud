import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
const control=vi.hoisted(()=>({fault:undefined as undefined|((path:string,value:any,stage:'before'|'after')=>void)}));
vi.mock('../../server/private-json.ts',async importOriginal=>{const actual=await importOriginal<typeof import('../../server/private-json.ts')>();return {...actual,writePrivateJson:async(path:string,value:unknown,...options:any[])=>{control.fault?.(path,value,'before');await (actual.writePrivateJson as any)(path,value,...options);control.fault?.(path,value,'after');}};});
import { reviewFixture, clearReviewRoots, packChangeRequest } from './independent-fixture.ts';
import { PACK_JOURNAL_MAX_BYTES } from '../../server/customer-pack-skill-history.ts';
import { loadRecipes } from '../../server/recipes.ts';
import type { PackSkillArchivePreview } from '../../shared/customer-packs.ts';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const confirm=(p:PackSkillArchivePreview)=>({expectedInstalledDigest:p.installedDigest,expectedInstalledRevision:p.installedRevision,expectedActiveDigest:p.activeDigest,expectedActiveRevision:p.activeRevision,expectedHead:p.head,expectedPreviewDigest:p.previewDigest});
afterEach(async()=>{control.fault=undefined;await clearReviewRoots();});
async function seeded(full=false){
 const f=await reviewFixture(),journal=await f.journal(),entry=journal.installs[f.initial.id],baseline=await f.nativeText(),skillId=f.initial.skills[0].id;
 const versions=Array.from({length:6},(_,index)=>{const content=index?baseline+`\nReviewed fictional improvement ${index+1}.\n`:baseline;return {revision:index+1,content,digest:sha(content),createdAt:'2026-09-22T00:00:00.000Z',reason:'Reviewed fictional revision'};});
 entry.overrides={[skillId]:{activeRevision:6,versions}};
 if(full){entry.receipt.note='';entry.receipt.note='x'.repeat(PACK_JOURNAL_MAX_BYTES-Buffer.byteLength(JSON.stringify(journal)));}
 await writeFile(f.journalPath,JSON.stringify(journal),{mode:0o600});await writeFile(f.native,versions.at(-1)!.content,{mode:0o600});
 const preview=await f.service.skillArchivePreview(f.initial.id,skillId);expect(preview.canArchive).toBe(true);
 return {...f,skillId,request:confirm(preview),before:JSON.stringify(journal),nativeBefore:versions.at(-1)!.content,recipesBefore:structuredClone(loadRecipes(true)),archive:(resume=false)=>f.reopen().archiveSkill(f.initial.id,skillId,confirm(preview),resume)};
}
describe('independent actual instruction archival recovery',()=>{
 it('completes and retries archival from an already-full legacy journal through the real private writer',async()=>{
  const f=await seeded(true);expect(Buffer.byteLength(f.before)).toBe(PACK_JOURNAL_MAX_BYTES);
  await expect(f.archive()).resolves.toMatchObject({localReady:true});
  const after=await f.journal(),raw=await readFile(f.journalPath,'utf8');expect(after.version).toBe(2);expect(after.installs[f.initial.id].skillArchiveIntent).toBeUndefined();expect(after.installs[f.initial.id].overrides[f.skillId].versions.map((v:any)=>v.revision)).toEqual([5,6]);
  expect(Buffer.byteLength(raw)).toBeLessThan(PACK_JOURNAL_MAX_BYTES);expect(await f.nativeText()).toBe(f.nativeBefore);expect(loadRecipes(true)).toEqual(f.recipesBefore);
  await expect(f.archive()).resolves.toMatchObject({localReady:true});expect(await readFile(f.journalPath,'utf8')).toBe(raw);
 });
 it('holds a scope change after archive-file durability and resumes only the original scope',async()=>{
  const f=await seeded();control.fault=(_path,value,stage)=>{if(stage==='after'&&value.format==='realbud-skill-history')f.changeWorkroom();};
  await expect(f.archive()).rejects.toThrow(/workspace|instruction/i);control.fault=undefined;
  const held=await f.journal();expect(held.installs[f.initial.id].skillArchiveIntent).toBeDefined();expect(held.installs[f.initial.id].overrides[f.skillId].versions).toHaveLength(6);expect(await f.nativeText()).toBe(f.nativeBefore);expect(loadRecipes(true)).toEqual(f.recipesBefore);
  await expect(f.archive(true)).rejects.toThrow(/workspace|review/i);f.originalScope();await expect(f.archive(true)).resolves.toMatchObject({localReady:true});expect(loadRecipes(true)).toEqual(f.recipesBefore);
 });
 it('rejects a v1 live journal when its only skill archive root survives in an immutable configuration archive',async()=>{
  const f=await seeded();await f.archive();
  for(let revision=2;revision<=4;revision++){
   const pack={...structuredClone(f.initial),revision,skills:[]};
   await f.service.upgrade(packChangeRequest(await f.service.previewUpgrade(pack)));
  }
  const preview=(await f.service.handle(f.route('archive-preview'),'POST',{}))!.body as any;
  await f.service.handle(f.route('archive'),'POST',{expectedInstalledDigest:preview.installedDigest,expectedInstalledRevision:preview.installedRevision,expectedPreviewDigest:preview.previewDigest});
  const journal=await f.journal(),entry=journal.installs[f.initial.id];
  expect(Object.values(entry.overrides??{})).toHaveLength(0);expect(entry.history.every((s:any)=>Object.values(s.overrides??{}).length===0)).toBe(true);
  delete entry.lastSkillArchive;journal.version=1;await writeFile(f.journalPath,JSON.stringify(journal),{mode:0o600});
  await expect(f.reopen().list()).rejects.toThrow(/version|history|recovery/i);
 });
 it('reconciles a lost reply after head publication without another batch or altered active text',async()=>{
  const f=await seeded();control.fault=(path,value,stage)=>{if(stage==='after'&&path===f.journalPath&&value.installs?.[f.initial.id]?.overrides?.[f.skillId]?.archiveHead&&!value.installs[f.initial.id].skillArchiveIntent)throw new Error('Synthetic lost completion reply');};
  await expect(f.archive()).rejects.toThrow('Synthetic lost completion reply');control.fault=undefined;
  const committed=await readFile(f.journalPath,'utf8');await expect(f.archive()).resolves.toMatchObject({localReady:true});expect(await readFile(f.journalPath,'utf8')).toBe(committed);expect(await f.nativeText()).toBe(f.nativeBefore);expect(loadRecipes(true)).toEqual(f.recipesBefore);
 });
});
