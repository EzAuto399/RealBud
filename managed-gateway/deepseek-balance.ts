/** Private supplier health only. Never a per-client usage or billing authority. */
import { exact,integer,object,requireThat } from './contracts.ts';
import { abortable } from './abort.ts';
export interface BalanceSnapshot {isAvailable:boolean;balances:{currency:'CNY'|'USD';total:string;granted:string;toppedUp:string}[];updatedAt:number}
export class DeepSeekBalancePoller {
  private readonly transport:typeof fetch|undefined;
  private readonly secret:()=>Promise<string>;
  private readonly now:()=>number;
  private snapshot:BalanceSnapshot|undefined;
  private inFlight:Promise<ReturnType<DeepSeekBalancePoller['status']>>|undefined;
  private failures=0;private dueAt=0;private error:string|undefined;
  constructor(options:{fetch?:typeof fetch;secret:()=>Promise<string>;now?:()=>number}){this.transport=options.fetch;this.secret=options.secret;this.now=options.now??Date.now;}
  status(){return {configured:!!this.transport,lastUpdatedAt:this.snapshot?.updatedAt??null,stale:!this.snapshot || this.now()-this.snapshot.updatedAt>=120_000,error:this.error??null,nextAttemptAt:this.dueAt,consecutiveFailures:this.failures,snapshot:this.snapshot?structuredClone(this.snapshot):null,perClientHistory:'unsupported_unconfigured' as const};}
  /** Called by the owning service's clock. One flight, min 60s spacing, max 10m error backoff.
   * No timer, daemon, secret lookup or network call is started by construction/status. */
  poll(){
    if(!this.transport || this.now()<this.dueAt)return Promise.resolve(this.status());
    if(this.inFlight)return this.inFlight;
    this.inFlight=this.read().finally(()=>{this.inFlight=undefined;});return this.inFlight;
  }
  private async read(){
    const signal=AbortSignal.timeout(5000);
    try {
      const key=await abortable(this.secret(),signal);requireThat(key.length>0,'balance_secret_unavailable');
      const response=await abortable(this.transport!('https://api.deepseek.com/user/balance',{method:'GET',redirect:'error',signal,headers:{Authorization:`Bearer ${key}`,Accept:'application/json'}}),signal);
      if(!response.ok){void response.body?.cancel().catch(()=>{});requireThat(false,'balance_request_failed');}
      requireThat(response.body,'invalid_balance_response');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{while(true){const part=await abortable(reader.read(),signal);if(part.done)break;bytes+=part.value.byteLength;requireThat(bytes<=64000,'balance_response_too_large');chunks.push(part.value);}}finally{void reader.cancel().catch(()=>{});}
      let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{requireThat(false,'invalid_balance_response');}object(value);exact(value,['is_available','balance_infos']);requireThat(typeof value.is_available==='boolean' && Array.isArray(value.balance_infos) && value.balance_infos.length>0 && value.balance_infos.length<=2,'invalid_balance_response');
      const currencies=new Set<string>();const balances:BalanceSnapshot['balances']=[];
      for(const item of value.balance_infos){object(item);exact(item,['currency','total_balance','granted_balance','topped_up_balance']);requireThat((item.currency==='USD' || item.currency==='CNY') && !currencies.has(item.currency),'invalid_balance_currency');currencies.add(item.currency);
        for(const name of ['total_balance','granted_balance','topped_up_balance'])requireThat(typeof item[name]==='string' && /^-?\d{1,18}(\.\d{1,9})?$/.test(item[name]),'invalid_balance_amount');
        const scaled=(text:string)=>{const negative=text.startsWith('-'),[whole,decimal='']=(negative?text.slice(1):text).split('.');return (BigInt(whole)*1_000_000_000n+BigInt(decimal.padEnd(9,'0')))*(negative?-1n:1n);};
        requireThat(scaled(String(item.total_balance))===scaled(String(item.granted_balance))+scaled(String(item.topped_up_balance)),'inconsistent_balance');
        balances.push({currency:item.currency,total:String(item.total_balance),granted:String(item.granted_balance),toppedUp:String(item.topped_up_balance)});
      }
      const updatedAt=this.now();integer(updatedAt,Number.MAX_SAFE_INTEGER);this.snapshot={isAvailable:value.is_available,balances,updatedAt};this.failures=0;this.error=undefined;this.dueAt=updatedAt+60_000;
    }catch{this.failures=Math.min(this.failures+1,10);this.error='balance_sync_failed';this.dueAt=this.now()+Math.min(600_000,60_000*2**(this.failures-1));}
    return this.status();
  }
}
