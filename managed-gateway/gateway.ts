import { createHmac } from 'node:crypto';
import { canonical, requireThat, type ExecutionAuthority, type GrantEnvelope, type ModelRequest, type ProviderAdapter, type UsageEvidence } from './contracts.ts';
import { validateRequest, verifyGrant } from './auth.ts';
import { validateAssistant } from './messages.ts';
import { UsageLedger } from './ledger.ts';
import { abortable, boundedStream } from './abort.ts';

export class ManagedGateway {
  readonly ledger: UsageLedger;
  private readonly routes: ReadonlyMap<string,ProviderAdapter>;
  private readonly authority: ExecutionAuthority;
  private readonly fingerprintKey: Uint8Array;
  constructor(options: { ledger:UsageLedger; routes:ReadonlyMap<string,ProviderAdapter>; authority:ExecutionAuthority; fingerprintKey:Uint8Array }) {
    requireThat(options.fingerprintKey.byteLength>=32,'fingerprint_key_required');
    this.ledger=options.ledger; this.routes=new Map(options.routes); this.authority=options.authority; this.fingerprintKey=options.fingerprintKey;
  }
  async execute(envelope: GrantEnvelope, request: ModelRequest, output: (event:{type:'reserved'|'delta'|'settled'|'duplicate'|'continuation';data:unknown})=>Promise<void>, signal:AbortSignal) {
    validateRequest(request); const grant=verifyGrant(envelope,request,this.ledger);
    requireThat(!request.protocol || grant.schema===2,'child_grant_required',403);
    const provider=this.routes.get(request.model); requireThat(provider,'model_route_unavailable',503);
    requireThat(grant.schema!==2 || grant.provider===provider.usageNamespace,'provider_scope_denied',403);
    requireThat(provider.terms.reviewReference && provider.terms.approvedUntil>this.ledger.now(),'provider_terms_not_admitted',503);
    const bound=provider.bound(request);
    const admissionSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,grant.exp-this.ledger.now()))]);
    admissionSignal.throwIfAborted();
    const acquiring=this.authority.acquire(grant,admissionSignal);
    // A late authority response cannot leave an acquired lease behind after cancellation.
    void acquiring.then(lease=>{if(admissionSignal.aborted)void lease.release().catch(()=>{});},()=>{});
    const lease=await abortable(acquiring,admissionSignal);
    let requestId:string|undefined; let started=false;
    const cancellation=AbortSignal.any([admissionSignal,lease.signal]);
    try {
      cancellation.throwIfAborted(); await abortable(lease.assertCurrent(),cancellation); verifyGrant(envelope,request,this.ledger);
      const fingerprint=createHmac('sha256',this.fingerprintKey).update(canonical(request)).digest('hex');
      const admission=this.ledger.reserve(grant,envelope.kid,fingerprint,request.idempotencyKey,bound);
      if (admission.duplicate) {
        await abortable(output({type:'duplicate',data:{requestId:admission.record.id,state:admission.record.state,chargedNanoAud:admission.record.chargedNanoAud,replayAvailable:false}}),cancellation); return;
      }
      requestId=admission.record.id;
      await abortable(output({type:'reserved',data:{requestId,rateVersion:grant.rateVersion,reservedNanoAud:admission.record.reservedNanoAud,included:admission.record.included}}),cancellation);
      cancellation.throwIfAborted(); await abortable(lease.assertCurrent(),cancellation); verifyGrant(envelope,request,this.ledger);
      this.ledger.dispatch(requestId,grant,provider.id,provider.usageNamespace); started=true;
      let evidence:UsageEvidence|undefined; let continuation:unknown;
      for await (const event of boundedStream(provider.stream(request,{signal:cancellation,dispatchId:requestId}),cancellation)) {
        cancellation.throwIfAborted(); await abortable(lease.assertCurrent(),cancellation); verifyGrant(envelope,request,this.ledger);
        if (event.type==='delta') {
          requireThat(!evidence && typeof event.text==='string' && Buffer.byteLength(event.text)<=1_000_000,'invalid_provider_stream',502);
          await abortable(output({type:'delta',data:{text:event.text}}),cancellation);
        } else if(event.type==='continuation') {
          requireThat(request.protocol==='tools-v1' && !continuation,'unexpected_continuation',502); validateAssistant(event.message); continuation=event.message;
        } else { requireThat(!evidence && event.evidence.source==='final_usage','invalid_usage_evidence',502); evidence=event.evidence; }
      }
      if (!evidence) { this.ledger.unknown(requestId,'missing_usage'); requireThat(false,'usage_reconciliation_required',502); }
      if(request.protocol==='tools-v1')requireThat(continuation,'missing_continuation',502);
      const settled=this.ledger.settle(requestId,provider.id,evidence);
      if(continuation)await abortable(output({type:'continuation',data:{message:continuation}}),cancellation);
      await abortable(output({type:'settled',data:{requestId,state:settled.state,units:settled.units,chargedNanoAud:settled.chargedNanoAud,included:settled.included}}),cancellation);
    } catch (error) {
      if (requestId) { if (started) this.ledger.unknown(requestId,'interrupted'); else this.ledger.releaseUndispatched(requestId); }
      throw error;
    } finally { await abortable(lease.release(),AbortSignal.timeout(1000)).catch(()=>{}); }
  }
}
