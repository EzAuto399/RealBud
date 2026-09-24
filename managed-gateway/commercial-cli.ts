/** Local operator entry for reviewed monthly commercial terms and invoice close.
 * Customer acceptance is deliberately unavailable here: only the authenticated
 * billing owner may accept through the portal API. No Square or email calls. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LedgerDatabase } from './database.ts';
import { UsageLedger, digest } from './ledger.ts';
import { BillingService } from './billing.ts';
import type { CommercialTermsDraft } from './commercial-terms.ts';
import { requireThat } from './contracts.ts';
import { SquareBilling } from './square.ts';

const [command,...args]=process.argv.slice(2);
requireThat(command==='publish' || command==='close' || command==='map','usage: commercial-cli.ts publish <reviewed-terms.json> | map <reviewed-square-mapping.json> | close <company-id> <YYYY-MM> <terms-version>');
requireThat(process.env.REALBUD_GATEWAY_DATA,'REALBUD_GATEWAY_DATA required');
requireThat(process.env.REALBUD_INTERNAL_COMPANY_ID,'REALBUD_INTERNAL_COMPANY_ID required');
const path=resolve(process.env.REALBUD_GATEWAY_DATA,'ledger.sqlite');
requireThat(existsSync(path),'gateway_database_not_found',503);
const db=new LedgerDatabase(path);
try {
  const billing=new BillingService(new UsageLedger(db,Date.now),undefined,{internalCompanyId:process.env.REALBUD_INTERNAL_COMPANY_ID});
  if(command==='publish') {
    requireThat(args.length===1 && existsSync(args[0]),'reviewed_terms_file_required');
    const draft=JSON.parse(readFileSync(args[0],'utf8')) as CommercialTermsDraft;
    const result=billing.commercialTerms!.publish(draft);
    process.stdout.write(JSON.stringify({companyId:result.terms.companyId,period:result.terms.period,version:result.terms.version,digest:result.digest,sellerBasisDigest:billing.commercialTerms!.sellerBasisDigest(result.terms),state:'awaiting_customer_acceptance'})+'\n');
  } else if(command==='map') {
    requireThat(args.length===1 && existsSync(args[0]),'reviewed_mapping_file_required');
    const mapping=JSON.parse(readFileSync(args[0],'utf8')) as {companyId:string;merchantId:string;locationId:string;customerId:string;evidence:string};
    const square=new SquareBilling({ledger:billing.ledger,secret:async()=>'',signatureKey:async()=>'',notificationUrl:'https://example.invalid/v1/webhooks/square',internalCompanyId:process.env.REALBUD_INTERNAL_COMPANY_ID});
    square.map(mapping);
    process.stdout.write(JSON.stringify({companyId:mapping.companyId,state:'square_mapping_recorded_no_external_call'})+'\n');
  } else {
    requireThat(args.length===3,'close_requires_company_period_version');
    const invoice=billing.finalizeCommercialInvoice(args[0],args[1],args[2]);
    process.stdout.write(JSON.stringify({invoiceId:invoice.id,companyId:invoice.companyId,period:invoice.period,totalCents:invoice.totalCents,digest:digest(invoice),state:'closed_not_sent'})+'\n');
  }
} finally { db.close(); }
