import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AtomicWriteError } from "./atomic.ts";
import { Desk } from "./desk.ts";
import { WorkBroker } from "./work-broker.ts";
import {
  runStructuredPmsImport,
  type StructuredPmsAggregate,
} from "./work-desk-reconciler.ts";

describe("structured work to Desk reconciliation", () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "realbud-work-desk-"));
    now = new Date(2026, 7, 27, 8, 30, 0).getTime();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function aggregate(): StructuredPmsAggregate {
    return {
      kind: "realbud.structured-pms-aggregate.v1",
      schemaVersion: 1,
      observedAt: now,
      csv: [
        "address,daysLate,rentLanded,levyPaid",
        '"12 Oak Street, Dickson ACT",4,false,false',
      ].join("\n"),
    };
  }

  function desk(): Desk {
    return new Desk({ file: join(dir, "desk.json"), now: () => now });
  }

  it("commits one brokered aggregate to Desk exactly once", () => {
    const activeDesk = desk();
    const broker = new WorkBroker({ file: join(dir, "broker.json"), now: () => now, idFactory: () => "receipt-one" });
    const expectedRevision = activeDesk.revision;

    const first = runStructuredPmsImport({
      broker,
      desk: activeDesk,
      requestId: "import-one",
      expectedRevision,
      aggregate: aggregate(),
      now: () => now,
    });
    expect(first.receipt.state).toBe("reconciled");
    expect(first.receipt.plan).toMatchObject({
      authorityKind: "user-request",
      dataClasses: ["portfolio-records"],
      routes: [{ route: "structured-batch" }],
    });
    expect(first.replayedDeskCommit).toBe(false);
    expect(first.snapshot.ledger.find((row) => row.propertyId === "prop-oak")?.daysSinceDue).toBe(4);
    expect(first.snapshot.sources.some((source) => source.label === "Brokered PMS export")).toBe(true);
    const committedRevision = first.snapshot.revision;

    const retry = runStructuredPmsImport({
      broker,
      desk: activeDesk,
      requestId: "import-one",
      expectedRevision,
      aggregate: aggregate(),
      now: () => now,
    });
    expect(retry.replayedDeskCommit).toBe(true);
    expect(retry.snapshot.revision).toBe(committedRevision);
    expect(broker.list()).toHaveLength(1);
  });

  it("recovers the crash window after Desk commit without duplicate evidence", () => {
    const activeDesk = desk();
    const brokerFile = join(dir, "broker.json");
    let writes = 0;
    let failReconcile = true;
    const broker = new WorkBroker({
      file: brokerFile,
      now: () => now,
      idFactory: () => "receipt-crash-window",
      writer: (path, body) => {
        writes += 1;
        if (failReconcile && writes === 5) throw new AtomicWriteError("not-landed");
        writeFileSync(path, body, { mode: 0o600 });
      },
    });
    const expectedRevision = activeDesk.revision;

    expect(() => runStructuredPmsImport({
      broker,
      desk: activeDesk,
      requestId: "import-crash-window",
      expectedRevision,
      aggregate: aggregate(),
      now: () => now,
    })).toThrow(/work broker update did not land/i);
    expect(broker.getByRequestId("import-crash-window")?.state).toBe("evidence-ready");
    const afterDeskCommit = activeDesk.snapshot();
    const committedRevision = afterDeskCommit.revision;
    const evidenceCount = afterDeskCommit.sources.length;

    failReconcile = false;
    const retry = runStructuredPmsImport({
      broker,
      desk: activeDesk,
      requestId: "import-crash-window",
      expectedRevision,
      aggregate: aggregate(),
      now: () => now,
    });
    expect(retry.receipt.state).toBe("reconciled");
    expect(retry.replayedDeskCommit).toBe(true);
    expect(retry.snapshot.revision).toBe(committedRevision);
    expect(retry.snapshot.sources).toHaveLength(evidenceCount);
  });

  it("rejects malformed or stale output before it can enter the broker", () => {
    const activeDesk = desk();
    const broker = new WorkBroker({ file: join(dir, "broker.json"), now: () => now });
    const stale = { ...aggregate(), observedAt: now - 13 * 60 * 60_000 };
    expect(() => runStructuredPmsImport({
      broker,
      desk: activeDesk,
      requestId: "stale-import",
      expectedRevision: activeDesk.revision,
      aggregate: stale,
      now: () => now,
    })).toThrow(/stale/i);
    expect(broker.list()).toEqual([]);

    expect(() => runStructuredPmsImport({
      broker,
      desk: activeDesk,
      requestId: "bad-import",
      expectedRevision: activeDesk.revision,
      aggregate: { ...aggregate(), csv: "not,a,valid,pms,shape" },
      now: () => now,
    })).toThrow();
    expect(broker.list()).toEqual([]);
  });
});
