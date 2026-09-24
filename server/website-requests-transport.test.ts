import { describe, expect, it, vi } from 'vitest';
import { createWebsiteRequestsTransport } from './website-requests-transport.ts';
const token='a'.repeat(64);
const parse=(value:unknown)=>value;
describe('website request transport',()=>{
  it('pins origin, denies redirects, bounds time and uses only the separate bearer',async()=>{
    const fetcher=vi.fn(async()=>Response.json({ok:true}));const transport=createWebsiteRequestsTransport(fetcher);
    await expect(transport.post('commands/poll',token,{cursor:0},parse)).resolves.toEqual({ok:true});
    const [url,init]=(fetcher.mock.calls as unknown as [string,RequestInit][])[0]!;
    expect(url).toBe('https://realbud.app/api/installations/commands/poll');expect(init.redirect).toBe('error');expect(init.signal).toBeInstanceOf(AbortSignal);expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
  });
  it('rejects off-origin and same-origin wrong-path response substitution',async()=>{
    for(const url of ['https://attacker.invalid/steal','https://realbud.app/api/installations/report']) {
      const response=Response.json({ok:true});Object.defineProperty(response,'url',{value:url});
      const transport=createWebsiteRequestsTransport(vi.fn(async()=>response));await expect(transport.post('commands/poll',token,{},parse)).rejects.toThrow(/website could not/);
    }
  });
  it('bounds chunked bodies without trusting content length and cancels its reader',async()=>{
    const cancel=vi.fn();const response=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(256_001));},cancel}),{headers:{'content-type':'application/json','content-length':'1'}});
    const transport=createWebsiteRequestsTransport(vi.fn(async()=>response));await expect(transport.post('commands/poll',token,{},parse)).rejects.toThrow(/website could not/);expect(cancel).toHaveBeenCalled();
  });
  it('rejects overlarge outbound metadata before fetch and redacts parser/network errors',async()=>{
    const fetcher=vi.fn(async()=>Response.json({ok:true}));const transport=createWebsiteRequestsTransport(fetcher);
    await expect(transport.post('commands/poll',token,{private:'x'.repeat(64_000)},parse)).rejects.toThrow(/website could not/);expect(fetcher).not.toHaveBeenCalled();
    await expect(transport.post('commands/poll',token,{},()=>{throw new Error(`private secret ${token}`);})).rejects.toThrow('The website could not confirm this request. Reconnect and try again.');
  });
  it('aborts a live wait during shutdown and accepts neither HTML nor partial JSON',async()=>{
    let signal:AbortSignal|null=null;
    const transport=createWebsiteRequestsTransport(vi.fn(async(_url,init)=>new Promise<Response>((_resolve,reject)=>{signal=init!.signal as AbortSignal;signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})));
    const waiting=transport.post('commands/poll',token,{},parse);transport.abort();await expect(waiting).rejects.toThrow(/website could not/);expect(signal!.aborted).toBe(true);
    for(const response of [new Response('<html>oops</html>',{headers:{'content-type':'text/html'}}),new Response('{',{headers:{'content-type':'application/json'}})])await expect(createWebsiteRequestsTransport(vi.fn(async()=>response)).post('commands/poll',token,{},parse)).rejects.toThrow(/website could not/);
  });
});
it.each(['v2/command-grants','v2/command-grants/cancel','v2/remote-approvers/clock','v2/remote-approvers/begin','v2/remote-approvers/status','v2/remote-approvers/confirm','v2/remote-approvers/revoke'] as const)('v2 route %s has its own fixed path and no v1 retry',async route=>{
 const fetcher=vi.fn(async()=>Response.json({error:'denied'},{status:403}));
 await expect(createWebsiteRequestsTransport(fetcher).post(route,token,{},parse)).rejects.toThrow(/no longer active/);
 expect(fetcher).toHaveBeenCalledTimes(1);expect((fetcher.mock.calls as unknown as [string][])[0]![0]).toBe(`https://realbud.app/api/installations/${route}`);
});

it('allows the larger exact review upload budget only on protocol 2 review',async()=>{
 const fetcher=vi.fn(async()=>Response.json({ok:true})),transport=createWebsiteRequestsTransport(fetcher);
 await transport.post('v2/work/review',token,{template:'x'.repeat(80_000)},parse);
 for(const route of ['commands/poll','v2/work/claim','v2/work/ack','v2/work/cancel'] as const)await expect(transport.post(route,token,{template:'x'.repeat(80_000)},parse)).rejects.toThrow();
 await expect(transport.post('v2/work/review',token,{template:'x'.repeat(128_000)},parse)).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();
});
