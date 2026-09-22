import {useRef,useState} from 'react';
import {useStore} from '@/state/store';
import {useWorkspaceTabs} from '@/lib/workspace-tabs';
import {MAX_WORKSPACE_TABS} from '@shared/workspace-tabs';
import {workspaceViewHash} from '@/lib/app-route';

/** Opening a shortcut changes only this private workspace's display settings. */
export function OpenBillsView() {
  const tabs=useWorkspaceTabs(),{dispatch}=useStore(),opening=useRef(false);
  const [error,setError]=useState('');
  const open=async()=>{
    if(opening.current || !tabs.data?.state) return;
    opening.current=true;setError('');
    try{
      const state=tabs.data.state,existing=state.tabs.find(tab=>tab.view.kind==='bills' && tab.view.filter==='all');
      let id=existing?.id;
      if(existing){if(!existing.visible)await tabs.save(state.tabs.map(tab=>tab.id===existing.id?{...tab,visible:true}:tab),state.revision);}
      else{
        if(state.tabs.length>=MAX_WORKSPACE_TABS)throw new Error('Your saved views are full. Remove an unused shortcut in Manage views before opening bills. Business records stay saved.');
        id=`view-${crypto.randomUUID()}`;
        await tabs.save([...state.tabs,{id,label:'Bills and calendar',visible:true,view:{kind:'bills',filter:'all'}}],state.revision);
      }
      window.location.hash=workspaceViewHash(id!);dispatch({type:'showWorkspaceTab',id:id!});
    }catch(cause){setError(cause instanceof Error?cause.message:'The bills view could not be saved. Refresh your views and try again.');}
    finally{opening.current=false;}
  };
  const button='min-h-11 rounded border border-line bg-sheet px-3 py-2 text-sm disabled:opacity-40';
  return <div className="space-y-2"><button className={button} disabled={tabs.loading||tabs.saving||!tabs.data?.state} onClick={()=>void open()}>Open bills and calendar</button>{(error||tabs.error||tabs.data?.recovery)&&<><p role="alert" className="text-sm text-danger">{error||tabs.error||tabs.data?.recovery?.message}</p><button className={button} onClick={()=>dispatch({type:'showWorkspaceTab'})}>Manage views</button></>}</div>;
}
