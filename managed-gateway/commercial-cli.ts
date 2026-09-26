/** Local operator entry for reviewed monthly commercial terms, the Square customer
 * mapping, the monthly invoice close and care credits. Customer acceptance is
 * deliberately unavailable here: only the authenticated billing owner may accept
 * through the portal API. No Square or email calls. `close` of an office that
 * accepted AI resale reads its finalized Modelvia customer invoices under
 * `REALBUD_MODELVIA_CLIENT_KEY` (read only, with `REALBUD_ENABLE_PROVIDER=1`) and
 * waits while the month's invoice is not finalized, unless `--defer-ai`.
 *
 * Per-office AI markup (`office-ai-terms.ts`): `propose-markup` records an
 * operator's proposal (audited, local only); `publish` fills an `aiUsage` block
 * that omits `markupBasisPoints` with the pending proposal, else the office's
 * accepted markup, else REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS; the office's
 * acceptance makes it effective; `sync-markup` writes the new Modelvia resale
 * policy (Modelvia operator variables and `REALBUD_ENABLE_PROVIDER=1`), which a
 * portal acceptance also does. `charge-detail` sets the office's invoice detail. */
import { existsSync, readFileSync } from 'node:fs';
import { LedgerDatabase } from './database.ts';
import { UsageLedger, digest } from './ledger.ts';
import { BillingService } from './billing.ts';
import type { CommercialTermsDraft } from './commercial-terms.ts';
import { requireThat } from './contracts.ts';
import { recordSquareMapping, type SquareMapping } from './square-mapping.ts';
import { composeModelviaClientBilling } from './modelvia-client-billing.ts';
import { customerTermsPolicy } from './modelvia-keys.ts';
import { closeOfficeMonth } from './office-ai-billing.ts';
import { composeResaleTermsClient } from './office-ai-access.ts';
import { officeMarkup, proposeOfficeMarkup, setOfficeChargeDetail, syncOfficeResalePolicy, withOfficeMarkup } from './office-ai-terms.ts';
import { ledgerPath, loadLocalEnv } from './local-env.ts';

loadLocalEnv();
const [command,...args]=process.argv.slice(2);
const COMMANDS=['publish','close','map','credit','propose-markup','markup','sync-markup','charge-detail'];
requireThat(COMMANDS.includes(command),'usage: commercial-cli.ts publish <reviewed-terms.json> | map <reviewed-square-mapping.json> | close <company-id> <YYYY-MM> <terms-version> [--defer-ai] | credit <company-id> <invoice-id> <credit-id> <amount-cents> <reason> | propose-markup <company-id> <basis-points 0..10000> <reason> | markup <company-id> | sync-markup <company-id> | charge-detail <company-id> all_in|itemized');
requireThat(process.env.REALBUD_INTERNAL_COMPANY_ID,'REALBUD_INTERNAL_COMPANY_ID required');
// The same database the server opens (local-env.ts); a wrong path fails loudly.
const path=ledgerPath(process.env);
requireThat(existsSync(path),'gateway_database_not_found',503);
const db=new LedgerDatabase(path);
try {
  const internalCompanyId=process.env.REALBUD_INTERNAL_COMPANY_ID;
  const billing=new BillingService(new UsageLedger(db,Date.now),undefined,{internalCompanyId});
  const policy=customerTermsPolicy(process.env);
  const defaultMarkup='unavailable' in policy?undefined:policy.resale?.clientMarkupBasisPoints;
  // The operator's identity for the audit trail; never a secret.
  const subject=`operator-cli:${(process.env.REALBUD_OPERATOR_SUBJECT??process.env.USER??'unknown').replace(/[^A-Za-z0-9@._-]/g,'').slice(0,200)||'unknown'}`;
  if(command==='propose-markup') {
    requireThat(args.length===3 && /^(0|[1-9][0-9]{0,4})$/.test(args[1]),'propose_markup_requires_company_basis_points_reason');
    const result=proposeOfficeMarkup(billing.ledger,subject,args[0],Number(args[1]),args[2]);
    process.stdout.write(JSON.stringify({...result,...officeMarkup(billing.ledger,args[0],defaultMarkup)})+'\n');
  } else if(command==='markup') {
    requireThat(args.length===1,'markup_requires_company');
    process.stdout.write(JSON.stringify({companyId:args[0],defaultBasisPoints:defaultMarkup??null,...officeMarkup(billing.ledger,args[0],defaultMarkup)})+'\n');
  } else if(command==='charge-detail') {
    requireThat(args.length===2,'charge_detail_requires_company_and_detail');
    process.stdout.write(JSON.stringify(setOfficeChargeDetail(billing.ledger,subject,args[0],args[1]))+'\n');
  } else if(command==='sync-markup') {
    requireThat(args.length===1,'sync_markup_requires_company');
    requireThat(!('unavailable' in policy),'unavailable' in policy?policy.unavailable:'',503);
    const modelvia=composeResaleTermsClient({env:process.env,fetch:(url,init)=>fetch(url,init)});
    requireThat(modelvia,'modelvia_operator_unconfigured',503);
    const result=await syncOfficeResalePolicy({ledger:billing.ledger,modelvia,clientFundedCompanies:(policy as Exclude<typeof policy,{unavailable:string}>).clientFundedCompanies},args[0]);
    process.stdout.write(JSON.stringify({companyId:args[0],...result})+'\n');
  } else if(command==='publish') {
    requireThat(args.length===1 && existsSync(args[0]),'reviewed_terms_file_required');
    const draft=withOfficeMarkup(billing.ledger,JSON.parse(readFileSync(args[0],'utf8')) as CommercialTermsDraft,defaultMarkup);
    const result=billing.commercialTerms!.publish(draft);
    process.stdout.write(JSON.stringify({companyId:result.terms.companyId,period:result.terms.period,version:result.terms.version,careCents:result.terms.careCents,...(result.terms.aiUsage?{aiMarkupBasisPoints:result.terms.aiUsage.markupBasisPoints}:{}),digest:result.digest,sellerBasisDigest:billing.commercialTerms!.sellerBasisDigest(result.terms),state:'awaiting_customer_acceptance'})+'\n');
  } else if(command==='map') {
    requireThat(args.length===1 && existsSync(args[0]),'reviewed_mapping_file_required');
    const mapping=JSON.parse(readFileSync(args[0],'utf8')) as SquareMapping;
    recordSquareMapping(billing.ledger,mapping,internalCompanyId);
    process.stdout.write(JSON.stringify({companyId:mapping.companyId,state:'square_mapping_recorded_no_external_call'})+'\n');
  } else if(command==='credit') {
    requireThat(args.length===5,'credit_requires_company_invoice_credit_amount_reason');
    const result=billing.creditCare(args[0],args[1],args[2],args[3],args[4]);
    process.stdout.write(JSON.stringify({companyId:args[0],invoiceId:args[1],creditId:args[2],amountCents:args[3],duplicate:result.duplicate,state:'care_credit_recorded_applies_to_next_invoice'})+'\n');
  } else {
    const deferAi=args[3]==='--defer-ai';
    requireThat(args.length===3 || (args.length===4 && deferAi),'close_requires_company_period_version');
    requireThat(!('unavailable' in policy),'unavailable' in policy?policy.unavailable:'',503);
    const modelvia=process.env.REALBUD_ENABLE_PROVIDER==='1'?composeModelviaClientBilling({env:process.env,fetch:(url,init)=>fetch(url,init)}):undefined;
    const closed=await closeOfficeMonth({billing,...(modelvia?{modelvia}:{}),clientFundedCompanies:(policy as Exclude<typeof policy,{unavailable:string}>).clientFundedCompanies},args[0],args[1],args[2],{deferAi});
    const invoice=closed.invoice;
    process.stdout.write(JSON.stringify({invoiceId:invoice.id,companyId:invoice.companyId,period:invoice.period,totalCents:invoice.totalCents,digest:digest(invoice),ai:closed.ai,
      modelviaInvoices:invoice.aiUsage?.modelviaInvoices.map(entry=>entry.id)??[],state:'closed_not_sent'})+'\n');
  }
} finally { db.close(); }
