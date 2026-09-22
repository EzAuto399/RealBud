import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it, expect } from 'vitest';
import { WorkflowDatabase } from './workflow-database.ts';
import { createRemoteDisclosureReview, restoreRemoteTemplate, validateRemoteTemplate, REMOTE_TEMPLATE_KIND, type RemoteDisclosureTemplate } from './website-remote-disclosure.ts';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'rb-remote-disclosure-'));const db=new WorkflowDatabase({dir,key:Buffer.alloc(32,7)});cleanup.push(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const descriptor={id:randomUUID(),operation:'prepare-recipe' as const,revision:'a'.repeat(64),label:'Briefing'};
 let text='Full reviewed instructions';
 const capture=async():Promise<RemoteDisclosureTemplate>=>({version:1,policy:'exact-reviewed-template-v1',descriptor,mailboxAlias:null,sections:[{label:'Instructions',value:text}]});
 const service=createRemoteDisclosureReview({db,workspaceId:randomUUID(),catalog:async()=>[descriptor],capture});
 return {db,descriptor,service,change:()=>text+=' changed'};
}
it('requires attended exact persisted review, preserves replay and invalidates changed text',async()=>{
 const f=fixture();const [row]=await f.service.preview({descriptorIds:[f.descriptor.id],mailboxAlias:null});
 const scope={descriptorId:f.descriptor.id,descriptorRevision:f.descriptor.revision,disclosureDigest:row.value.digest};
 await expect(f.service.requireApproved([scope])).rejects.toThrow(/review/);
 const body={reviews:[{id:row.id,revision:row.revision,digest:row.value.digest}]};
 expect(await f.service.approve(body)).toEqual([scope]);expect(await f.service.approve(body)).toEqual([scope]);await f.service.requireApproved([scope]);
 const published=await f.service.approvedTemplate(scope);expect(published).toEqual(row.value.template);published.sections[0].value='caller mutation';expect((await f.service.approvedTemplate(scope)).sections[0].value).toBe('Full reviewed instructions');
 f.change();await expect(f.service.approvedTemplate(scope)).rejects.toThrow(/review/);await expect(f.service.requireApproved([scope])).rejects.toThrow(/review/);
});
it('restored review retains complete text but loses disclosure authority and rejects substituted bytes',async()=>{
 const f=fixture();const [row]=await f.service.preview({descriptorIds:[f.descriptor.id],mailboxAlias:null});await f.service.approve({reviews:[{id:row.id,revision:row.revision,digest:row.value.digest}]});
 const current=f.db.get<any>(REMOTE_TEMPLATE_KIND,row.id)!;const restored=restoreRemoteTemplate(row.id,current.value);expect(restored.approved).toBe(false);expect(restored.restored).toBe(true);expect(restored.template).toEqual(current.value.template);
 expect(()=>validateRemoteTemplate(row.id,{...restored,approved:true})).toThrow();expect(()=>validateRemoteTemplate(row.id,{...restored,template:{...restored.template,sections:[]}})).toThrow();
});
it('changed capture between preview and consent does not persist approval',async()=>{
 const f=fixture();const [row]=await f.service.preview({descriptorIds:[f.descriptor.id],mailboxAlias:null});f.change();await expect(f.service.approve({reviews:[{id:row.id,revision:row.revision,digest:row.value.digest}]})).rejects.toThrow();expect(f.db.get<any>(REMOTE_TEMPLATE_KIND,row.id)!.value.approved).toBe(false);
});
