import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DeskSnapshot, ExecutionAdapterProjection, Loop, SourceConnection } from "../shared/contracts.ts";
import { REALBUD_VERSION } from "../shared/version.ts";
import { createSupportReport } from "./support-report.ts";

const desk = {
  version: 2,
  revision: 17,
  mode: "live",
  recovery: { active: false, reason: null, quarantined: [] },
  timezone: "Australia/Brisbane",
  retentionDays: 30,
  properties: [{ id: "p-secret", address: "1 Secret St", tenantName: "Private Person", tenantPhone: "0400000000" }],
  ledger: [],
  drafts: [{ id: "d-1", status: "pending", body: "private message" }],
  escalations: [],
  workItems: [{ id: "w-1", state: "waiting" }, { id: "w-2", state: "confirmed" }],
  lastRunAt: null,
  results: [],
  hands: "csv",
  handsDetail: "credential sk-secret /Users/private",
  sources: [{ id: "source-secret", kind: "csv", label: "Private export", stableKey: "secret-token" }],
  demo: false,
  book: {
    bookProposals: [], agency: { name: "Private Agency", timezone: "Australia/Brisbane", jurisdictions: ["QLD"] },
    tenancies: [], contacts: [], archivedProperties: [],
    importIssues: [{ id: "i-1", status: "open", rawIdentity: "Private Person", resolutionCount: 0, candidates: [], sourceId: "source-secret", kind: "unmatched" }],
    cases: [], decisions: [],
  },
} as unknown as DeskSnapshot;

const connections = [{
  id: "property-book",
  title: "Private Agency property book",
  description: "token secret",
  state: "ready",
  status: "ready",
  capabilities: ["private payload"],
  methods: [{ id: "local-export", label: "Private export", state: "active", detail: "secret" }],
}] as SourceConnection[];

const execution = [{
  id: "private-browser",
  label: "Do not export this label",
  method: "secret method",
  state: "ready",
  status: "Connected to Private Account",
  detail: "cookie secret",
  capabilities: ["private"],
  route: "scripted-browser",
  maxConcurrency: 1,
  boundaries: {
    manualAllow: true, humanSubmit: true, rawToolsExposed: false, ambientCredentials: false,
    personalBrowserAccess: false, personalHermesAccess: false, localFallback: true,
  },
  observedAt: Date.now(), expiresAt: Date.now() + 1_000,
}] as ExecutionAdapterProjection[];

describe("support report", () => {
  it("keeps only bounded categorical health and aggregate counts", () => {
    const report = createSupportReport({
      now: Date.UTC(2026, 7, 28),
      env: {
        REALBUD_APP_VERSION: "0.1.17",
        REALBUD_BUILD_ID: "../../secret path",
        REALBUD_PACKAGED: "1",
        REALBUD_PRODUCTION: "1",
      },
      platform: "darwin",
      architecture: "arm64",
      nodeVersion: "24.7.0",
      productMode: true,
      pilotContractComplete: false,
      desk,
      worker: {
        ready: true,
        pin: { product: "0.8.0" },
        cli: { installed: true, matchesPin: true },
        pack: { installed: true, approvalsManual: true },
        model: { provider: "private-provider", model: "private-model", keyPresent: true },
      },
      loops: [{ id: "morning-arrears", available: true, enabled: true }] as Loop[],
      loopRuns: [],
      routineRecoveryActive: false,
      connections,
      execution,
      mobile: { state: "ready", connectedCount: 1 },
      localRecovery: { active: true, issues: [{ area: "conversation history", action: "attention" }] },
    });

    expect(report).toMatchObject({
      app: { version: "0.1.17", buildId: null, distribution: "packaged", platform: "darwin", architecture: "arm64", nodeMajor: 24 },
      desk: { properties: 1, sources: 1, openWork: 1, pendingDrafts: 1, openImportIssues: 1 },
      worker: { state: "ready", modelAttached: true },
      recovery: { active: true, issues: [{ area: "conversation-history", action: "attention" }] },
    });
    const serialized = JSON.stringify(report);
    for (const privateValue of ["Private Person", "1 Secret St", "0400000000", "private message", "sk-secret", "/Users/private", "private-provider", "private-model", "cookie secret"]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("keeps the shared fallback version synchronized with package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(REALBUD_VERSION).toBe(pkg.version);
  });
});
