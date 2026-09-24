/**
 * The gateway's production composition, from the environment alone, so the
 * wiring `server.ts` runs is the wiring the tests run. Never import testing.ts.
 *
 * The one rule this file exists to keep: the connector broker reads each office's
 * Composio project key from the same secret store provisioning wrote it into.
 * Two stores (or provisioning's store plus `process.env`) would leave every
 * freshly provisioned device answering `connector_not_configured`.
 */
import { GatewayError } from './contracts.ts';
import type { UsageLedger } from './ledger.ts';
import type { HttpTransport, ComposioOrgClient } from './composio-org.ts';
import type { ModelviaOperatorClient } from './modelvia-keys.ts';
import { connectorRegistry, ManagedConnectors, type ConnectorOptions } from './connectors.ts';
import { createGatewayServer, type PortalIdentity } from './http.ts';
import { composeProvisioning, fileSecretStore, modelviaOperatorState, type SecretStore } from './provisioning.ts';
import { composeOperatorRoutes, operatorAccessState } from './office-ai-access.ts';

export type GatewayServerOptions = Parameters<typeof createGatewayServer>[0];

export interface GatewayComposition {
  server: GatewayServerOptions;
  /** `composed`, or the code naming the variable to set. Never a value. */
  provisioning: string;
  modelviaOperator: 'configured' | 'missing';
  operatorAccess: 'configured' | 'missing';
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
    modelviaOperator, operatorAccess,
    server: {
      allowedOrigins: options.allowedOrigins,
      portal: options.portal,
      modelviaOperator, operatorAccess,
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
