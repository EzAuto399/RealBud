import { describe, expect, it } from "vitest";

import type { ExecutionAdapterTransport, WorkRouteKind } from "../shared/contracts.ts";
import {
  createExecutionAdapterBinding,
  defineExecutionAdapterManifest,
  readExecutionAdapterBinding,
  type ExecutionAdapterAttestation,
  type ExecutionAdapterEffect,
  type ExecutionAdapterOperation,
} from "./execution-adapters.ts";
import {
  buildWorkPlan,
  readWorkPlan,
  workPlanDigest,
  workPlanReceiptBinding,
} from "./work-plan.ts";

const NOW = 1_800_000_000_000;
const EXPIRES = NOW + 10 * 60_000;

function binding(input: {
  id: string;
  route: WorkRouteKind;
  transport: ExecutionAdapterTransport;
  operation: ExecutionAdapterOperation;
  effect?: ExecutionAdapterEffect;
  named?: boolean;
}) {
  const effect = input.effect ?? "read-only";
  const remote = input.transport === "remote-lane";
  const named = input.named ?? (remote || input.transport === "private-browser" || input.transport === "bounded-cua");
  const manifest = defineExecutionAdapterManifest({
    kind: "realbud.execution-adapter.v1",
    schemaVersion: 1,
    id: input.id,
    version: 1,
    label: input.id,
    method: "Test method",
    transport: input.transport,
    route: input.route,
    operations: [input.operation],
    effect,
    requiresNamedAccount: named,
    requiresExplicitOptIn: named,
    runtimeAvailable: true,
    maxConcurrency: 1,
  });
  const attestation: ExecutionAdapterAttestation = {
    kind: "realbud.execution-adapter-attestation.v1",
    schemaVersion: 1,
    adapterId: manifest.id,
    adapterVersion: manifest.version,
    configurationGeneration: 4,
    state: "ready",
    observedAt: NOW,
    expiresAt: EXPIRES,
    policyDigest: workPlanDigest(`policy:${input.id}`),
    ...(named ? { accountIdentityDigest: workPlanDigest(`account:${input.id}`), explicitOptIn: true } : {}),
    ...(remote ? {
      remotePolicy: {
        region: "au-southeast-1",
        retentionHours: 2,
        deletionSupported: true,
        encryptionAtRest: true,
        encryptionInTransit: true,
        spendCeilingCents: 750,
        localFallback: true,
      },
    } : {}),
  };
  return createExecutionAdapterBinding({ manifest, attestation, operation: input.operation, now: NOW });
}

function base() {
  const requestDigest = workPlanDigest("ask-request");
  return {
    requestId: "ask-request-12345678",
    createdAt: NOW,
    expiresAt: EXPIRES,
    bookRevision: 12,
    caseRevision: null,
    inputDigests: [workPlanDigest("selected-file")],
    dataClasses: ["selected-files"] as const,
    routes: [{
      route: "local-analysis" as const,
      adapter: binding({
        id: "local-analysis-test",
        route: "local-analysis",
        transport: "isolated-task",
        operation: "analyse-selected-files",
      }),
    }],
    concurrencyKey: "selected-file-worker",
    recipe: { id: "selected-file-analysis", version: 1 },
    effectClass: "read-only" as const,
    authority: { kind: "user-request" as const, requestId: "ask-request-12345678", requestDigest },
  };
}

describe("authority-bound work plans", () => {
  it("round-trips an exact local plan and persists only digests and adapter policy metadata", () => {
    const plan = buildWorkPlan(base());
    expect(readWorkPlan(structuredClone(plan), NOW)).toEqual(plan);
    const receipt = workPlanReceiptBinding(plan);
    expect(receipt).toMatchObject({
      kind: "realbud.work-plan-binding.v1",
      authorityKind: "user-request",
      routes: [{
        route: "local-analysis",
        adapter: { adapterId: "local-analysis-test", operation: "analyse-selected-files" },
      }],
    });
    const serialized = JSON.stringify({ plan, receipt });
    expect(serialized).not.toMatch(/selected-file-worker|cookie|credential|\/Users\//i);
  });

  it("requires one exact Allow for possible external and cloud work", () => {
    const portalAdapter = binding({
      id: "portal-prepare-test",
      route: "scripted-browser",
      transport: "private-browser",
      operation: "prepare-approved-fields",
      effect: "prepare-only",
    });
    expect(() => buildWorkPlan({
      ...base(),
      dataClasses: ["portal-form-fields"],
      routes: [{ route: "scripted-browser", adapter: portalAdapter }],
      allowedOrigins: ["https://portal.example.test"],
      effectClass: "possible-external",
    })).toThrow(/requires one exact Allow/i);

    const cloud = binding({
      id: "cloud-analysis-test",
      route: "remote-analysis",
      transport: "remote-lane",
      operation: "analyse-selected-files",
    });
    expect(() => buildWorkPlan({
      ...base(),
      routes: [{ route: "remote-analysis", adapter: cloud }],
    })).toThrow(/cloud work requires one exact Allow/i);
  });

  it("binds cloud residency, retention, spend, account and a disclosed local fallback", () => {
    const cloud = binding({
      id: "cloud-analysis-test",
      route: "remote-analysis",
      transport: "remote-lane",
      operation: "analyse-selected-files",
    });
    const local = base().routes[0]!.adapter;
    const actionDigest = workPlanDigest("exact cloud job approval");
    const plan = buildWorkPlan({
      ...base(),
      routes: [
        { route: "remote-analysis", adapter: cloud },
        { route: "local-analysis", adapter: local },
      ],
      authority: { kind: "allow-decision", actionId: "action-cloud-1", actionRevision: 2, actionDigest },
    });
    expect(workPlanReceiptBinding(plan)).toMatchObject({
      authorityKind: "allow-decision",
      routes: [
        {
          route: "remote-analysis",
          adapter: {
            accountIdentityDigest: workPlanDigest("account:cloud-analysis-test"),
            remotePolicy: { region: "au-southeast-1", retentionHours: 2, spendCeilingCents: 750, localFallback: true },
          },
        },
        { route: "local-analysis" },
      ],
    });
  });

  it("never permits a local plan to escalate to cloud as a fallback", () => {
    const cloud = binding({
      id: "cloud-analysis-test",
      route: "remote-analysis",
      transport: "remote-lane",
      operation: "analyse-selected-files",
    });
    expect(() => buildWorkPlan({
      ...base(),
      routes: [...base().routes, { route: "remote-analysis", adapter: cloud }],
      authority: {
        kind: "allow-decision",
        actionId: "action-local-first",
        actionRevision: 1,
        actionDigest: workPlanDigest("approved local plan"),
      },
    })).toThrow(/cannot silently escalate to cloud/i);
  });

  it("rejects browser work from a schedule and detects stale or tampered adapter proof", () => {
    const portalAdapter = binding({
      id: "portal-read-test",
      route: "scripted-browser",
      transport: "private-browser",
      operation: "browse-approved-origin",
    });
    expect(() => buildWorkPlan({
      ...base(),
      dataClasses: ["bank-credit-metadata"],
      routes: [{ route: "scripted-browser", adapter: portalAdapter }],
      allowedOrigins: ["https://portal.example.test"],
      authority: {
        kind: "scheduled-routine",
        loopId: "morning-arrears",
        loopRevision: 3,
        occurrenceDigest: workPlanDigest("2026-08-28"),
      },
    })).toThrow(/scheduled authority is limited/i);

    const desktopBankAdapter = binding({
      id: "bounded-bank-cua-test",
      route: "desktop-cua",
      transport: "bounded-cua",
      operation: "browse-approved-origin",
    });
    expect(buildWorkPlan({
      ...base(),
      dataClasses: ["bank-credit-metadata"],
      routes: [{ route: "desktop-cua", adapter: desktopBankAdapter }],
      allowedOrigins: ["https://bank.example.test"],
    })).toMatchObject({
      effectClass: "read-only",
      routes: [{ route: "desktop-cua" }],
    });

    const plan = buildWorkPlan(base());
    const tampered = structuredClone(plan);
    tampered.routes[0]!.adapter!.bindingDigest = "f".repeat(64);
    expect(() => readWorkPlan(tampered, NOW)).toThrow(/adapter binding integrity/i);
    expect(() => readExecutionAdapterBinding({ ...plan.routes[0]!.adapter, expiresAt: NOW - 1 })).toThrow(/integrity|lifetime/i);
    expect(() => readWorkPlan(plan, EXPIRES + 1)).toThrow(/expired/i);
  });
});
