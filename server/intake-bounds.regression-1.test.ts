import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Desk } from "./desk.ts";
import { parseIntakeText } from "./intake.ts";
import { parseWorkerIntakeAction } from "./worker-intake.ts";

// Regression: ISSUE-002 — escaped multi-line intake persisted an oversized tenant field
// Found by /qa on 2026-08-26
// Report: .gstack/qa-reports/qa-report-realbud-local-2026-08-26.md
const dirs: string[] = [];

function testDesk(): Desk {
  const dir = mkdtempSync(join(tmpdir(), "realbud-intake-bounds-"));
  dirs.push(dir);
  return new Desk({ file: join(dir, "desk.json") });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("property intake field bounds", () => {
  it("keeps escaped or oversized quick-paste records out of structured intake", () => {
    const escaped = "201 Scale Street, Canberra ACT, Tenant 01\\n202 Scale Street, Canberra ACT, Tenant 02, 0400 100 002, 505";
    const parsed = parseIntakeText(escaped);
    expect(parsed.items).toEqual([]);
    expect(parsed.unparsed).toHaveLength(1);
  });

  it("rejects unsafe worker fields instead of turning them into Desk actions", () => {
    const action = {
      action: "realbud.stage-properties.v1",
      properties: [{
        address: "201 Scale Street, Canberra ACT",
        tenantName: "Tenant 01\\nTenant 02",
        tenantPhone: "0400 100 001",
        weeklyRentCents: 50_000,
      }],
      unparsed: [],
    };
    expect(parseWorkerIntakeAction(JSON.stringify(action))).toBeNull();
  });

  it("skips invalid proposals and rejects invalid direct batches atomically", () => {
    const desk = testDesk();
    const before = desk.snapshot().properties.length;
    const longName = "T".repeat(121);

    expect(desk.proposeBook({ items: [{
      address: "201 Scale Street, Canberra ACT",
      tenantName: longName,
      tenantPhone: "0400 100 001",
      weeklyRentCents: 50_000,
    }] })).toMatchObject({ created: 0, skipped: 1 });

    expect(() => desk.addProperties([
      { address: "202 Scale Street, Canberra ACT", tenantName: "Valid Tenant", tenantPhone: "0400 100 002", weeklyRentCents: 51_000 },
      { address: "203 Scale Street, Canberra ACT", tenantName: longName, tenantPhone: "0400 100 003", weeklyRentCents: 52_000 },
    ])).toThrow(/tenant name is too long/);
    expect(desk.snapshot().properties).toHaveLength(before);
  });
});
