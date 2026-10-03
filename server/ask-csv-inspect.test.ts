import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ASK_CSV_MAX_BYTES, inspectAskCsv } from "./ask-csv-inspect.ts";

const inspect = (text: string) => inspectAskCsv("fictional-properties.csv", Buffer.from(text));

describe("selected CSV inspection", () => {
  it("counts logical data rows with BOM, CRLF, quoted line breaks and explicit blank-record semantics", () => {
    const csv = '\uFEFFid,address,reference\r\n0001,"1 Fictional St,\r\nUnit 2",0010\r\n0002,2 Fictional St,0010\r\n0001,"1 Fictional St,\r\nUnit 2",0010\r\n,3 Fictional St,\r\n\r\n , , \r\n0003,4 Fictional St,010\r\n';
    const bytes = Buffer.from(csv), result = inspect(csv);
    expect(result).toMatchObject({
      status: "complete", coverageComplete: true, propertyBookChanged: false,
      source: { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, basis: "selected-upload-bytes" },
      counts: { dataRows: 5, columns: 3, blankRecords: 2, duplicateRows: 1, unevenRows: 0 },
      columns: [
        { header: "id", missingValues: 1, duplicateValues: 1, distinctNonemptyValues: 3 },
        { header: "address", missingValues: 0, duplicateValues: 1, distinctNonemptyValues: 4 },
        { header: "reference", missingValues: 1, duplicateValues: 2, distinctNonemptyValues: 2 },
      ],
    });
    expect(result.conventions.dataRows).toMatch(/Excludes the header/);
    expect(result.conventions.columnValues).toMatch(/after the first, not distinct duplicate groups/);
    expect(result.meaning).toMatch(/not a verified property count/);
  });

  it("keeps leading zeros and case, and does not infer what a column identifies", () => {
    expect(inspect('reference\n001\n1\nAb\nab\n Ab \n').columns).toEqual([
      { column: 1, header: "reference", headerRedacted: false, missingValues: 0, duplicateValues: 1, distinctNonemptyValues: 4 },
    ]);
  });

  it("reports missing/duplicate headers and uneven rows without dropping them from the count", () => {
    expect(inspect("id,id,\n1,2\n1,2,3,4\n")).toMatchObject({
      status: "needs-review", coverageComplete: true,
      counts: { dataRows: 2, blankHeaders: 1, duplicateHeaders: 1, unevenRows: 2 },
      unevenRowSample: [1, 2], unevenRowSampleComplete: true,
      columns: [{ missingValues: 0 }, { missingValues: 0 }, { missingValues: 1 }],
    });
    expect(inspect("id,name\n" + "fictional\n".repeat(21))).toMatchObject({
      counts: { dataRows: 21, unevenRows: 21 }, unevenRowSample: Array.from({ length: 20 }, (_, i) => i + 1), unevenRowSampleComplete: false,
    });
  });

  it("handles escaped quotes, CR-only lines and a header-only file", () => {
    expect(inspect('id,note\r1,"a ""quote"", and comma"\r')).toMatchObject({ status: "complete", counts: { dataRows: 1, columns: 2, blankRecords: 0 } });
    expect(inspect("id,name")).toMatchObject({ status: "complete", counts: { dataRows: 0, blankRecords: 0 } });
  });

  it.each(['id,note\n1,"unfinished', 'id,note\n1,un"quoted\n', 'id,note\n1,"closed"tail\n', "", "\n,,\n"])("does not offer a partial count for invalid input %j", csv => {
    expect(inspect(csv)).toMatchObject({ status: "invalid", coverageComplete: false, counts: null, columns: [] });
  });

  it("bounds parsing and report size without silently truncating counts", () => {
    for (const csv of ["x".repeat(ASK_CSV_MAX_BYTES + 1), "id\n" + "1\n".repeat(20_001), Array(65).fill("id").join(","), "x".repeat(129)]) {
      expect(inspect(csv)).toMatchObject({ status: "unsupported", coverageComplete: false, counts: null });
    }
    const widest = inspect(Array.from({ length: 64 }, (_, i) => String(i).padEnd(128, "x")).join(","));
    expect(widest.status).toBe("complete");
    expect(Buffer.byteLength(JSON.stringify(widest, null, 2))).toBeLessThan(32_000);
    expect(inspect("id\n" + "1\n".repeat(20_000))).toMatchObject({ status: "complete", counts: { dataRows: 20_000, duplicateRows: 19_999 } });
  });

  it("refuses unsupported encodings and delimiters without miscounting them as a one-column property list", () => {
    for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from("id\n1", "utf16le"), Buffer.from("id;name\n1;fictional"), Buffer.from("id\tname\n1\tfictional")]) {
      expect(inspectAskCsv("fictional.csv", bytes)).toMatchObject({ status: "unsupported", coverageComplete: false, counts: null });
    }
  });
});
