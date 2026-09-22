import { useEffect, useRef, useState } from 'react';
import type { CustomerPackChangePreview, CustomerPackRecipe } from '@shared/customer-packs';
import { JOB_ABILITY_LABELS } from '@/lib/job-plan';
const button='min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
function PlanDefinition({plan}:{plan:CustomerPackRecipe|null}) {
  if(!plan)return <p className="text-sm text-ink-secondary">No current plan</p>;
  return <div className="space-y-2 text-sm break-words"><p className="font-medium">{plan.title}</p><p className="whitespace-pre-wrap">{plan.description||'No additional description.'}</p>
    <ol className="list-decimal pl-5 space-y-1">{plan.steps.map((step,index)=><li key={index}>{step}</li>)}</ol>
    <dl className="space-y-2"><div><dt className="font-medium">What Bud may prepare</dt><dd>{plan.capabilities.map(capability=>JOB_ABILITY_LABELS[capability]).join(' · ')}</dd></div>
      <div><dt className="font-medium">Permitted websites</dt><dd>{plan.allowedOrigins.length?plan.allowedOrigins.join(', '):'None; this plan uses supplied sources.'}</dd></div>
      <div><dt className="font-medium">Run limits</dt><dd>Up to {plan.limits.maxRuntimeMinutes} minutes and {plan.limits.maxTurns} assistant steps.</dd></div>
      <div><dt className="font-medium">Schedule</dt><dd>{plan.schedule?`${plan.schedule.time}, ${plan.schedule.weekdays.map(day=>['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day]).join(', ')}`:'Off; run only after reviewing and approving the plan.'}</dd></div>
      <div><dt className="font-medium">Required evidence</dt><dd className="whitespace-pre-wrap">{plan.evidence||'No additional evidence instructions.'}</dd></div>
      {plan.siteNotes&&<div><dt className="font-medium">Working instructions</dt><dd className="whitespace-pre-wrap">{plan.siteNotes}</dd></div>}</dl></div>;
}
export function CustomerPackChangeReview({preview,busy,apply,cancel}:{preview:CustomerPackChangePreview;busy:boolean;apply:()=>void;cancel:()=>void}) {
  const [confirmed,setConfirmed]=useState(false);
  const region=useRef<HTMLElement>(null);
  useEffect(()=>{region.current?.focus({preventScroll:true});region.current?.scrollIntoView({block:'start'});},[preview.previewDigest]);
  return <section ref={region} tabIndex={-1} aria-label="Review pack version change" className="rounded-lg border border-agency p-4 space-y-3 focus-visible:outline-2 focus-visible:outline-agency">
    <h4 className="font-medium">{preview.action==='rollback'?'Roll back':'Upgrade'} {preview.pack.title} to version {preview.pack.revision}</h4>
    <p className="text-sm">This changes the saved plans and instruction files shown below. Previous configuration and work history stay saved. Every affected plan will be paused and require fresh approval; schedules remain off.</p>
    <ul className="space-y-2 text-sm">{preview.recipes.map(recipe=><li key={recipe.id}>
      <details><summary className="min-h-11 cursor-pointer">{recipe.after.title}: {recipe.action==='retire'?'retire and keep its saved history':recipe.action==='preserve'?'keep your plan and clear approval':recipe.action}</summary>
        <div className="grid gap-4 sm:grid-cols-2"><div className="min-w-0 rounded border border-line p-3 space-y-3"><h5 className="font-medium">Current plan</h5><PlanDefinition plan={recipe.before}/></div>
          <div className="min-w-0 rounded border border-line p-3 space-y-3"><h5 className="font-medium">After this change</h5><PlanDefinition plan={recipe.after}/></div></div></details>
    </li>)}</ul>
    {preview.skills.length>0&&<ul className="text-sm space-y-1">{preview.skills.map(skill=><li key={skill.id}>{skill.id}: {skill.action}{skill.overrideKept?' · your reviewed instruction revision is kept':''}</li>)}</ul>}
    <details><summary className="min-h-11 cursor-pointer text-sm">Review exact instruction file changes</summary><div className="space-y-3">{preview.instructions.map(instruction=><div key={instruction.key}><h5 className="font-medium">{instruction.key}</h5><div className="grid gap-3 sm:grid-cols-2"><div><h6>Before</h6><pre tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{instruction.before??'No existing file'}</pre></div><div><h6>After</h6><pre tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{instruction.after??'Retired; prior contents retained in saved configuration'}</pre></div></div></div>)}</div></details>
    {preview.conflicts.length>0&&<div role="alert" className="text-sm text-hold"><p>Resolve these conflicts, then preview again:</p><ul className="list-disc pl-5">{preview.conflicts.map((conflict,index)=><li key={index}>{conflict}</li>)}</ul></div>}
    <label className="flex min-h-11 gap-2 items-start text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy||!preview.canApply} onChange={event=>setConfirmed(event.target.checked)}/><span>I reviewed this exact change and understand that affected plans need fresh approval.</span></label>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy||!preview.canApply||!confirmed} onClick={apply}>Apply reviewed {preview.action}</button><button className={button} disabled={busy} onClick={cancel}>Cancel version change</button></div>
  </section>;
}
