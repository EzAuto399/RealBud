import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { saveAskAttachment } from "./ask-attach.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ask attachments", () => {
  it("writes a PDF under the data dir and rejects a disallowed type", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-ask-"));
    dirs.push(dir);
    const saved = saveAskAttachment(dir, {
      name: "lease.pdf",
      contentBase64: Buffer.from("%PDF-1.4 test").toString("base64"),
      size: 13,
    });
    expect(saved.name).toBe("lease.pdf");
    expect(saved.path).toContain("ask-uploads");
    expect(readFileSync(saved.path, "utf8")).toContain("%PDF-1.4");
    expect(() =>
      saveAskAttachment(dir, { name: "payload.exe", contentBase64: Buffer.from("x").toString("base64") }),
    ).toThrow(/cannot be attached/);
  });
});
