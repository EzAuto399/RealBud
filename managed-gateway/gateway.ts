import { createHmac } from 'node:crypto';
import { canonical, requireThat, type ExecutionAuthority, type GrantEnvelope, type ModelRequest, type ProviderAdapter, type UsageEvidence } from './contracts.ts';
import { validateRequest, verifyGrant } from './auth.ts';
import { validateAssistant } from './messages.ts';
import { UsageLedger } from './ledger.ts';
import { abortable, boundedStream } from './abort.ts';

type GatewayOutput = { type: 'reserved'|'delta'|'settled'|'duplicate'|'continuation'; data: unknown };

export class ManagedGateway {
  readonly ledger: UsageLedger;
  private readonly routes: ReadonlyMap<string,ProviderAdapter>;
  private readonly authority: ExecutionAuthority;
  private readonly fingerprintKey: Uint8Array;
  constructor(options: { ledger:UsageLedger; routes:ReadonlyMap<string,ProviderAdapter>; authority:ExecutionAuthority; fingerprintKey:Uint8Array }) {
    requireThat(options.fingerprintKey.byteLength>=32,'fingerprint_key_required');
    this.ledger=options.ledger; this.routes=new Map(options.routes); this.authority=options.authority; this.fingerprintKey=options.fingerprintKey;
  }
  async execute(envelope: GrantEnvelope, request: ModelRequest, output: (event:GatewayOutput)=>Promise<void>, signal:AbortSignal) {
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
    let requestId:string|undefined; let started=false; let evidence:UsageEvidence|undefined;
    const cancellation=AbortSignal.any([admissionSignal,lease.signal]);
    // Check at invocation, not just at the last provider event. Keep the final checks
    // and callback invocation in one synchronous continuation: output must stay lazy.
    const emit = async (event:GatewayOutput) => {
      cancellation.throwIfAborted();
      await abortable(lease.assertCurrent(),cancellation);
      cancellation.throwIfAborted();
      verifyGrant(envelope,request,this.ledger);
      cancellation.throwIfAborted();
      await abortable(output(event),cancellation);
    };
    try {
      cancellation.throwIfAborted(); await abortable(lease.assertCurrent(),cancellation); verifyGrant(envelope,request,this.ledger);
      const fingerprint=createHmac('sha256',this.fingerprintKey).update(canonical(request)).digest('hex');
      const admission=this.ledger.reserve(grant,envelope.kid,fingerprint,request.idempotencyKey,bound);
      if (admission.duplicate) {
        await emit({type:'duplicate',data:{requestId:admission.record.id,state:admission.record.state,chargedNanoAud:admission.record.chargedNanoAud,replayAvailable:false}}); return;
      }
      requestId=admission.record.id;
      await emit({type:'reserved',data:{requestId,rateVersion:grant.rateVersion,reservedNanoAud:admission.record.reservedNanoAud,included:admission.record.included}});
      cancellation.throwIfAborted(); await abortable(lease.assertCurrent(),cancellation); verifyGrant(envelope,request,this.ledger);
      this.ledger.dispatch(requestId,grant,provider.id,provider.usageNamespace); started=true;
      let continuation:unknown;
      for await (const event of boundedStream(provider.stream(request,{signal:cancellation,dispatchId:requestId}),cancellation)) {
        cancellation.throwIfAborted(); await abortable(lease.assertCurrent(),cancellation); verifyGrant(envelope,request,this.ledger);
        if (event.type==='delta') {
          requireThat(!evidence && typeof event.text==='string' && Buffer.byteLength(event.text)<=1_000_000,'invalid_provider_stream',502);
          await emit({type:'delta',data:{text:event.text}});
        } else if(event.type==='continuation') {
          requireThat(request.protocol==='tools-v1' && !continuation,'unexpected_continuation',502); validateAssistant(event.message); continuation=structuredClone(event.message);
        } else { requireThat(!evidence && event.evidence.source==='final_usage','invalid_usage_evidence',502); evidence=structuredClone(event.evidence); }
      }
      if (!evidence) { this.ledger.unknown(requestId,'missing_usage'); requireThat(false,'usage_reconciliation_required',502); }
      if(request.protocol==='tools-v1')requireThat(continuation,'missing_continuation',502);
      const settled=this.ledger.settle(requestId,provider.id,evidence);
      if(continuation)await emit({type:'continuation',data:{message:continuation}});
      await emit({type:'settled',data:{requestId,state:settled.state,units:settled.units,chargedNanoAud:settled.chargedNanoAud,included:settled.included}});
    } catch (error) {
      // Revocation stops protected output, not accounting for already incurred usage.
      // Cancellation can interrupt iterator completion after the final usage event.
      // Settle that saved evidence only through the ledger's normal validation; bad
      // evidence stays unknown/held. Neither path starts another provider request.
      if (requestId && started && evidence && cancellation.aborted) {
        try { this.ledger.settle(requestId,provider.id,evidence); }
        catch { this.ledger.unknown(requestId,'invalid_usage'); }
      }
      if (requestId) { if (started) this.ledger.unknown(requestId,'interrupted'); else this.ledger.releaseUndispatched(requestId); }
      throw error;
    } finally { await abortable(lease.release(),AbortSignal.timeout(1000)).catch(()=>{}); }
  }
}
