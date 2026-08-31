import { describe, expect, it } from "vitest";

import { lastCheckedLine, noDriftLine, readLawWatch } from "./law-watch";

describe("readLawWatch", () => {
  it("defaults a missing or empty payload", () => {
    expect(readLawWatch(undefined)).toEqual({
      lastCheckedAt: null,
      drift: [],
      checkedSources: [],
      scheduled: false,
    });
  });

  it("reads a checked payload and drops malformed drift rows", () => {
    expect(
      readLawWatch({
        lastCheckedAt: 1_700_000_000_000,
        scheduled: true,
        checkedSources: ["legislation.nsw.gov.au", 12, "legislation.vic.gov.au"],
        drift: [
          {
            jurisdiction: "NSW",
            topic: "Rent increases",
            reference: "once per 12 months",
            current: "once per 12 months, 60 days",
            note: "Notice days now named.",
          },
          "skip",
          { topic: "only topic" },
        ],
      }),
    ).toEqual({
      lastCheckedAt: 1_700_000_000_000,
      scheduled: true,
      checkedSources: ["legislation.nsw.gov.au", "legislation.vic.gov.au"],
      drift: [
        {
          jurisdiction: "NSW",
          topic: "Rent increases",
          reference: "once per 12 months",
          current: "once per 12 months, 60 days",
          note: "Notice days now named.",
        },
        {
          jurisdiction: "",
          topic: "only topic",
          reference: "",
          current: "",
          note: "",
        },
      ],
    });
  });
});

describe("lastCheckedLine", () => {
  it("says never checked when there is no stamp", () => {
    expect(lastCheckedLine(null)).toBe("Never checked");
  });

  it("uses a relative stamp for a recent check", () => {
    const now = 1_700_000_060_000;
    expect(lastCheckedLine(1_700_000_000_000, now)).toBe("Last checked 1 min ago");
  });
});

describe("noDriftLine", () => {
  it("names the source count after a clean check", () => {
    expect(noDriftLine(0)).toBe("No drift found — the reference matches the current Acts.");
    expect(noDriftLine(1)).toBe("No drift found — the reference matches the current Acts across 1 source.");
    expect(noDriftLine(4)).toBe("No drift found — the reference matches the current Acts across 4 sources.");
  });
});
