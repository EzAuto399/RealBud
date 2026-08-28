import { createHash } from "node:crypto";

import type {
  ExecutionAdapterProjection,
  ExecutionAdapterTransport,
  WorkRouteKind,
} from "../shared/contracts.ts";
import type { WorkRoutingCapabilities } from "./work-routing.ts";

const ATTESTATION_TTL_MS = 15 * 60 * 1_000;
const MAX_ADAPTERS = 64;
const MAX_OPERATIONS = 8;

export const EXECUTION_ADAPTER_OPERATIONS = [
  "read-structured-records",
  "read-bank-credits",
  "read-mail-items",
  "read-calendar-events",
  "analyse-selected-files",
  "browse-approved-origin",
  "prepare-approved-fields",
  "read-history-metadata",
] as const;

export type ExecutionAdapterOperation = (typeof EXECUTION_ADAPTER_OPERATIONS)[number];
export type ExecutionAdapterEffect = "read-only" | "prepare-only";

export interface ExecutionAdapterManifest {
  kind: "realbud.execution-adapter.v1";
  schemaVersion: 1;
  id: string;
  version: number;
  label: string;
  method: string;
  transport: ExecutionAdapterTransport;
  route: WorkRouteKind | null;
  operations: ExecutionAdapterOperation[];
  effect: ExecutionAdapterEffect;
  requiresNamedAccount: boolean;
  requiresExplicitOptIn: boolean;
  runtimeAvailable: boolean;
  runtimeUnavailableReason?: string;
  maxConcurrency: number;
}

export interface RemoteExecutionPolicy {
  region: string;
  retentionHours: number;
  deletionSupported: true;
  encryptionAtRest: true;
  encryptionInTransit: true;
  spendCeilingCents: number;
  localFallback: true;
}

export interface ExecutionAdapterAttestation {
  kind: "realbud.execution-adapter-attestation.v1";
  schemaVersion: 1;
  adapterId: string;
  adapterVersion: number;
  configurationGeneration: number;
  state: "ready" | "attention";
  observedAt: number;
  expiresAt: number;
  policyDigest: string;
  accountIdentityDigest?: string;
  explicitOptIn?: boolean;
  remotePolicy?: RemoteExecutionPolicy;
  reasonCode?: string;
}

/** Immutable, content-free proof that one code-owned adapter was ready for
 * one exact operation when a work plan was admitted. It is safe to persist in
 * broker receipts: account identity is a digest and no credential, source
 * content, cookie, path or provider response is present. */
export interface ExecutionAdapterBinding {
  kind: "realbud.execution-adapter-binding.v1";
  schemaVersion: 1;
  adapterId: string;
  adapterVersion: number;
  transport: ExecutionAdapterTransport;
  route: WorkRouteKind;
  operation: ExecutionAdapterOperation;
  effect: ExecutionAdapterEffect;
  configurationGeneration: number;
  observedAt: number;
  expiresAt: number;
  attestationDigest: string;
  policyDigest: string;
  accountIdentityDigest?: string;
  explicitOptIn: boolean;
  remotePolicy?: RemoteExecutionPolicy;
  bindingDigest: string;
}

interface RuntimeRecord {
  attestation: ExecutionAdapterAttestation;
  digest: string;
  revoked: boolean;
  revokedAt: number | null;
  revokeReason: string | null;
}

const OPERATION_LABELS: Record<ExecutionAdapterOperation, string> = {
  "read-structured-records": "Read typed records from one named source",
  "read-bank-credits": "Read bounded credit activity only",
  "read-mail-items": "Read named inbound items",
  "read-calendar-events": "Read named calendar context",
  "analyse-selected-files": "Analyse only PM-selected files",
  "browse-approved-origin": "Use one approved origin and account",
  "prepare-approved-fields": "Prepare approved fields; the PM submits",
  "read-history-metadata": "Recover bounded session metadata only",
};

const TRANSPORT_LABELS: Record<ExecutionAdapterTransport, string> = {
  "direct-api": "Direct API",
  "restricted-composio": "Restricted Composio",
  "approved-mcp": "Approved MCP",
  "isolated-task": "Isolated task workspace",
  "private-browser": "Private browser",
  "bounded-cua": "Bounded computer use",
  "remote-lane": "Cloud acceleration",
  "history-api": "Computer History recovery",
};

const TRANSPORT_ROUTES: Record<ExecutionAdapterTransport, ReadonlySet<WorkRouteKind | null>> = {
  "direct-api": new Set(["structured-batch"]),
  "restricted-composio": new Set(["structured-batch"]),
  "approved-mcp": new Set(["structured-batch"]),
  "isolated-task": new Set(["local-analysis"]),
  "private-browser": new Set(["scripted-browser", "isolated-browser"]),
  "bounded-cua": new Set(["desktop-cua"]),
  "remote-lane": new Set(["remote-analysis", "remote-browser"]),
  "history-api": new Set([null]),
};

const TRANSPORT_OPERATIONS: Record<ExecutionAdapterTransport, ReadonlySet<ExecutionAdapterOperation>> = {
  "direct-api": new Set(["read-structured-records", "read-bank-credits", "read-mail-items", "read-calendar-events"]),
  "restricted-composio": new Set(["read-structured-records", "read-bank-credits", "read-mail-items", "read-calendar-events"]),
  "approved-mcp": new Set(["read-structured-records", "read-bank-credits", "read-mail-items", "read-calendar-events"]),
  "isolated-task": new Set(["analyse-selected-files"]),
  "private-browser": new Set(["read-structured-records", "read-bank-credits", "browse-approved-origin", "prepare-approved-fields"]),
  "bounded-cua": new Set(["browse-approved-origin", "prepare-approved-fields"]),
  "remote-lane": new Set(["analyse-selected-files", "browse-approved-origin", "prepare-approved-fields"]),
  "history-api": new Set(["read-history-metadata"]),
};

const ROUTE_LIMITS: Readonly<Record<WorkRouteKind, number>> = {
  "structured-batch": 1,
  "local-analysis": 2,
  "remote-analysis": 8,
  "scripted-browser": 1,
  "isolated-browser": 2,
  "remote-browser": 8,
  "desktop-cua": 1,
};

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const SAFE_REASON = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function codedError(message: string, code = "invalid-execution-adapter", status = 400): Error {
  return Object.assign(new Error(message), { code, status });
}

function boundedText(name: string, value: unknown, maximum: number): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw codedError(`${name} is invalid`);
  }
  return value.trim();
}

function boundedInteger(name: string, value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw codedError(`${name} is invalid`);
  }
  return Number(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function normalizedOperations(raw: unknown, transport: ExecutionAdapterTransport): ExecutionAdapterOperation[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OPERATIONS) {
    throw codedError("adapter operations are invalid");
  }
  const operations = raw.map((value) => {
    if (typeof value !== "string" || !EXECUTION_ADAPTER_OPERATIONS.includes(value as ExecutionAdapterOperation)) {
      throw codedError("adapter operation is not supported");
    }
    const operation = value as ExecutionAdapterOperation;
    if (!TRANSPORT_OPERATIONS[transport].has(operation)) {
      throw codedError("adapter operation does not match its transport");
    }
    return operation;
  });
  if (new Set(operations).size !== operations.length) throw codedError("adapter operations must be unique");
  return [...operations].sort();
}

export function defineExecutionAdapterManifest(raw: unknown): ExecutionAdapterManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw codedError("adapter manifest is invalid");
  const value = raw as Record<string, unknown>;
  const optionalReason = Object.hasOwn(value, "runtimeUnavailableReason");
  const keys = [
    "kind", "schemaVersion", "id", "version", "label", "method", "transport", "route", "operations",
    "effect", "requiresNamedAccount", "requiresExplicitOptIn", "runtimeAvailable", "maxConcurrency",
    ...(optionalReason ? ["runtimeUnavailableReason"] : []),
  ];
  if (!exactKeys(value, keys)) throw codedError("adapter manifest has unknown or missing fields");
  if (value.kind !== "realbud.execution-adapter.v1" || value.schemaVersion !== 1) {
    throw codedError("adapter manifest version is unsupported");
  }
  const id = boundedText("adapter id", value.id, 120);
  if (!SAFE_ID.test(id)) throw codedError("adapter id is invalid");
  const version = boundedInteger("adapter version", value.version, 1_000_000);
  if (version < 1) throw codedError("adapter version must be positive");
  const transport = value.transport as ExecutionAdapterTransport;
  if (!Object.hasOwn(TRANSPORT_ROUTES, transport)) throw codedError("adapter transport is unsupported");
  const route = value.route as WorkRouteKind | null;
  if (!TRANSPORT_ROUTES[transport].has(route)) throw codedError("adapter route does not match its transport");
  const effect = value.effect;
  if (effect !== "read-only" && effect !== "prepare-only") throw codedError("adapter effect is invalid");
  const operations = normalizedOperations(value.operations, transport);
  if (effect === "prepare-only" && !operations.includes("prepare-approved-fields")) {
    throw codedError("prepare-only adapters must expose only the approved preparation operation");
  }
  if (operations.includes("prepare-approved-fields") && effect !== "prepare-only") {
    throw codedError("approved field preparation must use the prepare-only effect class");
  }
  if (effect === "prepare-only" && !["private-browser", "bounded-cua", "remote-lane"].includes(transport)) {
    throw codedError("this transport cannot prepare an external field");
  }
  if (typeof value.requiresNamedAccount !== "boolean" || typeof value.requiresExplicitOptIn !== "boolean") {
    throw codedError("adapter account and opt-in policy are invalid");
  }
  if (transport === "history-api" && value.requiresExplicitOptIn !== true) {
    throw codedError("Computer History recovery must require explicit opt-in");
  }
  if (transport === "remote-lane" && value.requiresNamedAccount !== true) {
    throw codedError("cloud acceleration must bind a named account");
  }
  if (typeof value.runtimeAvailable !== "boolean") throw codedError("adapter runtime availability is invalid");
  const runtimeUnavailableReason = optionalReason
    ? boundedText("runtime unavailable reason", value.runtimeUnavailableReason, 240)
    : undefined;
  if (value.runtimeAvailable === false && !runtimeUnavailableReason) {
    throw codedError("an unavailable runtime needs a reason");
  }
  if (value.runtimeAvailable === true && runtimeUnavailableReason) {
    throw codedError("an available runtime cannot carry an unavailable reason");
  }
  const maximum = route === null ? 0 : ROUTE_LIMITS[route];
  const maxConcurrency = boundedInteger("adapter concurrency", value.maxConcurrency, maximum);
  if (route !== null && maxConcurrency < 1) throw codedError("adapter concurrency must be positive");
  if (route === null && maxConcurrency !== 0) throw codedError("metadata adapters cannot own an execution lane");
  return {
    kind: "realbud.execution-adapter.v1",
    schemaVersion: 1,
    id,
    version,
    label: boundedText("adapter label", value.label, 100),
    method: boundedText("adapter method", value.method, 100),
    transport,
    route,
    operations,
    effect,
    requiresNamedAccount: value.requiresNamedAccount,
    requiresExplicitOptIn: value.requiresExplicitOptIn,
    runtimeAvailable: value.runtimeAvailable,
    ...(runtimeUnavailableReason ? { runtimeUnavailableReason } : {}),
    maxConcurrency,
  };
}

function normalizeRemotePolicy(raw: unknown): RemoteExecutionPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw codedError("cloud data policy is required");
  const value = raw as Record<string, unknown>;
  if (!exactKeys(value, [
    "region", "retentionHours", "deletionSupported", "encryptionAtRest", "encryptionInTransit",
    "spendCeilingCents", "localFallback",
  ])) throw codedError("cloud data policy has unknown or missing fields");
  const region = boundedText("cloud region", value.region, 32);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,31}$/.test(region)) throw codedError("cloud region is invalid");
  if (
    value.deletionSupported !== true || value.encryptionAtRest !== true ||
    value.encryptionInTransit !== true || value.localFallback !== true
  ) throw codedError("cloud policy must preserve deletion, encryption and local fallback");
  return {
    region,
    retentionHours: boundedInteger("cloud retention", value.retentionHours, 24 * 30),
    deletionSupported: true,
    encryptionAtRest: true,
    encryptionInTransit: true,
    spendCeilingCents: boundedInteger("cloud spend ceiling", value.spendCeilingCents, 10_000_000),
    localFallback: true,
  };
}

function normalizeAttestation(
  raw: unknown,
  manifest: ExecutionAdapterManifest,
  now: number,
): ExecutionAdapterAttestation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw codedError("adapter attestation is invalid");
  const value = raw as Record<string, unknown>;
  const optional = ["accountIdentityDigest", "explicitOptIn", "remotePolicy", "reasonCode"]
    .filter((key) => Object.hasOwn(value, key));
  if (!exactKeys(value, [
    "kind", "schemaVersion", "adapterId", "adapterVersion", "configurationGeneration", "state",
    "observedAt", "expiresAt", "policyDigest", ...optional,
  ])) throw codedError("adapter attestation has unknown or missing fields");
  if (value.kind !== "realbud.execution-adapter-attestation.v1" || value.schemaVersion !== 1) {
    throw codedError("adapter attestation version is unsupported");
  }
  if (value.adapterId !== manifest.id || value.adapterVersion !== manifest.version) {
    throw codedError("adapter attestation does not match its manifest", "adapter-version-mismatch", 409);
  }
  const state = value.state;
  if (state !== "ready" && state !== "attention") throw codedError("adapter state is invalid");
  const observedAt = boundedInteger("adapter observed time", value.observedAt, Number.MAX_SAFE_INTEGER);
  const expiresAt = boundedInteger("adapter expiry", value.expiresAt, Number.MAX_SAFE_INTEGER);
  if (observedAt > now + 5_000 || expiresAt <= observedAt || expiresAt > observedAt + ATTESTATION_TTL_MS) {
    throw codedError("adapter attestation freshness is invalid");
  }
  if (typeof value.policyDigest !== "string" || !SHA256.test(value.policyDigest)) {
    throw codedError("adapter policy digest is invalid");
  }
  const accountIdentityDigest = value.accountIdentityDigest;
  if (accountIdentityDigest !== undefined && (typeof accountIdentityDigest !== "string" || !SHA256.test(accountIdentityDigest))) {
    throw codedError("adapter account identity digest is invalid");
  }
  if (state === "ready" && manifest.requiresNamedAccount && accountIdentityDigest === undefined) {
    throw codedError("a named-account adapter cannot be ready without an account identity digest");
  }
  if (value.explicitOptIn !== undefined && typeof value.explicitOptIn !== "boolean") {
    throw codedError("adapter opt-in state is invalid");
  }
  if (state === "ready" && manifest.requiresExplicitOptIn && value.explicitOptIn !== true) {
    throw codedError("this adapter requires explicit opt-in before it can be ready");
  }
  const remotePolicy = manifest.transport === "remote-lane"
    ? normalizeRemotePolicy(value.remotePolicy)
    : undefined;
  if (manifest.transport !== "remote-lane" && value.remotePolicy !== undefined) {
    throw codedError("a local adapter cannot carry a cloud data policy");
  }
  const reasonCode = value.reasonCode === undefined ? undefined : boundedText("adapter reason", value.reasonCode, 80);
  if (reasonCode && !SAFE_REASON.test(reasonCode)) throw codedError("adapter reason is invalid");
  if (state === "attention" && !reasonCode) throw codedError("an attention attestation needs a reason code");
  return {
    kind: "realbud.execution-adapter-attestation.v1",
    schemaVersion: 1,
    adapterId: manifest.id,
    adapterVersion: manifest.version,
    configurationGeneration: boundedInteger("adapter configuration generation", value.configurationGeneration, 1_000_000_000),
    state,
    observedAt,
    expiresAt,
    policyDigest: value.policyDigest,
    ...(accountIdentityDigest ? { accountIdentityDigest } : {}),
    ...(value.explicitOptIn !== undefined ? { explicitOptIn: value.explicitOptIn as boolean } : {}),
    ...(remotePolicy ? { remotePolicy } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function attestationDigest(value: ExecutionAdapterAttestation): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bindingDigest(value: Omit<ExecutionAdapterBinding, "bindingDigest">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Build the only adapter proof accepted by an executable work plan. Callers
 * supply code-owned manifests and runtime observations; renderer/model input
 * must never reach this function as a manifest. */
export function createExecutionAdapterBinding(input: {
  manifest: ExecutionAdapterManifest;
  attestation: ExecutionAdapterAttestation;
  operation: ExecutionAdapterOperation;
  now?: number;
}): ExecutionAdapterBinding {
  const now = input.now ?? Date.now();
  const manifest = defineExecutionAdapterManifest(input.manifest);
  const attestation = normalizeAttestation(input.attestation, manifest, now);
  if (attestation.state !== "ready" || attestation.expiresAt <= now) {
    throw codedError("adapter is not freshly ready", "adapter-not-ready", 409);
  }
  if (!manifest.route || !manifest.operations.includes(input.operation)) {
    throw codedError("adapter operation is not admitted by its manifest", "adapter-operation-mismatch", 409);
  }
  const base: Omit<ExecutionAdapterBinding, "bindingDigest"> = {
    kind: "realbud.execution-adapter-binding.v1",
    schemaVersion: 1,
    adapterId: manifest.id,
    adapterVersion: manifest.version,
    transport: manifest.transport,
    route: manifest.route,
    operation: input.operation,
    effect: manifest.effect,
    configurationGeneration: attestation.configurationGeneration,
    observedAt: attestation.observedAt,
    expiresAt: attestation.expiresAt,
    attestationDigest: attestationDigest(attestation),
    policyDigest: attestation.policyDigest,
    ...(attestation.accountIdentityDigest ? { accountIdentityDigest: attestation.accountIdentityDigest } : {}),
    explicitOptIn: attestation.explicitOptIn === true,
    ...(attestation.remotePolicy ? { remotePolicy: structuredClone(attestation.remotePolicy) } : {}),
  };
  return { ...base, bindingDigest: bindingDigest(base) };
}

/** Revalidate a binding after persistence or before plan admission. Unknown
 * versions and extra fields fail closed. Freshness is checked by the work-plan
 * owner against the plan's own expiry. */
export function readExecutionAdapterBinding(raw: unknown): ExecutionAdapterBinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw codedError("adapter binding is invalid", "invalid-adapter-binding");
  }
  const value = raw as Record<string, unknown>;
  const optional = ["accountIdentityDigest", "remotePolicy"].filter((key) => Object.hasOwn(value, key));
  if (!exactKeys(value, [
    "kind", "schemaVersion", "adapterId", "adapterVersion", "transport", "route", "operation", "effect",
    "configurationGeneration", "observedAt", "expiresAt", "attestationDigest", "policyDigest", "explicitOptIn",
    "bindingDigest", ...optional,
  ])) throw codedError("adapter binding has unknown or missing fields", "invalid-adapter-binding");
  if (value.kind !== "realbud.execution-adapter-binding.v1" || value.schemaVersion !== 1) {
    throw codedError("adapter binding version is unsupported", "invalid-adapter-binding");
  }
  const transport = value.transport as ExecutionAdapterTransport;
  const route = value.route as WorkRouteKind;
  const operation = value.operation as ExecutionAdapterOperation;
  const effect = value.effect as ExecutionAdapterEffect;
  if (!Object.hasOwn(TRANSPORT_ROUTES, transport) || !TRANSPORT_ROUTES[transport].has(route)) {
    throw codedError("adapter binding route is invalid", "invalid-adapter-binding");
  }
  if (!EXECUTION_ADAPTER_OPERATIONS.includes(operation) || !TRANSPORT_OPERATIONS[transport].has(operation)) {
    throw codedError("adapter binding operation is invalid", "invalid-adapter-binding");
  }
  if (effect !== "read-only" && effect !== "prepare-only") {
    throw codedError("adapter binding effect is invalid", "invalid-adapter-binding");
  }
  if ((operation === "prepare-approved-fields") !== (effect === "prepare-only")) {
    throw codedError("adapter binding effect does not match its operation", "invalid-adapter-binding");
  }
  const attestation = value.attestationDigest;
  const policy = value.policyDigest;
  const account = value.accountIdentityDigest;
  if (!SHA256.test(String(attestation ?? "")) || !SHA256.test(String(policy ?? ""))) {
    throw codedError("adapter binding digest is invalid", "invalid-adapter-binding");
  }
  if (account !== undefined && !SHA256.test(String(account))) {
    throw codedError("adapter account binding is invalid", "invalid-adapter-binding");
  }
  if (typeof value.explicitOptIn !== "boolean") {
    throw codedError("adapter binding opt-in is invalid", "invalid-adapter-binding");
  }
  const remotePolicy = transport === "remote-lane" ? normalizeRemotePolicy(value.remotePolicy) : undefined;
  if (transport !== "remote-lane" && value.remotePolicy !== undefined) {
    throw codedError("local adapter binding carries a cloud policy", "invalid-adapter-binding");
  }
  const base: Omit<ExecutionAdapterBinding, "bindingDigest"> = {
    kind: "realbud.execution-adapter-binding.v1",
    schemaVersion: 1,
    adapterId: boundedText("adapter id", value.adapterId, 120),
    adapterVersion: boundedInteger("adapter version", value.adapterVersion, 1_000_000),
    transport,
    route,
    operation,
    effect,
    configurationGeneration: boundedInteger("adapter configuration generation", value.configurationGeneration, 1_000_000_000),
    observedAt: boundedInteger("adapter observed time", value.observedAt, Number.MAX_SAFE_INTEGER),
    expiresAt: boundedInteger("adapter expiry", value.expiresAt, Number.MAX_SAFE_INTEGER),
    attestationDigest: String(attestation),
    policyDigest: String(policy),
    ...(account ? { accountIdentityDigest: String(account) } : {}),
    explicitOptIn: value.explicitOptIn,
    ...(remotePolicy ? { remotePolicy } : {}),
  };
  if (base.adapterVersion < 1 || base.expiresAt <= base.observedAt) {
    throw codedError("adapter binding lifetime is invalid", "invalid-adapter-binding");
  }
  if (!SAFE_ID.test(base.adapterId) || !SHA256.test(String(value.bindingDigest ?? "")) || bindingDigest(base) !== value.bindingDigest) {
    throw codedError("adapter binding integrity check failed", "invalid-adapter-binding");
  }
  return { ...base, bindingDigest: String(value.bindingDigest) };
}

function projectionDetail(manifest: ExecutionAdapterManifest, state: ExecutionAdapterProjection["state"]): string {
  if (state === "runtime-unavailable") return manifest.runtimeUnavailableReason!;
  if (state === "ready") return "A fresh app-owned runtime receipt matches this exact adapter version and configuration.";
  if (state === "attention") return "The adapter reported a recoverable runtime problem. Existing Desk work and local fallback remain available.";
  if (state === "stale") return "The last runtime receipt expired. RealBud will not route work here until the adapter proves current again.";
  if (state === "revoked") return "The adapter was revoked. Queued work stays local or held; stale credentials and sessions grant nothing.";
  return "The governed adapter contract is built. No live account or runtime is attached, so this method cannot execute yet.";
}

export class ExecutionAdapterRegistry {
  private readonly manifests = new Map<string, ExecutionAdapterManifest>();
  private readonly runtime = new Map<string, RuntimeRecord>();
  private readonly now: () => number;

  constructor(rawManifests: readonly unknown[], options: { now?: () => number } = {}) {
    if (!Array.isArray(rawManifests) || rawManifests.length > MAX_ADAPTERS) {
      throw codedError("execution adapter catalog is invalid");
    }
    this.now = options.now ?? Date.now;
    for (const raw of rawManifests) {
      const manifest = defineExecutionAdapterManifest(raw);
      if (this.manifests.has(manifest.id)) throw codedError("execution adapter ids must be unique");
      this.manifests.set(manifest.id, manifest);
    }
  }

  attest(raw: unknown): { duplicate: boolean; projection: ExecutionAdapterProjection } {
    const adapterId = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).adapterId
      : null;
    if (typeof adapterId !== "string") throw codedError("adapter attestation has no adapter id");
    const manifest = this.manifests.get(adapterId);
    if (!manifest) throw codedError("adapter is not in the code-owned catalog", "adapter-not-registered", 404);
    if (!manifest.runtimeAvailable) throw codedError("adapter runtime is not available", "adapter-runtime-unavailable", 409);
    const attestation = normalizeAttestation(raw, manifest, this.now());
    const digest = attestationDigest(attestation);
    const current = this.runtime.get(manifest.id);
    if (current) {
      const currentGeneration = current.attestation.configurationGeneration;
      if (attestation.configurationGeneration < currentGeneration) {
        throw codedError("adapter configuration generation is stale", "stale-adapter-configuration", 409);
      }
      if (attestation.configurationGeneration === currentGeneration) {
        if (current.digest !== digest || current.revoked) {
          throw codedError("adapter generation is already bound to different runtime state", "adapter-attestation-conflict", 409);
        }
        return { duplicate: true, projection: this.projectOne(manifest) };
      }
    }
    this.runtime.set(manifest.id, {
      attestation,
      digest,
      revoked: false,
      revokedAt: null,
      revokeReason: null,
    });
    return { duplicate: false, projection: this.projectOne(manifest) };
  }

  revoke(adapterId: string, nextGeneration: number, reasonCode: string): ExecutionAdapterProjection {
    if (!SAFE_ID.test(adapterId)) throw codedError("adapter id is invalid");
    const manifest = this.manifests.get(adapterId);
    if (!manifest) throw codedError("adapter is not in the code-owned catalog", "adapter-not-registered", 404);
    const current = this.runtime.get(adapterId);
    if (!current) throw codedError("adapter has no runtime receipt to revoke", "adapter-not-attested", 409);
    const generation = boundedInteger("adapter configuration generation", nextGeneration, 1_000_000_000);
    if (generation <= current.attestation.configurationGeneration) {
      throw codedError("adapter revocation generation is stale", "stale-adapter-configuration", 409);
    }
    const reason = boundedText("adapter revoke reason", reasonCode, 80);
    if (!SAFE_REASON.test(reason)) throw codedError("adapter revoke reason is invalid");
    current.attestation = { ...current.attestation, configurationGeneration: generation };
    current.digest = attestationDigest(current.attestation);
    current.revoked = true;
    current.revokedAt = this.now();
    current.revokeReason = reason;
    return this.projectOne(manifest);
  }

  snapshot(): ExecutionAdapterProjection[] {
    return [...this.manifests.values()].map((manifest) => this.projectOne(manifest));
  }

  workRoutingCapabilities(): WorkRoutingCapabilities {
    const capabilities: WorkRoutingCapabilities = {
      localAnalysis: false,
      scriptedBrowser: false,
      isolatedBrowserPool: false,
      desktopCua: false,
      cloudAnalysis: false,
      cloudBrowser: false,
      cloudMaxConcurrency: 0,
    };
    for (const manifest of this.manifests.values()) {
      if (this.projectOne(manifest).state !== "ready") continue;
      if (manifest.route === "local-analysis") capabilities.localAnalysis = true;
      if (manifest.route === "scripted-browser") capabilities.scriptedBrowser = true;
      if (manifest.route === "isolated-browser") capabilities.isolatedBrowserPool = true;
      if (manifest.route === "desktop-cua") capabilities.desktopCua = true;
      if (manifest.route === "remote-analysis") capabilities.cloudAnalysis = true;
      if (manifest.route === "remote-browser") capabilities.cloudBrowser = true;
      if (manifest.route === "remote-analysis" || manifest.route === "remote-browser") {
        capabilities.cloudMaxConcurrency = Math.max(capabilities.cloudMaxConcurrency, manifest.maxConcurrency);
      }
    }
    return capabilities;
  }

  readyBinding(adapterId: string, operation: ExecutionAdapterOperation): ExecutionAdapterBinding {
    const manifest = this.manifests.get(adapterId);
    if (!manifest) throw codedError("adapter is not in the code-owned catalog", "adapter-not-registered", 404);
    const current = this.runtime.get(adapterId);
    if (!current || this.projectOne(manifest).state !== "ready") {
      throw codedError("adapter has no fresh ready runtime receipt", "adapter-not-ready", 409);
    }
    return createExecutionAdapterBinding({
      manifest,
      attestation: current.attestation,
      operation,
      now: this.now(),
    });
  }

  private projectOne(manifest: ExecutionAdapterManifest): ExecutionAdapterProjection {
    const current = this.runtime.get(manifest.id);
    const now = this.now();
    const state: ExecutionAdapterProjection["state"] = !manifest.runtimeAvailable
      ? "runtime-unavailable"
      : !current
        ? "foundation"
        : current.revoked
          ? "revoked"
          : current.attestation.expiresAt <= now
            ? "stale"
            : current.attestation.state === "ready"
              ? "ready"
              : "attention";
    const status = state === "runtime-unavailable"
      ? "Stable runtime unavailable"
      : state === "foundation"
        ? "Foundation built"
        : state === "ready"
          ? "Ready now"
          : state === "attention"
            ? "Needs recovery"
            : state === "stale"
              ? "Check expired"
              : "Revoked";
    return {
      id: manifest.id,
      label: manifest.label,
      method: manifest.method || TRANSPORT_LABELS[manifest.transport],
      state,
      status,
      detail: projectionDetail(manifest, state),
      capabilities: manifest.operations.map((operation) => OPERATION_LABELS[operation]),
      route: manifest.route,
      maxConcurrency: manifest.maxConcurrency,
      boundaries: {
        manualAllow: true,
        humanSubmit: true,
        rawToolsExposed: false,
        ambientCredentials: false,
        personalBrowserAccess: false,
        personalHermesAccess: false,
        localFallback: true,
      },
      observedAt: current?.attestation.observedAt ?? null,
      expiresAt: current?.attestation.expiresAt ?? null,
    };
  }
}

const manifest = (
  input: Omit<ExecutionAdapterManifest, "kind" | "schemaVersion">,
): ExecutionAdapterManifest => defineExecutionAdapterManifest({
  kind: "realbud.execution-adapter.v1",
  schemaVersion: 1,
  ...input,
});

/** Code-owned extension families. They are deliberately unattested at boot:
 * a manifest proves only that the admission policy exists. A provider or
 * runtime becomes routable only after its own adapter supplies a fresh
 * generation-bound attestation inside the server process. */
export const BUILT_IN_EXECUTION_ADAPTERS: readonly ExecutionAdapterManifest[] = [
  manifest({
    id: "direct-source-read",
    version: 1,
    label: "Named source API",
    method: "Direct API",
    transport: "direct-api",
    route: "structured-batch",
    operations: ["read-structured-records"],
    effect: "read-only",
    requiresNamedAccount: true,
    requiresExplicitOptIn: false,
    runtimeAvailable: true,
    maxConcurrency: 1,
  }),
  manifest({
    id: "restricted-composio-read",
    version: 1,
    label: "Restricted Composio source",
    method: "Restricted Composio",
    transport: "restricted-composio",
    route: "structured-batch",
    operations: ["read-mail-items", "read-calendar-events"],
    effect: "read-only",
    requiresNamedAccount: true,
    requiresExplicitOptIn: true,
    runtimeAvailable: true,
    maxConcurrency: 1,
  }),
  manifest({
    id: "approved-mcp-read",
    version: 1,
    label: "Reviewed MCP source",
    method: "Approved MCP",
    transport: "approved-mcp",
    route: "structured-batch",
    operations: ["read-mail-items", "read-calendar-events"],
    effect: "read-only",
    requiresNamedAccount: true,
    requiresExplicitOptIn: true,
    runtimeAvailable: true,
    maxConcurrency: 1,
  }),
  manifest({
    id: "selected-file-analysis",
    version: 1,
    label: "Bounded task recipes",
    method: "Isolated task workspace",
    transport: "isolated-task",
    route: "local-analysis",
    operations: ["analyse-selected-files"],
    effect: "read-only",
    requiresNamedAccount: false,
    requiresExplicitOptIn: false,
    runtimeAvailable: true,
    maxConcurrency: 2,
  }),
  manifest({
    id: "private-browser-pool",
    version: 1,
    label: "Private browser lanes",
    method: "RealBud-owned Chromium profiles",
    transport: "private-browser",
    route: "isolated-browser",
    operations: ["read-bank-credits", "browse-approved-origin"],
    effect: "read-only",
    requiresNamedAccount: true,
    requiresExplicitOptIn: true,
    runtimeAvailable: true,
    maxConcurrency: 2,
  }),
  manifest({
    id: "bounded-desktop-preparation",
    version: 1,
    label: "Bounded desktop preparation",
    method: "Private CUA runtime",
    transport: "bounded-cua",
    route: "desktop-cua",
    operations: ["browse-approved-origin", "prepare-approved-fields"],
    effect: "prepare-only",
    requiresNamedAccount: true,
    requiresExplicitOptIn: true,
    runtimeAvailable: true,
    maxConcurrency: 1,
  }),
  manifest({
    id: "cloud-analysis",
    version: 1,
    label: "Cloud analysis lanes",
    method: "Remote isolated analysis",
    transport: "remote-lane",
    route: "remote-analysis",
    operations: ["analyse-selected-files"],
    effect: "read-only",
    requiresNamedAccount: true,
    requiresExplicitOptIn: true,
    runtimeAvailable: true,
    maxConcurrency: 8,
  }),
  manifest({
    id: "cloud-browser",
    version: 1,
    label: "Cloud browser lanes",
    method: "Remote isolated browser",
    transport: "remote-lane",
    route: "remote-browser",
    operations: ["browse-approved-origin"],
    effect: "read-only",
    requiresNamedAccount: true,
    requiresExplicitOptIn: true,
    runtimeAvailable: true,
    maxConcurrency: 8,
  }),
  manifest({
    id: "computer-history-recovery",
    version: 1,
    label: "Computer History recovery",
    method: "Case and session metadata",
    transport: "history-api",
    route: null,
    operations: ["read-history-metadata"],
    effect: "read-only",
    requiresNamedAccount: false,
    requiresExplicitOptIn: true,
    runtimeAvailable: false,
    runtimeUnavailableReason: "The pinned stable CUA Driver does not expose the History API. RealBud will not switch an office to a preview runtime to claim it.",
    maxConcurrency: 0,
  }),
];
