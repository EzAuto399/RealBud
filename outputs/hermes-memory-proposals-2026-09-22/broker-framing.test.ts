import { createConnection } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { startMemoryProposalBroker } from '../../server/hermes-memory-proposal-broker.ts';
vi.mock('../../server/managed-service.ts', () => ({ managedService: { assertCapability: () => {} } }));
const packet = (authority: string, token: string, body: string, path = '/mcp', close = false) => `POST ${path} HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: ${token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: ${close ? 'close' : 'keep-alive'}\r\n\r\n${body}`;
describe('review observation: real broker early-response HTTP framing', () => {
  it.each([403,405,400,413])('does not execute an embedded request in the rejected %i body', async expected => {
    const propose = vi.fn(async () => ({version:1 as const,id:'000000ab',reviewLocation:'You → Bud → Bud’s memory' as const}));
    const broker = await startMemoryProposalBroker({isActive:()=>true,propose,assertCapability:()=>{}});
    try {
      const url = new URL(broker.descriptor.url), token = broker.descriptor.headers[0].value;
      const mutation = JSON.stringify({jsonrpc:'2.0',id:77,method:'tools/call',params:{name:'memory_propose',arguments:{requestId:'framing-fixture',payload:{target:'memory',action:'add',content:'Fictional preference.'}}}});
      const embedded = packet(url.host,token,mutation);
      const body = (expected === 413 ? 'x'.repeat(80 * 1024) : '') + embedded;
      const outer = packet(url.host,expected === 403 ? 'Bearer invalid' : token,body,expected === 405 ? '/unsupported' : '/mcp');
      const ping = packet(url.host,token,JSON.stringify({jsonrpc:'2.0',id:987,method:'ping'}),'/mcp',true);
      const response = await new Promise<string>((resolve,reject)=>{
        const socket=createConnection({host:'127.0.0.1',port:Number(url.port)});
        let bytes=''; const timer=setTimeout(()=>{socket.destroy();reject(new Error('fixture socket deadline'));},3000);
        socket.setEncoding('utf8'); socket.on('data',chunk=>{bytes+=chunk});
        socket.once('error',error=>{if((error as NodeJS.ErrnoException).code!=='ECONNRESET'){clearTimeout(timer);reject(error)}});
        socket.once('close',()=>{clearTimeout(timer);resolve(bytes)});
        socket.once('connect',()=>socket.end(outer+ping));
      });
      expect(response).toContain(`HTTP/1.1 ${expected}`);
      expect(propose).not.toHaveBeenCalled();
      if(expected !== 413) expect(response).toContain('"id":987');
    } finally {broker.close()}
  });
});
