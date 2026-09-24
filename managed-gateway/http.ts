import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GatewayError, requireThat, type PortalPrincipal } from './contracts.ts';
import type { ManagedConnectors } from './connectors.ts';
import { provisioningError, type InstallationProvisioning } from './provisioning.ts';
import type { OperatorRoutes } from './office-ai-access.ts';

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
/** Dedicated service, never mount on the desktop's loopback/per-boot-token API.
 * TLS termination, request concurrency/rate limits and external identity admission are
 * explicit deployment gates. No cookie auth or permissive CORS is installed.
 *
 * Routes: GET /health, GET /ready, /v1/connectors/*, POST
 * /v1/portal/installations/{provision,revoke}, and the operator-only POST
 * /v1/operator/offices/ai-access. Nothing else. AI rates, caps,
 * usage and invoices are Modelvia's; this service has no billing route. */
export function createGatewayServer(options:{portal:PortalIdentity;allowedOrigins:ReadonlySet<string>;connectors?:ManagedConnectors;provisioning?:InstallationProvisioning;
  /** Why provisioning is not composed, as a code naming the missing variable — never its value. */
  provisioningUnavailable?:string;
  /** Whether the Modelvia operator variables are all present. Configuration state only;
   * `/ready` never calls Modelvia. Defaults to `configured` exactly when provisioning is composed. */
  modelviaOperator?:'configured'|'missing';
  /** RealBud operator routes, under their own bearer (operator-token.ts). Absent
   * when `REALBUD_GATEWAY_OPERATOR_SECRET` is missing, short or equal to the portal secret. */
  operator?:OperatorRoutes;
  /** Presence of the operator secret, for `/ready`. Defaults to whether `operator` is composed. */
  operatorAccess?:'configured'|'missing'}) {
  const modelviaOperator=options.modelviaOperator??(options.provisioning?'configured':'missing');
  const operatorAccess=options.operatorAccess??(options.operator?'configured':'missing');
  const server=createServer(async(req,res)=>{
    const abort=new AbortController(); res.once('close',()=>{if(!res.writableEnded) abort.abort();});
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setTimeout(310_000,()=>res.destroy());
    try {
      const origin=req.headers.origin; requireThat(!origin || options.allowedOrigins.has(origin),'origin_denied',403);
      // Browsers use a same-origin portal BFF; explicit bearer auth blocks ambient-cookie CSRF.
      const url=new URL(req.url??'/','http://gateway.invalid');
      if(req.method==='GET' && url.pathname==='/health') { reply(res,200,{service:'realbud-managed-ai'}); return; }
      // Readiness, for the platform health check. 200 only when installation
      // provisioning is actually composed; otherwise 503 with the code naming the
      // variable to set — never its value. Unauthenticated on purpose: it reveals
      // configuration state, never configuration.
      if(req.method==='GET' && url.pathname==='/ready') {
        if(options.provisioning) { reply(res,200,{ready:true,provisioning:'composed',modelviaOperator,operatorAccess}); return; }
        reply(res,503,{ready:false,error:options.provisioningUnavailable||'provisioning_unavailable',modelviaOperator,operatorAccess}); return;
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
      // RealBud operator: set one office's AI access at Modelvia. Its own bearer and
      // secret; a portal token is never an operator and never reaches this write.
      if(req.method==='POST' && url.pathname==='/v1/operator/offices/ai-access') {
        requireThat(options.operator,'operator_unconfigured',503);
        let operator;
        try { operator=await options.operator!.authenticate(bearer(req)); } catch { throw new GatewayError('operator_unauthenticated',401); }
        requireThat(options.operator!.officeAiAccess,'operator_unconfigured',503);
        const value=json(await body(req,4096));
        try { reply(res,200,await options.operator!.officeAiAccess!.set(operator,value)); }
        catch(error) { throw error instanceof GatewayError?error:new GatewayError('office_ai_access_failed',502); }
        return;
      }
      requireThat(url.pathname.startsWith('/v1/portal/'),'not_found',404);
      const actor=await options.portal.authenticate(bearer(req));
      requireThat(actor && ['billing_owner','billing_reader'].includes(actor.role),'forbidden',403);
      // Vendor-side installation provisioning and revocation. The authenticated
      // principal is the authority, so a body's companyId is only a confirmation,
      // never an assertion. Service entitlement is checked where it matters:
      // `provision` refuses a company without an active entitlement before any
      // external effect; `revoke` deliberately does not, so an expired or
      // suspended office can still be shut off.
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
