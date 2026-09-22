import { useEffect, useState } from 'react';
import { api, useStore, type ConfigStatus } from '@/state/store';
import { Card } from './SettingsPrimitives';
import { officeSources } from '@/lib/connected-apps-refresh';

/** Mounted only inside an authenticated service-administration session. */
export function ManagedConnectionsCard() {
  const {state,dispatch}=useStore();
  const [endpoint,setEndpoint]=useState(''),[credential,setCredential]=useState('');
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [apps,setApps]=useState<string[]>([]),[withdrawn,setWithdrawn]=useState(false);
  const managed=Boolean(state.config?.composio.managed);
  useEffect(()=>{
    void api('/api/office-link').then((status:{serviceWithdrawn?:boolean})=>setWithdrawn(Boolean(status?.serviceWithdrawn))).catch(()=>{});
    if(!managed){setApps([]);return;}
    void api('/api/connectors/catalog').then((result:{cards?:{slug:string;label:string}[]})=>setApps((result?.cards??[]).map(card=>card.label||card.slug))).catch(()=>setApps([]));
  },[managed]);
  if (withdrawn) return <Card title="Managed connections" subtitle="Set up automatically when this computer was added to your RealBud account.">
    <p role="status" className="text-sm text-ink-secondary">Service access was withdrawn. Your records are kept, and everything already saved stays readable and exportable on this computer.</p>
    <p className="mt-2 text-sm text-ink-muted">Connected accounts and the model this computer used are no longer available. Ask service support to add this computer again to restore them.</p>
  </Card>;
  if (managed) return <Card title="Managed connections" subtitle="Set up automatically when this computer was added to your RealBud account.">
    <p className="text-sm text-ink-secondary">Managed by RealBud service{apps.length?` · apps: ${apps.join(', ')}`:''}.</p>
    <p className="mt-2 text-sm text-ink-muted">Nothing to enter here. The service holds the provider keys and checks this computer’s subscription and connection access on every request. Staff finish account sign-in under Apps.</p>
  </Card>;
  return <Card title="Managed connections" subtitle="The service holds provider keys. This computer receives access for one private workspace.">
    <p className="text-sm text-ink-secondary">A computer added through your RealBud account is set up automatically and needs nothing here. Use this form only for an installation that was not, after configuring the provider keys on the protected service.</p>
    <form className="mt-3 grid gap-3" onSubmit={event=>{
      event.preventDefault(); if(busy)return;setBusy(true);setError('');setMessage('');
      void api('/api/connected-apps/managed/setup',{method:'POST',body:JSON.stringify({endpoint:endpoint.trim(),credential:credential.trim()})},{timeoutMs:40_000})
        .then((result:{config:ConfigStatus})=>{dispatch({type:'configStatus',config:result.config});setCredential('');setMessage('Managed access checked and saved. Local Composio project keys were removed.');void officeSources.refresh();})
        .catch(reason=>setError(reason instanceof Error?reason.message:'Managed access could not be saved.'))
        .finally(()=>setBusy(false));
    }}>
      <label className="grid gap-1 text-sm">Service URL<input type="url" required value={endpoint} onChange={event=>setEndpoint(event.target.value)} placeholder="https://connections.example.com" autoComplete="off" disabled={busy} className="min-w-0 rounded border border-line bg-sheet px-3 py-2 text-ink" /></label>
      <label className="grid gap-1 text-sm">Installation credential<input type="password" required value={credential} onChange={event=>setCredential(event.target.value)} placeholder="Provided by service administration" autoComplete="new-password" disabled={busy} className="min-w-0 rounded border border-line bg-sheet px-3 py-2 text-ink" /></label>
      <p className="text-xs leading-relaxed text-ink-muted">This checks account metadata, then switches this workspace to the managed service and removes its local Composio keys. It does not read email messages or send mail. Staff finish account sign-in under Apps.</p>
      <button disabled={busy||!endpoint.trim()||!credential.trim()} type="submit" className="justify-self-start rounded border border-line px-3 py-2 text-sm hover:bg-raised disabled:opacity-50">{busy?'Checking access…':'Check and save managed access'}</button>
      {message&&<p role="status" className="text-sm text-ink-secondary">{message}</p>}
      {error&&<p role="alert" className="text-sm text-danger">{error}</p>}
    </form>
  </Card>;
}
