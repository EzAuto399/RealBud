import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeCompanyWorkflowTemplate } from "./workflow-template.ts";

const PORTABLE = [
  "allowedOrigins",
  "capabilities",
  "description",
  "evidence",
  "id",
  "limits",
  "schedule",
  "steps",
  "title",
];

function job(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: "Rent review",
    description: "Review listed rents",
    steps: ["Open the portal", "Check the rent roll"],
    allowedOrigins: ["propertyme.com.au"],
    evidence: "Rent roll screenshot",
    ...extra,
  };
}

function throws400(fn: () => unknown): Error {
  let err: unknown;
  try {
    fn();
  } catch (caught) {
    err = caught;
  }
  assert.ok(err instanceof Error);
  assert.equal((err as { status?: number }).status, 400);
  return err;
}

test("native pack sample roundtrip", () => {
  const sample = {
    version: 1,
    recipes: [
      job("wf-rent-review", {
        schedule: { time: "09:00", weekdays: [1, 2, 3, 4, 5] },
        status: "shadow",
        createdAt: 1,
        updatedAt: 2,
        revision: 4,
        expectedRevision: 4,
        approvedRevision: 3,
        planApprovedAt: 9,
        submitAcknowledgedAt: 8,
        attachment: { name: "roll.pdf" },
        siteNotes: "front office",
      }),
      job("wf-arrears"),
    ],
  };
  const once = normalizeCompanyWorkflowTemplate(sample);
  assert.equal(once.version, 1);
  assert.equal(once.recipes.length, 2);
  assert.equal(once.recipes[0]?.id, "wf-rent-review");
  assert.equal(once.recipes[0]?.title, "Rent review");
  assert.deepEqual(once.recipes[0]?.steps, ["Open the portal", "Check the rent roll"]);
  assert.deepEqual(normalizeCompanyWorkflowTemplate(once), once);
});

test("unsafe fields stripped, schedule disabled, no input mutation", () => {
  const payload = {
    version: 1,
    nonce: "drop-me",
    recipes: [
      job("wf-rent-review", {
        approval: { ok: true },
        tokens: { session: "secret-token" },
        cookies: "sid=abc",
        attachment: { path: "/secret" },
        status: "live",
        revision: 12,
        source: { pack: "office-a" },
        submitPermission: "admin",
        runState: { running: true },
        schedule: { time: "09:00", weekdays: [1, 2, 3, 4, 5] },
        siteNotes: "do not copy",
      }),
    ],
  };
  const snapshot = structuredClone(payload);
  const out = normalizeCompanyWorkflowTemplate(payload);
  assert.deepEqual(payload, snapshot);
  assert.deepEqual(Object.keys(out).sort(), ["recipes", "version"]);
  assert.deepEqual(Object.keys(out.recipes[0] ?? {}).sort(), PORTABLE);
  assert.equal(out.recipes[0]?.schedule, null);
  assert.equal("tokens" in (out.recipes[0] ?? {}), false);
  assert.equal("cookies" in (out.recipes[0] ?? {}), false);
  assert.equal("siteNotes" in (out.recipes[0] ?? {}), false);
  assert.equal("status" in (out.recipes[0] ?? {}), false);
});

test("rejects invalid schedule instead of disabling it", () => {
  const err = throws400(() =>
    normalizeCompanyWorkflowTemplate({
      version: 1,
      recipes: [job("wf-rent-review", { schedule: { time: "99:99", weekdays: [99] } })],
    }),
  );
  assert.doesNotMatch(err.message, /99:99|wf-rent-review/);
});

test("final invalid row rejects the snapshot", () => {
  throws400(() =>
    normalizeCompanyWorkflowTemplate({
      version: 1,
      recipes: [job("wf-one"), job("wf-two"), { id: "wf-three", title: 1, steps: [], allowedOrigins: [] }],
    }),
  );
});

test("duplicate ids, empty snapshot, bad version", () => {
  throws400(() =>
    normalizeCompanyWorkflowTemplate({ version: 1, recipes: [job("wf-one"), job("wf-one")] }),
  );
  throws400(() => normalizeCompanyWorkflowTemplate({ version: 1, recipes: [] }));
  throws400(() => normalizeCompanyWorkflowTemplate({ version: 2, recipes: [job("wf-one")] }));
  throws400(() => normalizeCompanyWorkflowTemplate(null));
  throws400(() => normalizeCompanyWorkflowTemplate({ version: 1, recipes: [null] }));
  const many: unknown[] = [];
  for (let i = 0; i < 101; i++) many.push(job(`wf-${i}`));
  throws400(() => normalizeCompanyWorkflowTemplate({ version: 1, recipes: many }));
});

test("size bounds and nonserializable data", () => {
  const ok = normalizeCompanyWorkflowTemplate({ version: 1, recipes: [job("wf-small")] });
  assert.ok(Buffer.byteLength(JSON.stringify(ok), "utf8") <= 24000);
  const recipes: unknown[] = [];
  for (let i = 0; i < 6; i++) {
    recipes.push(
      job(`wf-${i}`, {
        title: "T".repeat(80),
        description: "D".repeat(4000),
        steps: ["S".repeat(200), "S".repeat(200), "S".repeat(200)],
        evidence: "E".repeat(200),
      }),
    );
  }
  throws400(() => normalizeCompanyWorkflowTemplate({ version: 1, recipes }));
  const cycle: Record<string, unknown> = { version: 1, recipes: [job("wf-loop")] };
  cycle.self = cycle;
  throws400(() => normalizeCompanyWorkflowTemplate(cycle));
});
