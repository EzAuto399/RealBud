/** Local operator entry for reviewed monthly commercial terms, the Square customer
 * mapping, care invoice close and care credits. Customer acceptance is deliberately
 * unavailable here: only the authenticated billing owner may accept through the
 * portal API. No Square or email calls. */
import { existsSync, readFileSync } from 'node:fs';
import { LedgerDatabase } from './database.ts';
import { UsageLedger, digest } from './ledger.ts';
import { BillingService } from './billing.ts';
import type { CommercialTermsDraft } from './commercial-terms.ts';
import { requireThat } from './contracts.ts';
import { recordSquareMapping, type SquareMapping } from './square-mapping.ts';
import { ledgerPath, loadLocalEnv } from './local-env.ts';

loadLocalEnv();
const [command,...args]=process.argv.slice(2);
requireThat(command==='publish' || command==='close' || command==='map' || command==='credit','usage: commercial-cli.ts publish <reviewed-terms.json> | map <reviewed-square-mapping.json> | close <company-id> <YYYY-MM> <terms-version> | credit <company-id> <invoice-id> <credit-id> <amount-cents> <reason>');
requireThat(process.env.REALBUD_INTERNAL_COMPANY_ID,'REALBUD_INTERNAL_COMPANY_ID required');
// The same database the server opens (local-env.ts); a wrong path fails loudly.
const path=ledgerPath(process.env);
requireThat(existsSync(path),'gateway_database_not_found',503);
const db=new LedgerDatabase(path);
try {
  const internalCompanyId=process.env.REALBUD_INTERNAL_COMPANY_ID;
  const billing=new BillingService(new UsageLedger(db,Date.now),undefined,{internalCompanyId});
  if(command==='publish') {
    requireThat(args.length===1 && existsSync(args[0]),'reviewed_terms_file_required');
    const draft=JSON.parse(readFileSync(args[0],'utf8')) as CommercialTermsDraft;
    const result=billing.commercialTerms!.publish(draft);
    process.stdout.write(JSON.stringify({companyId:result.terms.companyId,period:result.terms.period,version:result.terms.version,careCents:result.terms.careCents,digest:result.digest,sellerBasisDigest:billing.commercialTerms!.sellerBasisDigest(result.terms),state:'awaiting_customer_acceptance'})+'\n');
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
    requireThat(args.length===3,'close_requires_company_period_version');
    const invoice=billing.finalizeCommercialInvoice(args[0],args[1],args[2]);
    process.stdout.write(JSON.stringify({invoiceId:invoice.id,companyId:invoice.companyId,period:invoice.period,totalCents:invoice.totalCents,digest:digest(invoice),state:'closed_not_sent'})+'\n');
  }
} finally { db.close(); }
