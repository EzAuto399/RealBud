import { describe, expect, it } from "vitest";
import { BATCH_LIMIT, type BatchItem, type WorkBatch } from "../shared/batches.ts";
import { restoreWorkBatches, validStoredWorkBatches } from "./batch-persistence.ts";

const REQUEST_HASH = "cafebabe".repeat(8);
const AT = 1_715_000_000_000;
const CREATED = 1_700_000_000_000;
const UPDATED = 1_710_000_000_000;
const REVIEWED = 1_712_000_000_000;
const RETRY_AT = 1_720_000_000_000;

function item(overrides: Partial<BatchItem> & Pick<BatchItem, "propertyId">): BatchItem {
  return {
    address: "410 Congress Ave, Austin TX",
    source: "Owner notes for 410 Congress Ave.",
    status: "ready",
    attempt: 1,
    output: "Draft owner update for 410 Congress Ave.",
    detail: "Prepared.",
    gaps: [],
    ...overrides,
  };
}

function batch(overrides: Partial<WorkBatch> = {}): WorkBatch {
  return {
    id: "batch-owner-congress",
    requestKey: "owner-req-1",
    requestHash: REQUEST_HASH,
    revision: 3,
    task: "owner-update",
    instruction: "Write a concise owner update.",
    status: "finished",
    retryOnly: false,
    autoContinue: false,
    waitingForWorker: false,
    detail: "All properties prepared.",
    sourceRevision: 8,
    sample: false,
    createdAt: CREATED,
    updatedAt: UPDATED,
    items: [item({ propertyId: "prop-410-congress" })],
    ...overrides,
  };
}

function currentPersistedFixture(): WorkBatch[] {
  return [
    batch({
      id: "batch-owner-live",
      requestKey: "owner-live-01",
      autoContinue: true,
      waitingForWorker: true,
      status: "running",
      detail: "Preparing remaining properties.",
      items: [
        item({
          propertyId: "prop-ready",
          address: "88 Rainey St, Austin TX",
          source: "Rainey Street owner packet.",
          status: "ready",
          attempt: 1,
          output: "Ready owner note.",
          detail: "Ready for review.",
          gaps: ["Confirm insurance renewal date."],
          reviewedAt: REVIEWED,
        }),
        item({
          propertyId: "prop-running",
          address: "21 Barton Springs Rd, Austin TX",
          source: "Barton Springs maintenance notes.",
          status: "running",
          attempt: 2,
          output: "Partial draft only.",
          detail: "Worker still running.",
          gaps: ["Need vendor quote."],
          retryAt: RETRY_AT,
        }),
        item({
          propertyId: "prop-queued",
          address: "5 South 1st St, Austin TX",
          source: "South 1st inspection notes.",
          status: "queued",
          attempt: 0,
          output: "",
          detail: "Waiting in queue.",
          gaps: [],
          retryAt: RETRY_AT + 50,
        }),
      ],
    }),
    batch({
      id: "batch-maint-paused",
      requestKey: "maint-pause-2",
      task: "maintenance-brief",
      instruction: "Summarise access and urgency.",
      status: "paused",
      retryOnly: true,
      autoContinue: true,
      waitingForWorker: true,
      detail: "Paused by operator.",
      sourceRevision: 2,
      items: [
        item({
          propertyId: "prop-failed",
          address: "900 E 6th St, Austin TX",
          source: "East 6th leak report.",
          status: "failed",
          attempt: 3,
          output: "",
          detail: "Could not finish this property.",
          gaps: ["Tenant phone missing."],
          reviewedAt: REVIEWED - 1,
          retryAt: RETRY_AT + 100,
        }),
      ],
    }),
    batch({
      id: "batch-inspect-done",
      requestKey: "inspect-done3",
      task: "inspection-checklist",
      instruction: "Checklist and missing documents.",
      status: "finished",
      detail: "Finished checklist batch.",
      sourceRevision: 0,
      sample: true,
      items: [
        item({
          propertyId: "prop-reviewed",
          address: "301 W 2nd St, Austin TX",
          source: "Second Street inspection pack.",
          status: "needs-review",
          attempt: 1,
          output: "Checklist draft.",
          detail: "Needs a human look.",
          gaps: ["HOA cert"],
          reviewedAt: REVIEWED,
        }),
      ],
    }),
  ];
}

function optionalFieldsAbsentFixture(): WorkBatch[] {
  const [first] = currentPersistedFixture();
  const stripped: WorkBatch = {
    id: "batch-legacy-min",
    requestKey: "legacy-min",
    requestHash: REQUEST_HASH,
    revision: 1,
    task: "owner-update",
    instruction: "Legacy owner update.",
    status: "paused",
    retryOnly: false,
    detail: "Older file without optional flags.",
    sourceRevision: 1,
    sample: false,
    createdAt: CREATED,
    updatedAt: UPDATED,
    items: [
      {
        propertyId: "prop-legacy",
        address: first.items[0].address,
        source: first.items[0].source,
        status: "queued",
        attempt: 0,
        output: "",
        detail: "Not started.",
        gaps: [],
      },
    ],
  };
  return [stripped];
}

describe("validStoredWorkBatches", () => {
  it("accepts a current persisted fixture including optional fields", () => {
    const stored = currentPersistedFixture();
    expect(validStoredWorkBatches(stored)).toBe(true);
  });

  it("accepts older records with optional fields absent", () => {
    expect(validStoredWorkBatches(optionalFieldsAbsentFixture())).toBe(true);
  });

  it("preserves exact whitespace, BOM, and Unicode in stored strings", () => {
    const source = "\uFEFF  Unit 3 — Café\n\tkeep spaces  日本語";
    const stored = [
      batch({
        instruction: "  keep instruction  ",
        detail: "\nline\n",
        items: [
          item({
            propertyId: "prop-unicode",
            address: "  12½ Lane  ",
            source,
            output: "\uFEFFready\noutput ",
            detail: "  note  ",
            gaps: ["  gap  ", "日本語"],
          }),
        ],
      }),
    ];
    expect(validStoredWorkBatches(stored)).toBe(true);
    expect(stored[0].items[0].source).toBe(source);
  });

  it("rejects malformed, null, duplicate, and oversize values", () => {
    expect(validStoredWorkBatches(null)).toBe(false);
    expect(validStoredWorkBatches(undefined)).toBe(false);
    expect(validStoredWorkBatches({})).toBe(false);
    expect(validStoredWorkBatches([null])).toBe(false);
    expect(validStoredWorkBatches([batch(), batch({ id: "batch-owner-congress", requestKey: "other-key1" })])).toBe(false);
    expect(validStoredWorkBatches([batch(), batch({ id: "other-batch", requestKey: "owner-req-1" })])).toBe(false);
    expect(validStoredWorkBatches([batch({ items: [item({ propertyId: "dup" }), item({ propertyId: "dup", address: "B" })] })])).toBe(false);
    expect(validStoredWorkBatches([batch({ requestKey: "short" })])).toBe(false);
    expect(validStoredWorkBatches([batch({ requestHash: "abc" })])).toBe(false);
    expect(validStoredWorkBatches([batch({ requestHash: "A".repeat(64) })])).toBe(false);
    expect(validStoredWorkBatches([batch({ task: "unknown" as WorkBatch["task"] })])).toBe(false);
    expect(validStoredWorkBatches([batch({ revision: 0 })])).toBe(false);
    expect(validStoredWorkBatches([batch({ revision: 1.5 })])).toBe(false);
    expect(validStoredWorkBatches([batch({ sourceRevision: 1.2 })])).toBe(false);
    expect(validStoredWorkBatches([batch({ instruction: "x".repeat(1001) })])).toBe(false);
    expect(validStoredWorkBatches([batch({ detail: "y".repeat(2001) })])).toBe(false);
    expect(validStoredWorkBatches([batch({ items: [] })])).toBe(false);
    expect(validStoredWorkBatches([batch({ items: [item({ propertyId: "p", source: "s".repeat(16_001) })] })])).toBe(false);
    expect(validStoredWorkBatches([batch({ items: [item({ propertyId: "p", output: "o".repeat(24_001) })] })])).toBe(false);
    expect(validStoredWorkBatches([batch({ items: [item({ propertyId: "p", gaps: Array.from({ length: 21 }, (_, i) => `g${i}`) })] })])).toBe(false);
    expect(validStoredWorkBatches([batch({ items: [item({ propertyId: "p", gaps: ["g".repeat(501)] })] })])).toBe(false);
    expect(validStoredWorkBatches([batch({ items: [item({ propertyId: "p", attempt: -1 })] })])).toBe(false);
    expect(validStoredWorkBatches([batch({ items: [item({ propertyId: "p", retryAt: -1 })] })])).toBe(false);
    expect(validStoredWorkBatches([batch({ autoContinue: "yes" as unknown as boolean })])).toBe(false);
    expect(validStoredWorkBatches([batch({ waitingForWorker: "yes" as unknown as boolean })])).toBe(false);
    expect(validStoredWorkBatches(Array.from({ length: 101 }, (_, i) => batch({
      id: `batch-${i}`,
      requestKey: `req-${String(i).padStart(5, "0")}`,
    })))).toBe(false);
  });

  it("accepts current size bounds and integer sourceRevision 0", () => {
    expect(validStoredWorkBatches([batch({ instruction: "x".repeat(1000), detail: "y".repeat(2000) })])).toBe(true);
    expect(validStoredWorkBatches([batch({ sourceRevision: 0 })])).toBe(true);
    expect(validStoredWorkBatches([batch({ sourceRevision: -2 })])).toBe(true);
    expect(validStoredWorkBatches([batch({ items: [item({ propertyId: "p", source: "s".repeat(16_000), output: "o".repeat(24_000), gaps: Array.from({ length: 20 }, () => "g".repeat(500)) })] })])).toBe(true);
    expect(validStoredWorkBatches(Array.from({ length: 100 }, (_, i) => batch({
      id: `batch-${i}`,
      requestKey: `req-${String(i).padStart(5, "0")}`,
    })))).toBe(true);
    expect(validStoredWorkBatches([batch({
      items: Array.from({ length: BATCH_LIMIT }, (_, i) => item({ propertyId: `prop-${i}` })),
    })])).toBe(true);
    expect(validStoredWorkBatches([batch({
      items: Array.from({ length: BATCH_LIMIT + 1 }, (_, i) => item({ propertyId: `prop-${i}` })),
    })])).toBe(false);
  });
});

describe("restoreWorkBatches", () => {
  it("clones, pauses unfinished work, and keeps completed identity", () => {
    const input = currentPersistedFixture();
    const snapshot = structuredClone(input);
    const restored = restoreWorkBatches(input, AT);

    expect(input).toEqual(snapshot);
    expect(validStoredWorkBatches(restored)).toBe(true);
    expect(restored).not.toBe(input);
    expect(restored.map(batch => batch.id)).toEqual(input.map(batch => batch.id));
    expect(restored.map(batch => batch.requestKey)).toEqual(input.map(batch => batch.requestKey));
    expect(restored.map(batch => batch.requestHash)).toEqual(input.map(batch => batch.requestHash));
    expect(restored.map(batch => batch.task)).toEqual(input.map(batch => batch.task));
    expect(restored.map(batch => batch.sourceRevision)).toEqual(input.map(batch => batch.sourceRevision));

    const [running, paused, finished] = restored;
    expect(running.status).toBe("paused");
    expect(running.autoContinue).toBe(false);
    expect(running.waitingForWorker).toBe(false);
    expect(running.revision).toBe(input[0].revision + 1);
    expect(running.updatedAt).toBe(AT);
    expect(running.createdAt).toBe(CREATED);
    expect(running.items.map(item => item.propertyId)).toEqual(input[0].items.map(item => item.propertyId));
    expect(running.items[0]).toMatchObject({
      status: "ready",
      attempt: 1,
      output: "Ready owner note.",
      gaps: ["Confirm insurance renewal date."],
      reviewedAt: REVIEWED,
    });
    expect(running.items[0]).not.toHaveProperty("retryAt");
    expect(running.items[1]).toMatchObject({
      status: "interrupted",
      attempt: 2,
      output: "Partial draft only.",
      gaps: ["Need vendor quote."],
    });
    expect(running.items[1].status).not.toBe("ready");
    expect(running.items[1]).not.toHaveProperty("retryAt");
    expect(running.items[2]).toMatchObject({
      status: "queued",
      attempt: 0,
      output: "",
    });
    expect(running.items[2]).not.toHaveProperty("retryAt");

    expect(paused.status).toBe("paused");
    expect(paused.autoContinue).toBe(false);
    expect(paused.waitingForWorker).toBe(false);
    expect(paused.retryOnly).toBe(true);
    expect(paused.requestHash).toBe(REQUEST_HASH);
    expect(paused.items[0]).toMatchObject({
      status: "failed",
      attempt: 3,
      reviewedAt: REVIEWED - 1,
    });
    expect(paused.items[0]).not.toHaveProperty("retryAt");

    expect(finished.status).toBe("finished");
    expect(finished.autoContinue).toBe(false);
    expect(finished.waitingForWorker).toBe(false);
    expect(finished.sample).toBe(true);
    expect(finished.sourceRevision).toBe(0);
    expect(finished.items[0]).toMatchObject({
      status: "needs-review",
      output: "Checklist draft.",
      reviewedAt: REVIEWED,
    });
  });

  it("keeps queued, paused, and finished states without completing interrupted work", () => {
    const input = [
      batch({
        id: "run-queued",
        requestKey: "run-queue1",
        status: "running",
        autoContinue: true,
        items: [item({ propertyId: "only-queued", status: "queued", attempt: 0, output: "", detail: "Queued." })],
      }),
      batch({
        id: "already-paused",
        requestKey: "paused-ok1",
        status: "paused",
        autoContinue: false,
        waitingForWorker: false,
        items: [item({ propertyId: "paused-ready", status: "ready", output: "Kept." })],
      }),
      batch({
        id: "finished-ok",
        requestKey: "finished1",
        status: "finished",
        autoContinue: false,
        waitingForWorker: false,
        items: [item({ propertyId: "done", status: "ready", output: "Done." })],
      }),
      batch({
        id: "finished-running",
        requestKey: "fin-run-1",
        status: "finished",
        autoContinue: false,
        waitingForWorker: false,
        items: [
          item({ propertyId: "done-keep", status: "ready", output: "Complete." }),
          item({ propertyId: "still-run", status: "running", attempt: 0, output: "", detail: "Live." }),
        ],
      }),
    ];
    const restored = restoreWorkBatches(input, AT);
    expect(restored[0].status).toBe("paused");
    expect(restored[0].items[0].status).toBe("queued");
    expect(restored[1].status).toBe("paused");
    expect(restored[1].revision).toBe(input[1].revision);
    expect(restored[1].updatedAt).toBe(UPDATED);
    expect(restored[2].status).toBe("finished");
    expect(restored[2].revision).toBe(input[2].revision);
    expect(restored[3].status).toBe("paused");
    expect(restored[3].items[0].status).toBe("ready");
    expect(restored[3].items[1].status).toBe("interrupted");
  });

  it("disables autoresume flags and drops retry timers", () => {
    const input = optionalFieldsAbsentFixture();
    input[0].items[0].retryAt = 0;
    const restored = restoreWorkBatches(input, AT);
    expect(restored[0].autoContinue).toBe(false);
    expect(restored[0].waitingForWorker).toBe(false);
    expect(restored[0].items[0]).not.toHaveProperty("retryAt");
    expect(restoreWorkBatches(restored, AT + 1)).toEqual(restored);
  });

  it("retains source, outputs, attempts, gaps, and review timestamps including whitespace", () => {
    const source = "\uFEFFExact source\n  block  — 日本語";
    const input = [
      batch({
        instruction: "\uFEFF  keep hash evidence  ",
        requestHash: REQUEST_HASH,
        retryOnly: true,
        status: "running",
        items: [
          item({
            propertyId: "prop-keep",
            source,
            status: "running",
            attempt: 2,
            output: "  partial output  ",
            gaps: ["\uFEFF gap ", "Café access"],
            reviewedAt: REVIEWED,
            retryAt: RETRY_AT,
          }),
        ],
      }),
    ];
    const restored = restoreWorkBatches(input, AT);
    expect(restored[0].requestHash).toBe(REQUEST_HASH);
    expect(restored[0].requestKey).toBe("owner-req-1");
    expect(restored[0].instruction).toBe("\uFEFF  keep hash evidence  ");
    expect(restored[0].sourceRevision).toBe(8);
    expect(restored[0].items[0].source).toBe(source);
    expect(restored[0].items[0].output).toBe("  partial output  ");
    expect(restored[0].items[0].attempt).toBe(2);
    expect(restored[0].items[0].gaps).toEqual(["\uFEFF gap ", "Café access"]);
    expect(restored[0].items[0].reviewedAt).toBe(REVIEWED);
    expect(restored[0].items[0].status).toBe("interrupted");
  });

  it("rejects unsafe revisions and timestamps without mutating input", () => {
    const input = currentPersistedFixture();
    const snapshot = structuredClone(input);
    expect(() => restoreWorkBatches(input, Number.NaN)).toThrow(/unsafe restore timestamp/);
    expect(() => restoreWorkBatches(input, Infinity)).toThrow(/unsafe restore timestamp/);
    expect(() => restoreWorkBatches(input, -Infinity)).toThrow(/unsafe restore timestamp/);
    for (const at of [-1, 1.5, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_001]) {
      expect(() => restoreWorkBatches(input, at)).toThrow(/unsafe restore timestamp/);
    }
    expect(input).toEqual(snapshot);

    const maxed = [batch({
      revision: Number.MAX_SAFE_INTEGER,
      status: "running",
      items: [item({ propertyId: "prop-max", status: "running" })],
    })];
    const maxedSnapshot = structuredClone(maxed);
    expect(() => restoreWorkBatches(maxed, AT)).toThrow(/unsafe batch revision/);
    expect(maxed).toEqual(maxedSnapshot);
  });

  it("pauses a legacy finished parent that still contains queued work", () => {
    const input = [batch({ items: [item({ propertyId: 'pending', status: 'queued', attempt: 0 })] })];
    const [restored] = restoreWorkBatches(input, AT);
    expect(restored.status).toBe('paused'); expect(restored.items[0].status).toBe('queued');
    expect(restored.revision).toBe(input[0].revision + 1);
    expect(restoreWorkBatches([restored], AT + 1)).toEqual([restored]);
  });

  it("advances the edited timestamp even if the destination clock is behind", () => {
    const input = [batch({ status: 'running', updatedAt: AT + 100.5 })];
    expect(restoreWorkBatches(input, AT)[0].updatedAt).toBe(AT + 101);
    const overflow = [batch({ status: 'running', updatedAt: 8_640_000_000_000_000 })];
    const snapshot = structuredClone(overflow);
    expect(() => restoreWorkBatches(overflow, AT)).toThrow(/unsafe restore timestamp/);
    expect(overflow).toEqual(snapshot);
  });

  it("rejects invalid history and leaves input unchanged", () => {
    const bad = [batch({ id: "dup" }), batch({ id: "dup", requestKey: "other-key1" })];
    const snapshot = structuredClone(bad);
    expect(() => restoreWorkBatches(bad, AT)).toThrow(/invalid batch history/);
    expect(() => restoreWorkBatches(null, AT)).toThrow(/invalid batch history/);
    expect(bad).toEqual(snapshot);
  });

  it("returns a post-transform payload that still passes the stored validator", () => {
    const restored = restoreWorkBatches(currentPersistedFixture(), AT);
    expect(validStoredWorkBatches(restored)).toBe(true);
    restored[0].items[0].output = "mutated after restore";
    expect(currentPersistedFixture()[0].items[0].output).toBe("Ready owner note.");
  });
});
