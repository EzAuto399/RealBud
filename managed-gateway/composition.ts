/**
 * The gateway's production composition, from the environment alone, so the
 * wiring `server.ts` runs is the wiring the tests run. Never import testing.ts.
 *
 * The one rule this file exists to keep: the connector broker reads each office's
 * Composio project key from the same secret store provisioning wrote it into.
 * Two stores (or provisioning's store plus `process.env`) would leave every
 * freshly provisioned device answering `connector_not_configured`.
 */
import { GatewayError, requireThat } from './contracts.ts';
import type { UsageLedger } from './ledger.ts';
import type { HttpTransport, ComposioOrgClient } from './composio-org.ts';
import type { ModelviaOperatorClient } from './modelvia-keys.ts';
import { connectorRegistry, ManagedConnectors, type ConnectorOptions } from './connectors.ts';
import { createGatewayServer, type PortalIdentity } from './http.ts';
import { composeProvisioning, fileSecretStore, modelviaOperatorState, updateRegistry, type SecretStore } from './provisioning.ts';
import { composioAuthConfigClient, oauthAppsFromEnv } from './composio-auth-config.ts';
import { composioAppAdapter } from './composio-apps.ts';
import { composeOperatorRoutes, composeResaleTermsClient, operatorAccessState } from './office-ai-access.ts';
import { officeAiTermsRoutes, syncOfficeResalePolicy } from './office-ai-terms.ts';
import { officeAiUsageCsv } from './office-ai-usage-csv.ts';
import { BillingService, composeInvoiceTermsDays, type Invoice } from './billing.ts';
import { composePaymentInstructions } from './invoice-html.ts';
export { composePaymentInstructions };
import { operatorBillingRoutes } from './operator-billing.ts';
import { BillingPlans, composeBillingPlanConfig } from './billing-plans.ts';
import { composeModelviaClientBilling } from './modelvia-client-billing.ts';
import { customerTermsPolicy } from './modelvia-keys.ts';
import { officeMargins } from './office-ai-billing.ts';
import { SquareHostedPaymentAdapter } from './square-payment.ts';
import { composeHermiosSubscriptions } from './office-subscriptions.ts';

export type GatewayServerOptions = Parameters<typeof createGatewayServer>[0];

export interface GatewayComposition {
  server: GatewayServerOptions;
  /** `composed`, or the code naming the variable to set. Never a value. */
  provisioning: string;
  modelviaOperator: 'configured' | 'missing';
  operatorAccess: 'configured' | 'missing';
  /** Care-fee collection through Square: `off` (invoices close and read, no checkout), `sandbox` or `live`. */
  careCollection: CareCollectionMode;
  /** Billing plans over the same billing service; `server.ts` rolls them forward daily. */
  billingPlans: BillingPlans;
  /** `configured`, or the code naming the seller/reference variable a plan still needs. */
  billingPlanConfig: string;
}

export type CareCollectionMode = 'off' | 'sandbox' | 'live';
export interface CareCollection { billing: BillingService; careCollection: CareCollectionMode; squareWebhooks: boolean }
const SQUARE_ENV = ['SQUARE_ACCESS_TOKEN', 'SQUARE_MERCHANT_ID', 'SQUARE_LOCATION_ID', 'SQUARE_NOTIFICATION_URL', 'SQUARE_WEBHOOK_SIGNATURE_KEY', 'REALBUD_INTERNAL_COMPANY_ID'] as const;
/** Operator attestations live collection needs; also gates a live Hermios catalog write (`hermios-square-catalog.ts`). */
export const LIVE_APPROVAL_ENV = ['REALBUD_SELLER_BASIS_APPROVAL_REF', 'REALBUD_PRODUCTION_INVOICE_APPROVAL_REF', 'REALBUD_MANAGED_PROJECT_VERIFIED_REF'] as const;

/**
 * Care-fee billing from the environment. `REALBUD_PAYMENT_MODE` is `local`
 * (default: invoices close through the operator command and read through the
 * portal, checkout answers `payment_provider_unselected`), `sandbox` or `live`.
 * Sandbox and live are explicit: they need `REALBUD_AUTHORIZE_COLLECTION=1` and
 * every Square variable, and live additionally the reviewed seller-basis digest
 * and the three approval references. A collection mode with a variable missing
 * refuses to compose, naming the variable and never its value, so a deployment
 * that asked to collect cannot silently run with collection off. AI usage is
 * Modelvia's and never reaches these invoices.
 */
export function composeCareCollection(options: { env: NodeJS.ProcessEnv; ledger: UsageLedger; fetch: HttpTransport }): CareCollection {
  const { env, ledger } = options;
  const value = (name: string) => (env[name] ?? '').trim();
  const mode = value('REALBUD_PAYMENT_MODE') || 'local';
  requireThat(mode === 'local' || mode === 'sandbox' || mode === 'live', 'care_collection_unconfigured:REALBUD_PAYMENT_MODE', 503);
  const internalCompanyId = value('REALBUD_INTERNAL_COMPANY_ID') || undefined;
  // Days from issue to due date (owner decision, 29 September 2026: 7).
  const invoiceTermsDays = composeInvoiceTermsDays(env);
  if (mode === 'local') return { billing: new BillingService(ledger, undefined, { internalCompanyId, invoiceTermsDays }), careCollection: 'off', squareWebhooks: false };
  requireThat(value('REALBUD_AUTHORIZE_COLLECTION') === '1', 'care_collection_unconfigured:REALBUD_AUTHORIZE_COLLECTION', 503);
  for (const name of SQUARE_ENV) requireThat(value(name), `care_collection_unconfigured:${name}`, 503);
  if (mode === 'live') {
    // Operator attestations, never facts inferred from a token. Every checkout
    // also checks the office's accepted terms, exact amount and this seller basis.
    requireThat(/^[a-f0-9]{64}$/.test(value('REALBUD_SELLER_BASIS_DIGEST')), 'care_collection_unconfigured:REALBUD_SELLER_BASIS_DIGEST', 503);
    for (const name of LIVE_APPROVAL_ENV) requireThat(value(name), `care_collection_unconfigured:${name}`, 503);
  }
  const adapter = new SquareHostedPaymentAdapter({ ledger, environment: mode === 'live' ? 'production' : 'sandbox',
    fetchImpl: options.fetch as unknown as typeof fetch,
    accessToken: value('SQUARE_ACCESS_TOKEN'), signatureKey: value('SQUARE_WEBHOOK_SIGNATURE_KEY'), notificationUrl: value('SQUARE_NOTIFICATION_URL'),
    merchantId: value('SQUARE_MERCHANT_ID'), locationId: value('SQUARE_LOCATION_ID'), internalCompanyId: internalCompanyId!,
    ...(mode === 'live' ? { expectedSellerBasisDigest: value('REALBUD_SELLER_BASIS_DIGEST') } : {}) });
  return { billing: new BillingService(ledger, adapter, { authorizeCollection: true, internalCompanyId, invoiceTermsDays }), careCollection: mode, squareWebhooks: true };
}

/**
 * Connector key lookup: the provisioning secret store first; the process
 * environment only for a registry entry written by the operator CLI before
 * provisioning existed, whose `projectKeyEnv` names a deployment variable. A
 * store that refuses a read (loose permissions, oversized file) fails the
 * request rather than falling back.
 */
export function connectorSecret(secrets: SecretStore | undefined, env: NodeJS.ProcessEnv): (name: string) => string | undefined {
  return name => secrets?.read(name) ?? env[name];
}

/** Everything `connectors.ts` needs to admit any Composio toolkit on a person's
 * ask. Without a registry there is nothing to admit into. */
export function composeAppAdmission(options: { env: NodeJS.ProcessEnv; fetch: HttpTransport; registry: string }): Pick<ConnectorOptions, 'authConfigs' | 'admitApp' | 'apps' | 'rebindGmail'> {
  const base = (options.env.REALBUD_COMPOSIO_API_BASE ?? '').trim();
  const baseOption = base ? { base } : {};
  return {
    authConfigs: composioAuthConfigClient({ fetch: options.fetch, ...baseOption, oauthApps: oauthAppsFromEnv(options.env) }),
    apps: composioAppAdapter({ fetch: options.fetch, ...baseOption }),
    admitApp: (deviceId, app) => updateRegistry(options.registry, devices => ({
      devices: devices.map(device => device.id === deviceId && !(device.apps ?? ['gmail']).includes(app) ? { ...device, apps: [...(device.apps ?? ['gmail']), app] } : device),
    })),
    // Compare-and-set: only the one device, only while it still records `from`.
    rebindGmail: (deviceId, from, to) => updateRegistry(options.registry, devices => ({
      devices: devices.map(device => device.id === deviceId && device.authConfigId === from ? { ...device, authConfigId: to } : device),
    })),
  };
}

export function composeGateway(options: {
  env: NodeJS.ProcessEnv; ledger: UsageLedger; fetch: HttpTransport;
  portal: PortalIdentity; allowedOrigins: ReadonlySet<string>;
  /** Test seams: the vendor clients and the Composio Gmail adapter calls. */
  org?: ComposioOrgClient; modelvia?: ModelviaOperatorClient;
  connectorAdapters?: Pick<ConnectorOptions, 'access' | 'authorize' | 'transport' | 'scan'>;
}): GatewayComposition {
  const { env, ledger } = options;
  // `fetch` is handed over only when the provider gate is open, so nothing can
  // call out while provisioning is disabled.
  const gatedFetch: HttpTransport = env.REALBUD_ENABLE_PROVIDER === '1' ? options.fetch : (async () => {
    throw new GatewayError('provisioning_disabled', 503);
  });
  const provisioning = composeProvisioning({ env, ledger, fetch: gatedFetch,
    ...(options.org ? { org: options.org } : {}), ...(options.modelvia ? { modelvia: options.modelvia } : {}) });
  const operator = composeOperatorRoutes({ env, ledger, fetch: gatedFetch, ...(options.modelvia ? { modelvia: options.modelvia } : {}) });
  // Square is reached only in an explicit sandbox or live collection mode; the
  // ungated transport is what those modes asked for.
  const care = composeCareCollection({ env, ledger, fetch: options.fetch });
  // The owner's margin view: care from this ledger, AI from Modelvia under the
  // client key (read only, behind the same provider gate).
  const clientBilling = composeModelviaClientBilling({ env, fetch: gatedFetch });
  const policy = customerTermsPolicy(env);
  const clientFundedCompanies = 'unavailable' in policy ? new Set<string>() : policy.clientFundedCompanies;
  const defaultMarkupBasisPoints = 'unavailable' in policy ? undefined : policy.resale?.clientMarkupBasisPoints;
  // Each office's accepted markup reaches Modelvia as a new resale policy.
  const resaleTerms = composeResaleTermsClient({ env, fetch: gatedFetch, ...(options.modelvia ? { modelvia: options.modelvia } : {}) });
  const afterTermsAccepted = resaleTerms && !('unavailable' in policy)
    ? (companyId: string) => syncOfficeResalePolicy({ ledger, modelvia: resaleTerms, clientFundedCompanies }, companyId) : undefined;
  if (operator) {
    operator.margins = period => officeMargins({ billing: care.billing, ...(clientBilling ? { modelvia: clientBilling } : {}), clientFundedCompanies, ...(defaultMarkupBasisPoints !== undefined ? { defaultMarkupBasisPoints } : {}) }, period);
    operator.officeAiTerms = officeAiTermsRoutes({ ledger, clientFundedCompanies, ...(defaultMarkupBasisPoints !== undefined ? { defaultMarkupBasisPoints } : {}), ...(resaleTerms ? { modelvia: resaleTerms } : {}) });
  }
  // The store provisioning writes. When provisioning is not composed, the same
  // directory is still read, so devices it admitted earlier keep working.
  let secrets: SecretStore | undefined;
  if ('provisioning' in provisioning) secrets = provisioning.secrets;
  else if ((env.REALBUD_GATEWAY_SECRETS_DIR ?? '').trim()) {
    try { secrets = fileSecretStore(env.REALBUD_GATEWAY_SECRETS_DIR!.trim()); } catch { secrets = undefined; }
  }
  const registry = (env.REALBUD_GATEWAY_CONNECTOR_REGISTRY ?? '').trim();
  const modelviaOperator = modelviaOperatorState(env), operatorAccess = operatorAccessState(env);
  // Billing plans: the seller basis and reference ids from the deployment, the
  // resale default from the Modelvia terms policy. Plan routes answer 503 naming
  // the missing variable until every one is set.
  // Hermios subscriptions: off unless asked for; Square only in a collection mode.
  const hermios = composeHermiosSubscriptions({ env, ledger, fetch: options.fetch });
  const planConfig = composeBillingPlanConfig(env);
  const billingPlans = new BillingPlans({ billing: care.billing, config: planConfig, clientFundedCompanies,
    ...('unavailable' in policy ? { resaleUnavailable: policy.unavailable } : policy.resale ? { resale: policy.resale } : {}) });
  return {
    provisioning: 'provisioning' in provisioning ? 'composed' : provisioning.unavailable,
    modelviaOperator, operatorAccess, careCollection: care.careCollection,
    billingPlans, billingPlanConfig: 'unavailable' in planConfig ? planConfig.unavailable : 'configured',
    server: {
      allowedOrigins: options.allowedOrigins,
      portal: options.portal,
      modelviaOperator, operatorAccess,
      billing: care.billing, squareWebhooks: care.squareWebhooks,
      ...(afterTermsAccepted ? { afterTermsAccepted } : {}),
      ...(clientBilling ? { aiUsageCsv: (invoice: Invoice) => officeAiUsageCsv({ ledger, modelvia: clientBilling }, invoice) } : {}),
      ...(operator ? { operator } : {}),
      // The billing desk: care billing is always composed; Modelvia is read at
      // close exactly as `commercial-cli.ts close` reads it.
      operatorBilling: operatorBillingRoutes({ billing: care.billing, ...(clientBilling ? { modelvia: clientBilling } : {}), clientFundedCompanies, plans: billingPlans,
        ...('unavailable' in policy ? { policyUnavailable: policy.unavailable } : {}) }),
      billingPlans,
      paymentInstructions: composePaymentInstructions(env),
      ...('subscriptions' in hermios ? { hermios: hermios.subscriptions } : { hermiosUnavailable: hermios.unavailable }),
      ...('provisioning' in provisioning ? { provisioning: provisioning.provisioning } : { provisioningUnavailable: provisioning.unavailable }),
      ...(registry ? { connectors: new ManagedConnectors({ ledger,
        devices: () => connectorRegistry(registry),
        secret: connectorSecret(secrets, env),
        // On-demand app admission: the office's own project key (same store),
        // Composio behind the provider gate, and the registry writer.
        ...composeAppAdmission({ env, fetch: gatedFetch, registry }),
        ...options.connectorAdapters,
      }) } : {}),
    },
  };
}
