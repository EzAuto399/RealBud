/**
 * Production/local entry for the managed AI gateway.
 * Secrets via env; SQLite on a durable volume. Never import testing.ts here.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { LedgerDatabase } from "./database.ts";
import { UsageLedger } from "./ledger.ts";
import { ManagedGateway } from "./gateway.ts";
import { BillingService } from "./billing.ts";
import { LocalPaymentAdapter } from "./local-payment.ts";
import { createGatewayServer } from "./http.ts";
import { verifyPortalToken } from "./portal-token.ts";
import { GatewayError, requireThat } from "./contracts.ts";
import { directProvider } from "./direct-provider.ts";
import { createSquareBilling } from "./square-live.ts";
import { OpenAICostsPoller } from "./openai-costs.ts";
import { connectorRegistry, ManagedConnectors } from "./connectors.ts";
import { composeProvisioning } from "./provisioning.ts";

function loadLocalEnv() {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const cut = trimmed.indexOf("=");
    const key = trimmed.slice(0, cut).trim();
    const value = trimmed.slice(cut + 1);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadLocalEnv();

const port = Number(process.env.PORT || 8787);
const dataDir = resolve(process.env.REALBUD_GATEWAY_DATA || "./data");
const dbPath = resolve(dataDir, "ledger.sqlite");
const portalSecret = process.env.REALBUD_GATEWAY_PORTAL_SECRET || "";
const paymentMode = (process.env.REALBUD_PAYMENT_MODE || "local") as
  | "local"
  | "sandbox"
  | "live";
// An unrecognised value used to fall through the two `!== "local"` / `=== "live"`
// comparisons below: it required no REALBUD_AUTHORIZE_COLLECTION, and the gateway
// then advertised a payment mode it was not actually in. Refuse at boot instead.
requireThat(
  paymentMode === "local" || paymentMode === "sandbox" || paymentMode === "live",
  "REALBUD_PAYMENT_MODE must be local, sandbox or live",
);
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

const db = new LedgerDatabase(dbPath);
const ledger = new UsageLedger(db, Date.now);
const paymentKey = Buffer.from(
  process.env.REALBUD_PAYMENT_WEBHOOK_KEY ||
    randomBytes(32).toString("hex"),
  "hex",
);
requireThat(paymentKey.byteLength >= 32, "REALBUD_PAYMENT_WEBHOOK_KEY invalid");

const squareToken = process.env.SQUARE_ACCESS_TOKEN || "";
const squareNotify = process.env.SQUARE_NOTIFICATION_URL || "";
const squareSig = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "";
// Square's sandbox and production are separate hosts with separate tokens. Aim
// the client at the host that matches the configured mode, so a sandbox token
// is never sent to the production host (and vice versa). `live` is the only mode
// that may touch the real account.
const squareEnvironment = paymentMode === "sandbox" ? "sandbox" : "production";
export const square =
  squareToken && squareNotify && squareSig
    ? createSquareBilling({
        ledger,
        accessToken: squareToken,
        notificationUrl: squareNotify,
        signatureKey: squareSig,
        environment: squareEnvironment,
      })
    : null;

const authorizeCollection =
  paymentMode === "sandbox" || paymentMode === "live"
    ? process.env.REALBUD_AUTHORIZE_COLLECTION === "1"
    : false;
if (paymentMode !== "local") {
  requireThat(
    authorizeCollection,
    "Set REALBUD_AUTHORIZE_COLLECTION=1 to enable sandbox/live payment collection",
  );
  // NOTE: SquareBilling above is a statement/draft-invoice manager. It does NOT
  // implement HostedPaymentAdapter (no id/mode/createCheckout/verifyWebhook), so it
  // cannot serve /v1/portal/.../checkout. BillingService is therefore still handed
  // the local simulator, and a checkout URL from it is https://checkout.invalid/...
  // Do not set REALBUD_AUTHORIZE_COLLECTION=1 unless a real HostedPaymentAdapter is
  // wired here first: sandbox/live collection fails closed on this flag below.
  requireThat(
    !authorizeCollection,
    "sandbox/live payment collection is not wired: BillingService has no Square HostedPaymentAdapter, so checkout would return a simulator URL (https://checkout.invalid/...). Keep REALBUD_AUTHORIZE_COLLECTION unset until Square checkout is implemented.",
  );
}

const payment = new LocalPaymentAdapter(paymentKey, Date.now);

const billing = new BillingService(ledger, payment, { authorizeCollection });

const routes = new Map();
const deepseekKey = process.env.DEEPSEEK_API_KEY;
const kimiKey = process.env.KIMI_API_KEY;
if (deepseekKey && process.env.REALBUD_ENABLE_PROVIDER === "1") {
  routes.set(
    "deepseek-chat",
    directProvider({
      provider: "deepseek",
      model: "deepseek-chat",
      upstreamModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      maximumOutputTokens: Number(process.env.DEEPSEEK_MAX_OUTPUT || 8192),
      enforcedContextTokens: Number(process.env.DEEPSEEK_CONTEXT || 128000),
      terms: {
        reviewReference: process.env.DEEPSEEK_TERMS_REF || "operator-admitted",
        approvedUntil: Date.now() + 365 * 86400000,
      },
      secret: async () => deepseekKey,
      fetch,
    }),
  );
}
if (kimiKey && process.env.REALBUD_ENABLE_PROVIDER === "1") {
  routes.set(
    "kimi-k3",
    directProvider({
      provider: "kimi",
      model: "kimi-k3",
      upstreamModel: process.env.KIMI_MODEL || "kimi-k3",
      maximumOutputTokens: Number(process.env.KIMI_MAX_OUTPUT || 8192),
      enforcedContextTokens: Number(process.env.KIMI_CONTEXT || 128000),
      terms: {
        reviewReference: process.env.KIMI_TERMS_REF || "operator-admitted",
        approvedUntil: Date.now() + 365 * 86400000,
      },
      secret: async () => kimiKey,
      fetch,
    }),
  );
}

const authority = {
  async acquire() {
    const signal = AbortSignal.timeout(300_000);
    return {
      signal,
      async assertCurrent() {
        signal.throwIfAborted();
      },
      async release() {},
    };
  },
};

const gateway = new ManagedGateway({
  ledger,
  routes,
  authority,
  fingerprintKey: Buffer.from(
    process.env.REALBUD_FINGERPRINT_KEY || randomBytes(32).toString("hex"),
    "hex",
  ),
});

const openaiAdmin = process.env.OPENAI_ADMIN_KEY || "";
const openaiCosts = new OpenAICostsPoller({
  secret: async () => openaiAdmin,
  fetch: openaiAdmin ? fetch : undefined,
});
if (openaiAdmin) {
  const tick = () => {
    void openaiCosts.poll();
  };
  tick();
  setInterval(tick, 60_000).unref();
}

// Vendor-side installation provisioning, from the environment alone. Disabled
// unless REALBUD_ENABLE_PROVIDER=1, like every other outbound provider here. A
// deployment that enables it but misses a variable answers 503 naming that
// variable, rather than booting with a half-built Composio or Modelvia client.
// `fetch` is handed over only when the gate is open, so nothing can call out
// while provisioning is disabled.
const provisioningComposition = composeProvisioning({
  env: process.env,
  ledger,
  fetch: process.env.REALBUD_ENABLE_PROVIDER === "1" ? fetch : (async () => {
    throw new GatewayError("provisioning_disabled", 503);
  }),
});

const server = createGatewayServer({
  gateway,
  billing,
  allowedOrigins: siteOrigins,
  ...("provisioning" in provisioningComposition
    ? { provisioning: provisioningComposition.provisioning }
    : { provisioningUnavailable: provisioningComposition.unavailable }),
  ...(process.env.REALBUD_GATEWAY_CONNECTOR_REGISTRY ? { connectors: new ManagedConnectors({ ledger,
    devices: () => connectorRegistry(process.env.REALBUD_GATEWAY_CONNECTOR_REGISTRY!),
    secret: name => process.env[name],
  }) } : {}),
  health: {
    squareConfigured: !!square,
    // Which mode the gateway is in, so an operator can see that a sandbox/live
    // deployment is real rather than reading squareConfigured alone.
    paymentMode,
    openaiCostsConfigured: openaiCosts.status().configured,
  },
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
      routes: [...routes.keys()],
      paymentMode,
      squareConfigured: !!square,
      // A code, never a value: says which variable a deployment still has to set.
      provisioning: "provisioning" in provisioningComposition ? "composed" : provisioningComposition.unavailable,
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
