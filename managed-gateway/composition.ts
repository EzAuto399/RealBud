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
import { composeProvisioning, fileSecretStore, modelviaOperatorState, type SecretStore } from './provisioning.ts';
import { composeOperatorRoutes, operatorAccessState } from './office-ai-access.ts';
import { BillingService } from './billing.ts';
import { composeModelviaClientBilling } from './modelvia-client-billing.ts';
import { customerTermsPolicy } from './modelvia-keys.ts';
import { officeMargins } from './office-ai-billing.ts';
import { SquareHostedPaymentAdapter } from './square-payment.ts';

export type GatewayServerOptions = Parameters<typeof createGatewayServer>[0];

export interface GatewayComposition {
  server: GatewayServerOptions;
  /** `composed`, or the code naming the variable to set. Never a value. */
  provisioning: string;
  modelviaOperator: 'configured' | 'missing';
  operatorAccess: 'configured' | 'missing';
  /** Care-fee collection through Square: `off` (invoices close and read, no checkout), `sandbox` or `live`. */
  careCollection: CareCollectionMode;
}

export type CareCollectionMode = 'off' | 'sandbox' | 'live';
export interface CareCollection { billing: BillingService; careCollection: CareCollectionMode; squareWebhooks: boolean }
const SQUARE_ENV = ['SQUARE_ACCESS_TOKEN', 'SQUARE_MERCHANT_ID', 'SQUARE_LOCATION_ID', 'SQUARE_NOTIFICATION_URL', 'SQUARE_WEBHOOK_SIGNATURE_KEY', 'REALBUD_INTERNAL_COMPANY_ID'] as const;
const LIVE_APPROVAL_ENV = ['REALBUD_SELLER_BASIS_APPROVAL_REF', 'REALBUD_PRODUCTION_INVOICE_APPROVAL_REF', 'REALBUD_MANAGED_PROJECT_VERIFIED_REF'] as const;

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
  if (mode === 'local') return { billing: new BillingService(ledger, undefined, { internalCompanyId }), careCollection: 'off', squareWebhooks: false };
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
  return { billing: new BillingService(ledger, adapter, { authorizeCollection: true, internalCompanyId }), careCollection: mode, squareWebhooks: true };
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
  if (operator) {
    const modelvia = composeModelviaClientBilling({ env, fetch: gatedFetch });
    const policy = customerTermsPolicy(env);
    const clientFundedCompanies = 'unavailable' in policy ? new Set<string>() : policy.clientFundedCompanies;
    operator.margins = period => officeMargins({ billing: care.billing, ...(modelvia ? { modelvia } : {}), clientFundedCompanies }, period);
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
  return {
    provisioning: 'provisioning' in provisioning ? 'composed' : provisioning.unavailable,
    modelviaOperator, operatorAccess, careCollection: care.careCollection,
    server: {
      allowedOrigins: options.allowedOrigins,
      portal: options.portal,
      modelviaOperator, operatorAccess,
      billing: care.billing, squareWebhooks: care.squareWebhooks,
      ...(operator ? { operator } : {}),
      ...('provisioning' in provisioning ? { provisioning: provisioning.provisioning } : { provisioningUnavailable: provisioning.unavailable }),
      ...(registry ? { connectors: new ManagedConnectors({ ledger,
        devices: () => connectorRegistry(registry),
        secret: connectorSecret(secrets, env),
        ...options.connectorAdapters,
      }) } : {}),
    },
  };
}
