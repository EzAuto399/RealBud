import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bankDownloadBytes, readBankFile } from "./bank-file";

const file = (bytes: Uint8Array) => ({ name: "Original bank.csv", size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer });
describe("bank file transport", () => {
  it("reads raw bytes without stripping a BOM or replacing invalid characters", async () => {
    const bytes = Buffer.from("\uFEFFheader\r\ncafé 🏡\r\n");
    const source = await readBankFile(file(bytes));
    expect(source.filename).toBe("Original bank.csv");
    expect(Buffer.from(source.bytesBase64, "base64")).toEqual(bytes);
    await expect(readBankFile(file(Buffer.from([0xff, 0xfe, 0x44, 0])))).rejects.toThrow(/UTF-8/);
    await expect(readBankFile(file(Buffer.from([0x63, 0x61, 0x66, 0xe9])))).rejects.toThrow(/UTF-8/);
  });
  it("checks size before reading and rejects a changed file", async () => {
    await expect(readBankFile({ name: "huge.csv", size: 750001, arrayBuffer: async () => { throw new Error("must not read"); } })).rejects.toThrow(/750/);
    await expect(readBankFile({ ...file(Buffer.from("data")), size: 3 })).rejects.toThrow(/changed/);
  });
  it("verifies raw download bytes against length and digest before making a Blob", async () => {
    const bytes = Buffer.from("\uFEFFCSV\r\n"), source = await readBankFile(file(bytes));
    const artifact = { ...source, csv: bytes.toString("utf8"), encoding: "utf-8-bom" as const, byteLength: bytes.length,
      digest: createHash("sha256").update(bytes).digest("hex"), originalBytesCaptured: true };
    expect(Buffer.from(await bankDownloadBytes(artifact))).toEqual(bytes);
    await expect(bankDownloadBytes({ ...artifact, bytesBase64: Buffer.from("changed").toString("base64") })).rejects.toThrow(/integrity/);
    await expect(bankDownloadBytes({ ...artifact, byteLength: bytes.length + 1 })).rejects.toThrow(/integrity/);
  });
});
