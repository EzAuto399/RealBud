/** Zero-touch installation provisioning carried by the website redeem reply.
 *
 * The vendor side issues everything this computer needs when an installation is
 * first set up: a managed connector grant (the Composio project key stays on the
 * broker) and a per-installation, revocable, spend-capped model gateway key.
 * Absent `provisioning` the reply is the older link-only contract.
 *
 * This module is dependency-free and validates with exact key sets: an added
 * field on the hosted side is a rejection here, never a silent pass-through.
 */

export const INSTALLATION_PROVISIONING_VERSION = 1;

export interface InstallationProvisioning {
  version: 1;
  service: { companyId: string; hostInstallationId: string };
  connector: { endpoint: string; credential: string; profile: string; apps: string[] };
  model: { provider: "modelvia"; baseUrl: string; projectId: string; key: string; keyId: string; spendCapLabel: string };
}

/**
 * The reasons the website states when it deliberately issued no grant
 * (`website/lib/installation-provisioning.ts`). The first four name a setup
 * step on the office's account that support finishes, after which the next
 * check-in provisions; the gateway ones name RealBud's own service setup; the
 * last is an attempt whose outcome the website could not record, held for
 * support. The card shows one sentence per reason.
 */
export const PROVISIONING_SKIP_REASONS = [
  "no_platform_customer",
  "service_not_entitled",
  "service_not_active",
  "modelvia_customer_not_ready",
  "provisioning_gateway_unconfigured",
  "provisioning_gateway_same_as_platform",
  "provisioning_gateway_wrong_service",
  "provisioning_gateway_not_ready",
  "provisioning_attempt_requires_review",
] as const;
export type ProvisioningSkipReason = typeof PROVISIONING_SKIP_REASONS[number];
/** A stated absence: linked, but no grant was issued, for `skipped`. A reason
 * a newer website adds is kept verbatim (bounded identifier) rather than
 * refused, so it can never turn linking into a failure. */
export interface ProvisioningSkipped { skipped: string }
export function isProvisioningSkipReason(value: string): value is ProvisioningSkipReason {
  return (PROVISIONING_SKIP_REASONS as readonly string[]).includes(value);
}
export function isProvisioningSkipped(value: InstallationProvisioning | ProvisioningSkipped | undefined): value is ProvisioningSkipped {
  return value !== undefined && "skipped" in value;
}
/** Shape of a stored or reported reason; the website's own spelling. */
export function isProvisioningSkipReasonText(value: unknown): value is string {
  return typeof value === "string" && SKIP_REASON.test(value);
}

export interface OfficeLinkRedeemResult {
  installationId: string;
  companyId: string;
  agencyLabel: string;
  provisioning?: InstallationProvisioning | ProvisioningSkipped;
}

/** Service ledger identifiers: opaque, not names. Same shape the entitlement
 * authority accepts, so a provisioned installation can be matched to a grant. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CONNECTOR_CREDENTIAL = /^rbc_[a-f0-9]{64}$/;
/** Per-installation Modelvia client key. An organization or operator key is a
 * different shape and is refused below wherever it appears. */
const MODEL_KEY = /^rbk_[A-Za-z0-9_-]{24,200}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PROFILE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const APP = /^[a-z][a-z0-9_-]{0,63}$/;
/** Printable ASCII. The gateway emits a short human label ("A$200/month,
 * A$1/request, 2 at once", never above 80); gateways from before 25 September
 * 2026 emitted the raw nanoAUD figures at about 82 characters, so the bound
 * stays wide enough for both. Nothing parses the label; it is shown as is. */
const SPEND_CAP = /^[\x20-\x7e]{1,160}$/;
/** Lower-case identifier, as the website spells every stated reason. */
const SKIP_REASON = /^[a-z][a-z0-9_]{0,63}$/;
/** Anything shaped like a vendor organization/project key must never be handed
 * to a customer machine, whatever field it arrives in. */
const ORGANIZATION_KEY = /(?:\b(?:ak|ck)_[A-Za-z0-9_-]{16,})|(?:\bsk-[A-Za-z0-9_-]{16,})/;

const MAX_APPS = 32;

function invalid(): never {
  throw new Error("The website returned service setup this computer cannot accept. Retry the same code.");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalid();
  return value;
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

/** https origin with no path, query, fragment or embedded credentials. A
 * loopback http origin stays available for local service rigs, matching the
 * managed connector endpoint rule; nothing else may be plain http. */
function origin(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") invalid();
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) invalid();
  return value;
}

/** The model gateway publishes an OpenAI-compatible API under a path (`/v1`),
 * so its base URL keeps whatever path the vendor issued. Query, fragment and
 * embedded credentials are still refused, and a trailing slash is normalized
 * away so the same gateway is one value everywhere. */
function gatewayBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.username || url.password || url.search || url.hash) invalid();
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) invalid();
  if (!/^(?:\/[A-Za-z0-9._~-]{1,64})*\/?$/.test(url.pathname)) invalid();
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

/** Depth-bounded scan so an organization key cannot ride along in any field. */
function refuseOrganizationKeys(value: unknown, depth = 0): void {
  if (typeof value === "string") { if (ORGANIZATION_KEY.test(value)) throw new Error("The website returned a vendor key this computer must not hold. Contact service support."); return; }
  if (depth > 8 || !value || typeof value !== "object") return;
  for (const entry of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) refuseOrganizationKeys(entry, depth + 1);
}

/**
 * `undefined` when the reply carries no provisioning at all (an older website,
 * or one whose gateway was unreachable this time).
 *
 * The portal answers `{ skipped: <reason> }` when it deliberately did not mint
 * a grant — for example an office with no platform customer binding. That is a
 * stated absence, not a malformed descriptor: it never blocks linking, and the
 * reason is returned so the card can say what to do next. Anything else that
 * is present but malformed throws a user-facing sentence.
 */
export function parseInstallationProvisioning(value: unknown): InstallationProvisioning | ProvisioningSkipped | undefined {
  if (value === undefined || value === null) return undefined;
  refuseOrganizationKeys(value);
  if (object(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "skipped")) {
    if (!isProvisioningSkipReasonText(value.skipped)) invalid();
    return { skipped: value.skipped };
  }
  const root = exact(value, ["version", "service", "connector", "model"]);
  if (root.version !== INSTALLATION_PROVISIONING_VERSION) invalid();

  const service = exact(root.service, ["companyId", "hostInstallationId"]);
  // The gateway also gives the website its Composio project identifier for
  // installation accounting. Admit that documented metadata explicitly; the
  // local worker needs only the scoped connector credential, never the project.
  const hasConnectorProject = object(root.connector) && Object.hasOwn(root.connector, "projectId");
  const connector = exact(root.connector, ["endpoint", "credential", "profile", "apps", ...(hasConnectorProject ? ["projectId"] : [])]);
  if (hasConnectorProject) text(connector.projectId, ID);
  const model = exact(root.model, ["provider", "baseUrl", "projectId", "key", "keyId", "spendCapLabel"]);

  const apps = connector.apps;
  if (!Array.isArray(apps) || !apps.length || apps.length > MAX_APPS) invalid();
  const names = apps.map(app => text(app, APP));
  if (new Set(names).size !== names.length) invalid();
  if (model.provider !== "modelvia") invalid();

  return {
    version: INSTALLATION_PROVISIONING_VERSION,
    service: { companyId: text(service.companyId, ID), hostInstallationId: text(service.hostInstallationId, ID) },
    connector: {
      endpoint: origin(connector.endpoint),
      credential: text(connector.credential, CONNECTOR_CREDENTIAL),
      profile: text(connector.profile, PROFILE),
      apps: [...names].sort(),
    },
    model: {
      provider: "modelvia",
      baseUrl: gatewayBaseUrl(model.baseUrl),
      projectId: text(model.projectId, ID),
      key: text(model.key, MODEL_KEY),
      keyId: text(model.keyId, KEY_ID),
      spendCapLabel: text(model.spendCapLabel, SPEND_CAP),
    },
  };
}

/** Apps a managed installation may connect when the website named none. */
export const DEFAULT_MANAGED_APPS = ["gmail"] as const;

// ── AI usage for one calendar month ─────────────────────────────────────────

/** Amounts are exact nano-AUD decimal strings: a month of usage can exceed
 * Number.MAX_SAFE_INTEGER, and a rounded number would be a wrong bill. */
export interface InstallationUsage {
  period: string;
  requests: number;
  tokens: { input: string; output: string };
  money: { customerNetNanoAud: string | null };
  monthlyCapNanoAud: string | null;
  remainingNanoAud: string | null;
  updatedAt: string;
}

/** `checking` is the first load, not zero usage — the card must not show a
 * number it has not been given. */
export type InstallationUsageState =
  | { state: "not-linked" }
  | { state: "checking" }
  | { state: "unavailable" }
  | { state: "ready"; usage: InstallationUsage };

export const USAGE_PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const AMOUNT = /^\d{1,60}$/;
const SIGNED_AMOUNT = /^-?\d{1,60}$/;

export function currentUsagePeriod(now = new Date()): string {
  // Modelvia and the portal close accounting months in Brisbane (UTC+10,
  // without daylight saving). The desktop must ask for that same month.
  return new Date(now.getTime() + 36_000_000).toISOString().slice(0, 7);
}

function usageInvalid(): never { throw new Error("The usage report could not be read."); }

function amount(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) usageInvalid();
  return value;
}

/** Optional fields may be absent or explicitly null; anything else is refused. */
function optionalAmount(value: unknown, pattern: RegExp): string | null {
  return value === undefined || value === null ? null : amount(value, pattern);
}

/** Strict: the reply must answer the period that was asked for, so a cached or
 * misrouted month is never shown as this month's spend. */
export function parseInstallationUsage(value: unknown, period: string): InstallationUsage {
  if (!object(value)) usageInvalid();
  const allowed = ["period", "requests", "tokens", "money", "monthlyCapNanoAud", "remainingNanoAud", "updatedAt"];
  if (Object.keys(value).some(key => !allowed.includes(key))) usageInvalid();
  if (!USAGE_PERIOD.test(period) || value.period !== period) usageInvalid();
  if (typeof value.requests !== "number" || !Number.isSafeInteger(value.requests) || value.requests < 0) usageInvalid();
  if (typeof value.updatedAt !== "string" || value.updatedAt.length > 40 || !Number.isFinite(Date.parse(value.updatedAt))) usageInvalid();
  const tokens = value.tokens, money = value.money;
  if (!object(tokens) || !exactKeys(tokens, ["input", "output"]) || !object(money) || !exactKeys(money, ["customerNetNanoAud"])) usageInvalid();
  return {
    period,
    requests: value.requests,
    tokens: { input: amount(tokens.input, AMOUNT), output: amount(tokens.output, AMOUNT) },
    money: { customerNetNanoAud: money.customerNetNanoAud === null ? null : amount(money.customerNetNanoAud, AMOUNT) },
    monthlyCapNanoAud: optionalAmount(value.monthlyCapNanoAud, AMOUNT),
    remainingNanoAud: optionalAmount(value.remainingNanoAud, SIGNED_AMOUNT),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/**
 * Exact nano-AUD → "A$1,234.56". Same method as the portal's analytics
 * formatter (`website/lib/platform-analytics.ts`): BigInt throughout, so no
 * amount is ever rounded through a float.
 */
export function formatNanoAud(value: string | null, decimals = 2): string {
  if (value === null) return "Not priced";
  if (!/^-?\d+$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 9) return "Unavailable";
  const n = BigInt(value), negative = n < BigInt(0), absolute = negative ? -n : n, scale = BigInt(10) ** BigInt(9 - decimals);
  const rounded = (absolute + scale / BigInt(2)) / scale, denominator = BigInt(10) ** BigInt(decimals);
  return `${negative && rounded !== BigInt(0) ? "-" : ""}A$${(rounded / denominator).toLocaleString("en-AU")}${decimals ? `.${(rounded % denominator).toString().padStart(decimals, "0")}` : ""}`;
}

export function formatTokenCount(value: string): string {
  return /^\d+$/.test(value) ? BigInt(value).toLocaleString("en-AU") : "Unavailable";
}
