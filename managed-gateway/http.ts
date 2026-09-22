import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GatewayError, exact, object, requireThat, type GrantEnvelope, type PortalPrincipal } from './contracts.ts';
import { ManagedGateway } from './gateway.ts';
import { BillingService } from './billing.ts';
import { invoiceHtml } from './invoice-html.ts';
import type { ManagedConnectors } from './connectors.ts';
import { provisioningError, type InstallationProvisioning } from './provisioning.ts';

export interface PortalIdentity {
  /** Verify audience, expiry, revocation and tenant binding server-side. Never derive
   * identity from x-company-id/member headers, office sessions or execution grants. */
  authenticate(bearer:string):Promise<PortalPrincipal>;
}
async function body(req:IncomingMessage,max:number):Promise<Buffer> {
  const chunks:Buffer[]=[]; let size=0;
  for await(const part of req) { const b=Buffer.from(part); size+=b.length; requireThat(size<=max,'body_too_large',413); chunks.push(b); }
  return Buffer.concat(chunks);
}
function json(raw:Buffer):unknown { try { return JSON.parse(raw.toString('utf8')); } catch { throw new GatewayError('invalid_json'); } }
function bearer(req:IncomingMessage):string {
  const auth=req.headers.authorization; requireThat(typeof auth==='string' && /^Bearer [A-Za-z0-9_.-]{20,16000}$/.test(auth),'unauthenticated',401); return auth.slice(7);
}
function reply(res:ServerResponse,status:number,data:unknown) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(data));
}
async function streamWrite(res:ServerResponse,data:string,signal:AbortSignal) {
  signal.throwIfAborted(); if(res.write(data)) return;
  await new Promise<void>((resolve,reject)=>{
    const clean=()=>{res.off('drain',drain);res.off('close',close);signal.removeEventListener('abort',close);};
    const drain=()=>{clean();resolve();}, close=()=>{clean();reject(new GatewayError('client_disconnected',499));};
    res.once('drain',drain);res.once('close',close);signal.addEventListener('abort',close,{once:true});
    if(signal.aborted) close();
  });
}
/** Dedicated service, never mount on the desktop's loopback/per-boot-token API.
 * TLS termination, request concurrency/rate limits and external identity admission are
 * explicit deployment gates. No cookie auth or permissive CORS is installed. */
export function createGatewayServer(options:{gateway:ManagedGateway;billing:BillingService;portal:PortalIdentity;allowedOrigins:ReadonlySet<string>;connectors?:ManagedConnectors;provisioning?:InstallationProvisioning;
  /** Why provisioning is not composed, as a code naming the missing variable — never its value. */
  provisioningUnavailable?:string;health?:{squareConfigured?:boolean;openaiCostsConfigured?:boolean;paymentMode?:'local'|'sandbox'|'live'}}) {
  const server=createServer(async(req,res)=>{
    const abort=new AbortController(); res.once('close',()=>{if(!res.writableEnded) abort.abort();});
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setTimeout(310_000,()=>res.destroy());
    try {
      const origin=req.headers.origin; requireThat(!origin || options.allowedOrigins.has(origin),'origin_denied',403);
      // Browsers use a same-origin portal BFF; explicit bearer auth blocks ambient-cookie CSRF.
      const url=new URL(req.url??'/','http://gateway.invalid');
      if(req.method==='GET' && url.pathname==='/health') { reply(res,200,{service:'realbud-managed-ai',mode:'local',productionEnabled:false,squareConfigured:false,openaiCostsConfigured:false,...options.health}); return; }
      // Readiness, for the platform health check. 200 only when installation
      // provisioning is actually composed; otherwise 503 with the code naming the
      // variable to set — never its value. Unauthenticated on purpose: it reveals
      // configuration state, never configuration.
      if(req.method==='GET' && url.pathname==='/ready') {
        if(options.provisioning) { reply(res,200,{ready:true,provisioning:'composed'}); return; }
        reply(res,503,{ready:false,error:options.provisioningUnavailable||'provisioning_unavailable'}); return;
      }
      if(url.pathname.startsWith('/v1/connectors/')) {
        requireThat(options.connectors, 'connectors_unavailable', 503);
        requireThat(!url.search, 'invalid_connector_query');
        const profile=req.headers['x-realbud-profile'], session=req.headers['mcp-session-id'];
        requireThat(typeof profile==='string' && /^[a-z0-9-]{1,64}$/.test(profile), 'invalid_connector_profile', 403);
        requireThat(session===undefined || (typeof session==='string' && /^[a-f0-9]{64}$/.test(session)), 'invalid_connector_session', 400);
        const result=await options.connectors.handle({token:bearer(req),profile,session,method:req.method??'',path:url.pathname,
          body:req.method==='POST'?json(await body(req,32_000)):undefined,signal:abort.signal});
        if(result.session) res.setHeader('mcp-session-id',result.session);
        if(result.body===undefined) { res.writeHead(result.status);res.end(); } else reply(res,result.status,result.body);
        return;
      }
      if(req.method==='POST' && url.pathname==='/v1/model/stream') {
        const token=bearer(req); let envelope:unknown;
        try { envelope=JSON.parse(Buffer.from(token,'base64url').toString('utf8')); } catch { throw new GatewayError('invalid_grant',401); }
        const request=json(await body(req,1_000_000));
        await options.gateway.execute(envelope as GrantEnvelope,request as never,async event=>{
          if(!res.headersSent) res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
          await streamWrite(res,`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,abort.signal);
        },abort.signal); res.end(); return;
      }
      if(req.method==='POST' && url.pathname==='/v1/webhooks/payment') {
        const signature=req.headers['x-realbud-payment-signature']; requireThat(typeof signature==='string','invalid_webhook_signature',401);
        reply(res,200,await options.billing.webhook(await body(req,256_000),signature)); return;
      }
      if(req.method==='POST' && url.pathname==='/v1/webhooks/refund') {
        const signature=req.headers['x-realbud-payment-signature']; requireThat(typeof signature==='string','invalid_webhook_signature',401);
        reply(res,200,await options.billing.refundWebhook(await body(req,256_000),signature)); return;
      }
      requireThat(url.pathname.startsWith('/v1/portal/'),'not_found',404);
      const actor=await options.portal.authenticate(bearer(req));
      requireThat(actor && ['billing_owner','billing_reader'].includes(actor.role),'forbidden',403);
      const ledger=options.gateway.ledger; ledger.tenant(actor.companyId);
      if(req.method==='GET' && url.pathname==='/v1/portal/usage') { reply(res,200,ledger.portalUsage(actor)); return; }
      if(req.method==='GET' && url.pathname==='/v1/portal/rates') { reply(res,200,{rates:ledger.cards()}); return; }
      if(req.method==='POST' && url.pathname==='/v1/portal/rates/accept') {
        const value=json(await body(req,4096)); object(value); exact(value,['version','digest']);
        requireThat(typeof value.version==='string' && typeof value.digest==='string','invalid_acceptance'); reply(res,200,ledger.acceptCard(actor,value.version,value.digest)); return;
      }
      if(req.method==='POST' && url.pathname==='/v1/portal/limits') {
        const value=json(await body(req,4096)); object(value); exact(value,['monthlyCapNanoAud','requestCapNanoAud','maxConcurrent']);
        ledger.setCaps(actor,value as never); reply(res,200,ledger.portalUsage(actor)); return;
      }
      // Vendor-side installation provisioning and revocation. Same portal bearer as
      // every other /v1/portal route; the authenticated principal is the authority,
      // so a body's companyId is only a confirmation, never an assertion.
      const installation=/^\/v1\/portal\/installations\/(provision|revoke)$/.exec(url.pathname);
      if(req.method==='POST' && installation) {
        requireThat(options.provisioning,options.provisioningUnavailable||'provisioning_unavailable',503);
        const value=json(await body(req,4096));
        try {
          reply(res,200,installation[1]==='provision'
            ? await options.provisioning!.provision(actor,value)
            : await options.provisioning!.revoke(actor,value));
        } catch(error) { throw provisioningError(error); }
        return;
      }
      if(req.method==='GET' && url.pathname==='/v1/portal/invoices') { reply(res,200,{invoices:options.billing.portalInvoices(actor)}); return; }
      const match=/^\/v1\/portal\/invoices\/([A-Za-z0-9-]+)(?:\/(checkout|receipt|document))?$/.exec(url.pathname);
      if(match) {
        const invoice=options.billing.invoice(actor,match[1]);
        if(req.method==='POST' && match[2]==='checkout') { reply(res,200,await options.billing.checkout(actor,invoice.id)); return; }
        if(req.method==='GET' && match[2]==='receipt') { reply(res,200,options.billing.receipt(actor,invoice.id)); return; }
        if(req.method==='GET' && match[2]==='document') {
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"}); res.end(invoiceHtml(invoice)); return;
        }
        if(req.method==='GET' && !match[2]) { reply(res,200,invoice); return; }
      }
      throw new GatewayError('not_found',404);
    } catch(error) {
      // Never return upstream error bodies, stack traces, prompt content, tokens or secrets.
      const code=error instanceof GatewayError?error.code:'request_failed'; const status=error instanceof GatewayError?error.status:502;
      if(!res.headersSent) reply(res,status,{error:code}); else if(!res.destroyed) res.end(`event: error\ndata: ${JSON.stringify({error:code})}\n\n`);
    }
  });
  server.requestTimeout=30_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;server.maxHeadersCount=32;
  return server;
}
