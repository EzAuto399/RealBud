/** Bound service waits as well as provider transport. Losing a race never retries effects. */
export function abortable<T>(promise:Promise<T>, signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason??new Error('cancelled'));};
    if(signal.aborted) { promise.catch(()=>{}); abort(); return; }
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
export async function* boundedStream<T>(source:AsyncIterable<T>,signal:AbortSignal):AsyncIterable<T> {
  const iterator=source[Symbol.asyncIterator]();
  try { while(true) { signal.throwIfAborted(); const item=await abortable(iterator.next(),signal); if(item.done)return; yield item.value; } }
  finally { if(iterator.return) { const closing=iterator.return(); if(signal.aborted) void closing.catch(()=>{}); else await abortable(closing,signal); } }
}
