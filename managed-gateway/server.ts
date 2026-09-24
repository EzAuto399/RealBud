/**
 * Production/local entry for the RealBud managed gateway: installation
 * provisioning and revocation, connectors, health and readiness. Modelvia is the
 * only source of AI rates, caps, usage and invoices; nothing here bills, polls
 * provider costs or forwards model traffic.
 * Secrets via env; SQLite on a durable volume. Never import testing.ts here.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LedgerDatabase } from "./database.ts";
import { UsageLedger } from "./ledger.ts";
import { createGatewayServer } from "./http.ts";
import { verifyPortalToken } from "./portal-token.ts";
import { GatewayError, requireThat } from "./contracts.ts";
import { connectorRegistry, ManagedConnectors } from "./connectors.ts";
import { composeProvisioning, modelviaOperatorState } from "./provisioning.ts";
import { ledgerPath, loadLocalEnv } from "./local-env.ts";
import { composeOperatorRoutes, operatorAccessState } from "./office-ai-access.ts";

loadLocalEnv();

const port = Number(process.env.PORT || 8787);
// The same path the entitlement command writes (local-env.ts).
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
// records, the connector link journal and the audit chain. Its older billing
// tables stay in the schema, readable and untouched.
const db = new LedgerDatabase(dbPath);
const ledger = new UsageLedger(db, Date.now);

// Vendor-side installation provisioning, from the environment alone. Disabled
// unless REALBUD_ENABLE_PROVIDER=1. A deployment that enables it but misses a
// variable answers 503 naming that variable, rather than booting with a
// half-built Composio or Modelvia client. `fetch` is handed over only when the
// gate is open, so nothing can call out while provisioning is disabled.
const gatedFetch: typeof fetch = process.env.REALBUD_ENABLE_PROVIDER === "1" ? fetch : (async () => {
  throw new GatewayError("provisioning_disabled", 503);
});
const provisioningComposition = composeProvisioning({ env: process.env, ledger, fetch: gatedFetch });
const modelviaOperator = modelviaOperatorState(process.env);
// Operator routes (office AI access) under their own secret. Missing, short or
// equal to the portal secret composes nothing: the route answers 503.
const operator = composeOperatorRoutes({ env: process.env, ledger, fetch: gatedFetch });
const operatorAccess = operatorAccessState(process.env);

const server = createGatewayServer({
  allowedOrigins: siteOrigins,
  modelviaOperator,
  operatorAccess,
  ...(operator ? { operator } : {}),
  ...("provisioning" in provisioningComposition
    ? { provisioning: provisioningComposition.provisioning }
    : { provisioningUnavailable: provisioningComposition.unavailable }),
  ...(process.env.REALBUD_GATEWAY_CONNECTOR_REGISTRY ? { connectors: new ManagedConnectors({ ledger,
    devices: () => connectorRegistry(process.env.REALBUD_GATEWAY_CONNECTOR_REGISTRY!),
    secret: name => process.env[name],
  }) } : {}),
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

server.listen(port, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      listening: port,
      data: dbPath,
      origins: [...siteOrigins],
      // Codes, never values: say which variable a deployment still has to set.
      provisioning: "provisioning" in provisioningComposition ? "composed" : provisioningComposition.unavailable,
      modelviaOperator,
      operatorAccess,
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
