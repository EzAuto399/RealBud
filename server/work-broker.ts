import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { WorkRouteKind } from "../shared/contracts.ts";
import { AtomicWriteError, writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import {
  readWorkPlan,
  readWorkPlanReceiptBinding,
  workPlanReceiptBinding,
  type WorkEffectClass,
  type WorkPlan,
  type WorkPlanReceiptBinding,
  type WorkRecipeRef,
} from "./work-plan.ts";

export type { WorkEffectClass, WorkRecipeRef } from "./work-plan.ts";

const FILE_KIND = "realbud.work-broker.v1" as const;
const SCHEMA_VERSION = 1 as const;
const MAX_INPUT_DIGESTS = 10_000;
const MAX_ALLOWED_ORIGINS = 8;
const MAX_LEASE_MS = 10 * 60 * 1_000;
const MAX_RECEIPTS = 4_000;

const ROUTE_KINDS = new Set<WorkRouteKind>([
  "structured-batch",
  "local-analysis",
  "remote-analysis",
  "scripted-browser",
  "isolated-browser",
  "remote-browser",
  "desktop-cua",
]);

export const DEFAULT_WORK_ROUTE_LIMITS: Readonly<Record<WorkRouteKind, number>> = {
  "structured-batch": 1,
  "local-analysis": 2,
  "remote-analysis": 8,
  "scripted-browser": 1,
  "isolated-browser": 2,
  "remote-browser": 8,
  "desktop-cua": 1,
};

export type WorkReceiptState =
  | "queued"
  | "leased"
  | "running"
  | "evidence-ready"
  | "reconciled"
  | "cancelled"
  | "failed"
  | "expired"
  | "effect-unknown";

export interface WorkReceipt {
  kind: "realbud.work-receipt.v1";
  schemaVersion: 1;
  id: string;
  requestId: string;
  requestDigest: string;
  bookRevision: number;
  caseRevision: number | null;
  inputDigests: string[];
  route: WorkRouteKind;
  concurrencyKeyDigest: string;
  allowedOrigins: string[];
  recipe: WorkRecipeRef;
  effectClass: WorkEffectClass;
  /** Added without invalidating legacy v1 receipts. Every new admission has
   * this authority/adapter binding; older settled receipts remain readable. */
  plan?: WorkPlanReceiptBinding;
  state: WorkReceiptState;
  attempts: number;
  cancellationGeneration: number;
  fencingToken: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  leaseOwnerDigest?: string;
  leaseExpiresAt?: number;
  effectBoundaryAt?: number;
  outputDigest?: string;
  errorCode?: string;
}

export type WorkAdmissionRequest = WorkPlan;

export interface WorkAdmission {
  receipt: WorkReceipt;
  duplicate: boolean;
}

export interface WorkClaim {
  receipt: WorkReceipt;
  runnerId: string;
  fencingToken: number;
  cancellationGeneration: number;
}

interface WorkBrokerFile {
  kind: typeof FILE_KIND;
  schemaVersion: typeof SCHEMA_VERSION;
  receipts: WorkReceipt[];
}

export interface WorkBrokerOptions {
  file?: string;
  now?: () => number;
  idFactory?: () => string;
  writer?: (path: string, body: string) => void;
  maxQueued?: number;
  maxAttempts?: number;
  routeLimits?: Partial<Record<WorkRouteKind, number>>;
}

interface NormalizedAdmission {
  requestId: string;
  requestDigest: string;
  bookRevision: number;
  caseRevision: number | null;
  inputDigests: string[];
  route: WorkRouteKind;
  concurrencyKeyDigest: string;
  allowedOrigins: string[];
  recipe: WorkRecipeRef;
  effectClass: WorkEffectClass;
  plan: WorkPlanReceiptBinding;
  expiresAt: number;
}

interface MutationResult<T> {
  changed: boolean;
  value: T;
}

const ACTIVE_STATES = new Set<WorkReceiptState>(["queued", "leased", "running", "evidence-ready"]);
const CLAIM_STATES = new Set<WorkReceiptState>(["leased", "running"]);

function codedError(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

export function workDigest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function boundedId(name: string, value: unknown, maximum = 200): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value) || value.length > maximum) {
    throw codedError(`${name} is invalid`, 400, "invalid-work-receipt");
  }
  return value;
}

function boundedInteger(name: string, value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw codedError(`${name} must be a bounded non-negative integer`, 400, "invalid-work-receipt");
  }
  return Number(value);
}

function finiteTime(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw codedError(`${name} must be a finite timestamp`, 400, "invalid-work-receipt");
  }
  return value;
}

function normalizeOrigins(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ALLOWED_ORIGINS) {
    throw codedError("allowedOrigins is invalid", 400, "invalid-work-receipt");
  }
  const origins = raw.map((value) => {
    if (typeof value !== "string" || value.length > 300) {
      throw codedError("allowed origin is invalid", 400, "invalid-work-receipt");
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw codedError("allowed origin is invalid", 400, "invalid-work-receipt");
    }
    const localHttp = parsed.protocol === "http:"
      && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
    if (
      parsed.username
      || parsed.password
      || (parsed.protocol !== "https:" && !localHttp)
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      throw codedError("allowed origin must be an exact HTTPS or local test origin", 400, "invalid-work-receipt");
    }
    return parsed.origin;
  });
  return [...new Set(origins)].sort();
}

function normalizeDigests(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_INPUT_DIGESTS || raw.some((value) => !isDigest(value))) {
    throw codedError("inputDigests must contain bounded SHA-256 digests", 400, "invalid-work-receipt");
  }
  if (new Set(raw).size !== raw.length) {
    throw codedError("inputDigests must be unique", 400, "duplicate-work-input");
  }
  return [...raw];
}

function normalizeRecipe(raw: unknown): WorkRecipeRef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw codedError("recipe is invalid", 400, "invalid-work-receipt");
  }
  const value = raw as Partial<WorkRecipeRef>;
  const recipe = {
    id: boundedId("recipe id", value.id, 120),
    version: boundedInteger("recipe version", value.version, 1_000_000),
  };
  if (recipe.version < 1) throw codedError("recipe version must be positive", 400, "invalid-work-receipt");
  return recipe;
}

function normalizeRoute(value: unknown): WorkRouteKind {
  if (typeof value !== "string" || !ROUTE_KINDS.has(value as WorkRouteKind)) {
    throw codedError("work route is invalid", 400, "invalid-work-receipt");
  }
  return value as WorkRouteKind;
}

function normalizeState(value: unknown): WorkReceiptState {
  const states: WorkReceiptState[] = [
    "queued",
    "leased",
    "running",
    "evidence-ready",
    "reconciled",
    "cancelled",
    "failed",
    "expired",
    "effect-unknown",
  ];
  if (typeof value !== "string" || !states.includes(value as WorkReceiptState)) {
    throw codedError("work receipt state is invalid", 503, "work-broker-recovery-required");
  }
  return value as WorkReceiptState;
}

function cloneReceipt(receipt: WorkReceipt): WorkReceipt {
  return structuredClone(receipt);
}

function clearLease(receipt: WorkReceipt): void {
  delete receipt.leaseOwnerDigest;
  delete receipt.leaseExpiresAt;
}

type RequestDigestMaterial = Omit<NormalizedAdmission, "requestId" | "requestDigest" | "plan"> & {
  plan?: WorkPlanReceiptBinding;
};

function requestDigest(value: RequestDigestMaterial): string {
  if (!value.plan) return workDigest(JSON.stringify(value));
  // The immutable plan already binds the primary and permitted fallback
  // routes. Keep the current route outside this digest so a code-owned,
  // forward-only fallback can update it without weakening idempotency.
  const { route: _currentRoute, ...stable } = value;
  return workDigest(JSON.stringify(stable));
}

function normalizeAdmission(raw: WorkAdmissionRequest, now: number): NormalizedAdmission {
  let plan: WorkPlan;
  try {
    plan = readWorkPlan(raw, now);
  } catch (error) {
    const status = Number((error as { status?: number }).status ?? 400);
    const code = String((error as { code?: string }).code ?? "invalid-work-plan");
    throw codedError(error instanceof Error ? error.message : "work plan is invalid", status, code);
  }
  const requestId = boundedId("request id", plan.requestId);
  const route = normalizeRoute(plan.routes[0]!.route);
  const bookRevision = boundedInteger("book revision", plan.bookRevision);
  const caseRevision = plan.caseRevision == null ? null : boundedInteger("case revision", plan.caseRevision);
  const inputDigests = normalizeDigests(plan.inputDigests);
  const allowedOrigins = normalizeOrigins(plan.allowedOrigins);
  const recipe = normalizeRecipe(plan.recipe);
  const effectClass = plan.effectClass;
  const expiresAt = finiteTime("expiresAt", plan.expiresAt);
  const receiptPlan = workPlanReceiptBinding(plan);
  const normalized = {
    bookRevision,
    caseRevision,
    inputDigests,
    route,
    concurrencyKeyDigest: plan.concurrencyKeyDigest,
    allowedOrigins,
    recipe,
    effectClass,
    plan: receiptPlan,
    expiresAt,
  };
  return {
    requestId,
    requestDigest: requestDigest(normalized),
    ...normalized,
  };
}

function normalizeLoadedReceipt(raw: unknown): WorkReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw codedError("work receipt is malformed", 503, "work-broker-recovery-required");
  }
  const value = raw as Partial<WorkReceipt>;
  if (value.kind !== "realbud.work-receipt.v1" || value.schemaVersion !== 1) {
    throw codedError("work receipt version is unsupported", 503, "work-broker-recovery-required");
  }
  const state = normalizeState(value.state);
  const effectClass = value.effectClass;
  if (effectClass !== "read-only" && effectClass !== "possible-external") {
    throw codedError("work receipt effect class is malformed", 503, "work-broker-recovery-required");
  }
  const receipt: WorkReceipt = {
    kind: "realbud.work-receipt.v1",
    schemaVersion: 1,
    id: boundedId("receipt id", value.id),
    requestId: boundedId("request id", value.requestId),
    requestDigest: isDigest(value.requestDigest)
      ? value.requestDigest
      : (() => { throw codedError("request digest is malformed", 503, "work-broker-recovery-required"); })(),
    bookRevision: boundedInteger("book revision", value.bookRevision),
    caseRevision: value.caseRevision == null ? null : boundedInteger("case revision", value.caseRevision),
    inputDigests: normalizeDigests(value.inputDigests),
    route: normalizeRoute(value.route),
    concurrencyKeyDigest: isDigest(value.concurrencyKeyDigest)
      ? value.concurrencyKeyDigest
      : (() => { throw codedError("concurrency key digest is malformed", 503, "work-broker-recovery-required"); })(),
    allowedOrigins: normalizeOrigins(value.allowedOrigins),
    recipe: normalizeRecipe(value.recipe),
    effectClass,
    state,
    attempts: boundedInteger("attempts", value.attempts, 100),
    cancellationGeneration: boundedInteger("cancellation generation", value.cancellationGeneration),
    fencingToken: boundedInteger("fencing token", value.fencingToken),
    createdAt: finiteTime("createdAt", value.createdAt),
    updatedAt: finiteTime("updatedAt", value.updatedAt),
    expiresAt: finiteTime("expiresAt", value.expiresAt),
  };
  if (value.plan !== undefined) {
    try {
      receipt.plan = readWorkPlanReceiptBinding(value.plan);
    } catch {
      throw codedError("work receipt plan binding is malformed", 503, "work-broker-recovery-required");
    }
    if (!receipt.plan.routes.some((route) => route.route === receipt.route)) {
      throw codedError("work receipt route does not match its plan", 503, "work-broker-recovery-required");
    }
  }
  if (value.leaseOwnerDigest !== undefined) {
    if (!isDigest(value.leaseOwnerDigest)) throw codedError("lease owner is malformed", 503, "work-broker-recovery-required");
    receipt.leaseOwnerDigest = value.leaseOwnerDigest;
  }
  if (value.leaseExpiresAt !== undefined) receipt.leaseExpiresAt = finiteTime("leaseExpiresAt", value.leaseExpiresAt);
  if (value.effectBoundaryAt !== undefined) receipt.effectBoundaryAt = finiteTime("effectBoundaryAt", value.effectBoundaryAt);
  if (value.outputDigest !== undefined) {
    if (!isDigest(value.outputDigest)) throw codedError("output digest is malformed", 503, "work-broker-recovery-required");
    receipt.outputDigest = value.outputDigest;
  }
  if (value.errorCode !== undefined) receipt.errorCode = boundedId("error code", value.errorCode, 120);
  if (CLAIM_STATES.has(state) && (!receipt.leaseOwnerDigest || receipt.leaseExpiresAt === undefined)) {
    throw codedError("active work receipt has no complete lease", 503, "work-broker-recovery-required");
  }
  if (!CLAIM_STATES.has(state) && (receipt.leaseOwnerDigest || receipt.leaseExpiresAt !== undefined)) {
    throw codedError("settled work receipt retains a lease", 503, "work-broker-recovery-required");
  }
  if (receipt.updatedAt < receipt.createdAt || receipt.expiresAt < receipt.createdAt) {
    throw codedError("work receipt timestamps are inconsistent", 503, "work-broker-recovery-required");
  }
  if (receipt.effectBoundaryAt !== undefined && receipt.effectClass !== "possible-external") {
    throw codedError("read-only work receipt has an effect boundary", 503, "work-broker-recovery-required");
  }
  if ((state === "evidence-ready" || state === "reconciled") && !receipt.outputDigest) {
    throw codedError("completed work receipt has no output digest", 503, "work-broker-recovery-required");
  }
  if (state === "effect-unknown" && receipt.effectBoundaryAt === undefined) {
    throw codedError("unknown-effect receipt has no persisted boundary", 503, "work-broker-recovery-required");
  }
  const recomputed = requestDigest({
    bookRevision: receipt.bookRevision,
    caseRevision: receipt.caseRevision,
    inputDigests: receipt.inputDigests,
    route: receipt.route,
    concurrencyKeyDigest: receipt.concurrencyKeyDigest,
    allowedOrigins: receipt.allowedOrigins,
    recipe: receipt.recipe,
    effectClass: receipt.effectClass,
    ...(receipt.plan ? { plan: receipt.plan } : {}),
    expiresAt: receipt.expiresAt,
  });
  if (receipt.requestDigest !== recomputed) {
    throw codedError("work receipt authority digest does not match", 503, "work-broker-recovery-required");
  }
  return receipt;
}

function normalizeRouteLimits(raw: WorkBrokerOptions["routeLimits"]): Record<WorkRouteKind, number> {
  const limits = { ...DEFAULT_WORK_ROUTE_LIMITS };
  for (const [kind, value] of Object.entries(raw ?? {})) {
    const route = normalizeRoute(kind);
    limits[route] = boundedInteger(`${route} limit`, value, 32);
  }
  limits["local-analysis"] = Math.min(2, limits["local-analysis"]);
  limits["scripted-browser"] = Math.min(1, limits["scripted-browser"]);
  limits["isolated-browser"] = Math.min(2, limits["isolated-browser"]);
  limits["desktop-cua"] = Math.min(1, limits["desktop-cua"]);
  limits["structured-batch"] = Math.min(1, limits["structured-batch"]);
  return limits;
}

export class WorkBroker {
  readonly file: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly writer: (path: string, body: string) => void;
  private readonly maxQueued: number;
  private readonly maxAttempts: number;
  private readonly routeLimits: Record<WorkRouteKind, number>;
  private receipts: WorkReceipt[] = [];
  private storageUncertain = false;

  constructor(options: WorkBrokerOptions = {}) {
    this.file = options.file ?? join(DATA_DIR, "work-broker.json");
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.writer = options.writer ?? writeFileAtomic;
    this.maxQueued = boundedInteger("max queued", options.maxQueued ?? 2_000, MAX_RECEIPTS);
    this.maxAttempts = boundedInteger("max attempts", options.maxAttempts ?? 3, 20);
    if (this.maxQueued < 1 || this.maxAttempts < 1) throw codedError("broker limits must be positive", 400, "invalid-work-broker");
    this.routeLimits = normalizeRouteLimits(options.routeLimits);
    this.load();
    this.reconcileStartup();
  }

  routeCapacity(route: WorkRouteKind): number {
    return this.routeLimits[route];
  }

  list(): WorkReceipt[] {
    return this.receipts.map(cloneReceipt);
  }

  get(id: string): WorkReceipt | null {
    const receipt = this.receipts.find((item) => item.id === id);
    return receipt ? cloneReceipt(receipt) : null;
  }

  getByRequestId(requestId: string): WorkReceipt | null {
    const receipt = this.receipts.find((item) => item.requestId === requestId);
    return receipt ? cloneReceipt(receipt) : null;
  }

  admit(request: WorkAdmissionRequest): WorkAdmission {
    return this.admitBatch([request])[0]!;
  }

  admitBatch(requests: WorkAdmissionRequest[]): WorkAdmission[] {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > this.maxQueued) {
      throw codedError("work admission batch is invalid", 400, "invalid-work-receipt");
    }
    const at = this.now();
    const normalized = requests.map((request) => normalizeAdmission(request, at));
    return this.mutate(() => {
      const byRequest = new Map(this.receipts.map((receipt) => [receipt.requestId, receipt]));
      const newRequestIds = new Set(normalized.filter((item) => !byRequest.has(item.requestId)).map((item) => item.requestId));
      const active = this.receipts.filter((receipt) => ACTIVE_STATES.has(receipt.state)).length;
      if (active + newRequestIds.size > this.maxQueued) {
        throw codedError("work queue is full", 429, "work-queue-full");
      }
      let changed = false;
      const admissions = normalized.map((item): WorkAdmission => {
        const existing = byRequest.get(item.requestId);
        if (existing) {
          if (existing.requestDigest !== item.requestDigest) {
            throw codedError("request id is already bound to different work", 409, "idempotency-conflict");
          }
          return { receipt: existing, duplicate: true };
        }
        const receipt: WorkReceipt = {
          kind: "realbud.work-receipt.v1",
          schemaVersion: 1,
          id: boundedId("receipt id", this.idFactory()),
          requestId: item.requestId,
          requestDigest: item.requestDigest,
          bookRevision: item.bookRevision,
          caseRevision: item.caseRevision,
          inputDigests: item.inputDigests,
          route: item.route,
          concurrencyKeyDigest: item.concurrencyKeyDigest,
          allowedOrigins: item.allowedOrigins,
          recipe: item.recipe,
          effectClass: item.effectClass,
          plan: item.plan,
          state: "queued",
          attempts: 0,
          cancellationGeneration: 0,
          fencingToken: 0,
          createdAt: at,
          updatedAt: at,
          expiresAt: item.expiresAt,
        };
        if (this.receipts.some((candidate) => candidate.id === receipt.id)) {
          throw codedError("receipt id collision", 503, "work-broker-id-collision");
        }
        this.receipts.push(receipt);
        byRequest.set(receipt.requestId, receipt);
        changed = true;
        return { receipt, duplicate: false };
      });
      return { changed, value: admissions };
    });
  }

  leaseNext(input: {
    runnerId: string;
    routes?: WorkRouteKind[];
    requestIds?: string[];
    leaseMs?: number;
  }): WorkClaim | null {
    const runnerId = boundedId("runner id", input.runnerId, 240);
    const leaseMs = boundedInteger("lease duration", input.leaseMs ?? 30_000, MAX_LEASE_MS);
    if (leaseMs < 1) throw codedError("lease duration must be positive", 400, "invalid-work-lease");
    const allowedRoutes = input.routes === undefined
      ? ROUTE_KINDS
      : new Set(input.routes.map(normalizeRoute));
    const allowedRequestIds = input.requestIds === undefined
      ? null
      : new Set(input.requestIds.map((requestId) => boundedId("request id", requestId)));
    return this.mutate(() => {
      const at = this.now();
      let changed = this.sweepInMemory(at);
      const active = this.receipts.filter((receipt) => CLAIM_STATES.has(receipt.state) && (receipt.leaseExpiresAt ?? 0) > at);
      const candidate = this.receipts.find((receipt) => {
        if (
          receipt.state !== "queued"
          || receipt.expiresAt <= at
          || !allowedRoutes.has(receipt.route)
          || (allowedRequestIds !== null && !allowedRequestIds.has(receipt.requestId))
        ) return false;
        if (receipt.attempts >= this.maxAttempts) return false;
        const routeActive = active.filter((item) => item.route === receipt.route).length;
        if (routeActive >= this.routeLimits[receipt.route]) return false;
        return !active.some((item) => item.concurrencyKeyDigest === receipt.concurrencyKeyDigest);
      });
      if (!candidate) return { changed, value: null };
      candidate.state = "leased";
      candidate.attempts += 1;
      candidate.fencingToken += 1;
      candidate.leaseOwnerDigest = workDigest(runnerId);
      candidate.leaseExpiresAt = Math.min(candidate.expiresAt, at + leaseMs);
      candidate.updatedAt = at;
      changed = true;
      return {
        changed,
        value: {
          receipt: candidate,
          runnerId,
          fencingToken: candidate.fencingToken,
          cancellationGeneration: candidate.cancellationGeneration,
        },
      };
    });
  }

  start(claim: WorkClaim): WorkReceipt {
    this.sweepExpired();
    return this.mutate(() => {
      const receipt = this.assertClaim(claim, ["leased"]);
      receipt.state = "running";
      receipt.updatedAt = this.now();
      return { changed: true, value: receipt };
    });
  }

  markEffectBoundary(claim: WorkClaim): WorkReceipt {
    this.sweepExpired();
    return this.mutate(() => {
      const receipt = this.assertClaim(claim, ["running"]);
      if (receipt.effectClass !== "possible-external") {
        throw codedError("read-only work has no external effect boundary", 409, "invalid-effect-boundary");
      }
      if (receipt.effectBoundaryAt !== undefined) return { changed: false, value: receipt };
      receipt.effectBoundaryAt = this.now();
      receipt.updatedAt = receipt.effectBoundaryAt;
      return { changed: true, value: receipt };
    });
  }

  complete(claim: WorkClaim, outputDigest: string): WorkReceipt {
    if (!isDigest(outputDigest)) throw codedError("output digest is invalid", 400, "invalid-work-output");
    this.sweepExpired();
    return this.mutate(() => {
      const receipt = this.assertClaim(claim, ["running"]);
      receipt.state = "evidence-ready";
      receipt.outputDigest = outputDigest;
      delete receipt.errorCode;
      clearLease(receipt);
      receipt.updatedAt = this.now();
      return { changed: true, value: receipt };
    });
  }

  fail(claim: WorkClaim, input: { code: string; retryable: boolean }): WorkReceipt {
    const errorCode = boundedId("error code", input.code, 120);
    this.sweepExpired();
    return this.mutate(() => {
      const receipt = this.assertClaim(claim, ["leased", "running"]);
      const at = this.now();
      if (receipt.effectBoundaryAt !== undefined) {
        receipt.state = "effect-unknown";
        receipt.errorCode = "external-effect-ambiguous";
      } else if (input.retryable && receipt.attempts < this.maxAttempts && receipt.expiresAt > at) {
        receipt.state = "queued";
        receipt.errorCode = errorCode;
        receipt.fencingToken += 1;
      } else {
        receipt.state = receipt.expiresAt <= at ? "expired" : "failed";
        receipt.errorCode = errorCode;
      }
      clearLease(receipt);
      receipt.updatedAt = at;
      return { changed: true, value: receipt };
    });
  }

  reconcile(id: string, outputDigest: string): WorkReceipt {
    const receiptId = boundedId("receipt id", id);
    if (!isDigest(outputDigest)) throw codedError("output digest is invalid", 400, "invalid-work-output");
    return this.mutate(() => {
      const receipt = this.receipts.find((item) => item.id === receiptId);
      if (!receipt) throw codedError("work receipt was not found", 404, "work-not-found");
      if (receipt.state === "reconciled" && receipt.outputDigest === outputDigest) {
        return { changed: false, value: receipt };
      }
      if (receipt.state !== "evidence-ready" || receipt.outputDigest !== outputDigest) {
        throw codedError("work output is not ready for reconciliation", 409, "work-not-reconcilable");
      }
      receipt.state = "reconciled";
      receipt.updatedAt = this.now();
      return { changed: true, value: receipt };
    });
  }

  cancel(id: string, expectedGeneration?: number): WorkReceipt {
    const receiptId = boundedId("receipt id", id);
    return this.mutate(() => {
      const receipt = this.receipts.find((item) => item.id === receiptId);
      if (!receipt) throw codedError("work receipt was not found", 404, "work-not-found");
      if (expectedGeneration !== undefined && expectedGeneration !== receipt.cancellationGeneration) {
        throw codedError("work cancellation generation is stale", 409, "stale-work-claim");
      }
      if (receipt.state === "cancelled" || receipt.state === "effect-unknown") {
        return { changed: false, value: receipt };
      }
      if (receipt.state === "reconciled" || receipt.state === "failed" || receipt.state === "expired") {
        throw codedError("settled work cannot be cancelled", 409, "work-settled");
      }
      receipt.cancellationGeneration += 1;
      receipt.fencingToken += 1;
      receipt.state = receipt.effectBoundaryAt === undefined ? "cancelled" : "effect-unknown";
      if (receipt.state === "effect-unknown") receipt.errorCode = "external-effect-ambiguous";
      clearLease(receipt);
      receipt.updatedAt = this.now();
      return { changed: true, value: receipt };
    });
  }

  /** Move queued read-only work to a later route that was disclosed and
   * authority-bound in the original plan. This cannot add a route, move
   * backwards, resurrect settled work or cross a possible-effect boundary. */
  fallback(id: string, targetRoute: WorkRouteKind, expectedFencingToken: number): WorkReceipt {
    const receiptId = boundedId("receipt id", id);
    const route = normalizeRoute(targetRoute);
    this.sweepExpired();
    return this.mutate(() => {
      const receipt = this.receipts.find((item) => item.id === receiptId);
      if (!receipt) throw codedError("work receipt was not found", 404, "work-not-found");
      if (receipt.fencingToken !== expectedFencingToken) {
        throw codedError("work fallback generation is stale", 409, "stale-work-claim");
      }
      if (receipt.state === "expired") {
        throw codedError("work expired before its fallback could start", 409, "work-expired");
      }
      if (receipt.state !== "queued" || receipt.effectBoundaryAt !== undefined) {
        throw codedError("only queued pre-effect work can use a fallback", 409, "work-not-fallback-ready");
      }
      if (receipt.effectClass !== "read-only" || !receipt.plan) {
        throw codedError("this work has no executable fallback authority", 409, "work-fallback-not-authorized");
      }
      const currentIndex = receipt.plan.routes.findIndex((item) => item.route === receipt.route);
      const targetIndex = receipt.plan.routes.findIndex((item) => item.route === route);
      if (currentIndex < 0 || targetIndex <= currentIndex) {
        throw codedError("target route is not a later disclosed fallback", 409, "work-fallback-not-authorized");
      }
      const target = receipt.plan.routes[targetIndex]!;
      if (target.adapter && target.adapter.expiresAt <= this.now()) {
        throw codedError("fallback adapter attestation expired", 409, "adapter-binding-stale");
      }
      receipt.route = route;
      receipt.fencingToken += 1;
      receipt.errorCode = "route-fallback";
      receipt.updatedAt = this.now();
      return { changed: true, value: receipt };
    });
  }

  sweepExpired(): number {
    return this.mutate(() => {
      const before = this.receipts.map((receipt) => `${receipt.id}:${receipt.state}:${receipt.fencingToken}`).join("|");
      this.sweepInMemory(this.now());
      const after = this.receipts.map((receipt) => `${receipt.id}:${receipt.state}:${receipt.fencingToken}`).join("|");
      return { changed: before !== after, value: this.receipts.filter((receipt) => receipt.state === "expired").length };
    });
  }

  storageStatus(): "ok" | "uncertain" {
    return this.storageUncertain ? "uncertain" : "ok";
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      throw codedError(`work broker state needs recovery: ${error instanceof Error ? error.name : "read failure"}`, 503, "work-broker-recovery-required");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw codedError("work broker state needs recovery", 503, "work-broker-recovery-required");
    }
    const file = parsed as Partial<WorkBrokerFile>;
    if (file.kind !== FILE_KIND || file.schemaVersion !== SCHEMA_VERSION || !Array.isArray(file.receipts)) {
      throw codedError("work broker state version is unsupported", 503, "work-broker-recovery-required");
    }
    if (file.receipts.length > MAX_RECEIPTS) {
      throw codedError("work broker state exceeds its bound", 503, "work-broker-recovery-required");
    }
    this.receipts = file.receipts.map(normalizeLoadedReceipt);
    const ids = new Set(this.receipts.map((receipt) => receipt.id));
    const requestIds = new Set(this.receipts.map((receipt) => receipt.requestId));
    if (ids.size !== this.receipts.length || requestIds.size !== this.receipts.length) {
      throw codedError("work broker state contains duplicate authority", 503, "work-broker-recovery-required");
    }
  }

  private reconcileStartup(): void {
    const at = this.now();
    let changed = false;
    for (const receipt of this.receipts) {
      if (receipt.state === "queued" && (receipt.expiresAt <= at || receipt.attempts >= this.maxAttempts)) {
        receipt.state = receipt.expiresAt <= at ? "expired" : "failed";
        if (receipt.state === "failed") receipt.errorCode = "attempt-limit-reached";
        receipt.updatedAt = at;
        changed = true;
        continue;
      }
      if (!CLAIM_STATES.has(receipt.state)) continue;
      changed = true;
      if (receipt.effectBoundaryAt !== undefined) {
        receipt.state = "effect-unknown";
        receipt.errorCode = "external-effect-ambiguous";
      } else if (receipt.expiresAt <= at) {
        receipt.state = "expired";
      } else if (receipt.attempts >= this.maxAttempts) {
        receipt.state = "failed";
        receipt.errorCode = "attempt-limit-reached";
      } else {
        receipt.state = "queued";
      }
      receipt.fencingToken += 1;
      receipt.updatedAt = at;
      clearLease(receipt);
    }
    if (changed) this.saveOrBlock();
  }

  private sweepInMemory(at: number): boolean {
    let changed = false;
    for (const receipt of this.receipts) {
      if (receipt.state === "queued" && (receipt.expiresAt <= at || receipt.attempts >= this.maxAttempts)) {
        receipt.state = receipt.expiresAt <= at ? "expired" : "failed";
        if (receipt.state === "failed") receipt.errorCode = "attempt-limit-reached";
        receipt.updatedAt = at;
        changed = true;
        continue;
      }
      if (!CLAIM_STATES.has(receipt.state)) continue;
      if ((receipt.leaseExpiresAt ?? 0) > at && receipt.expiresAt > at) continue;
      if (receipt.effectBoundaryAt !== undefined) {
        receipt.state = "effect-unknown";
        receipt.errorCode = "external-effect-ambiguous";
      } else if (receipt.expiresAt <= at) {
        receipt.state = "expired";
      } else if (receipt.attempts >= this.maxAttempts) {
        receipt.state = "failed";
        receipt.errorCode = "attempt-limit-reached";
      } else {
        receipt.state = "queued";
      }
      receipt.fencingToken += 1;
      receipt.updatedAt = at;
      clearLease(receipt);
      changed = true;
    }
    return changed;
  }

  private assertClaim(claim: WorkClaim, allowedStates: WorkReceiptState[]): WorkReceipt {
    const receipt = this.receipts.find((item) => item.id === claim.receipt.id);
    if (!receipt) throw codedError("work receipt was not found", 404, "work-not-found");
    if (
      !allowedStates.includes(receipt.state)
      || receipt.fencingToken !== claim.fencingToken
      || receipt.cancellationGeneration !== claim.cancellationGeneration
      || receipt.leaseOwnerDigest !== workDigest(claim.runnerId)
      || (receipt.leaseExpiresAt ?? 0) <= this.now()
    ) {
      throw codedError("work claim is stale or no longer owns the lease", 409, "stale-work-claim");
    }
    return receipt;
  }

  private mutate<T>(operation: () => MutationResult<T>): T {
    if (this.storageUncertain) {
      throw codedError("work broker storage outcome is uncertain; restart and reconcile before more work", 503, "work-broker-storage-uncertain");
    }
    const before = structuredClone(this.receipts);
    let result: MutationResult<T>;
    try {
      result = operation();
    } catch (error) {
      this.receipts = before;
      throw error;
    }
    if (!result.changed) return structuredClone(result.value);
    try {
      this.trimSettled();
      this.saveOrBlock();
    } catch (error) {
      if (error instanceof AtomicWriteError && error.disposition === "not-landed") {
        this.receipts = before;
        throw codedError("work broker update did not land", 503, "work-broker-write-failed");
      }
      this.storageUncertain = true;
      throw codedError("work broker storage outcome is uncertain; restart and reconcile before more work", 503, "work-broker-storage-uncertain");
    }
    return structuredClone(result.value);
  }

  private trimSettled(): void {
    if (this.receipts.length <= MAX_RECEIPTS) return;
    const settled = this.receipts
      .filter((receipt) => !ACTIVE_STATES.has(receipt.state))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    const remove = new Set(settled.slice(0, this.receipts.length - MAX_RECEIPTS).map((receipt) => receipt.id));
    this.receipts = this.receipts.filter((receipt) => !remove.has(receipt.id));
    if (this.receipts.length > MAX_RECEIPTS) {
      throw codedError("work broker has too much unsettled work", 429, "work-queue-full");
    }
  }

  private saveOrBlock(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const body: WorkBrokerFile = {
      kind: FILE_KIND,
      schemaVersion: SCHEMA_VERSION,
      receipts: this.receipts,
    };
    this.writer(this.file, JSON.stringify(body, null, 2));
  }
}
