/**
 * Production/local entry for the RealBud managed gateway: installation
 * provisioning and revocation, connectors, service entitlement, the monthly
 * care-fee invoice and its Square collection, health and readiness. Modelvia is
 * the only source of AI rates, caps, usage and AI invoices; nothing here bills
 * AI usage, polls provider costs or forwards model traffic.
 * Secrets via env; SQLite on a durable volume. Never import testing.ts here.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LedgerDatabase } from "./database.ts";
import { UsageLedger } from "./ledger.ts";
import { createGatewayServer } from "./http.ts";
import { verifyPortalToken } from "./portal-token.ts";
import { GatewayError, requireThat } from "./contracts.ts";
import { composeGateway } from "./composition.ts";
import { ledgerPath, loadLocalEnv } from "./local-env.ts";
import { composeResendInvoiceEmail, drainInvoiceEmails } from "./invoice-email.ts";

loadLocalEnv();

const port = Number(process.env.PORT || 8787);
const host = process.env.PLATFORM_BIND_HOST || "0.0.0.0";
// The same path the entitlement and commercial commands write (local-env.ts).
const dbPath = ledgerPath(process.env);
const portalSecret = process.env.REALBUD_GATEWAY_PORTAL_SECRET || "";
const siteOrigins = new Set(
  (
    process.env.REALBUD_ALLOWED_ORIGINS ||
    "https://realbud.app,https://www.realbud.app"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

requireThat(
  portalSecret.length >= 32,
  "REALBUD_GATEWAY_PORTAL_SECRET required (>=32 chars)",
);
mkdirSync(dirname(dbPath), { recursive: true });

// The ledger database holds service entitlements (tenants), provisioning
// records, the connector link journal, the care-fee terms, invoices and
// payments, and the audit chain. Its older AI-usage tables stay in the schema,
// readable and untouched.
const db = new LedgerDatabase(dbPath);
const ledger = new UsageLedger(db, Date.now);

// Provisioning, operator routes, connectors and care-fee collection, from the
// environment alone (composition.ts). Provisioning is disabled unless
// REALBUD_ENABLE_PROVIDER=1; a deployment that enables it but misses a variable
// answers 503 naming that variable. A sandbox or live REALBUD_PAYMENT_MODE with a
// Square variable missing refuses to start, naming the variable. Connectors read
// the office project keys from the same secret store provisioning writes them into.
const composition = composeGateway({
  env: process.env,
  ledger,
  fetch,
  allowedOrigins: siteOrigins,
  portal: {
    async authenticate(bearer) {
      try {
        return verifyPortalToken(bearer, portalSecret);
      } catch {
        throw new GatewayError("unauthenticated", 401);
      }
    },
  },
});
const { modelviaOperator, operatorAccess, careCollection } = composition;
const invoiceEmail=composeResendInvoiceEmail(process.env);
const emailBilling=composition.server.billing;
if(invoiceEmail) requireThat(emailBilling?.commercialTerms,'invoice_email_commercial_terms_unavailable',503);
const server = createGatewayServer(composition.server);
let emailDrain:Promise<void>|undefined;
let emailTimer:NodeJS.Timeout|undefined;
let stopping=false;
const runEmailDrain=()=>{
  if(!invoiceEmail || !emailBilling || stopping || emailDrain) return;
  emailDrain=drainInvoiceEmails(emailBilling,invoiceEmail)
    .then(result=>{if(result.scanned) console.log(JSON.stringify({invoiceEmailDrain:'result',...result}));})
    .catch(()=>{console.error(JSON.stringify({invoiceEmailDrain:'failed'}));})
    .finally(()=>{emailDrain=undefined;});
};

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      listening: port,
      data: dbPath,
      origins: [...siteOrigins],
      // Codes, never values: say which variable a deployment still has to set.
      provisioning: composition.provisioning,
      modelviaOperator,
      operatorAccess,
      careCollection,
      invoiceEmail:invoiceEmail?'resend':'off',
    }),
  );
  if(invoiceEmail) {runEmailDrain();emailTimer=setInterval(runEmailDrain,60_000);}
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if(stopping) return;
    stopping=true;
    if(emailTimer) clearInterval(emailTimer);
    server.close(async () => {
      await emailDrain;
      db.close();
      process.exit(0);
    });
  });
}
