import { useState } from 'react';

type Mapping = { columns: { date: string; amount: string; narrative: string; reference: string }; dateFormat: string; rules: {propertyId:string;reference:string;aliases:string[]}[] };
const control = 'min-h-11 rounded border border-line bg-sheet px-3 py-2 text-sm text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
export function BankReviewAmendment({mapping,busy,onCancel,onCreate}:{mapping:Mapping;busy:boolean;onCancel:()=>void;onCreate:(mapping:Mapping,reason:string)=>Promise<void>}) {
  const [columns,setColumns] = useState(mapping.columns), [dateFormat,setDateFormat] = useState(mapping.dateFormat);
  const [rules,setRules] = useState(()=>structuredClone(mapping.rules)), [rulePage,setRulePage] = useState(0);
  const [reason,setReason] = useState('');
  const changeRule = (index:number,patch:Partial<Mapping['rules'][number]>) => setRules(current=>current.map((rule,i)=>i===index?{...rule,...patch}:rule));
  return <section aria-label="Correct bank review" className="rounded-lg border border-agency p-3 space-y-3">
    <h3 className="font-medium">Create a corrected review</h3>
    <p className="text-sm text-ink-secondary">The same original bank file will be used. Earlier decisions and downloads stay in history. Review every transaction again before downloading the corrected copy.</p>
    <p className="text-sm text-hold">If an earlier copy was already imported, reconcile it in REI Cloud before importing a corrected copy.</p>
    <div className="grid gap-2 sm:grid-cols-2">{(['date','amount','narrative','reference'] as const).map(key=><label key={key} className="text-sm capitalize">Corrected {key} column<input className={`block w-full mt-1 ${control}`} disabled={busy} value={columns[key]} onChange={e=>setColumns({...columns,[key]:e.target.value})}/></label>)}</div>
    <label className="block text-sm">Corrected date format<select className={`block mt-1 ${control}`} disabled={busy} value={dateFormat} onChange={e=>setDateFormat(e.target.value)}><option>DD/MM/YYYY</option><option>YYYY-MM-DD</option></select></label>
    <fieldset className="space-y-3"><legend className="text-sm font-medium">Corrected property references</legend>
      <p className="text-xs text-ink-muted">Use the exact reference from your property records. Each payer alias is separate; punctuation is kept as entered. Keep these fields unchanged if only your transaction decisions need correction.</p>
      {rules.slice(rulePage*10,(rulePage+1)*10).map((rule,offset)=>{const index=rulePage*10+offset;return <div key={index} className="rounded border border-line p-3 space-y-2">
        <div className="grid gap-2 sm:grid-cols-2"><label className="block text-sm">Property name<input aria-label={`Corrected property ${index+1}`} className={`block w-full mt-1 ${control}`} disabled={busy} value={rule.propertyId} onChange={e=>changeRule(index,{propertyId:e.target.value})}/></label>
          <label className="block text-sm">Reference number<input aria-label={`Corrected reference for property ${index+1}`} className={`block w-full mt-1 ${control}`} disabled={busy} value={rule.reference} onChange={e=>changeRule(index,{reference:e.target.value})}/></label></div>
        {rule.aliases.map((alias,aliasIndex)=><div key={aliasIndex} className="flex items-end gap-2"><label className="block min-w-0 flex-1 text-sm">Payer alias {aliasIndex+1}<input aria-label={`Payer alias ${aliasIndex+1} for property ${index+1}`} className={`block w-full mt-1 ${control}`} disabled={busy} value={alias} onChange={e=>changeRule(index,{aliases:rule.aliases.map((value,i)=>i===aliasIndex?e.target.value:value)})}/></label><button className={control} disabled={busy} aria-label={`Remove alias ${aliasIndex+1} for property ${index+1}`} onClick={()=>changeRule(index,{aliases:rule.aliases.filter((_,i)=>i!==aliasIndex)})}>Remove</button></div>)}
        <div className="flex flex-wrap gap-2"><button className={control} disabled={busy||rule.aliases.length>=20} onClick={()=>changeRule(index,{aliases:[...rule.aliases,'']})}>Add payer alias</button><button className={control} disabled={busy} onClick={()=>{setRules(current=>current.filter((_,i)=>i!==index));setRulePage(current=>Math.min(current,Math.max(0,Math.ceil((rules.length-1)/10)-1)));}}>Remove property {index+1}</button></div>
      </div>;})}
      <div className="flex flex-wrap items-center gap-2 text-sm"><button className={control} disabled={busy||rules.length>=2000} onClick={()=>{setRules(current=>[...current,{propertyId:'',reference:'',aliases:[]}]);setRulePage(Math.floor(rules.length/10));}}>Add property</button>
        {rules.length>10&&<><button className={control} disabled={busy||rulePage===0} onClick={()=>setRulePage(rulePage-1)}>Previous properties</button><span>{rulePage*10+1}–{Math.min((rulePage+1)*10,rules.length)} of {rules.length}</span><button className={control} disabled={busy||(rulePage+1)*10>=rules.length} onClick={()=>setRulePage(rulePage+1)}>Next properties</button></>}
      </div>
    </fieldset>
    <label className="block text-sm">Correction reason<input className={`block w-full mt-1 ${control}`} maxLength={500} disabled={busy} value={reason} onChange={e=>setReason(e.target.value)} placeholder="What needs correcting?"/></label>
    <div className="flex flex-wrap gap-2"><button className={control} disabled={busy || !reason.trim()} onClick={()=>void onCreate({columns,dateFormat,rules},reason)}>Create corrected review</button><button className={control} disabled={busy} onClick={onCancel}>Cancel correction</button></div>
  </section>;
}
